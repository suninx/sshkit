import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmDir, tmpDir } from "../helpers/tmp";

/**
 * keystore.ts / pty.ts / settings.ts / snippets.ts / store.ts 的覆盖率补齐。
 * 共同主题:写盘失败不静默、平台/环境变量兜底、以及存储层对坏数据的容忍。
 */

/* ---------------- 假件 ---------------- */

const keychain = new Map<string, string>();
let keychainBroken = false;
vi.mock("keytar", () => ({
  default: {
    setPassword: async (svc: string, acct: string, pw: string) => {
      if (keychainBroken) throw new Error("keychain unavailable");
      keychain.set(`${svc}|${acct}`, pw);
    },
    getPassword: async (svc: string, acct: string) => keychain.get(`${svc}|${acct}`) ?? null,
    deletePassword: async (svc: string, acct: string) => keychain.delete(`${svc}|${acct}`),
  },
}));

interface SpawnOpts { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
const spawned: Array<{ file: string; args: string[]; opts: SpawnOpts }> = [];
class FakePty {
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
let lastPty: FakePty;
vi.mock("node-pty", () => ({
  spawn: (file: string, args: string[], opts: SpawnOpts) => {
    spawned.push({ file, args, opts });
    lastPty = new FakePty();
    return lastPty;
  },
}));

vi.mock("electron", () => ({
  app: { getPath: () => (globalThis as { __userData?: string }).__userData ?? "/tmp/sshkit-cov-default" },
}));

const { putCreds, getCreds, deleteCreds } = await import("../../src/main/keystore");
const { PtyService } = await import("../../src/main/pty");
const { SnippetStore } = await import("../../src/main/snippets");
const { HostStore } = await import("../../src/main/store");

let dir: string;
beforeEach(() => {
  dir = tmpDir("sshkit-cov-misc-");
  keychain.clear();
  keychainBroken = false;
  spawned.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (benchEnv === undefined) delete process.env.SSHKIT_BENCH;
  rmDir(dir);
});
const benchEnv = process.env.SSHKIT_BENCH;

const withPlatform = async (platform: NodeJS.Platform, fn: () => void | Promise<void>): Promise<void> => {
  const orig = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { await fn(); } finally { Object.defineProperty(process, "platform", { value: orig, configurable: true }); }
};

const withEnv = async (patch: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> => {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(patch)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

/* ---------------- keystore ---------------- */

describe("keystore:凭据只写不读的边界", () => {
  it("password/passphrase 都写入;空值不落库(不产生空字段)", async () => {
    await putCreds("h_1", { password: "pw", passphrase: "pp" });
    await expect(getCreds("h_1")).resolves.toEqual({ password: "pw", passphrase: "pp" });
    expect([...keychain.values()][0]).toBe(JSON.stringify({ password: "pw", passphrase: "pp" }));

    await putCreds("h_2", { password: "", passphrase: undefined });
    expect([...keychain.entries()].find(([k]) => k.endsWith("h_2"))![1]).toBe("{}");
    // 没有存过 → {}
    await expect(getCreds("h_missing")).resolves.toEqual({});
  });

  it("只写 passphrase 时不带 password 字段", async () => {
    await putCreds("h_3", { passphrase: "only-pp" });
    await expect(getCreds("h_3")).resolves.toEqual({ password: undefined, passphrase: "only-pp" });
  });

  it("钥匙串里的 JSON 损坏时:返回空对象但必须打日志(不能装成没存过)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    keychain.set("sshkit|host:h_bad", "{not json");
    await expect(getCreds("h_bad")).resolves.toEqual({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("凭据无法解析"), expect.anything());
  });

  it("deleteCreds 下发到钥匙串", async () => {
    await putCreds("h_del", { password: "x" });
    await deleteCreds("h_del");
    await expect(getCreds("h_del")).resolves.toEqual({});
  });
});

/* ---------------- pty ---------------- */

describe("pty:平台与环境变量兜底", () => {
  it("Windows:优先 $COMSPEC;没有则退回 powershell.exe", async () => {
    await withPlatform("win32", async () => {
      await withEnv({ COMSPEC: "C:\\Windows\\system32\\cmd.exe" }, () => {
        new PtyService().create({ send: vi.fn(), isDestroyed: () => false } as never, { cols: 80, rows: 24 });
        expect(spawned.at(-1)!.file).toBe("C:\\Windows\\system32\\cmd.exe");
      });
      await withEnv({ COMSPEC: undefined }, () => {
        new PtyService().create({ send: vi.fn(), isDestroyed: () => false } as never, { cols: 80, rows: 24 });
        expect(spawned.at(-1)!.file).toBe("powershell.exe");
      });
    });
  });

  it("非 Windows:优先 $SHELL;没有则 /bin/zsh", async () => {
    await withPlatform("darwin", async () => {
      await withEnv({ SHELL: "/bin/bash" }, () => {
        new PtyService().create({ send: vi.fn(), isDestroyed: () => false } as never, { cols: 80, rows: 24 });
        expect(spawned.at(-1)!.file).toBe("/bin/bash");
      });
      await withEnv({ SHELL: undefined }, () => {
        new PtyService().create({ send: vi.fn(), isDestroyed: () => false } as never, { cols: 80, rows: 24 });
        expect(spawned.at(-1)!.file).toBe("/bin/zsh");
      });
    });
  });

  it("cwd 优先级:opts.cwd > HOME > USERPROFILE > os.homedir()", async () => {
    const sender = () => ({ send: vi.fn(), isDestroyed: () => false });
    const cwdOf = (cwdOpt?: string) => {
      new PtyService().create(sender() as never, { cols: 80, rows: 24, ...(cwdOpt ? { cwd: cwdOpt } : {}) });
      return spawned.at(-1)!.opts.cwd;
    };

    expect(cwdOf("/explicit")).toBe("/explicit");
    await withEnv({ HOME: "/home/u" }, () => { expect(cwdOf()).toBe("/home/u"); });
    await withEnv({ HOME: undefined, USERPROFILE: "/users/u" }, () => { expect(cwdOf()).toBe("/users/u"); });
    await withEnv({ HOME: undefined, USERPROFILE: undefined }, () => { expect(cwdOf()).toBe(os.homedir()); });
  });

  it("LANG 缺省时回落到 en_US.UTF-8;显式值时沿用", async () => {
    const sender = () => ({ send: vi.fn(), isDestroyed: () => false });
    await withEnv({ LANG: undefined }, () => {
      new PtyService().create(sender() as never, { cols: 80, rows: 24 });
      expect(spawned.at(-1)!.opts.env.LANG).toBe("en_US.UTF-8");
    });
    await withEnv({ LANG: "zh_CN.UTF-8" }, () => {
      new PtyService().create(sender() as never, { cols: 80, rows: 24 });
      expect(spawned.at(-1)!.opts.env.LANG).toBe("zh_CN.UTF-8");
    });
  });

  it("bench 模式下 write 会打印命中/未命中(含未知 id)", () => {
    process.env.SSHKIT_BENCH = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const svc = new PtyService();
    const id = svc.create({ send: vi.fn(), isDestroyed: () => false } as never, { cols: 80, rows: 24 });
    svc.write(id, "ls");
    svc.write(99999, "nope");
    const lines = log.mock.calls.map((c) => c.map(String).join(" "));
    expect(lines.some((l) => l.includes("pty.write") && l.includes("ok"))).toBe(true);
    expect(lines.some((l) => l.includes("找不到该 pty"))).toBe(true);
  });
});

/* ---------------- settings ---------------- */

describe("settings:写盘失败时缓存仍然生效", () => {
  it("userData 路径不可写:setSetting 不抛、内存值已更新、console.error 留痕", async () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "file-not-dir");
    (globalThis as { __userData?: string }).__userData = path.join(blocker, "userdata");
    vi.resetModules();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { getSettings, setSetting } = await import("../../src/main/settings");
    const next = setSetting("locale", "zh");
    expect(next.locale).toBe("zh");
    expect(getSettings().locale).toBe("zh");
    expect(err).toHaveBeenCalledWith("[settings] 写入失败:", expect.anything());
    expect(fs.existsSync(path.join(blocker, "userdata", "settings.json"))).toBe(false);
  });
});

/* ---------------- snippets ---------------- */

describe("snippets:坏数据与写盘失败", () => {
  const fileOf = () => path.join(dir, "snippets.json");

  it("JSON 不是数组时按空清单处理", () => {
    fs.writeFileSync(fileOf(), JSON.stringify({ items: [] }));
    expect(new SnippetStore(fileOf()).list()).toEqual([]);
  });

  it("缺 name/command 的条目补空串;两者都空的被过滤", () => {
    fs.writeFileSync(fileOf(), JSON.stringify([
      { id: "a", name: "has-name" },
      { id: "b", command: "echo b" },
      { id: "c" },
      { id: "d", name: null, command: null },
    ]));
    const list = new SnippetStore(fileOf()).list();
    expect(list.map((x) => x.name)).toEqual(["has-name", ""]);
    expect(list.map((x) => x.command)).toEqual(["", "echo b"]);
  });

  it("saveSnippet:name/command 为 undefined 时落空串;重复 id 是更新、未知 id 是新增", () => {
    const s = new SnippetStore(fileOf());
    const created = s.saveSnippet({ name: "n1", command: "c1" });
    const updated = s.saveSnippet({ id: created.id, name: "n2", command: "c2" });
    expect(updated.id).toBe(created.id);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]).toMatchObject({ name: "n2", command: "c2" });

    const withUnknownId = s.saveSnippet({ id: "ghost", name: "n3", command: "c3" });
    expect(withUnknownId.id).not.toBe("ghost");
    expect(s.list().map((x) => x.name).sort()).toEqual(["n2", "n3"]);

    const empty = s.saveSnippet({ name: undefined as never, command: undefined as never });
    expect(empty).toMatchObject({ name: "", command: "" });
  });

  it("写盘失败时 saveSnippet 不抛,但 console.error 留痕,内存清单仍可用", () => {
    const blocker = path.join(dir, "blocker-file");
    fs.writeFileSync(blocker, "x");
    const brokenFile = path.join(blocker, "snippets.json");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = new SnippetStore(brokenFile);
    const saved = s.saveSnippet({ name: "kept", command: "in-memory" });
    expect(saved.name).toBe("kept");
    expect(s.list().map((x) => x.name)).toEqual(["kept"]);
    expect(err).toHaveBeenCalledWith("[snippets] 写入失败:", expect.anything());
  });
});

/* ---------------- store ---------------- */

describe("store:输入缺省与坏文件", () => {
  const base = { name: "n", host: "192.0.2.1", port: 22, username: "root", authType: "password" as const };

  it("host/port/username 缺省时的默认值与拒绝", () => {
    const s = new HostStore(dir);
    expect(() => s.create({ ...base, host: undefined as never })).toThrow(/host/i);
    expect(() => s.create({ ...base, username: undefined as never })).toThrow(/username/i);
    const rec = s.create({ ...base, port: undefined as never });
    expect(rec.port).toBe(22); // port 缺省 → 22
  });

  it("name 缺省时用 host;password 认证不需要 keyPath", () => {
    const s = new HostStore(dir);
    const rec = s.create({ ...base, name: undefined as never });
    expect(rec.name).toBe("192.0.2.1");
    expect(rec.keyPath).toBeUndefined();
    expect(rec.group).toBeUndefined();
    expect(rec.tags).toBeUndefined();
  });

  it("key 认证缺 keyPath 被拒绝;tags 去重去空并截到 32 个", () => {
    const s = new HostStore(dir);
    expect(() => s.create({ ...base, authType: "key" })).toThrow(/keyPath/i);
    const rec = s.create({
      ...base,
      authType: "key",
      keyPath: " ~/.ssh/id_ed25519 ",
      tags: [" a ", "a", "", "  ", "b", ...Array.from({ length: 40 }, (_, i) => `t${i}`)],
    });
    expect(rec.keyPath).toBe("~/.ssh/id_ed25519");
    expect(rec.tags).toEqual(["a", "b", ...Array.from({ length: 32 }, (_, i) => `t${i}`)].slice(0, 32));
  });

  it("update 未知 id 抛错", () => {
    const s = new HostStore(dir);
    expect(() => s.update("h_missing", { name: "x" })).toThrow(/unknown host id/);
  });

  it("hosts.json 的 hosts 不是数组时按空清单启动", () => {
    fs.writeFileSync(path.join(dir, "hosts.json"), JSON.stringify({ version: 1, hosts: {} }));
    expect(new HostStore(dir).list()).toEqual([]);
  });
});
