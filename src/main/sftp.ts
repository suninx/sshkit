import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client, SFTPWrapper } from "ssh2";
import type { SftpEntry, TransferProgress } from "../shared/sftp";

interface ProgressSink {
  (p: TransferProgress): void;
}

const isDirMode = (mode: number): boolean => (mode & 0o170000) === 0o040000;

type ErrBox = Error | null | undefined;

export class SftpController {
  private nextJobId = 1;

  /** 每个会话缓存一条"专用 SFTP 连接"(见 openAux 的说明) */
  private readonly aux = new Map<number, { client: Client; sftp: SFTPWrapper }>();

  constructor(
    private readonly clientOf: (sessionId: number) => Client | undefined,
    private readonly sink: ProgressSink,
    /* 需要时给某会话开一条专用连接(由 main 注入:它才知道该会话的主机与凭据) */
    private readonly connectAux?: (sessionId: number) => Promise<Client | null>,
  ) {}

  async sftp(sid: number): Promise<SFTPWrapper> {
    const cached = this.aux.get(sid);
    if (cached) return cached.sftp;
    const client = this.clientOf(sid);
    if (!client) throw new Error("no active ssh session");
    try {
      return await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err: ErrBox, s: SFTPWrapper) => (err ? reject(err) : resolve(s)));
      });
    } catch (first) {
      /* 交互会话上开不出 sftp 通道时,改用一条专用连接再试(见 SshService.openAux)。 */
      if (!this.connectAux) throw first;
      const aux = await this.connectAux(sid);
      if (!aux) throw first;
      try {
        const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
          aux.sftp((err: ErrBox, s: SFTPWrapper) => (err ? reject(err) : resolve(s)));
        });
        this.aux.set(sid, { client: aux, sftp });
        aux.once("close", () => this.aux.delete(sid));
        return sftp;
      } catch (second) {
        try { aux.end(); } catch { /* ignore */ }
        throw second;
      }
    }
  }

  private cb<T>(resolve: (v: T) => void, reject: (e: Error) => void) {
    return (e: ErrBox, v: T) => (e ? reject(e) : resolve(v));
  }

  /* ---------- listings (both sides, same shape) ---------- */

  async listRemote(sid: number, dir: string): Promise<{ path: string; entries: SftpEntry[] }> {
    const sftp = await this.sftp(sid);
    const [realPath, list] = await Promise.all([
      new Promise<string>((resolve, reject) => sftp.realpath(dir, this.cb(resolve, reject))),
      new Promise<Array<{ filename: string; attrs: { size: number; mtime: number; mode: number } }>>(
        (resolve, reject) => sftp.readdir(dir, this.cb(resolve, reject)),
      ),
    ]);
    return {
      path: realPath,
      entries: list.map((it) => ({
        name: it.filename,
        size: it.attrs.size,
        isDir: isDirMode(it.attrs.mode),
        mtime: it.attrs.mtime,
        mode: it.attrs.mode,
      })),
    };
  }

  async listLocal(dir: string): Promise<{ path: string; entries: SftpEntry[] }> {
    const cwd = dir.replace(/^~(?=\/|$)/, os.homedir());
    const dtos = await fsp.readdir(cwd, { withFileTypes: true });
    const entries: SftpEntry[] = [];
    for (const d of dtos) {
      try {
        const st = await fsp.stat(path.join(cwd, d.name));
        entries.push({ name: d.name, size: st.size, isDir: d.isDirectory(),
          mtime: Math.floor(st.mtimeMs / 1000), mode: st.mode });
      } catch { continue; }
    }
    return { path: cwd, entries };
  }

  /* ---------- chore ops ---------- */

  async mkdirRemote(sid: number, dir: string): Promise<void> {
    const sftp = await this.sftp(sid);
    await new Promise<void>((resolve, reject) => sftp.mkdir(dir, this.cb(resolve, reject)));
  }

  async removeRemote(sid: number, target: string): Promise<void> {
    const sftp = await this.sftp(sid);
    const st = await new Promise<{ isDirectory: boolean }>((resolve, reject) =>
      sftp.stat(target, (e: ErrBox, a: { mode: number }) => (e ? reject(e) : resolve({ isDirectory: isDirMode(a.mode) }))));
    await new Promise<void>((resolve, reject) => {
      const done = (e: ErrBox) => (e ? reject(e) : resolve());
      if (st.isDirectory) sftp.rmdir(target, done); else sftp.unlink(target, done);
    });
  }

  async renameRemote(sid: number, from: string, to: string): Promise<void> {
    const sftp = await this.sftp(sid);
    await new Promise<void>((resolve, reject) => sftp.rename(from, to, this.cb(resolve, reject)));
  }

  async mkdirLocal(dir: string): Promise<void> { await fsp.mkdir(dir); }

  async removeLocal(target: string): Promise<void> {
    const st = await fsp.stat(target);
    if (st.isDirectory()) { await fsp.rmdir(target); return; }
    await fsp.unlink(target);
  }

  async renameLocal(from: string, to: string): Promise<void> { await fsp.rename(from, to); }

  /* ---------- transfers (single file, fastPut/fastGet) ---------- */

  async upload(sid: number, localPath: string, remotePath: string): Promise<number> {
    const sftp = await this.sftp(sid);
    const total = (await fsp.stat(localPath)).size;
    const jobId = this.nextJobId++;
    const prog = (bytes: number, state: TransferProgress["state"], error?: string) =>
      this.sink({ sid, jobId, dir: "up", file: path.basename(remotePath), bytes, total, state, error });
    prog(0, "active");
    try {
      await new Promise<void>((resolve, reject) =>
        sftp.fastPut(localPath, remotePath, {
          step: (transferred: number) => prog(transferred, "active"),
        }, (e: ErrBox) => (e ? reject(e) : resolve())),
      );
      prog(total, "done");
    } catch (err) {
      prog(total, "error", String((err as Error).message));
      throw err;
    }
    return jobId;
  }

  async download(sid: number, remotePath: string, localPath: string): Promise<number> {
    const sftp = await this.sftp(sid);
    const st = await new Promise<{ size: number; isDirectory: boolean }>((resolve, reject) =>
      sftp.stat(remotePath, (e: ErrBox, a: { size: number; mode: number }) =>
        (e ? reject(e) : resolve({ size: a.size, isDirectory: isDirMode(a.mode) }))));
    if (st.isDirectory) throw new Error("directory download is not supported yet");
    const jobId = this.nextJobId++;
    const prog = (bytes: number, state: TransferProgress["state"], error?: string) =>
      this.sink({ sid, jobId, dir: "down", file: path.basename(remotePath), bytes, total: st.size, state, error });
    prog(0, "active");
    try {
      await new Promise<void>((resolve, reject) =>
        sftp.fastGet(remotePath, localPath, {
          step: (transferred: number) => prog(transferred, "active"),
        }, (e: ErrBox) => (e ? reject(e) : resolve())),
      );
      prog(st.size, "done");
    } catch (err) {
      prog(st.size, "error", String((err as Error).message));
      throw err;
    }
    return jobId;
  }
}
