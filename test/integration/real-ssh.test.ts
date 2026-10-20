import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserKey, startRealSshd, type RealSshd } from "../helpers/real-sshd";
import type { HostRecord } from "../../src/shared/host";

/**
 * 真实 SSH 集成测试:进程内起一个**真** ssh2 服务器,用产品代码的**真**客户端去连。
 *
 * 与 test/unit/main-ssh.test.ts 的分工:
 *   - 单测用假 Client,证明"我们的状态机/分支对";
 *   - 这里用真 Client,证明"我们对 ssh2 真实契约的理解对" —— 握手、认证失败的真实错误文案、
 *     主机密钥回调的真实参数、shell 通道的数据与退出语义、known_hosts 的键型/指纹。
 * 全部走 127.0.0.1 随机端口,三平台 CI 都能跑,不依赖 docker 或系统 sshd。
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-real-ssh-"));
const origHome = process.env.HOME;
const origProfile = process.env.USERPROFILE;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;   // Windows:os.homedir() 读 USERPROFILE

let SshService: typeof import("../../src/main/ssh").SshService;
let addHostKey: typeof import("../../src/main/knownhosts").addHostKey;
let server: RealSshd;

/** 收集渲染层会收到的消息(真实异步流 → 用小轮询等待) */
function makeSender() {
  const data: string[] = [];
  const exits: Array<{ exitCode: number; error?: string; reason?: string }> = [];
  const ask: Array<Record<string, unknown>> = [];
  return {
    data, exits, ask,
    sender: {
      isDestroyed: () => false,
      send: (ch: string, ...args: unknown[]) => {
        if (ch === "terminal:data") data.push(String(args[1]));
        else if (ch === "terminal:exit") exits.push(args[1] as never);
        else if (ch === "knownhost:ask") ask.push(args[0] as Record<string, unknown>);
      },
    } as never,
  };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const host = (over: Partial<HostRecord> = {}): HostRecord => ({
  id: "h_real", name: "real", host: "127.0.0.1", port: server.port,
  username: "u-pass", authType: "password", createdAt: new Date().toISOString(),
  ...over,
});

beforeAll(async () => {
  vi.resetModules();
  const kh = await import("../../src/main/knownhosts");
  addHostKey = kh.addHostKey;
  ({ SshService } = await import("../../src/main/ssh"));
  server = await startRealSshd();
});
afterAll(async () => {
  await server?.close();
  process.env.HOME = origHome;
  process.env.USERPROFILE = origProfile;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  server.observed.lastInput = "";
  server.observed.authFailures = 0;
});

describe("真实协议:密码认证 + shell 通道", () => {
  it("连上真实服务器:收到 shell 欢迎输出、输入被回显、退出码如实上报", async () => {
    const svc = new SshService();
    const s = makeSender();
    // 未知主机 → 会弹询问;这里直接答 add,验证"真实主机密钥 + 真实写入"整条链路
    const p = svc.connect(s.sender, host(), { password: "secret" }, { cols: 100, rows: 30 });
    await waitFor(() => s.ask.length > 0);
    const req = s.ask[0]!;
    expect(req.host).toBe(`[127.0.0.1]:${server.port}`);     // 非 22 端口按 OpenSSH 约定
    expect(String(req.fingerprint)).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(String(req.keyType)).toMatch(/^(ssh-rsa|rsa-sha2-256|rsa-sha2-512)$/);
    svc.answerHostKey(String(req.reqId), "add");
    const id = await p;

    // 真服务器把欢迎语写进 shell → 产品代码经 decoder 转成 terminal:data
    await waitFor(() => s.data.join("").includes("welcome"));
    expect(server.observed.ptys[0]).toBe("100x30");

    svc.write(id, "ls -la\r");
    await waitFor(() => s.data.join("").includes("echo:ls -la"));
    expect(server.observed.lastInput).toContain("ls -la");

    svc.resize(id, 120, 40);
    await waitFor(() => server.observed.windowChanges.length > 0);
    expect(server.observed.windowChanges.at(-1)).toEqual([120, 40]);

    svc.write(id, "exit 7\r");
    await waitFor(() => s.exits.length > 0);
    expect(s.exits[0]).toMatchObject({ exitCode: 7 });
  });

  it("known_hosts 落盘内容与真实主机密钥一致(能再次通过校验,不再询问)", async () => {
    const file = path.join(HOME, ".ssh", "known_hosts");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain(`[127.0.0.1]:${server.port}`);

    const svc = new SshService();
    const s = makeSender();
    const id = await svc.connect(s.sender, host({ id: "h_real2" }), { password: "secret" }, { cols: 80, rows: 24 });
    expect(s.ask).toHaveLength(0);          // 已知主机:不再询问
    await waitFor(() => s.data.join("").includes("welcome"));
    svc.dispose(id);
  });

  it("密码错误:真实 ssh2 的失败被识别为 auth(而不是笼统的 error)", async () => {
    const svc = new SshService();
    const s = makeSender();
    // 先把这个主机写进 known_hosts,避免被主机密钥询问拦住
    addHostKey(`[127.0.0.1]:${server.port}`, Buffer.from("placeholder-not-used"), "ssh-rsa");
    const p = svc.connect(s.sender, host({ id: "h_bad" }), { password: "wrong" }, { cols: 80, rows: 24 });
    const req = s.ask[0];
    if (req) svc.answerHostKey(String(req.reqId), "cancel");
    await expect(p).rejects.toThrow(/authentication|permission denied|all configured authentication/i);
    await waitFor(() => s.exits.length > 0);
    expect(s.exits[0]).toMatchObject({ reason: "auth" });
    expect(server.observed.authFailures).toBeGreaterThan(0);
  });
});

describe("真实协议:公钥认证与辅助连接", () => {
  it("私钥文件认证:客户端发出 publickey,服务器接受", async () => {
    const keyPath = path.join(HOME, "id_ed25519");
    const { publicKeyPem } = makeUserKey(keyPath);
    const keyServer = await startRealSshd({ keyUser: { username: "u-key", publicKeyPem } });
    try {
      const svc = new SshService();
      const s = makeSender();
      const h = host({ id: "h_key", port: keyServer.port, username: "u-key", authType: "key", keyPath });
      const p = svc.connect(s.sender, h, {}, { cols: 80, rows: 24 });
      await waitFor(() => s.ask.length > 0);
      svc.answerHostKey(String(s.ask[0]!.reqId), "add");
      const id = await p;
      expect(keyServer.observed.authMethods).toContain("publickey");
      expect(keyServer.observed.publicKeyAlgos.length).toBeGreaterThan(0);
      await waitFor(() => s.data.join("").includes("welcome"));
      svc.dispose(id);
    } finally {
      await keyServer.close();
    }
  });

  it("openAux:已知主机密钥不一致时拒绝(不弹窗),一致时成功", async () => {
    const khFile = path.join(HOME, ".ssh", "known_hosts");
    const original = fs.readFileSync(khFile, "utf8");
    const field = `[127.0.0.1]:${server.port}`;
    try {
      // 把该主机的已知密钥换成一把无关的密钥 -> 真实握手时状态是 changed -> openAux 直接拒绝
      const bogus = Buffer.from("wrong-key-blob-for-test").toString("base64");
      fs.writeFileSync(khFile, `${field} ssh-rsa ${bogus}\n`);
      const svc = new SshService();
      await expect(svc.openAux(host({ id: "h_aux_bad" }), { password: "secret" }))
        .rejects.toThrow(/host|verif|authentication|closed|timed out/i);
    } finally {
      fs.writeFileSync(khFile, original);
    }

    // 恢复真实密钥后 -> 第二条连接成功
    const knownSvc = new SshService();
    const aux = await knownSvc.openAux(host({ id: "h_aux_ok" }), { password: "secret" });
    // 断言拿到的是真实 ssh2 Client(具备完整 API),不是"某个真值"
    expect(typeof aux.forwardOut).toBe("function");
    expect(typeof aux.sftp).toBe("function");
    aux.end();
  });
});
