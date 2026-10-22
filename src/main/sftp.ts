import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client, SFTPWrapper } from "ssh2";
import type { ConflictPolicy, SftpEntry, TransferProgress, TreeProgress, TreeResult } from "../shared/sftp";

interface ProgressSink {
  (p: TransferProgress): void;
}

const isDirMode = (mode: number): boolean => (mode & 0o170000) === 0o040000;

type ErrBox = Error | null | undefined;

/** `readdir` 的最小形状(测试注入假 dirent 用) */
export type LocalReader = (dir: string) => Promise<Array<{
  name: string; isDirectory(): boolean; isFile(): boolean }>>;

/** 目录遍历的并发波次:每波同时读 N 个目录,避免上千文件时一层层串行等 RTT */
const WALK_CONCURRENCY = 4;

/** 本地目录清单(相对路径 + 大小 + 是否目录)。
 *  符号链接等"既非文件也非目录"的项**跳过并计数**(远端无法安全跟随,且可能成环);
 *  reader 可注入 —— Windows 非管理员建不了符号链接,靠假 dirent 也能覆盖这条分支。 */
export async function walkLocalTree(
  root: string,
  reader: LocalReader = (dir) => fsp.readdir(dir, { withFileTypes: true }) as unknown as ReturnType<LocalReader>,
  statSize: (p: string) => Promise<number> = async (p) => (await fsp.stat(p)).size,
  join: (a: string, b: string) => string = path.join,
): Promise<{ entries: Array<{ rel: string; size: number; isDir: boolean }>; skipped: number }> {
  const entries: Array<{ rel: string; size: number; isDir: boolean }> = [];
  let skipped = 0;
  let frontier: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];
  while (frontier.length > 0) {
    const wave = frontier.splice(0, WALK_CONCURRENCY);
    const lists = await Promise.all(wave.map(async (d) => ({ d, list: await reader(d.abs) })));
    for (const { d, list } of lists) {
      for (const e of list) {
        const childAbs = join(d.abs, e.name);
        const childRel = d.rel ? `${d.rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          entries.push({ rel: childRel, size: 0, isDir: true });
          frontier.push({ abs: childAbs, rel: childRel });
        } else if (e.isFile()) {
          entries.push({ rel: childRel, size: await statSize(childAbs), isDir: false });
        } else {
          skipped += 1;
        }
      }
    }
  }
  return { entries, skipped };
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

  /** 远端目录清单(相对路径)。同样按波次并发读目录。 */
  private async walkRemoteTree(sftp: SFTPWrapper, root: string): Promise<{ entries: Array<{ rel: string; size: number; isDir: boolean }>; skipped: number }> {
    const entries: Array<{ rel: string; size: number; isDir: boolean }> = [];
    let skipped = 0;
    let frontier: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];
    while (frontier.length > 0) {
      const wave = frontier.splice(0, WALK_CONCURRENCY);
      const lists = await Promise.all(wave.map(async (d) => ({ d, list: await this.readdirRemote(sftp, d.abs) })));
      for (const { d, list } of lists) {
        for (const e of list) {
          const childRel = d.rel ? `${d.rel}/${e.filename}` : e.filename;
          const childAbs = `${d.abs.replace(/\/$/, "")}/${e.filename}`;
          const mode = e.attrs.mode;
          /* 必须整体比较类型位:位与写法会把符号链接(0o120000)误判成普通文件(0o100000) */
          const kind = mode & 0o170000;
          if (kind === 0o040000) {
            entries.push({ rel: childRel, size: 0, isDir: true });
            frontier.push({ abs: childAbs, rel: childRel });
          } else if (kind === 0o100000 || kind === 0) {
            entries.push({ rel: childRel, size: e.attrs.size, isDir: false });
          } else {
            skipped += 1;   /* 远端符号链接 / 设备文件:不跟 */
          }
        }
      }
    }
    return { entries, skipped };
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

  /** 目标已存在时按策略决定写到哪;返回 null 表示"跳过这个文件" */
  private async resolveTarget(target: string, policy: ConflictPolicy,
                               exists: (p: string) => Promise<boolean>): Promise<string | null> {
    if (!(await exists(target))) return target;
    if (policy === "skip") return null;
    if (policy === "overwrite") return target;
    /* rename:给名字加序号,保留扩展名 */
    const slash = target.lastIndexOf("/");
    const dot = target.lastIndexOf(".");
    const hasExt = dot > slash;
    const base = hasExt ? target.slice(0, dot) : target;
    const ext = hasExt ? target.slice(dot) : "";
    for (let i = 1; i < 100; i += 1) {
      const cand = `${base} (${i})${ext}`;
      if (!(await exists(cand))) return cand;
    }
    throw new Error("too many conflicting files");
  }

  /** 上传单个文件:先写 `目标.part`,成功后 rename 成目标 —— 中断时留下的是 .part,
   *  下次从它的长度续传,不会把半截文件当成完整文件。 */
  private async uploadOne(sftp: SFTPWrapper, localPath: string, target: string,
                          onBytes: (n: number) => void, cancelled: () => boolean): Promise<number> {
    const total = (await fsp.stat(localPath)).size;
    const part = `${target}.part`;
    let offset = 0;
    try { offset = (await this.statRemote(sftp, part)).size; } catch { offset = 0; }
    if (offset > total) offset = 0;
    if (offset < total) {
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(localPath, { start: offset });
        const ws = sftp.createWriteStream(part, { flags: offset > 0 ? "a" : "w" });
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
    }
    if (cancelled()) return offset;
    /* 完成:覆盖目标(远端 rename 在部分服务端不覆盖已存在文件,先删) */
    try {
      await new Promise<void>((resolve, reject) => sftp.unlink(target, (e: ErrBox) => (e ? reject(e) : resolve())));
    } catch { /* 目标本来不存在:不用删 */ }
    await new Promise<void>((resolve, reject) => sftp.rename(part, target, (e: ErrBox) => (e ? reject(e) : resolve())));
    onBytes(total);
    return total;
  }

  /** 下载单个文件:同样先写 `.part`,成功后 rename;支持续传。 */
  private async downloadOne(sftp: SFTPWrapper, remotePath: string, target: string,
                            onBytes: (n: number) => void, cancelled: () => boolean): Promise<number> {
    const total = (await this.statRemote(sftp, remotePath)).size;
    const part = `${target}.part`;
    let offset = 0;
    try { offset = (await fsp.stat(part)).size; } catch { offset = 0; }
    if (offset > total) offset = 0;
    if (offset < total) {
      await fsp.mkdir(path.dirname(part), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const rs = sftp.createReadStream(remotePath, { start: offset });
        const ws = fs.createWriteStream(part, { flags: offset > 0 ? "a" : "w" });
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
    }
    if (cancelled()) return offset;
    await fsp.rm(target, { force: true });
    await fsp.rename(part, target);
    onBytes(total);
    return total;
  }

  /** 递归传输一个文件或目录树(up/down);返回汇总结果。policy 决定目标已存在时怎么办。 */
  async transferTree(sid: number, dir: "up" | "down", localPath: string, remotePathRaw: string,
                     opts: { policy?: ConflictPolicy; retries?: number } = {}): Promise<TreeResult> {
    const sftp = await this.sftp(sid);
    /* 远端路径统一成绝对形式(踩过:./dst 与 dst 会写成两处) */
    const remotePath = remotePathRaw.startsWith("/") ? remotePathRaw : `/${remotePathRaw}`;
    const policy = opts.policy ?? "overwrite";
    /* 每个文件最多尝试 retries 次:网络抖动/通道瞬断时自动重试,靠 .part 从断点继续。
       注意只在"传输失败"上重试,业务错误(rename 失败等)也会重试 —— 都是可恢复的瞬时错误。 */
    const retries = Math.max(1, opts.retries ?? 3);
    const jobId = this.nextJobId++;
    const job = { cancelled: false };
    this.jobs.set(jobId, job);
    const cancelled = (): boolean => job.cancelled;

    let entries: Array<{ rel: string; size: number; isDir: boolean }>;
    let skippedEntries = 0;
    let rootIsDir = false;
    if (dir === "up") {
      const st = await fsp.stat(localPath);
      rootIsDir = st.isDirectory();
      if (rootIsDir) { const w = await walkLocalTree(localPath); entries = w.entries; skippedEntries = w.skipped; }
      else entries = [{ rel: path.basename(localPath), size: st.size, isDir: false }];
    } else {
      const st = await this.statRemote(sftp, remotePath);
      rootIsDir = st.isDir;
      if (rootIsDir) { const w = await this.walkRemoteTree(sftp, remotePath); entries = w.entries; skippedEntries = w.skipped; }
      else entries = [{ rel: path.posix.basename(remotePath), size: st.size, isDir: false }];
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

    const remoteExists = async (p: string): Promise<boolean> => {
      try { await this.statRemote(sftp, p); return true; } catch { return false; }
    };
    const localExists = async (p: string): Promise<boolean> => {
      try { await fsp.stat(p); return true; } catch { return false; }
    };

    let done = 0;
    let skippedFiles = 0;
    let overallBytes = 0;
    try {
      let index = 0;
      for (const f of files) {
        if (cancelled()) break;
        index += 1;
        const srcPath = dir === "up" ? (rootIsDir ? path.join(localPath, f.rel) : localPath)
          : (rootIsDir ? `${remotePath}/${f.rel}` : remotePath);
        const wanted = dir === "up" ? (rootIsDir ? `${remotePath}/${f.rel}` : remotePath)
          : (rootIsDir ? path.join(localPath, f.rel) : localPath);
        const target = await this.resolveTarget(wanted, policy, dir === "up" ? remoteExists : localExists);
        if (target === null) { skippedFiles += 1; emit(index, f.rel, 0, f.size, overallBytes, "skipped"); continue; }
        const base = overallBytes;
        const onBytes = (n: number): void => emit(index, f.rel, n, f.size, base + n, "active");
        emit(index, f.rel, 0, f.size, base, "active");
        try {
          let moved = 0;
          for (let attempt = 1; ; attempt += 1) {
            try {
              moved = dir === "up"
                ? await this.uploadOne(sftp, srcPath, target, onBytes, cancelled)
                : await this.downloadOne(sftp, srcPath, target, onBytes, cancelled);
              break;
            } catch (err) {
              if (attempt >= retries || cancelled()) throw err;
            }
          }
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
    return { jobId, files: done, skippedFiles, skippedEntries, bytes: overallBytes, cancelled: job.cancelled };
  }
}
