import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmDir, tmpDir } from "../helpers/tmp";
import { SftpController } from "../../src/main/sftp";
import type { TransferProgress } from "../../src/shared/sftp";

/**
 * sftp.ts 覆盖率补齐:SFTP 子系统回退到专用连接(含失败/缓存/失效)、
 * 目录操作与下载的错误路径、本地目录里坏条目的跳过。
 */

class FakeSftp extends EventEmitter {
  files = new Map<string, { size: number; mode: number; mtime: number }>();
  calls: Array<[string, ...unknown[]]> = [];
  failReaddir: Error | null = null;
  failRealpath: Error | null = null;
  failFastGet: Error | null = null;
  failMkdir: Error | null = null;
  failUnlink: Error | null = null;

  realpath(p: string, cb: (e: Error | null, abs: string) => void): void {
    if (this.failRealpath) { cb(this.failRealpath, ""); return; }
    cb(null, p);
  }
  readdir(_dir: string, cb: (e: Error | null, list: Array<{ filename: string; attrs: { size: number; mode: number; mtime: number } }>) => void): void {
    if (this.failReaddir) { cb(this.failReaddir, []); return; }
    cb(null, [...this.files.entries()].map(([name, st]) => ({ filename: name, attrs: st })));
  }
  stat(p: string, cb: (e: Error | null, st: { size: number; mode: number; isDirectory: () => boolean }) => void): void {
    const st = this.files.get(p);
    if (!st) { cb(Object.assign(new Error("No such file"), { code: 2 }), undefined as never); return; }
    cb(null, { ...st, isDirectory: () => (st.mode & 0o170000) === 0o040000 });
  }
  mkdir(p: string, cb: (e: Error | null) => void): void {
    this.calls.push(["mkdir", p]);
    cb(this.failMkdir);
  }
  unlink(p: string, cb: (e: Error | null) => void): void {
    this.calls.push(["unlink", p]);
    cb(this.failUnlink);
  }
  rmdir(p: string, cb: (e: Error | null) => void): void {
    this.calls.push(["rmdir", p]);
    cb(null);
  }
  rename(a: string, b: string, cb: (e: Error | null) => void): void {
    this.calls.push(["rename", a, b]);
    cb(null);
  }
  fastPut(_l: string, _r: string, _o: { step?: (n: number) => void }, cb: (e: Error | null) => void): void {
    cb(null);
  }
  fastGet(_r: string, _l: string, _o: { step?: (n: number) => void }, cb: (e: Error | null) => void): void {
    cb(this.failFastGet);
  }
}

class FakeClient extends EventEmitter {
  sftpObj = new FakeSftp();
  sftpCalls = 0;
  failSftp: Error | null = null;
  end = vi.fn();
  constructor() {
    super();
    // 通过实例方法暴露,便于测试里替换失败行为
  }
  sftp(cb: (e: Error | null, s: FakeSftp) => void): void {
    this.sftpCalls++;
    if (this.failSftp) { cb(this.failSftp, undefined as never); return; }
    cb(null, this.sftpObj);
  }
}

const entry = (size: number, mode: number) => ({ size, mode, mtime: 1 });

let dir: string;
beforeEach(() => { dir = tmpDir("sshkit-cov-sftp-"); });
afterEach(() => { vi.restoreAllMocks(); rmDir(dir); });

describe("sftp 通道:缓存与专用连接回退", () => {
  it("没有回退路径时,每次操作都在会话连接上现开 sftp 子系统(缓存只作用于专用连接)", async () => {
    const client = new FakeClient();
    const ctrl = new SftpController(() => client as never, () => undefined);
    await ctrl.mkdirRemote(1, "/tmp/a");
    await ctrl.mkdirRemote(1, "/tmp/b");
    expect(client.sftpCalls).toBe(2);
    expect(client.sftpObj.calls).toEqual([["mkdir", "/tmp/a"], ["mkdir", "/tmp/b"]]);
  });

  it("没有 connectAux 时,子系统失败直接抛原始错误(不假装成功)", async () => {
    const client = new FakeClient();
    client.failSftp = new Error("Unable to start subsystem: sftp");
    const ctrl = new SftpController(() => client as never, () => undefined);
    await expect(ctrl.listRemote(1, "/")).rejects.toThrow(/subsystem/i);
  });

  it("connectAux 返回 null 时仍抛原始子系统错误", async () => {
    const client = new FakeClient();
    client.failSftp = new Error("channel open failure");
    const connectAux = vi.fn(async () => null);
    const ctrl = new SftpController(() => client as never, () => undefined, connectAux);
    await expect(ctrl.listRemote(1, "/")).rejects.toThrow(/channel open failure/);
    expect(connectAux).toHaveBeenCalledWith(1);
  });

  it("回退连接也开不出 sftp 时:end 掉 aux 并抛第二次错误(不泄漏连接)", async () => {
    const session = new FakeClient();
    session.failSftp = new Error("Unable to start subsystem: sftp");
    const aux = new FakeClient();
    aux.failSftp = new Error("aux channel failed");
    const ctrl = new SftpController(() => session as never, () => undefined, async () => aux as never);
    await expect(ctrl.listRemote(1, "/")).rejects.toThrow(/aux channel failed/);
    expect(aux.end).toHaveBeenCalledTimes(1);
  });

  it("回退连接成功后被缓存:第二次操作不再新建连接;关闭后重新建", async () => {
    const session = new FakeClient();
    session.failSftp = new Error("Unable to start subsystem: sftp");
    const aux = new FakeClient();
    aux.sftpObj.files.set("a.txt", entry(5, 0o100644));
    const connectAux = vi.fn(async () => aux as never);
    const ctrl = new SftpController(() => session as never, () => undefined, connectAux);
    const first = await ctrl.listRemote(1, "/");
    expect(first.entries.map((e) => e.name)).toEqual(["a.txt"]);
    await ctrl.mkdirRemote(1, "/x");
    expect(connectAux).toHaveBeenCalledTimes(1);
    expect(aux.sftpCalls).toBe(1);

    aux.emit("close");
    await ctrl.mkdirRemote(1, "/y");
    expect(connectAux).toHaveBeenCalledTimes(2);
  });

  it("会话连接不存在时直接报错(不是静默空列表)", async () => {
    const ctrl = new SftpController(() => undefined, () => undefined);
    await expect(ctrl.listRemote(9, "/")).rejects.toThrow(/no active ssh session/);
  });
});

describe("列表与目录操作失败路径", () => {
  it("realpath 失败 → listRemote 拒绝并保留原始错误", async () => {
    const client = new FakeClient();
    client.sftpObj.failRealpath = new Error("permission denied (realpath)");
    const ctrl = new SftpController(() => client as never, () => undefined);
    await expect(ctrl.listRemote(1, "/secret")).rejects.toThrow(/permission denied/);
  });

  it("readdir 失败 → listRemote 拒绝(不返回空目录)", async () => {
    const client = new FakeClient();
    client.sftpObj.failReaddir = Object.assign(new Error("No such directory"), { code: 2 });
    const ctrl = new SftpController(() => client as never, () => undefined);
    await expect(ctrl.listRemote(1, "/missing")).rejects.toThrow(/No such directory/);
  });

  it("removeRemote:目录走 rmdir,文件走 unlink", async () => {
    const client = new FakeClient();
    client.sftpObj.files.set("/d", entry(0, 0o040755));
    client.sftpObj.files.set("/f", entry(1, 0o100644));
    const ctrl = new SftpController(() => client as never, () => undefined);
    await ctrl.removeRemote(1, "/d");
    await ctrl.removeRemote(1, "/f");
    expect(client.sftpObj.calls).toEqual([["rmdir", "/d"], ["unlink", "/f"]]);
  });

  it("removeRemote:stat 失败直接拒绝;unlink 失败也拒绝", async () => {
    const client = new FakeClient();
    const ctrl = new SftpController(() => client as never, () => undefined);
    await expect(ctrl.removeRemote(1, "/ghost")).rejects.toThrow(/No such file/);

    client.sftpObj.files.set("/f", entry(1, 0o100644));
    client.sftpObj.failUnlink = new Error("unlink denied");
    await expect(ctrl.removeRemote(1, "/f")).rejects.toThrow(/unlink denied/);
  });

  it("mkdirRemote 失败会拒绝(不吞错误)", async () => {
    const client = new FakeClient();
    client.sftpObj.failMkdir = new Error("mkdir denied");
    const ctrl = new SftpController(() => client as never, () => undefined);
    await expect(ctrl.mkdirRemote(1, "/nope")).rejects.toThrow(/mkdir denied/);
  });

  it("listLocal 跳过拿不到 stat 的坏条目(悬挂软链),其余照常列出", async () => {
    fs.writeFileSync(path.join(dir, "ok.txt"), "hello");
    /* 制造一个"存在但 stat 拿不到"的条目:
       - POSIX:普通符号链接指向不存在的目标;
       - Windows:**目录联接(junction)** —— 普通用户即可创建,而 fs.symlinkSync 默认
         (文件软链)需要 SeCreateSymbolicLinkPrivilege(开发者模式/管理员),
         非管理员会 EPERM。GitHub 的 Windows runner 是管理员,所以 CI 抓不到这个坑,
         只有真实用户机器会红(2026-10-21 用户反馈"非管理员跑测试不能全过")。 */
    const linkPath = path.join(dir, "dangling");
    const target = path.join(dir, "does-not-exist");
    if (process.platform === "win32") fs.symlinkSync(target, linkPath, "junction");
    else fs.symlinkSync(target, linkPath);
    const ctrl = new SftpController(() => undefined, () => undefined);
    const r = await ctrl.listLocal(dir);
    expect(r.entries.map((e) => e.name)).toContain("ok.txt");
    expect(r.entries.map((e) => e.name)).not.toContain("dangling");
  });


  it("removeLocal 目录用 rmdir 删除", async () => {
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    const ctrl = new SftpController(() => undefined, () => undefined);
    await ctrl.removeLocal(sub);
    expect(fs.existsSync(sub)).toBe(false);
  });
});

describe("下载的错误路径", () => {
  it("远端 stat 失败 → 拒绝(没有 size 就没法报进度)", async () => {
    const client = new FakeClient();
    const ctrl = new SftpController(() => client as never, () => undefined);
    await expect(ctrl.download(1, "/missing.bin", path.join(dir, "x"))).rejects.toThrow(/No such file/);
  });

  it("fastGet 失败 → 上报 state=error(带 total)并抛出", async () => {
    const client = new FakeClient();
    client.sftpObj.files.set("/a.bin", entry(1024, 0o100644));
    client.sftpObj.failFastGet = new Error("permission denied");
    const events: TransferProgress[] = [];
    const ctrl = new SftpController(() => client as never, (p) => events.push(p));
    await expect(ctrl.download(1, "/a.bin", path.join(dir, "a.bin"))).rejects.toThrow(/permission denied/);
    expect(events.at(-1)).toMatchObject({ dir: "down", file: "a.bin", state: "error", total: 1024 });
  });
});
