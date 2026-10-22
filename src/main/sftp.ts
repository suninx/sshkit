import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client, SFTPWrapper } from "ssh2";
import type { SftpEntry, TransferProgress, TreeProgress, TreeResult } from "../shared/sftp";

interface ProgressSink {
  (p: TransferProgress): void;
}

const isDirMode = (mode: number): boolean => (mode & 0o170000) === 0o040000;

type ErrBox = Error | null | undefined;

/** `readdir` 的最小形状(测试注入假 dirent 用) */
export type LocalReader = (dir: string) => Promise<Array<{
  name: string; isDirectory(): boolean; isFile(): boolean }>>;

/** 本地目录清单(相对路径 + 大小 + 是否目录)。符号链接等"既非文件也非目录"的项**跳过**:
 *  远端无法安全跟随,且可能成环。reader 可注入,便于在无符号链接权限的平台(Windows 非管理员)
 *  也能覆盖这条分支。 */
export async function walkLocalTree(
  root: string,
  reader: LocalReader = (dir) => fsp.readdir(dir, { withFileTypes: true }) as unknown as ReturnType<LocalReader>,
  statSize: (p: string) => Promise<number> = async (p) => (await fsp.stat(p)).size,
  join: (a: string, b: string) => string = path.join,
): Promise<Array<{ rel: string; size: number; isDir: boolean }>> {
  const out: Array<{ rel: string; size: number; isDir: boolean }> = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const e of await reader(abs)) {
      const childAbs = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push({ rel: childRel, size: 0, isDir: true }); await walk(childAbs, childRel); }
      else if (e.isFile()) out.push({ rel: childRel, size: await statSize(childAbs), isDir: false });
    }
  };
  await walk(root, "");
  return out;
}

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

  /* ================= 树(目录)传输:递归 / 断点续传 / 可取消 =================
     与上面的单文件 fastPut/fastGet 并存:单文件走 fast* 更快,目录树走流式(能算进度、
     能按已传字节续传)。取消是"文件粒度"的:正在传的那个文件会停下并保留部分内容,
     下次重传从断点继续。 */

  private readonly jobs = new Map<number, { cancelled: boolean }>();

  /** 取消一个树任务;返回是否命中(已结束的任务返回 false) */
  cancelJob(jobId: number): boolean {
    const j = this.jobs.get(jobId);
    if (!j) return false;
    j.cancelled = true;
    return true;
  }

  private readdirRemote(sftp: SFTPWrapper, dir: string): Promise<Array<{ filename: string; attrs: { size: number; mode: number } }>> {
    return new Promise((resolve, reject) => sftp.readdir(dir, (e: ErrBox, list) =>
      (e ? reject(e) : resolve(list as Array<{ filename: string; attrs: { size: number; mode: number } }>))));
  }

  private statRemote(sftp: SFTPWrapper, target: string): Promise<{ size: number; isDir: boolean }> {
    return new Promise((resolve, reject) => sftp.stat(target, (e: ErrBox, a: { size: number; mode: number }) =>
      (e ? reject(e) : resolve({ size: a.size, isDir: isDirMode(a.mode) }))));
  }

  /** 远端目录清单(相对路径) */
  private async walkRemoteTree(sftp: SFTPWrapper, root: string): Promise<Array<{ rel: string; size: number; isDir: boolean }>> {
    const out: Array<{ rel: string; size: number; isDir: boolean }> = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      for (const e of await this.readdirRemote(sftp, abs)) {
        const childRel = rel ? `${rel}/${e.filename}` : e.filename;
        const childAbs = `${abs.replace(/\/$/, "")}/${e.filename}`;
        if (isDirMode(e.attrs.mode)) { out.push({ rel: childRel, size: 0, isDir: true }); await walk(childAbs, childRel); }
        else out.push({ rel: childRel, size: e.attrs.size, isDir: false });
      }
    };
    await walk(root, "");
    return out;
  }

  /** 逐级建远端目录;已存在则跳过(不依赖 mkdir -p,SFTP 没有这个语义)。
     入参由 transferTree 归一为绝对路径,所以这里不需要相对/绝对分支。 */
  private async ensureRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
    let cur = "";
    for (const seg of dir.split("/").filter(Boolean)) {
      cur += `/${seg}`;
      try { await this.statRemote(sftp, cur); }
      catch { await new Promise<void>((resolve, reject) => sftp.mkdir(cur, (e: ErrBox) => (e ? reject(e) : resolve()))); }
    }
  }

  /** 上传单文件,支持断点续传:远端已有部分内容时从断点 append */
  private async uploadResume(sftp: SFTPWrapper, localPath: string, remotePath: string,
                             onBytes: (n: number) => void, cancelled: () => boolean): Promise<number> {
    const total = (await fsp.stat(localPath)).size;
    let offset = 0;
    try { offset = (await this.statRemote(sftp, remotePath)).size; } catch { offset = 0; }
    if (offset > total) offset = 0;          /* 远端比本地还大 → 视为脏文件,从头来 */
    if (offset === total) { onBytes(total); return total; }
    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(localPath, { start: offset });
      /* 断点续传才 append;从头来(offset=0,例如远端是脏文件)必须覆盖,否则拼出脏内容 */
      const ws = sftp.createWriteStream(remotePath, { flags: offset > 0 ? "a" : "w" });
      let sent = offset;
      rs.on("data", (c: Buffer) => {
        sent += c.length;
        onBytes(sent);
        if (cancelled()) { rs.destroy(); ws.destroy(); }
      });
      rs.on("error", reject);
      ws.on("error", reject);
      ws.on("close", () => resolve());
      rs.pipe(ws);
    });
    return total;
  }

  /** 下载单文件,支持断点续传:本地已有部分内容时从断点 append */
  private async downloadResume(sftp: SFTPWrapper, remotePath: string, localPath: string,
                               onBytes: (n: number) => void, cancelled: () => boolean): Promise<number> {
    const total = (await this.statRemote(sftp, remotePath)).size;
    let offset = 0;
    try { offset = (await fsp.stat(localPath)).size; } catch { offset = 0; }
    if (offset > total) offset = 0;
    if (offset === total) { onBytes(total); return total; }
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const rs = sftp.createReadStream(remotePath, { start: offset });
      const ws = fs.createWriteStream(localPath, { flags: offset > 0 ? "a" : "w" });
      let got = offset;
      rs.on("data", (c: Buffer) => {
        got += c.length;
        onBytes(got);
        if (cancelled()) { rs.destroy(); ws.destroy(); }
      });
      rs.on("error", reject);
      ws.on("error", reject);
      ws.on("close", () => resolve());
      rs.pipe(ws);
    });
    return total;
  }

  /** 递归传输一个文件或目录树(up/down),返回汇总结果 */
  async transferTree(sid: number, dir: "up" | "down", localPath: string, remotePathRaw: string): Promise<TreeResult> {
    const sftp = await this.sftp(sid);
    /* 远端路径统一成绝对形式:listRemote 返回的都是绝对路径,若调用方给了相对路径就补上 "/",
       否则"建目录"与"写文件"会用两种形式表示同一位置(踩过:./reldst vs reldst)。 */
    const remotePath = remotePathRaw.startsWith("/") ? remotePathRaw : `/${remotePathRaw}`;
    const jobId = this.nextJobId++;
    const job = { cancelled: false };
    this.jobs.set(jobId, job);
    const cancelled = (): boolean => job.cancelled;

    /* 源是文件还是目录 */
    let entries: Array<{ rel: string; size: number; isDir: boolean }>;
    let rootIsDir = false;
    if (dir === "up") {
      const st = await fsp.stat(localPath);
      rootIsDir = st.isDirectory();
      entries = rootIsDir ? await walkLocalTree(localPath) : [{ rel: path.basename(localPath), size: st.size, isDir: false }];
    } else {
      const st = await this.statRemote(sftp, remotePath);
      rootIsDir = st.isDir;
      entries = rootIsDir ? await this.walkRemoteTree(sftp, remotePath) : [{ rel: path.posix.basename(remotePath), size: st.size, isDir: false }];
    }

    const files = entries.filter((e) => !e.isDir);
    const dirs = entries.filter((e) => e.isDir);
    const overallTotal = files.reduce((n, f) => n + f.size, 0);

    const emit = (index: number, relPath: string, bytes: number, total: number,
                  overallBytes: number, state: TransferProgress["state"], error?: string): void => {
      const p: TreeProgress = { sid, jobId, dir,
        file: relPath.slice(relPath.lastIndexOf("/") + 1), bytes, total,
        state, error, relPath, index, count: files.length, overallBytes, overallTotal };
      this.sink(p);
    };

    /* 目标根:目录时先建(up 建远端 / down 建本地) */
    if (rootIsDir) {
      if (dir === "up") await this.ensureRemoteDir(sftp, remotePath);
      else await fsp.mkdir(localPath, { recursive: true });
      for (const d of dirs) {
        if (dir === "up") await this.ensureRemoteDir(sftp, `${remotePath}/${d.rel}`);
        else await fsp.mkdir(path.join(localPath, d.rel), { recursive: true });
      }
    }

    let done = 0;
    let overallBytes = 0;
    try {
      let index = 0;
      for (const f of files) {
        if (cancelled()) break;
        index += 1;
        const base = overallBytes;
        const onBytes = (n: number): void => emit(index, f.rel, n, f.size, base + n, "active");
        emit(index, f.rel, 0, f.size, base, "active");
        try {
          const moved = dir === "up"
            ? await this.uploadResume(sftp, localPath.endsWith("/") || rootIsDir ? path.join(localPath, f.rel) : localPath,
                                      rootIsDir ? `${remotePath}/${f.rel}` : remotePath, onBytes, cancelled)
            : await this.downloadResume(sftp, rootIsDir ? `${remotePath}/${f.rel}` : remotePath,
                                        rootIsDir ? path.join(localPath, f.rel) : localPath, onBytes, cancelled);
          overallBytes = base + moved;
          done += 1;
          emit(index, f.rel, moved, f.size, overallBytes, cancelled() ? "cancelled" : "done");
        } catch (err) {
          emit(index, f.rel, 0, f.size, overallBytes, "error", String((err as Error).message));
          throw err;
        }
      }
    } finally {
      this.jobs.delete(jobId);
    }
    return { jobId, files: done, bytes: overallBytes, cancelled: job.cancelled };
  }
}
