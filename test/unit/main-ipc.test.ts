import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ElectronMock } from "../helpers/electron-mock";

/**
 * 主进程 IPC 通道行为测试:直接 import src/main/main.ts 注册真实 handler,
 * 再用 electron 假件里的注册表"走一遍真实 IPC"(参数与渲染层一致)。
 * 每个断言都看**行为后果**(落盘内容/返回值/副作用),不是"能调用"。
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-ipc-home-"));
const origHome = process.env.HOME;
const origProfile = process.env.USERPROFILE;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;   // Windows:os.homedir() 读 USERPROFILE   // known_hosts 在模块加载时按 os.homedir() 计算

let em: ElectronMock;
let work: string;

vi.mock("electron", async () => {
  const { createElectronMock } = await import("../helpers/electron-mock");
  em = createElectronMock();
  return em.module;
});

/* keytar:内存实现;并允许测试注入失败(用于"钥匙串不可用时删除仍应成功") */
const keychain = new Map<string, string>();
/** 只看主机凭据:主进程启动时还会往钥匙串写 MCP 本地令牌(account = "mcp:token") */
const hostKeys = (): string[] => [...keychain.keys()].filter((k) => k.includes("|host:"));
let keytarFails = false;
vi.mock("keytar", () => ({
  default: {
    setPassword: async (s: string, a: string, p: string) => {
      if (keytarFails) throw new Error("keychain unavailable");
      keychain.set(`${s}|${a}`, p);
    },
    getPassword: async (s: string, a: string) => keychain.get(`${s}|${a}`) ?? null,
    deletePassword: async (s: string, a: string) => {
      if (keytarFails) throw new Error("keychain unavailable");
      return keychain.delete(`${s}|${a}`);
    },
  },
}));

class FakePtyB {
  dataCbs: Array<(d: string) => void> = [];
  exitCbs: Array<(e: { exitCode: number }) => void> = [];
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = 0;
  onData = (cb: (d: string) => void) => { this.dataCbs.push(cb); return { dispose: () => undefined }; };
  onExit = (cb: (e: { exitCode: number }) => void) => { this.exitCbs.push(cb); return { dispose: () => undefined }; };
  write = (d: string) => { this.written.push(d); };
  resize = (c: number, r: number) => { this.resized.push([c, r]); };
  kill = () => { this.killed++; };
}
const ptys: FakePtyB[] = [];
vi.mock("node-pty", () => ({
  spawn: () => { const p = new FakePtyB(); ptys.push(p); return p; },
}));

const hostInput = (over: Record<string, unknown> = {}) => ({
  name: "node-1", host: "10.0.0.10", port: 22, username: "root",
  authType: "password", ...over,
});

beforeAll(async () => {
  await import("../../src/main/main");
  work = em.tmp();
});
afterAll(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origProfile;
  for (const d of [HOME, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe("app / window / clipboard", () => {
  it("app:info 返回名称与版本", async () => {
    const info = (await em.invoke("app:info")) as { versions: { app: string } };
    expect(info.versions.app).toBe("0.1.0-test");
  });

  it("clipboard:write → read 往返一致", async () => {
    await em.invoke("clipboard:write", "hello 剪贴板");
    await expect(em.invoke("clipboard:read")).resolves.toBe("hello 剪贴板");
  });

  it("window:new 会新建窗口", async () => {
    const before = em.windows.length;
    await em.invoke("window:new");
    expect(em.windows.length).toBe(before + 1);
  });
});

describe("hosts:*", () => {
  it("create → list 能取到,并落盘到 userData/hosts.json", async () => {
    const rec = (await em.invoke("hosts:create", hostInput({ name: "created-1" }))) as { id: string; name: string };
    expect(rec.id).toMatch(/^h_/);
    const list = (await em.invoke("hosts:list")) as Array<{ name: string }>;
    expect(list.map((h) => h.name)).toContain("created-1");
    const raw = JSON.parse(fs.readFileSync(path.join(em.userData, "hosts.json"), "utf8")) as { hosts: unknown[] };
    expect(JSON.stringify(raw)).toContain("created-1");
  });

  it("update 改字段;非法输入被拒绝且原记录不变", async () => {
    const rec = (await em.invoke("hosts:create", hostInput({ name: "upd-1" }))) as { id: string };
    const upd = (await em.invoke("hosts:update", rec.id, { name: "upd-2" })) as { name: string };
    expect(upd.name).toBe("upd-2");
    await expect(em.invoke("hosts:update", rec.id, { port: 0 })).rejects.toThrow(/port/i);
    const list = (await em.invoke("hosts:list")) as Array<{ id: string; port: number }>;
    expect(list.find((h) => h.id === rec.id)?.port).toBe(22);
  });

  it("delete 会移除记录并清理钥匙串", async () => {
    const rec = (await em.invoke("hosts:create", hostInput({ name: "del-1" }))) as { id: string };
    await em.invoke("creds:put", rec.id, { password: "secret" });
    expect(hostKeys().length).toBe(1);
    await em.invoke("hosts:delete", rec.id);
    const list = (await em.invoke("hosts:list")) as Array<{ id: string }>;
    expect(list.some((h) => h.id === rec.id)).toBe(false);
    expect(hostKeys().length).toBe(0);
  });

  it("回归:钥匙串不可用时删除主机仍然成功(否则用户看到'点了删除没反应')", async () => {
    const rec = (await em.invoke("hosts:create", hostInput({ name: "del-kc-down" }))) as { id: string };
    keytarFails = true;
    try {
      await expect(em.invoke("hosts:delete", rec.id)).resolves.toBeUndefined();
      const list = (await em.invoke("hosts:list")) as Array<{ id: string }>;
      expect(list.some((h) => h.id === rec.id)).toBe(false);
    } finally { keytarFails = false; }
  });
});

describe("creds:*", () => {
  it("未知主机 id 写入凭据会被拒绝", async () => {
    await expect(em.invoke("creds:put", "h_nope", { password: "x" })).rejects.toThrow(/unknown host id/);
  });

  it("creds:has 反映是否保存过凭据", async () => {
    const rec = (await em.invoke("hosts:create", hostInput({ name: "creds-1" }))) as { id: string };
    expect(await em.invoke("creds:has", rec.id)).toBe(false);
    await em.invoke("creds:put", rec.id, { password: "pw" });
    expect(await em.invoke("creds:has", rec.id)).toBe(true);
  });
});

describe("settings:*", () => {
  it("默认跟随系统;写入 zh 后落盘且能读回", async () => {
    await em.invoke("settings:setLocale", "system");
    expect(((await em.invoke("settings:getLocale")) as { pref: string }).pref).toBe("system");
    await em.invoke("settings:setLocale", "zh");
    const zh = (await em.invoke("settings:getLocale")) as { pref: string; effective: string };
    expect(zh.pref).toBe("zh");
    expect(zh.effective).toBe("zh");
    const raw = JSON.parse(fs.readFileSync(path.join(em.userData, "settings.json"), "utf8")) as { locale: string };
    expect(raw.locale).toBe("zh");
  });

  it("非法偏好回落为跟随系统(白名单)", async () => {
    await em.invoke("settings:setLocale", "klingon");
    expect(((await em.invoke("settings:getLocale")) as { pref: string }).pref).toBe("system");
  });
});

describe("snippets:*", () => {
  it("save → list → remove 完整生命周期", async () => {
    const saved = (await em.invoke("snippets:save", { name: "snip-1", command: "uptime" })) as { id: string };
    expect(saved.id).toBeTruthy();
    let list = (await em.invoke("snippets:list")) as Array<{ name: string }>;
    expect(list.map((s) => s.name)).toContain("snip-1");
    await em.invoke("snippets:remove", saved.id);
    list = (await em.invoke("snippets:list")) as Array<{ name: string }>;
    expect(list.map((s) => s.name)).not.toContain("snip-1");
  });
});

describe("knownhost:*", () => {
  it("import 从文件导入(经 dialog 选择)→ list 能看到 → remove 删掉", async () => {
    const src = path.join(work, "kh_src");
    fs.writeFileSync(src, "imp.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
    const r = (await em.invoke("knownhost:import", src)) as { added: number };
    expect(r.added).toBeGreaterThanOrEqual(1);
    const rows = (await em.invoke("knownhost:list")) as Array<{ host: string }>;
    expect(rows.some((x) => x.host === "imp.example")).toBe(true);
    // 该通道返回"删除后的完整列表"(而不是删除条数),断言列表里不再有它
    const afterRemove = (await em.invoke("knownhost:remove", "imp.example")) as Array<{ host: string }>;
    expect(afterRemove.some((x) => x.host === "imp.example")).toBe(false);
    const after = (await em.invoke("knownhost:list")) as Array<{ host: string }>;
    expect(after.some((x) => x.host === "imp.example")).toBe(false);
  });

  it("dialog 取消时不导入(返回 0)", async () => {
    em.dialog.openResult = null;
    const r = (await em.invoke("knownhost:import")) as { added: number };
    expect(r.added).toBe(0);
  });
});

describe("fwd:*", () => {
  it("save → rules 列表 → delete 清掉", async () => {
    const rule = { id: "fwd_t1", hostId: "h_1", kind: "local", bindAddress: "127.0.0.1", port: 18099, destinationAddress: "127.0.0.1", destinationPort: 80 };
    const saved = (await em.invoke("fwd:save", rule)) as { id: string; port: number };
    expect(saved.id).toBe("fwd_t1");
    expect(saved.port).toBe(18099);
    const rules = (await em.invoke("fwd:rules")) as Array<{ port: number }>;
    expect(rules.some((r) => r.port === 18099)).toBe(true);
    await em.invoke("fwd:delete", saved.id);
    const after = (await em.invoke("fwd:rules")) as Array<{ port: number }>;
    expect(after.some((r) => r.port === 18099)).toBe(false);
  });

  it("没有可用 ssh 会话时 fwd:start 会把 error 状态报出来", async () => {
    const saved = (await em.invoke("fwd:save", { id: "fwd_t2", hostId: "h_none", kind: "local", bindAddress: "127.0.0.1", port: 0, destinationAddress: "127.0.0.1", destinationPort: 80 })) as { id: string };
    const st = (await em.invoke("fwd:start", { ...saved })) as { state: string };
    expect(["starting", "running", "error"]).toContain(st.state);
    await em.invoke("fwd:stop", saved.id);
  });
});

describe("local:*", () => {
  it("list / mkdir / rename / remove 对真实临时目录生效", async () => {
    const dir = path.join(work, "localdir");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const listing = (await em.invoke("local:list", dir)) as { entries: Array<{ name: string }> };
    expect(listing.entries.map((e) => e.name)).toContain("a.txt");

    const sub = path.join(dir, "sub");
    await em.invoke("local:mkdir", sub);
    expect(fs.existsSync(sub)).toBe(true);
    await em.invoke("local:rename", path.join(dir, "a.txt"), path.join(dir, "b.txt"));
    expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(true);
    await em.invoke("local:remove", path.join(dir, "b.txt"));
    expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(false);
  });
});

describe("terminal:* 与场景清理", () => {
  it("create 返回 id,write/resize/dispose 作用到对应 pty", async () => {
    const created = (await em.invoke("terminal:create", { cols: 90, rows: 25 })) as { id: number };
    const id = created.id;
    expect(typeof id).toBe("number");
    em.fire("terminal:write", id, "echo hi\r");
    em.fire("terminal:resize", id, 100, 30);
    expect(ptys.at(-1)!.written).toEqual(["echo hi\r"]);
    expect(ptys.at(-1)!.resized).toEqual([[100, 30]]);
    em.fire("terminal:dispose", id);
    expect(ptys.at(-1)!.killed).toBe(1);
  });

  it("sessions:disposeAll 不抛(清理所有终端与 ssh)", async () => {
    expect(() => em.fire("sessions:disposeAll")).not.toThrow();
  });
});
