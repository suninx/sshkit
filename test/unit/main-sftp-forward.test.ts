import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmDir, tmpDir } from "../helpers/tmp";
import { SftpController } from "../../src/main/sftp";
import { ForwardService } from "../../src/main/forward";
import type { ForwardStatus } from "../../src/main/forward";
import type { TransferProgress } from "../../src/shared/sftp";

/* ---------------- 假 ssh2 SFTP 包装 ---------------- */
interface FakeEntry { name: string; size: number; mode: number; mtime: number; isDirectory: () => boolean }
class FakeSftp extends EventEmitter {
  files = new Map<string, FakeEntry>();
  calls: Array<[string, ...unknown[]]> = [];
  realpath(p: string, cb: (e: Error | null, abs: string) => void) { cb(null, p); }
  /* 真实 ssh2 的 readdir 返回 [{ filename, attrs: { size, mode, mtime } }],按真实形状构造 */
  readdir(_dir: string, cb: (e: Error | null, list: Array<{ filename: string; attrs: { size: number; mode: number; mtime: number } }>) => void) {
    cb(null, [...this.files.values()].map((f) => ({ filename: f.name, attrs: { size: f.size, mode: f.mode, mtime: f.mtime } })));
  }
  stat(p: string, cb: (e: Error | null, st: FakeEntry) => void) {
    const st = this.files.get(p);
    if (!st) cb(Object.assign(new Error("No such file"), { code: 2 }), undefined as never);
    else cb(null, st);
  }
  mkdir(p: string, cb: (e: Error | null) => void) { this.calls.push(["mkdir", p]); cb(null); }
  unlink(p: string, cb: (e: Error | null) => void) { this.calls.push(["unlink", p]); cb(null); }
  rename(a: string, b: string, cb: (e: Error | null) => void) { this.calls.push(["rename", a, b]); cb(null); }
  fastPut(local: string, remote: string, opts: { step?: (n: number) => void }, cb: (e: Error | null) => void) {
    this.calls.push(["fastPut", local, remote]);
    opts.step?.(5);
    cb(null);
  }
  fastGet(remote: string, local: string, opts: { step?: (n: number) => void }, cb: (e: Error | null) => void) {
    this.calls.push(["fastGet", remote, local]);
    opts.step?.(7);
    cb(null);
  }
}
const entry = (name: string, over: Partial<FakeEntry> = {}): FakeEntry => ({
  name, size: 10, mode: 0o100644, mtime: 1, isDirectory: () => false, ...over,
});

class FakeClient extends EventEmitter {
  sftpObj = new FakeSftp();
  sftpCb: ((e: Error | null, s: FakeSftp) => void) | null = null;
  sftp(cb: (e: Error | null, s: FakeSftp) => void) { cb(null, this.sftpObj); }
  forwardIn = vi.fn((_a: string, _p: number, cb: (e: Error | null, port: number) => void) => cb(null, 33333));
  forwardOut = vi.fn((_s: string, _sp: number, _d: string, _dp: number, cb: (e: Error | null, s: net.Socket) => void) => {
    const sock = new net.Socket();
    cb(null, sock);
  });
  end = vi.fn();
}

let dir: string;
beforeEach(() => { dir = tmpDir("sshkit-sftp2-"); });
afterEach(() => rmDir(dir));

const fakeClient = (sid: number) => (s: number) => (s === sid ? (new FakeClient() as never) : undefined);

describe("SftpController:远端操作", () => {
  it("没有该会话的连接时直接拒绝(而不是静默空列表)", async () => {
    const ctrl = new SftpController(() => undefined, () => undefined);
    await expect(ctrl.listRemote(1, "/root")).rejects.toBeTruthy();
  });

  it("listRemote 把目录项转成统一结构(名字/大小/是否目录/权限位)", async () => {
    const client = new FakeClient();
    client.sftpObj.files.set("/root", entry("root", { mode: 0o040755, isDirectory: () => true }));
    client.sftpObj.files.set("/root/a.txt", entry("a.txt"));
    client.sftpObj.files.set("/root/sub", entry("sub", { mode: 0o040755, isDirectory: () => true }));
    const ctrl = new SftpController(() => client as never, () => undefined);
    const r = await ctrl.listRemote(1, "/root");
    expect(r.path).toBe("/root");
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    expect(byName["a.txt"]).toMatchObject({ isDir: false, size: 10 });
    expect(byName["sub"].isDir).toBe(true);
    expect(byName["sub"].mode & 0o170000).toBe(0o040000);
  });

  it("mkdir/remove/rename 直接下发到远端", async () => {
    const client = new FakeClient();
    client.sftpObj.files.set("/root/f", entry("f"));
    client.sftpObj.files.set("/root/a", entry("a"));
    const ctrl = new SftpController(() => client as never, () => undefined);
    await ctrl.mkdirRemote(1, "/root/newdir");
    await ctrl.removeRemote(1, "/root/f");
    await ctrl.renameRemote(1, "/root/a", "/root/b");
    expect(client.sftpObj.calls).toEqual([
      ["mkdir", "/root/newdir"], ["unlink", "/root/f"], ["rename", "/root/a", "/root/b"],
    ]);
  });

  it("upload:进度按 active(0) → active(n) → done 上报,并返回 jobId", async () => {
    const local = path.join(dir, "up.txt");
    fs.writeFileSync(local, "12345");
    const events: TransferProgress[] = [];
    const ctrl = new SftpController(() => new FakeClient() as never, (p) => events.push(p));
    const jobId = await ctrl.upload(1, local, "/root/up.txt");
    expect(jobId).toBeGreaterThan(0);
    expect(events.map((e) => e.state)).toEqual(["active", "active", "done"]);
    expect(events.at(-1)).toMatchObject({ dir: "up", file: "up.txt", total: 5, bytes: 5 });
  });

  it("upload 失败:上报 error 并抛出(不能假装成功)", async () => {
    const local = path.join(dir, "bad.txt");
    fs.writeFileSync(local, "x");
    const client = new FakeClient();
    client.sftpObj.fastPut = (((_l: string, _r: string, _o: unknown, cb: (e: Error) => void) => cb(new Error("permission denied"))) as never);
    const events: TransferProgress[] = [];
    const ctrl = new SftpController(() => client as never, (p) => events.push(p));
    await expect(ctrl.upload(1, local, "/root/x")).rejects.toThrow(/permission denied/);
    expect(events.at(-1)).toMatchObject({ state: "error" });
  });

  it("download:目录直接拒绝并说清原因", async () => {
    const client = new FakeClient();
    client.sftpObj.files.set("/root/dir", entry("dir", { mode: 0o040755, isDirectory: () => true }));
    const ctrl = new SftpController(() => client as never, () => undefined);
    await expect(ctrl.download(1, "/root/dir", path.join(dir, "dir"))).rejects.toThrow(/directory download/i);
  });

  it("download:文件正常传输并按 done 收尾", async () => {
    const client = new FakeClient();
    client.sftpObj.files.set("/root/a.bin", entry("a.bin", { size: 2048 }));
    const events: TransferProgress[] = [];
    const ctrl = new SftpController(() => client as never, (p) => events.push(p));
    await ctrl.download(1, "/root/a.bin", path.join(dir, "a.bin"));
    expect(events.at(-1)).toMatchObject({ dir: "down", file: "a.bin", state: "done", total: 2048 });
  });

  it("会话连接上没有 sftp 子系统时,回退到 connectAux 的专用连接", async () => {
    const aux = new FakeClient();
    aux.sftpObj.files.set("/root", entry("root", { mode: 0o040755, isDirectory: () => true }));
    aux.sftpObj.files.set("/root/x", entry("x"));
    const session = new FakeClient();
    // 会话的 sftp 请求失败(真实场景:Channel open failure),由回退路径接管
    session.sftp = ((cb: (e: Error | null, s: unknown) => void) => cb(new Error("Unable to start subsystem: sftp"), null)) as never;
    const ctrl = new SftpController(
      (sid) => (sid === 1 ? (session as never) : undefined),
      () => undefined,
      async () => aux as never,
    );
    const r = await ctrl.listRemote(1, "/root");
    // 假 readdir 会返回表里全部登记项,这里只关心回退后的连接能列出目标文件
    expect(r.entries.map((e) => e.name)).toContain("x");
  });
});

describe("ForwardService:三种模式的起停", () => {
  let ud: string;
  const states: ForwardStatus[] = [];
  const make = (client: FakeClient | undefined) =>
    new ForwardService(ud, () => (client as never | undefined), (s) => states.push(s));

  beforeEach(() => { ud = tmpDir("sshkit-fwd2-"); states.length = 0; });
  afterEach(() => rmDir(ud));

  it("remote(-R):forwardIn 成功后进入 running 并记录远端端口", () => {
    const client = new FakeClient();
    const svc = make(client);
    const rule = { id: "r", hostId: "h", kind: "remote" as const, bindAddress: "127.0.0.1", port: 18081, destinationAddress: "127.0.0.1", destinationPort: 80 };
    svc.saveRule(rule);
    const st = svc.start(rule);
    expect(st.state).toBe("running");
    expect(st.boundPort).toBe(33333);
    expect(client.forwardIn).toHaveBeenCalledWith("0.0.0.0", 18081, expect.any(Function));
    svc.stop(rule.id);
  });

  it("remote:forwardIn 失败时状态为 error,且原因可读", () => {
    const client = new FakeClient();
    client.forwardIn = vi.fn((_a: string, _p: number, cb: (e: Error) => void) => cb(new Error("remote bind failed"))) as never;
    const svc = make(client);
    const rule = { id: "r2", hostId: "h", kind: "remote" as const, bindAddress: "127.0.0.1", port: 18082, destinationAddress: "127.0.0.1", destinationPort: 80 };
    svc.start(rule);
    expect(svc.statusOf("r2")).toMatchObject({ state: "error" });
    expect(String(svc.statusOf("r2").error)).toMatch(/remote bind failed/);
  });

  it("local(-L)有客户端时:连入会调用 forwardOut,并把两端接起来", async () => {
    const client = new FakeClient();
    const svc = make(client);
    const port = await new Promise<number>((res) => {
      const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
    });
    const rule = { id: "l1", hostId: "h", kind: "local" as const, bindAddress: "127.0.0.1", port, destinationAddress: "10.1.1.1", destinationPort: 22 };
    svc.start(rule);
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((res) => { sock.once("connect", () => res()); sock.once("error", () => res()); setTimeout(res, 2000); });
    for (let i = 0; i < 40 && client.forwardOut.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    sock.destroy();
    expect(client.forwardOut).toHaveBeenCalled();
    const args = client.forwardOut.mock.calls[0];
    expect(args[2]).toBe("10.1.1.1");
    expect(args[3]).toBe(22);
    svc.stop(rule.id);
  });

  it("stopAll 关闭所有活动转发", () => {
    const svc = make(new FakeClient());
    const a = { id: "s1", hostId: "h", kind: "remote" as const, bindAddress: "127.0.0.1", port: 1, destinationAddress: "127.0.0.1", destinationPort: 2 };
    const b = { id: "s2", hostId: "h", kind: "remote" as const, bindAddress: "127.0.0.1", port: 3, destinationAddress: "127.0.0.1", destinationPort: 4 };
    svc.start(a); svc.start(b);
    expect(() => svc.stopAll()).not.toThrow();
    expect(svc.statusOf("s1").state).toBe("stopped");
  });
});
