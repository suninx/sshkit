import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRecord } from "../../src/shared/host";

/**
 * SshService 行为测试。用假的 ssh2 Client(EventEmitter)驱动连接生命周期,
 * 覆盖:连接成功/鉴权失败/握手前断开/主机密钥三态(已知/未知/变更)/数据与退出/
 * 写入与窗口/主动关闭/辅助连接(openAux)。
 *
 * 注意:HOME 在导入被测模块**之前**改到临时目录 —— knownhosts.ts 在模块加载时按
 * os.homedir() 计算 known_hosts 路径,测试绝不能读写用户的真实 ~/.ssh。
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-home-"));
const origHome = process.env.HOME;
const origProfile = process.env.USERPROFILE;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;   // Windows:os.homedir() 读 USERPROFILE

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svc: any;
let FakeClientCtor: { last: FakeClient | null } = { last: null };
let addHostKey: typeof import("../../src/main/knownhosts").addHostKey;

class FakeStream extends EventEmitter {
  write = vi.fn();
  end = vi.fn();
  setWindow = vi.fn();
  stderr = new EventEmitter();
}

class FakeClient extends EventEmitter {
  config: Record<string, unknown> | null = null;
  stream = new FakeStream();
  end = vi.fn();
  shellCalls: unknown[] = [];
  connect(cfg: Record<string, unknown>) { this.config = cfg; }
  shell(opts: unknown, cb: (err: Error | null, s: FakeStream) => void) {
    this.shellCalls.push(opts);
    cb(null, this.stream);
  }
  sftp(cb: (err: Error | null, s: null) => void) { cb(new Error("no sftp"), null); }
  forwardOut = vi.fn();
}

const host = (over: Partial<HostRecord> = {}): HostRecord => ({
  id: "h_1", name: "node-1", host: "h.example", port: 22, username: "root",
  authType: "password", createdAt: new Date().toISOString(),
  ...over,
});

const sender = () => ({
  isDestroyed: () => false,
  send: vi.fn(),
});

/** 从最近一次 connect 的 config 里取 hostVerifier,以驱动主机密钥分支 */
async function verifierResult(p: {
  send: ReturnType<typeof vi.fn>;
}, blob: Buffer): Promise<{ verify: (v: boolean) => void; ask: unknown[] | null }> {
  const cfg = FakeClientCtor.last!.config as { hostVerifier: (k: unknown, v: (ok: boolean) => void) => void };
  let captured: (v: boolean) => void = () => {};
  const before = p.send.mock.calls.length;
  cfg.hostVerifier(blob, (ok) => { captured = () => { /* noop */ }; void ok; });
  // 说明:hostVerifier 的回调由本函数外部驱动,这里只返回句柄供断言
  const ask = p.send.mock.calls.slice(before).find((c: unknown[]) => c[0] === "knownhost:ask") ?? null;
  return { verify: (v) => captured(v), ask: ask as unknown[] | null };
}

beforeAll(async () => {
  vi.resetModules();
  const kh = await import("../../src/main/knownhosts");
  addHostKey = kh.addHostKey;
  const { SshService } = await import("../../src/main/ssh");
  svc = new SshService(() => {
    const c = new FakeClient();
    FakeClientCtor.last = c;
    return c as never;
  });
});

beforeEach(() => {
  FakeClientCtor.last = null;
});

afterAll(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origProfile;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("connect(): 正常路径", () => {
  it("等 ready 才返回 sessionId,并把 shell 参数传下去", async () => {
    const s = sender();
    const p = svc.connect(s, host(), { password: "pw" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    expect(c.config).toMatchObject({ host: "h.example", port: 22, username: "root", password: "pw" });
    c.emit("ready");
    await expect(p).resolves.toBe(1_000_001);
    expect(c.shellCalls[0]).toEqual({ term: "xterm-256color", cols: 80, rows: 24 });
  });

  it("远端输出经 utf8 解码后转发为 terminal:data", async () => {
    const s = sender();
    const p = svc.connect(s, host(), { password: "pw" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    c.emit("ready");
    const id = await p;
    const chunk = Buffer.from("héllo\n", "utf8");
    // 多字节字符被拆成两个 chunk 时也不应产生乱码(decoder 跨 chunk 保持状态)
    c.stream.emit("data", chunk.subarray(0, 2));
    c.stream.emit("data", chunk.subarray(2));
    const data = s.send.mock.calls.filter((x: unknown[]) => x[0] === "terminal:data").map((x: unknown[]) => x[2]).join("");
    expect(data).toBe("héllo\n");
    expect(typeof id).toBe("number");
  });

  it("stream 退出/关闭都会上报 terminal:exit,且原因不同", async () => {
    const s = sender();
    const p = svc.connect(s, host(), { password: "pw" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    c.emit("ready");
    const id = await p;
    c.stream.emit("exit", 7);
    expect(s.send).toHaveBeenCalledWith("terminal:exit", id, { exitCode: 7, reason: "closed" });

    const s2 = sender();
    const p2 = svc.connect(s2, host(), { password: "pw" }, { cols: 80, rows: 24 });
    const c2 = FakeClientCtor.last!;
    c2.emit("ready");
    const id2 = await p2;
    c2.stream.emit("close");
    expect(s2.send).toHaveBeenCalledWith("terminal:exit", id2, { exitCode: 0 });
  });

  it("write/resize 转发到远端 stream,resize 有最小值保护", async () => {
    const s = sender();
    const p = svc.connect(s, host(), { password: "pw" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    c.emit("ready");
    const id = await p;
    svc.write(id, "ls\r");
    expect(c.stream.write).toHaveBeenCalledWith("ls\r");
    svc.resize(id, 100, 40);
    expect(c.stream.setWindow).toHaveBeenCalledWith(40, 100, 0, 0);
    svc.resize(id, 0, 0);
    expect(c.stream.setWindow).toHaveBeenLastCalledWith(2, 2, 0, 0);
  });
});

describe("connect(): 失败路径必须说清原因", () => {
  it("鉴权失败 → 拒绝 + terminal:exit reason=auth", async () => {
    const s = sender();
    const p = svc.connect(s, host(), { password: "wrong" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    c.emit("error", new Error("All configured authentication methods failed"));
    await expect(p).rejects.toThrow(/authentication/i);
    expect(s.send).toHaveBeenCalledWith("terminal:exit", expect.any(Number), expect.objectContaining({ reason: "auth" }));
  });

  it("其他错误 → reason=error", async () => {
    const s = sender();
    const p = svc.connect(s, host(), { password: "pw" }, { cols: 80, rows: 24 });
    FakeClientCtor.last!.emit("error", new Error("ECONNREFUSED"));
    await expect(p).rejects.toThrow(/ECONNREFUSED/);
    expect(s.send).toHaveBeenCalledWith("terminal:exit", expect.any(Number), expect.objectContaining({ reason: "error" }));
  });

  it("握手完成前断开 → 拒绝,并报 dropped", async () => {
    const s = sender();
    const p = svc.connect(s, host(), { password: "pw" }, { cols: 80, rows: 24 });
    FakeClientCtor.last!.emit("close");
    await expect(p).rejects.toThrow(/closed before ready/);
  });

  it("没有保存密码 → 直接拒绝,不发起连接", async () => {
    const p = svc.connect(sender(), host(), {}, { cols: 80, rows: 24 });
    await expect(p).rejects.toThrow(/no saved password/i);
  });
});

describe("主机密钥(T6 询问式)", () => {
  const blob = Buffer.from("fake-key-blob-1");

  it("已知且一致 → 直接放行,不弹询问", async () => {
    const h = host({ host: "known.example", port: 22 });
    addHostKey("known.example", blob);
    const s = sender();
    const p = svc.connect(s, h, { password: "pw" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    const cfg = c.config as { hostVerifier: (k: unknown, v: (ok: boolean) => void) => void };
    const seen: boolean[] = [];
    cfg.hostVerifier(blob, (ok) => seen.push(ok));
    expect(seen).toEqual([true]);
    expect(s.send.mock.calls.some((x: unknown[]) => x[0] === "knownhost:ask")).toBe(false);
    c.emit("ready");
    await p;
  });

  it("未知主机 → 发 knownhost:ask(带指纹);用户选 Close 则拒绝连接", async () => {
    const s = sender();
    const p = svc.connect(s, host({ host: "unknown.example" }), { password: "pw" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    let verified: boolean | null = null;
    (c.config as { hostVerifier: (k: unknown, v: (ok: boolean) => void) => void })
      .hostVerifier(Buffer.from("brand-new-key"), (ok) => { verified = ok; });

    const ask = s.send.mock.calls.find((x: unknown[]) => x[0] === "knownhost:ask");
    expect(ask).toBeTruthy();
    const payload = ask![1] as { reqId: string; host: string; fingerprint: string; keyType: string };
    expect(payload.host).toBe("unknown.example");
    expect(payload.fingerprint).toMatch(/^[A-Za-z0-9+/]+=*$/);   // 已去掉重复的 "SHA256:" 前缀
    expect(svc.answerHostKey(payload.reqId, "cancel")).toBe(true);
    expect(verified).toBe(false);
    c.emit("error", new Error("host key rejected"));
    await expect(p).rejects.toBeTruthy();
  });

  it("用户选 Continue(仅本次) → 放行且**不写** known_hosts", async () => {
    const s = sender();
    const p = svc.connect(s, host({ host: "once.example" }), { password: "pw" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    let verified = false;
    (c.config as { hostVerifier: (k: unknown, v: (ok: boolean) => void) => void })
      .hostVerifier(Buffer.from("once-key"), (ok) => { verified = ok; });
    const payload = s.send.mock.calls.find((x: unknown[]) => x[0] === "knownhost:ask")![1] as { reqId: string };
    svc.answerHostKey(payload.reqId, "continue");
    expect(verified).toBe(true);
    const khFile = path.join(HOME, ".ssh", "known_hosts");
    const text = fs.existsSync(khFile) ? fs.readFileSync(khFile, "utf8") : "";
    expect(text).not.toContain("once.example");
    c.emit("ready");
    await p;
  });

  it("用户选 Add and continue → 放行并写入 known_hosts", async () => {
    const s = sender();
    const key = Buffer.from("add-me-key");
    const p = svc.connect(s, host({ host: "add.example", port: 2222 }), { password: "pw" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    let verified = false;
    (c.config as { hostVerifier: (k: unknown, v: (ok: boolean) => void) => void })
      .hostVerifier(key, (ok) => { verified = ok; });
    const payload = s.send.mock.calls.find((x: unknown[]) => x[0] === "knownhost:ask")![1] as { reqId: string };
    svc.answerHostKey(payload.reqId, "add");
    expect(verified).toBe(true);
    const text = fs.readFileSync(path.join(HOME, ".ssh", "known_hosts"), "utf8");
    expect(text).toContain("[add.example]:2222");   // 非标准端口按 OpenSSH 约定写成 [host]:port
    c.emit("ready");
    await p;
  });

  it("对不存在的 reqId 作答返回 false(不抛)", () => {
    expect(svc.answerHostKey("hk_nope", "continue")).toBe(false);
  });
});

describe("会话管理与辅助连接", () => {
  it("clientOf/clientOfHost/hostIdOf 反映当前会话", async () => {
    const s = sender();
    const p = svc.connect(s, host({ id: "h_9", host: "aux.example" }), { password: "pw" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    c.emit("ready");
    const id = await p;
    expect(svc.clientOf(id)).toBe(c);
    expect(svc.hostIdOf(id)).toBe("h_9");
    expect(svc.clientOfHost("h_9")).toBe(c);
  });

  it("主动 dispose 不报断线(不向渲染层发 terminal:exit)", async () => {
    const s = sender();
    const p = svc.connect(s, host(), { password: "pw" }, { cols: 80, rows: 24 });
    const c = FakeClientCtor.last!;
    c.emit("ready");
    const id = await p;
    s.send.mockClear();
    svc.dispose(id);
    expect(c.stream.end).toHaveBeenCalled();
    expect(c.end).toHaveBeenCalled();
    expect(s.send.mock.calls.some((x: unknown[]) => x[0] === "terminal:exit")).toBe(false);
    expect(svc.clientOf(id)).toBeUndefined();
  });

  it("openAux:ready 后返回独立客户端;error 时拒绝", async () => {
    const p1 = svc.openAux(host({ host: "aux.example" }), { password: "pw" });
    const c1 = FakeClientCtor.last!;
    c1.emit("ready");
    await expect(p1).resolves.toBe(c1);

    const p2 = svc.openAux(host({ host: "aux2.example" }), { password: "pw" });
    FakeClientCtor.last!.emit("error", new Error("aux refused"));
    await expect(p2).rejects.toThrow(/aux refused/);
  });

  it("openAux 的主机密钥校验:已知一致才放行,未知直接拒绝(不弹窗)", async () => {
    const key = Buffer.from("aux-known-key");
    addHostKey("aux-known.example", key);
    const p = svc.openAux(host({ host: "aux-known.example" }), { password: "pw" });
    const c = FakeClientCtor.last!;
    const cfg = c.config as { hostVerifier: (k: unknown, v: (ok: boolean) => void) => void };
    let ok1: boolean | null = null;
    cfg.hostVerifier(key, (v) => { ok1 = v; });
    expect(ok1).toBe(true);

    let ok2: boolean | null = null;
    cfg.hostVerifier(Buffer.from("different-key"), (v) => { ok2 = v; });
    expect(ok2).toBe(false);
    c.emit("ready");
    await p;
  });
});
