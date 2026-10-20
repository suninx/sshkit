import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRecord } from "../../src/shared/host";
import { ed25519Blob } from "../helpers/keys";

/**
 * ssh.ts 覆盖率补齐:主机密钥询问的 120s 超时、会话结束时作废挂起询问、
 * shell 开失败、以及"已经结算后仍收到事件"的守卫分支。
 *
 * 这些用例锁的是行为：
 *  - 用户不回答主机密钥询问时,安全默认是**拒绝**并明确告知(不能一直挂着);
 *  - 会话结束必须把残留的询问作废(否则界面残留一个点了没反应的对话框);
 *  - 已结算的 connect 不会被第二次 ready 改写结果;
 *  - 远端 shell 正常退出后再掉线,不能再报一次"掉线"。
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-cov-ssh-home-"));
const origHome = process.env.HOME;
const origProfile = process.env.USERPROFILE;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

interface FakeStream extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  setWindow: ReturnType<typeof vi.fn>;
  stderr: EventEmitter;
}

class FakeClient extends EventEmitter {
  config: Record<string, unknown> | null = null;
  stream: FakeStream | null = null;
  shellError: Error | null = null;
  shellCalls = 0;
  end = vi.fn();
  sftp(cb: (err: Error | null, s: null) => void): void { cb(new Error("no sftp"), null); }
  connect(cfg: Record<string, unknown>): void { this.config = cfg; }
  shell(_opts: unknown, cb: (err: Error | null, s: FakeStream | null) => void): void {
    this.shellCalls++;
    if (this.shellError) { cb(this.shellError, null); return; }
    const stream = Object.assign(new EventEmitter(), {
      write: vi.fn(), end: vi.fn(), setWindow: vi.fn(), stderr: new EventEmitter(),
    }) as FakeStream;
    this.stream = stream;
    cb(null, stream);
  }
}

let SshService: typeof import("../../src/main/ssh").SshService;
let addHostKey: typeof import("../../src/main/knownhosts").addHostKey;
let checkHostKey: typeof import("../../src/main/knownhosts").checkHostKey;
let last: FakeClient | null = null;

beforeAll(async () => {
  vi.resetModules();
  const kh = await import("../../src/main/knownhosts");
  addHostKey = kh.addHostKey;
  checkHostKey = kh.checkHostKey;
  const mod = await import("../../src/main/ssh");
  SshService = mod.SshService;
});

beforeEach(() => {
  last = null;
});

afterAll(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origProfile;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

const host = (over: Partial<HostRecord> = {}): HostRecord => ({
  id: "h_1", name: "n", host: "cov.example", port: 22, username: "root",
  authType: "password", createdAt: new Date().toISOString(), ...over,
});

const sender = () => ({ send: vi.fn(), isDestroyed: () => false });

const mk = (): InstanceType<typeof SshService> =>
  new SshService(() => {
    const c = new FakeClient();
    last = c;
    return c as never;
  });

const opts = { cols: 80, rows: 24 };

/** 主进程内部记录挂起询问的表(测试用来找 reqId 并断言是否被清理) */
const pendingOf = (svc: unknown): Map<string, { verify: (ok: boolean) => void; host: string }> =>
  (svc as { pendingHostKey: Map<string, { verify: (ok: boolean) => void; host: string }> }).pendingHostKey;

/** 用 ssh2 的方式驱动 hostVerifier:传一个会记录结论的回调 */
const driveHostKey = (c: FakeClient, onVerify: (ok: boolean) => void = () => undefined): void => {
  const cfg = c.config as { hostVerifier: (key: unknown, cb: (ok: boolean) => void) => void };
  cfg.hostVerifier(ed25519Blob(7), onVerify);
};

describe("主机密钥询问超时:用户不回答 = 安全拒绝", () => {
  it("120s 无答复 → verify(false)、询问作废、terminal:exit 说明原因,错误按 hostkey 归类", async () => {
    vi.useFakeTimers();
    try {
      const svc = mk();
      const s = sender();
      const p = svc.connect(s as never, host({ host: "timeout.example" }), { password: "pw" }, opts);
      const rejected = expect(p).rejects.toThrow(/connect timed out/);
      const c = last!;
      let verified: boolean | null = null;
      driveHostKey(c, (ok) => { verified = ok; });
      const reqId = [...pendingOf(svc).keys()][0];

      await vi.advanceTimersByTimeAsync(20_000); // readyTimer 兜底
      await vi.advanceTimersByTimeAsync(100_000); // 主机密钥应答窗口
      await rejected;
      expect(verified).toBe(false);
      expect(pendingOf(svc).size).toBe(0);
      expect(s.send).toHaveBeenCalledWith(
        "terminal:exit",
        expect.any(Number),
        expect.objectContaining({ error: expect.stringMatching(/host key not confirmed/i) }),
      );
      // 挂钩超时后 ssh2 会报 error:必须按"主机密钥没确认"上报,而不是普通网络错误
      c.emit("error", new Error("Host denied"));
      expect(s.send).toHaveBeenCalledWith(
        "terminal:exit",
        expect.any(Number),
        expect.objectContaining({ reason: "hostkey" }),
      );
      expect(svc.answerHostKey(reqId, "continue")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("用户及时答复后,过期的超时定时器是 no-op(不再发第二条退出)", async () => {
    vi.useFakeTimers();
    try {
      const svc = mk();
      const s = sender();
      const p = svc.connect(s as never, host({ host: "answered.example" }), { password: "pw" }, opts);
      const c = last!;
      driveHostKey(c);
      const reqId = [...pendingOf(svc).keys()][0];
      const rejected = expect(p).rejects.toThrow(/connect timed out/);
      expect(svc.answerHostKey(reqId, "continue")).toBe(true);
      const exitsBefore = s.send.mock.calls.filter((x: unknown[]) => x[0] === "terminal:exit").length;

      await vi.advanceTimersByTimeAsync(200_000);
      // ready 之前 connect 会因 readyTimer(20s)失败;但"主机密钥超时"的退出消息不应出现
      await rejected;
      const exits = s.send.mock.calls.filter((x: unknown[]) => x[0] === "terminal:exit");
      expect(exits.length).toBe(exitsBefore);
      expect(svc.answerHostKey(reqId, "cancel")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("会话结束时作废挂起的主机密钥询问", () => {
  it("client error 会 cancel 本会话的询问:verify(false),并给渲染层发 knownhost:ask-cancel", async () => {
    const svc = mk();
    const s = sender();
    const p = svc.connect(s as never, host({ host: "cancel.example" }), { password: "pw" }, opts);
    const rejected = expect(p).rejects.toThrow();
    const c = last!;
    let verified: boolean | null = null;
    driveHostKey(c, (ok) => { verified = ok; });
    const reqId = [...pendingOf(svc).keys()][0];

    c.emit("error", new Error("handshake failed"));
    await rejected;
    expect(verified).toBe(false);
    expect(s.send).toHaveBeenCalledWith("knownhost:ask-cancel", reqId);
    expect(svc.answerHostKey(reqId, "continue")).toBe(false);
  });

  it("只作废**本会话**的询问:另一个会话的询问仍可正常作答", async () => {
    const svc = mk();
    const s1 = sender();
    const p1 = svc.connect(s1 as never, host({ id: "h_a", host: "iso-a.example" }), { password: "pw" }, opts);
    const c1 = last!;
    driveHostKey(c1);
    const reqA = [...pendingOf(svc).keys()][0];

    const s2 = sender();
    const p2 = svc.connect(s2 as never, host({ id: "h_b", host: "iso-b.example" }), { password: "pw" }, opts);
    const c2 = last!;
    driveHostKey(c2);
    const reqB = [...pendingOf(svc).keys()].find((r) => r !== reqA)!;

    const rej1 = expect(p1).rejects.toThrow();
    c1.emit("error", new Error("boom"));
    await rej1;
    expect(s2.send.mock.calls.some((x: unknown[]) => x[0] === "knownhost:ask-cancel")).toBe(false);
    expect(svc.answerHostKey(reqB, "continue")).toBe(true);
    c2.emit("ready");
    await expect(p2).resolves.toBeGreaterThan(0);
  });

  it("窗口已销毁时取消询问:回调仍被置 false,但不再给渲染层发消息", async () => {
    const svc = mk();
    const s = { send: vi.fn(), isDestroyed: () => true };
    const p = svc.connect(s as never, host({ host: "gone.example" }), { password: "pw" }, opts);
    const rejected = expect(p).rejects.toThrow();
    const c = last!;
    let verified: boolean | null = null;
    driveHostKey(c, (ok) => { verified = ok; });
    c.emit("error", new Error("boom"));
    await rejected;
    expect(verified).toBe(false);
    expect(s.send).not.toHaveBeenCalled();
  });
});

describe("ready / shell / 退出 的边界分支", () => {
  it("shell 开失败:connect 已成功但立刻上报 terminal:exit(shell: …)并结束 client", async () => {
    const svc = mk();
    const s = sender();
    const p = svc.connect(s as never, host(), { password: "pw" }, opts);
    const c = last!;
    c.shellError = new Error("channel open failed");
    c.emit("ready");
    const id = await p;
    expect(s.send).toHaveBeenCalledWith("terminal:exit", id, {
      exitCode: -1,
      error: "shell: channel open failed",
    });
    expect(c.end).toHaveBeenCalledTimes(1);
    expect(svc.clientOf(id)).toBeUndefined();
  });

  it("stream 退出码为 null 时按 0 上报(reason=closed)", async () => {
    const svc = mk();
    const s = sender();
    const p = svc.connect(s as never, host(), { password: "pw" }, opts);
    const c = last!;
    c.emit("ready");
    const id = await p;
    c.stream!.emit("exit", null);
    expect(s.send).toHaveBeenCalledWith("terminal:exit", id, { exitCode: 0, reason: "closed" });
  });

  it("ready 后紧接 error:promise 已结算,不被改写;错误仍要上报给界面", async () => {
    const svc = mk();
    const s = sender();
    const p = svc.connect(s as never, host(), { password: "pw" }, opts);
    const c = last!;
    c.emit("ready");
    const id = await p;
    c.emit("error", new Error("link dropped"));
    expect(s.send).toHaveBeenCalledWith("terminal:exit", id, {
      exitCode: -1,
      error: "link dropped",
      reason: "error",
    });
  });

  it("重复 ready 不会第二次结算 connect(守卫生效),也不会抛", async () => {
    const svc = mk();
    const s = sender();
    const p = svc.connect(s as never, host(), { password: "pw" }, opts);
    const c = last!;
    c.emit("ready");
    const id = await p;
    c.emit("ready");
    expect(id).toBeGreaterThan(0);
    expect(s.send.mock.calls.filter((x: unknown[]) => x[0] === "terminal:exit")).toEqual([]);
  });

  it("stream 正常退出后再掉线:不重复报 dropped", async () => {
    const svc = mk();
    const s = sender();
    const p = svc.connect(s as never, host(), { password: "pw" }, opts);
    const c = last!;
    c.emit("ready");
    await p;
    c.stream!.emit("exit", 0);
    s.send.mockClear();
    c.emit("close");
    expect(s.send.mock.calls.filter((x: unknown[]) => x[0] === "terminal:exit")).toEqual([]);
  });

  it("error 之后再 close:会话已清理,不补发一条 dropped", async () => {
    const svc = mk();
    const s = sender();
    const p = svc.connect(s as never, host(), { password: "pw" }, opts);
    const rejected = expect(p).rejects.toThrow(/refused/);
    const c = last!;
    c.emit("error", new Error("refused"));
    await rejected;
    s.send.mockClear();
    c.emit("close");
    expect(s.send.mock.calls.filter((x: unknown[]) => x[0] === "terminal:exit")).toEqual([]);
  });

  it("主动 dispose 后的 close 不报断线(用户关的 tab 不该弹重连)", async () => {
    const svc = mk();
    const s = sender();
    const p = svc.connect(s as never, host(), { password: "pw" }, opts);
    const c = last!;
    c.emit("ready");
    const id = await p;
    svc.dispose(id);
    s.send.mockClear();
    c.emit("close");
    expect(s.send.mock.calls.filter((x: unknown[]) => x[0] === "terminal:exit")).toEqual([]);
  });

  it("握手前 close:按 dropped 上报并清理会话", async () => {
    const svc = mk();
    const s = sender();
    const p = svc.connect(s as never, host(), { password: "pw" }, opts);
    const rejected = expect(p).rejects.toThrow(/closed before ready/);
    const c = last!;
    c.emit("close");
    await rejected;
    expect(s.send).toHaveBeenCalledWith(
      "terminal:exit",
      expect.any(Number),
      expect.objectContaining({ reason: "dropped" }),
    );
  });

  it("默认工厂:new SshService() 可构造(生产用真实 ssh2 Client)", () => {
    const svc = new SshService();
    expect(svc.clientOf(123)).toBeUndefined();
    svc.dispose(123); // 未知会话安全
  });
});

describe("主机密钥答复:replace 动作", () => {
  it("replace 把旧条目换成新 key(不是追加成两条)", async () => {
    const svc = mk();
    const s = sender();
    const hostField = "replace.example";
    const oldKey = ed25519Blob(11);
    addHostKey(hostField, oldKey);

    const p = svc.connect(s as never, host({ host: hostField }), { password: "pw" }, opts);
    const c = last!;
    driveHostKey(c); // 用 ed25519Blob(7) 校验:与旧 key 不同 → changed,触发询问
    const reqId = [...pendingOf(svc).keys()][0];
    expect(svc.answerHostKey(reqId, "replace")).toBe(true);
    // replace 的语义:旧条目被剔除、新 key 成为唯一可信 key
    expect(checkHostKey(hostField, ed25519Blob(7)).status).toBe("ok");
    expect(checkHostKey(hostField, oldKey).status).toBe("changed");
    const text = fs.readFileSync(path.join(HOME, ".ssh", "known_hosts"), "utf8");
    expect(text.trim().split("\n").filter((l) => l.startsWith(hostField))).toHaveLength(1);
    c.emit("ready");
    await p;
  });
});
