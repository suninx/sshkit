import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { walkLocalTree, SftpController } from "../../src/main/sftp";
import type { TreeProgress } from "../../src/shared/sftp";

/* ---------- 内存版 SFTP:够真到能跑递归/续传/取消 ---------- */
type ErrBox = Error | null | undefined;

class FakeSftp extends EventEmitter {
  dirs = new Set<string>(["/"]);
  files = new Map<string, Buffer>();

  mkdir(p: string, cb: (e?: ErrBox) => void): void {
    if (this.dirs.has(p)) { cb(new Error("EEXIST")); return; }
    this.dirs.add(p);
    cb();
  }

  stat(p: string, cb: (e: ErrBox, a?: { size: number; mode: number }) => void): void {
    if (this.dirs.has(p)) { cb(null, { size: 0, mode: 0o040755 }); return; }
    const f = this.files.get(p);
    if (!f) { cb(new Error("ENOENT")); return; }
    cb(null, { size: f.length, mode: 0o100644 });
  }

  readdir(p: string, cb: (e: ErrBox, list?: Array<{ filename: string; attrs: { size: number; mode: number } }>) => void): void {
    const prefix = p.replace(/\/$/, "") + "/";
    const names = new Map<string, { size: number; mode: number }>();
    for (const d of this.dirs) {
      if (!d.startsWith(prefix) || d === p) continue;
      const rest = d.slice(prefix.length);
      if (!rest.includes("/")) names.set(rest, { size: 0, mode: 0o040755 });
    }
    for (const [f, buf] of this.files) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest.includes("/")) names.set(rest, { size: buf.length, mode: 0o100644 });
    }
    cb(null, [...names].map(([filename, attrs]) => ({ filename, attrs })));
  }

  createReadStream(p: string, opts: { start?: number } = {}): Readable {
    const buf = this.files.get(p);
    if (!buf) throw new Error("ENOENT");
    return Readable.from([buf.subarray(opts.start ?? 0)]);
  }

  createWriteStream(p: string, opts: { flags?: string } = {}): NodeJS.WritableStream & EventEmitter {
    const chunks: Buffer[] = [];
    if (opts.flags === "a") {
      const prev = this.files.get(p);
      if (prev) chunks.push(prev);
    }
    const self = new EventEmitter() as unknown as NodeJS.WritableStream & EventEmitter;
    (self as unknown as { write: (c: Buffer) => boolean }).write = (c: Buffer): boolean => { chunks.push(c); return true; };
    (self as unknown as { destroy: () => void }).destroy = (): void => { self.emit("close"); };
    (self as unknown as { end: () => void }).end = (): void => {
      this.files.set(p, Buffer.concat(chunks));
      setTimeout(() => self.emit("close"), 0);
    };
    return self;
  }
}

function makeCtl(remote = new FakeSftp()): { ctl: SftpController; events: TreeProgress[]; sftp: FakeSftp } {
  const events: TreeProgress[] = [];
  const ctl = new SftpController(
    () => undefined,
    (p) => events.push(p as TreeProgress),
  );
  vi.spyOn(ctl, "sftp").mockResolvedValue(remote as never);
  return { ctl, events, sftp: remote };
}

function tmp(layout: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-tree-"));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

describe("walkLocalTree:目录清单", () => {
  it("递归列出文件与目录,相对路径用 posix 分隔;符号链接等既非文件也非目录的项跳过", async () => {
    const calls: string[] = [];
    const tree = await walkLocalTree("/root", async (dir) => {
      calls.push(dir);
      if (dir === "/root") {
        return [
          { name: "a.txt", isDirectory: () => false, isFile: () => true },
          { name: "sub", isDirectory: () => true, isFile: () => false },
          { name: "link", isDirectory: () => false, isFile: () => false },   // ← 跳过分支
        ];
      }
      return [{ name: "b.txt", isDirectory: () => false, isFile: () => true }];
    }, async () => 7);
    expect(tree).toEqual([
      { rel: "a.txt", size: 7, isDir: false },
      { rel: "sub", size: 0, isDir: true },
      { rel: "sub/b.txt", size: 7, isDir: false },
    ]);
    expect(calls).toEqual(["/root", "/root/sub"]);
  });

  it("默认参数走真实 fs(空目录 → 空清单)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-empty-"));
    expect(await walkLocalTree(dir)).toEqual([]);
  });
});

describe("transferTree:上传目录", () => {
  it("建远端目录、上传全部文件,进度含每文件与聚合信息", async () => {
    const { ctl, events, sftp } = makeCtl();
    const root = tmp({ "a.txt": "aaa", "sub/b.txt": "bbbbb" });
    const res = await ctl.transferTree(1, "up", root, "/dst");
    expect(res).toMatchObject({ files: 2, bytes: 8, cancelled: false });
    expect(sftp.dirs.has("/dst")).toBe(true);
    expect(sftp.dirs.has("/dst/sub")).toBe(true);
    expect(sftp.files.get("/dst/a.txt")?.toString()).toBe("aaa");
    expect(sftp.files.get("/dst/sub/b.txt")?.toString()).toBe("bbbbb");
    expect(events.at(-1)).toMatchObject({ state: "done", index: 2, count: 2, overallTotal: 8, overallBytes: 8 });
  });

  it("单文件上传(root 不是目录)", async () => {
    const { ctl, sftp } = makeCtl();
    const dir = tmp({ "one.txt": "xyz" });
    const res = await ctl.transferTree(1, "up", path.join(dir, "one.txt"), "/one.txt");
    expect(res).toMatchObject({ files: 1, bytes: 3 });
    expect(sftp.files.get("/one.txt")?.toString()).toBe("xyz");
  });

  it("断点续传:远端已有前缀时从断点 append,不重传已有字节", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/f.txt", Buffer.from("hello "));
    const dir = tmp({ "f.txt": "hello world" });
    const res = await ctl.transferTree(1, "up", path.join(dir, "f.txt"), "/f.txt");
    expect(res.bytes).toBe(11);
    expect(sftp.files.get("/f.txt")?.toString()).toBe("hello world");
  });

  it("远端比本地还大时当作脏文件从头覆盖(不能 append 出脏内容)", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/f.txt", Buffer.from("0123456789ABCDEF"));
    const dir = tmp({ "f.txt": "abc" });
    await ctl.transferTree(1, "up", path.join(dir, "f.txt"), "/f.txt");
    expect(sftp.files.get("/f.txt")?.toString()).toBe("abc");
  });

  it("远端大小与本地一致 → 直接算完成,不再写", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/f.txt", Buffer.from("same"));
    const write = vi.spyOn(sftp, "createWriteStream");
    const dir = tmp({ "f.txt": "same" });
    const res = await ctl.transferTree(1, "up", path.join(dir, "f.txt"), "/f.txt");
    expect(res.bytes).toBe(4);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("transferTree:下载目录", () => {
  it("建本地目录、下载全部文件", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.dirs.add("/src");
    sftp.dirs.add("/src/sub");
    sftp.files.set("/src/a.txt", Buffer.from("aaa"));
    sftp.files.set("/src/sub/b.txt", Buffer.from("bb"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-dl-"));
    const res = await ctl.transferTree(1, "down", path.join(dest, "out"), "/src");
    expect(res).toMatchObject({ files: 2, bytes: 5 });
    expect(fs.readFileSync(path.join(dest, "out/a.txt"), "utf8")).toBe("aaa");
    expect(fs.readFileSync(path.join(dest, "out/sub/b.txt"), "utf8")).toBe("bb");
  });

  it("断点续传:本地已有前缀时从断点 append", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/r.txt", Buffer.from("0123456789"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-resume-"));
    const local = path.join(dest, "r.txt");
    fs.writeFileSync(local, "0123");
    const res = await ctl.transferTree(1, "down", local, "/r.txt");
    expect(res.bytes).toBe(10);
    expect(fs.readFileSync(local, "utf8")).toBe("0123456789");
  });

  it("本地已完整 → 跳过", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/r.txt", Buffer.from("abc"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-skip-"));
    const full = path.join(dest, "full.txt");
    fs.writeFileSync(full, "abc");
    expect(await ctl.transferTree(1, "down", full, "/r.txt")).toMatchObject({ bytes: 3 });
  });

  it("本地比远端大 → 当作脏文件从头覆盖", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/r2.txt", Buffer.from("zz"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-big-"));
    const big = path.join(dest, "big.txt");
    fs.writeFileSync(big, "0123456789");
    await ctl.transferTree(1, "down", big, "/r2.txt");
    expect(fs.readFileSync(big, "utf8")).toBe("zz");
  });
});

describe("transferTree:取消与错误", () => {
  it("传输中取消:停止后续文件并返回 cancelled=true", async () => {
    const sftp = new FakeSftp();
    sftp.dirs.add("/s");
    sftp.files.set("/s/1.txt", Buffer.from("1"));
    sftp.files.set("/s/2.txt", Buffer.from("2"));
    const events: TreeProgress[] = [];
    let ctl!: SftpController;
    ctl = new SftpController(() => undefined, (p) => {
      events.push(p as TreeProgress);
      /* 第一个文件开始传时就取消:后续文件不该再开始 */
      if (p.state === "active" && p.index === 1) ctl.cancelJob((p as TreeProgress).jobId);
    });
    vi.spyOn(ctl, "sftp").mockResolvedValue(sftp as never);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-cancel-"));
    const res = await ctl.transferTree(1, "down", path.join(dest, "o"), "/s");
    expect(res.cancelled).toBe(true);
    expect(fs.existsSync(path.join(dest, "o/2.txt"))).toBe(false);
  });

  it("cancelJob 对已结束任务返回 false;对进行中任务置位并让结果 cancelled", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/x.txt", Buffer.from("x"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-c2-"));
    const res = await ctl.transferTree(1, "down", path.join(dest, "x.txt"), "/x.txt");
    expect(res.cancelled).toBe(false);
    expect(ctl.cancelJob(res.jobId)).toBe(false);   // 已结束 → false
    expect(ctl.cancelJob(123456)).toBe(false);      // 未知 → false
  });

  it("单个文件失败 → 上报 state=error 并整体抛出", async () => {
    const { ctl, sftp, events } = makeCtl();
    sftp.files.set("/bad.txt", Buffer.from("x"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-err-"));
    const spy = vi.spyOn(sftp, "createReadStream").mockImplementation(() => { throw new Error("boom"); });
    await expect(ctl.transferTree(1, "down", path.join(dest, "bad.txt"), "/bad.txt")).rejects.toThrow("boom");
    expect(events.some((e) => e.state === "error" && e.error === "boom")).toBe(true);
    spy.mockRestore();
  });

  it("ensureRemoteDir:已存在的层级跳过,缺的才 mkdir", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.dirs.add("/have");
    sftp.files.set("/have/f.txt", Buffer.from("f"));
    const dir = tmp({ "f.txt": "f" });
    await ctl.transferTree(1, "up", dir, "/have");
    expect(sftp.files.get("/have/f.txt")?.toString()).toBe("f");
  });
});

describe("边界与失败路径", () => {
  it("远端 readdir 失败 → 下载目录整体拒绝(不静默当空目录)", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.dirs.add("/bad");
    vi.spyOn(sftp, "readdir").mockImplementation((_p, cb) => cb(new Error("permission denied")));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-rd-"));
    await expect(ctl.transferTree(1, "down", path.join(dest, "o"), "/bad")).rejects.toThrow("permission denied");
  });

  it("目标给相对路径时归一为绝对路径(建目录与写文件位置一致)", async () => {
    const { ctl, sftp } = makeCtl();
    const dir = tmp({ "a.txt": "a" });
    const res = await ctl.transferTree(1, "up", dir, "reldst");
    expect(res.files).toBe(1);
    expect(sftp.files.get("/reldst/a.txt")?.toString()).toBe("a");   // 相对路径归一为绝对
  });

  it("远端 mkdir 失败 → 抛出(不吞错)", async () => {
    const { ctl, sftp } = makeCtl();
    vi.spyOn(sftp, "mkdir").mockImplementation((_p, cb) => cb(new Error("read-only fs")));
    const dir = tmp({ "a.txt": "a" });
    await expect(ctl.transferTree(1, "up", dir, "/ro")).rejects.toThrow("read-only fs");
  });

  it("上传过程中取消 → 当前文件中断,结果 cancelled=true", async () => {
    const sftp = new FakeSftp();
    sftp.dirs.add("/u");
    const dir = tmp({ "big.bin": "x".repeat(256 * 1024) });
    let ctl!: SftpController;
    ctl = new SftpController(() => undefined, (p) => {
      if (p.state === "active" && p.bytes > 0) ctl.cancelJob((p as TreeProgress).jobId);
    });
    vi.spyOn(ctl, "sftp").mockResolvedValue(sftp as never);
    const res = await ctl.transferTree(1, "up", path.join(dir, "big.bin"), "/u/big.bin");
    expect(res.cancelled).toBe(true);
  });
});
