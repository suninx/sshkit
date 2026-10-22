import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { walkLocalTree, SftpController } from "../../src/main/sftp";
import type { TreeProgress } from "../../src/shared/sftp";

type ErrBox = Error | null | undefined;

/* 内存版 SFTP:够真到能跑递归 / 续传 / 冲突 / 取消 */
class FakeSftp extends EventEmitter {
  dirs = new Set<string>(["/"]);
  files = new Map<string, Buffer>();
  symlinks = new Set<string>();

  mkdir(p: string, cb: (e?: ErrBox) => void): void {
    if (this.dirs.has(p)) { cb(new Error("EEXIST")); return; }
    this.dirs.add(p);
    cb();
  }

  stat(p: string, cb: (e: ErrBox, a?: { size: number; mode: number }) => void): void {
    if (this.dirs.has(p)) { cb(null, { size: 0, mode: 0o040755 }); return; }
    const f = this.files.get(p);
    if (!f) { cb(new Error("ENOENT")); return; }
    cb(null, { size: f.length, mode: this.symlinks.has(p) ? 0o120777 : 0o100644 });
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
      if (!rest.includes("/")) names.set(rest, { size: buf.length, mode: this.symlinks.has(f) ? 0o120777 : 0o100644 });
    }
    cb(null, [...names].map(([filename, attrs]) => ({ filename, attrs })));
  }

  unlink(p: string, cb: (e?: ErrBox) => void): void {
    if (!this.files.has(p)) { cb(new Error("ENOENT")); return; }
    this.files.delete(p); cb();
  }

  chmod(p: string, mode: number, cb: (e?: ErrBox) => void): void {
    if (!this.files.has(p) && !this.dirs.has(p)) { cb(new Error("ENOENT")); return; }
    this.modes.set(p, mode); cb();
  }

  modes = new Map<string, number>();

  rename(from: string, to: string, cb: (e?: ErrBox) => void): void {
    const f = this.files.get(from);
    if (!f) { cb(new Error("ENOENT")); return; }
    this.files.delete(from); this.files.set(to, f); cb();
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
    const api = self as unknown as { write: (c: Buffer) => boolean; end: () => void; destroy: () => void };
    api.write = (c: Buffer): boolean => { chunks.push(c); return true; };
    api.destroy = (): void => { self.emit("close"); };
    api.end = (): void => { this.files.set(p, Buffer.concat(chunks)); setTimeout(() => self.emit("close"), 0); };
    return self;
  }
}

function makeCtl(remote = new FakeSftp()): { ctl: SftpController; events: TreeProgress[]; sftp: FakeSftp } {
  const events: TreeProgress[] = [];
  const ctl = new SftpController(() => undefined, (p) => events.push(p as TreeProgress));
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

const read = (p: string): string => fs.readFileSync(p, "utf8");

describe("walkLocalTree", () => {
  it("递归列文件/目录;符号链接等特殊项跳过并计数", async () => {
    const calls: string[] = [];
    const out = await walkLocalTree("/root", async (dir) => {
      calls.push(dir);
      if (dir === "/root") {
        return [
          { name: "a.txt", isDirectory: () => false, isFile: () => true },
          { name: "sub", isDirectory: () => true, isFile: () => false },
          { name: "link", isDirectory: () => false, isFile: () => false },
        ];
      }
      return [{ name: "b.txt", isDirectory: () => false, isFile: () => true }];
    }, async () => 7, (a, b) => `${a}/${b}`);
    expect(out.entries).toEqual([
      { rel: "a.txt", size: 7, isDir: false },
      { rel: "sub", size: 0, isDir: true },
      { rel: "sub/b.txt", size: 7, isDir: false },
    ]);
    expect(out.skipped).toBe(1);
    /* 注入 POSIX 拼接:遍历器拿到的绝对路径在 Windows 上是反斜杠,不能用 POSIX 字符串比较 */
    expect(calls).toEqual(["/root", "/root/sub"]);
  });

  it("默认参数走真实 fs(空目录)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-empty-"));
    expect(await walkLocalTree(dir)).toEqual({ entries: [], skipped: 0 });
  });
});

describe("上传", () => {
  it("目录:建远端目录、逐文件上传(.part → rename),进度含聚合信息", async () => {
    const { ctl, events, sftp } = makeCtl();
    const root = tmp({ "a.txt": "aaa", "sub/b.txt": "bbbbb" });
    const res = await ctl.transferTree(1, "up", root, "/dst");
    expect(res).toEqual({ jobId: 1, files: 2, skippedFiles: 0, skippedEntries: 0, bytes: 8, cancelled: false });
    expect(sftp.dirs.has("/dst/sub")).toBe(true);
    expect(sftp.files.get("/dst/a.txt")?.toString()).toBe("aaa");
    expect(sftp.files.get("/dst/sub/b.txt")?.toString()).toBe("bbbbb");
    expect([...sftp.files.keys()].some((k) => k.endsWith(".part"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ state: "done", index: 2, count: 2, overallTotal: 8, overallBytes: 8 });
  });

  it("单文件", async () => {
    const { ctl, sftp } = makeCtl();
    const dir = tmp({ "one.txt": "xyz" });
    const res = await ctl.transferTree(1, "up", path.join(dir, "one.txt"), "/one.txt");
    expect(res).toMatchObject({ files: 1, bytes: 3 });
    expect(sftp.files.get("/one.txt")?.toString()).toBe("xyz");
  });

  it("断点续传:远端 .part 有前缀时从断点 append", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/f.txt.part", Buffer.from("hello "));
    const dir = tmp({ "f.txt": "hello world" });
    const res = await ctl.transferTree(1, "up", path.join(dir, "f.txt"), "/f.txt");
    expect(res.bytes).toBe(11);
    expect(sftp.files.get("/f.txt")?.toString()).toBe("hello world");
  });

  it(".part 比源还大 → 当作脏文件从头来", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/f.txt.part", Buffer.from("0123456789ABCDEF"));
    const dir = tmp({ "f.txt": "abc" });
    await ctl.transferTree(1, "up", path.join(dir, "f.txt"), "/f.txt");
    expect(sftp.files.get("/f.txt")?.toString()).toBe("abc");
  });

  it(".part 已完整 → 不再传输,直接 rename", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/f.txt.part", Buffer.from("done"));
    const write = vi.spyOn(sftp, "createWriteStream");
    const dir = tmp({ "f.txt": "done" });
    const res = await ctl.transferTree(1, "up", path.join(dir, "f.txt"), "/f.txt");
    expect(res.bytes).toBe(4);
    expect(write).not.toHaveBeenCalled();
    expect(sftp.files.get("/f.txt")?.toString()).toBe("done");
  });

  it("目标已存在 + overwrite → 覆盖", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/f.txt", Buffer.from("OLD"));
    const dir = tmp({ "f.txt": "new" });
    await ctl.transferTree(1, "up", path.join(dir, "f.txt"), "/f.txt", { policy: "overwrite" });
    expect(sftp.files.get("/f.txt")?.toString()).toBe("new");
  });

  it("目标已存在 + skip → 跳过并计数", async () => {
    const { ctl, events, sftp } = makeCtl();
    sftp.files.set("/f.txt", Buffer.from("OLD"));
    const dir = tmp({ "f.txt": "new" });
    const res = await ctl.transferTree(1, "up", path.join(dir, "f.txt"), "/f.txt", { policy: "skip" });
    expect(res).toMatchObject({ files: 0, skippedFiles: 1, bytes: 0 });
    expect(sftp.files.get("/f.txt")?.toString()).toBe("OLD");
    expect(events.some((e) => e.state === "skipped")).toBe(true);
  });

  it("目标已存在 + rename → 加序号(保留扩展名;无扩展名也支持)", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/f.txt", Buffer.from("1"));
    sftp.files.set("/f (1).txt", Buffer.from("2"));
    sftp.files.set("/Makefile", Buffer.from("m"));
    sftp.files.set("/Makefile (1)", Buffer.from("m1"));
    const dir = tmp({ "f.txt": "new", "Makefile": "mm" });
    await ctl.transferTree(1, "up", path.join(dir, "f.txt"), "/f.txt", { policy: "rename" });
    await ctl.transferTree(1, "up", path.join(dir, "Makefile"), "/Makefile", { policy: "rename" });
    expect(sftp.files.get("/f (2).txt")?.toString()).toBe("new");
    expect(sftp.files.get("/Makefile (2)")?.toString()).toBe("mm");
  });

  it("rename 撞满 99 个 → 抛错(不无限循环)", async () => {
    const { ctl, sftp } = makeCtl();
    const exists = new Set<string>(["/x.txt"]);
    for (let i = 1; i < 100; i += 1) exists.add(`/x (${i}).txt`);
    vi.spyOn(sftp, "stat").mockImplementation((p: string, cb: (e: ErrBox, a?: { size: number; mode: number }) => void) =>
      (exists.has(p) ? cb(null, { size: 1, mode: 0o100644 }) : cb(new Error("ENOENT"))));
    const dir = tmp({ "x.txt": "z" });
    await expect(ctl.transferTree(1, "up", path.join(dir, "x.txt"), "/x.txt", { policy: "rename" }))
      .rejects.toThrow("too many conflicting files");
  });
});

describe("下载", () => {
  it("目录:建本地目录、逐文件下载", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.dirs.add("/src");
    sftp.dirs.add("/src/sub");
    sftp.files.set("/src/a.txt", Buffer.from("aaa"));
    sftp.files.set("/src/sub/b.txt", Buffer.from("bb"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-dl-"));
    const res = await ctl.transferTree(1, "down", path.join(dest, "out"), "/src");
    expect(res).toMatchObject({ files: 2, bytes: 5 });
    expect(read(path.join(dest, "out/a.txt"))).toBe("aaa");
    expect(read(path.join(dest, "out/sub/b.txt"))).toBe("bb");
  });

  it("断点续传:本地 .part 有前缀时从断点 append", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/r.txt", Buffer.from("0123456789"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-resume-"));
    fs.writeFileSync(path.join(dest, "r.txt.part"), "0123");
    const res = await ctl.transferTree(1, "down", path.join(dest, "r.txt"), "/r.txt");
    expect(res.bytes).toBe(10);
    expect(read(path.join(dest, "r.txt"))).toBe("0123456789");
  });

  it(".part 已完整 → 直接 rename", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/r.txt", Buffer.from("abc"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-full-"));
    fs.writeFileSync(path.join(dest, "r.txt.part"), "abc");
    await ctl.transferTree(1, "down", path.join(dest, "r.txt"), "/r.txt");
    expect(read(path.join(dest, "r.txt"))).toBe("abc");
  });

  it("远端目录里的符号链接 → 跳过并计数", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.dirs.add("/s2");
    sftp.files.set("/s2/real.txt", Buffer.from("r"));
    sftp.files.set("/s2/link", Buffer.from("l"));
    sftp.symlinks.add("/s2/link");
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-sym-"));
    const res = await ctl.transferTree(1, "down", path.join(dest, "o"), "/s2");
    expect(res).toMatchObject({ files: 1, skippedEntries: 1 });
    expect(fs.existsSync(path.join(dest, "o/link"))).toBe(false);
  });
});

describe("边界与失败", () => {
  it("远端 readdir 失败 → 整体拒绝", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.dirs.add("/bad");
    vi.spyOn(sftp, "readdir").mockImplementation((_p: string, cb: (e: ErrBox, l?: never) => void) => cb(new Error("permission denied")));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-rd-"));
    await expect(ctl.transferTree(1, "down", path.join(dest, "o"), "/bad")).rejects.toThrow("permission denied");
  });

  it("远端相对路径归一为绝对(建目录与写文件位置一致)", async () => {
    const { ctl, sftp } = makeCtl();
    const dir = tmp({ "a.txt": "a" });
    await ctl.transferTree(1, "up", dir, "reldst");
    expect(sftp.files.get("/reldst/a.txt")?.toString()).toBe("a");
  });

  it("远端 mkdir 失败 → 抛出", async () => {
    const { ctl, sftp } = makeCtl();
    vi.spyOn(sftp, "mkdir").mockImplementation((_p: string, cb: (e?: ErrBox) => void) => cb(new Error("read-only fs")));
    const dir = tmp({ "a.txt": "a" });
    await expect(ctl.transferTree(1, "up", dir, "/ro")).rejects.toThrow("read-only fs");
  });

  it("单文件失败 → state=error 并抛出", async () => {
    const { ctl, sftp, events } = makeCtl();
    sftp.files.set("/bad.txt", Buffer.from("x"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-err-"));
    vi.spyOn(sftp, "createReadStream").mockImplementation(() => { throw new Error("boom"); });
    await expect(ctl.transferTree(1, "down", path.join(dest, "bad.txt"), "/bad.txt")).rejects.toThrow("boom");
    expect(events.some((e) => e.state === "error" && e.error === "boom")).toBe(true);
  });

  it("上传中取消:中断当前文件并保留 .part,结果 cancelled=true", async () => {
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
    expect(sftp.files.has("/u/big.bin")).toBe(false);
  });

  it("传输中取消:后续文件不再开始", async () => {
    const sftp = new FakeSftp();
    sftp.dirs.add("/s");
    sftp.files.set("/s/1.txt", Buffer.from("1"));
    sftp.files.set("/s/2.txt", Buffer.from("2"));
    let ctl!: SftpController;
    ctl = new SftpController(() => undefined, (p) => {
      if (p.state === "active" && (p as TreeProgress).index === 1) ctl.cancelJob((p as TreeProgress).jobId);
    });
    vi.spyOn(ctl, "sftp").mockResolvedValue(sftp as never);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-cancel-"));
    const res = await ctl.transferTree(1, "down", path.join(dest, "o"), "/s");
    expect(res.cancelled).toBe(true);
    expect(fs.existsSync(path.join(dest, "o/2.txt"))).toBe(false);
  });

  it("cancelJob:已结束与未知任务都返回 false", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/x.txt", Buffer.from("x"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-c2-"));
    const res = await ctl.transferTree(1, "down", path.join(dest, "x.txt"), "/x.txt");
    expect(ctl.cancelJob(res.jobId)).toBe(false);
    expect(ctl.cancelJob(123456)).toBe(false);
  });
});

describe("下载:脏 .part 与目标覆盖", () => {
  it("本地 .part 比远端文件还大 → 视为脏文件从头下", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/r.txt", Buffer.from("abc"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-dirty-"));
    fs.writeFileSync(path.join(dest, "r.txt.part"), "0123456789");
    await ctl.transferTree(1, "down", path.join(dest, "r.txt"), "/r.txt");
    expect(read(path.join(dest, "r.txt"))).toBe("abc");
  });

  it("目标已存在 + overwrite → 覆盖(走的正是 localExists=true 分支)", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/r.txt", Buffer.from("new"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-ow-"));
    const target = path.join(dest, "r.txt");
    fs.writeFileSync(target, "OLD");
    await ctl.transferTree(1, "down", target, "/r.txt", { policy: "overwrite" });
    expect(read(target)).toBe("new");
  });
});

describe("收尾失败路径", () => {
  it("上传完成后 rename 失败 → 抛出(不假装成功)", async () => {
    const { ctl, sftp } = makeCtl();
    vi.spyOn(sftp, "rename").mockImplementation((_a: string, _b: string, cb: (e?: ErrBox) => void) => cb(new Error("rename denied")));
    const dir = tmp({ "f.txt": "x" });
    await expect(ctl.transferTree(1, "up", path.join(dir, "f.txt"), "/f.txt")).rejects.toThrow("rename denied");
  });

  it("下载完成后本地 rename 失败 → 抛出", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/r.txt", Buffer.from("x"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-rn-"));
    const target = path.join(dest, "r.txt");
    fs.mkdirSync(`${target}.part`, { recursive: true });   /* 让 rename 目标被目录占据 */
    await expect(ctl.transferTree(1, "down", target, "/r.txt")).rejects.toThrow();
  });
});

describe("失败重试", () => {
  it("第一次传输失败、第二次成功 → 最终完成(.part 让重试从断点继续)", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.dirs.add("/rt");
    sftp.files.set("/rt/a.txt", Buffer.from("hello"));
    const real = sftp.createReadStream.bind(sftp);
    let failed = false;
    vi.spyOn(sftp, "createReadStream").mockImplementation((p: string, o?: { start?: number }) => {
      if (!failed) { failed = true; throw new Error("channel reset"); }
      return real(p, o);
    });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-retry-"));
    const res = await ctl.transferTree(1, "down", path.join(dest, "o"), "/rt");
    expect(res).toMatchObject({ files: 1, cancelled: false });
    expect(read(path.join(dest, "o/a.txt"))).toBe("hello");
  });

  it("一直失败 → 抛最后一次错误(不会无限重试)", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.dirs.add("/rt");
    sftp.files.set("/rt/a.txt", Buffer.from("x"));
    const spy = vi.spyOn(sftp, "createReadStream").mockImplementation(() => { throw new Error("always"); });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-retry2-"));
    await expect(ctl.transferTree(1, "down", path.join(dest, "o"), "/rt", { retries: 2 })).rejects.toThrow("always");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("改权限", () => {
  it("远端:成功路径把 mode 交给 sftp.chmod;失败原样抛出", async () => {
    const { ctl, sftp } = makeCtl();
    sftp.files.set("/x.txt", Buffer.from("x"));
    await ctl.chmodRemote(1, "/x.txt", 0o600);
    expect(sftp.modes.get("/x.txt")).toBe(0o600);
    vi.spyOn(sftp, "chmod").mockImplementation((_p: string, _m: number, cb: (e?: ErrBox) => void) => cb(new Error("perm denied")));
    await expect(ctl.chmodRemote(1, "/x.txt", 0o644)).rejects.toThrow("perm denied");
  });

  /* Windows 的 fs.chmod 只实现"只读"这一位;完整 rwx 位断言在 Windows 必然红。
     这里只验跨平台都成立的真实行为:写位能被关掉、再打开。 */
  it("本地:真的改到文件权限(写位可关可开)", async () => {
    const { ctl } = makeCtl();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-chmod-"));
    const f = path.join(dir, "a.sh");
    fs.writeFileSync(f, "#!/bin/sh\n");
    expect(fs.statSync(f).mode & 0o200).not.toBe(0);
    await ctl.chmodLocal(f, 0o444);
    expect(fs.statSync(f).mode & 0o200).toBe(0);
    await ctl.chmodLocal(f, 0o666);
    expect(fs.statSync(f).mode & 0o200).not.toBe(0);
  });
});
