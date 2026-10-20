import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmDir, tmpDir } from "../helpers/tmp";
import { SnippetStore } from "../../src/main/snippets";
import type { HostRecord } from "../../src/shared/host";

/* ssh.ts 用假客户端(与 main-ssh.test.ts 同思路,但这里专测鉴权配置分支) */
class FakeClient extends EventEmitter {
  config: Record<string, unknown> | null = null;
  connect(cfg: Record<string, unknown>) { this.config = cfg; }
  end = vi.fn();
  shell(_o: unknown, cb: (e: Error | null, s: EventEmitter) => void) {
    const s = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), setWindow: vi.fn() });
    cb(null, s);
  }
}
let last: FakeClient;
let SshService: typeof import("../../src/main/ssh").SshService;

const HOME = tmpDir("sshkit-auth-home-");
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

beforeEach(async () => {
  fs.mkdirSync(HOME, { recursive: true });   // 上一用例的 afterEach 会删掉 HOME,这里重建
  vi.resetModules();
  ({ SshService } = await import("../../src/main/ssh"));
});

afterEach(() => rmDir(HOME));

const host = (over: Partial<HostRecord> = {}): HostRecord => ({
  id: "h_a", name: "n", host: "h.example", port: 22, username: "root",
  authType: "password", createdAt: new Date().toISOString(), ...over,
});
const sender = () => ({ send: vi.fn(), isDestroyed: () => false });

describe("SnippetStore", () => {
  let file: string;
  beforeEach(() => { file = path.join(tmpDir("sshkit-snip-"), "snippets.json"); });

  it("save 生成 id 并落盘;重建实例能读回", () => {
    const dir = path.dirname(file);
    const s = new SnippetStore(file);
    s.saveSnippet({ name: "uptime", command: "uptime -p" });
    expect(s.list().map((x) => x.name)).toEqual(["uptime"]);
    expect(fs.existsSync(file)).toBe(true);
    const again = new SnippetStore(file);
    expect(again.list().map((x) => x.name)).toEqual(["uptime"]);
    rmDir(dir);
  });

  it("load 会丢弃损坏数据并裁剪过长字段(不让坏文件拖垮功能)", () => {
    const s = new SnippetStore(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([
      { id: "a", name: "ok", command: "echo hi" },
      { name: "toolong", command: "x".repeat(5000) },
      { name: "", command: "" },          // 空记录应被过滤
      "not-an-object",
    ]));
    const loaded = new SnippetStore(file);
    const list = loaded.list();
    expect(list.map((x) => x.name)).toContain("ok");
    const long = list.find((x) => x.name === "toolong");
    expect(long?.command.length).toBe(4000);
    expect(list.every((x) => x.name || x.command)).toBe(true);
    void s;
  });

  it("文件损坏(非 JSON)时从空清单起步,不抛", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{oops");
    expect(new SnippetStore(file).list()).toEqual([]);
  });

  it("remove 只删指定 id", () => {
    const s = new SnippetStore(file);
    s.saveSnippet({ name: "a", command: "1" });
    s.saveSnippet({ name: "b", command: "2" });
    const a = s.list().find((x) => x.name === "a")!;
    s.remove(a.id);
    expect(s.list().map((x) => x.name)).toEqual(["b"]);
  });
});

describe("SshService:鉴权配置", () => {
  const mk = () => new SshService(() => { last = new FakeClient(); return last as never; });

  it("password 模式把密码写进配置;缺密码直接报错", async () => {
    const svc = mk();
    const p = svc.connect(sender() as never, host(), { password: "pw" }, { cols: 80, rows: 24 });
    expect(last.config).toMatchObject({ password: "pw" });
    last.emit("ready");
    await p;

    await expect(svc.connect(sender() as never, host({ id: "h_b" }), {}, { cols: 80, rows: 24 }))
      .rejects.toThrow(/no saved password/i);
  });

  it("key 模式读取私钥文件并带 passphrase;文件不存在时报错", async () => {
    const keyPath = path.join(HOME, "id_test");
    fs.writeFileSync(keyPath, "PRIVATE-KEY-CONTENT");
    const svc = mk();
    const p = svc.connect(sender() as never, host({ authType: "key", keyPath }), { passphrase: "pp" }, { cols: 80, rows: 24 });
    expect(String((last.config as { privateKey: unknown }).privateKey)).toContain("PRIVATE-KEY-CONTENT");
    expect(last.config).toMatchObject({ passphrase: "pp" });
    last.emit("ready");
    await p;

    await expect(svc.connect(sender() as never, host({ id: "h_c", authType: "key", keyPath: path.join(HOME, "missing") }), {}, { cols: 80, rows: 24 }))
      .rejects.toThrow(/ENOENT|no such file/i);
  });

  it("agent 模式用 SSH_AUTH_SOCK", async () => {
    const old = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    try {
      const svc = mk();
      const p = svc.connect(sender() as never, host({ authType: "agent" }), {}, { cols: 80, rows: 24 });
      expect(last.config).toMatchObject({ agent: "/tmp/agent.sock" });
      last.emit("ready");
      await p;
    } finally {
      if (old === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = old;
    }
  });

  it("keepalive 与 readyTimeout 有明确取值(主机密钥询问要等用户)", async () => {
    const svc = mk();
    const p = svc.connect(sender() as never, host(), { password: "pw" }, { cols: 80, rows: 24 });
    expect(last.config).toMatchObject({ keepaliveInterval: 15000, keepaliveCountMax: 5, readyTimeout: 120_000 });
    last.emit("ready");
    await p;
  });
});
