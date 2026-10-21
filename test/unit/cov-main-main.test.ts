/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519Blob } from "../helpers/keys";
import type { ElectronMock } from "../helpers/electron-mock";

/* 本文件的「应用菜单」用例测的就是 macOS 菜单(带 ⌘, 偏好设置入口)。
   installAppMenu 在 main.ts 启动时按 process.platform 决定是"装菜单"还是"清空菜单",
   而 GitHub 的 Linux/Windows runner 上会走后者 —— 于是这些断言必然红。
   用 vi.hoisted 在模块 import 之前把平台声明成 darwin:
   这样三平台都能验证同一个产品逻辑,且不影响其它测试文件(每个文件独立进程)。 */
vi.hoisted(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});

/**
 * main.ts 覆盖率补齐:菜单(偏好设置入口 / 语言重建 / 非 mac 平台)、bench 窗口定位、
 * 渲染层 console 转发、ssh:connect 的三类认证与终端转发、knownhost 导入对话框、
 * 端口转发与 SFTP 的状态推送(含窗口已关保护)、app 生命周期钩子。
 *
 * 断言的都是行为后果:菜单项点击真的发 prefs:open、转发状态真的推到窗口、
 * 窗口没了就不该再往它发消息、before-quit 真的收掉 pty/ssh/转发。
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-cov-main-home-"));
const origHome = process.env.HOME;
const origProfile = process.env.USERPROFILE;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const KEY_BLOB = ed25519Blob(1);

let em: ElectronMock;
let T: {
  menu: { built: any[][]; set: any[] };
  dialogCalls: unknown[][];
  consoleHandlers: Map<unknown, (event: unknown, ...args: unknown[]) => void>;
  senderEvents: unknown[][];
  quitCalls: () => number;
  setSenderDestroyed: (v: boolean) => void;
  setSystemLangs: (v: string[] | undefined) => void;
  setSystemLangFn: (fn: (() => string[]) | undefined) => void;
  resetSystemLangFn: () => void;
};
let BrowserWin: any;
let clipboardState: { text: string };
let dialogState: { openResult: string[] | null; messages: string[] };
let sshClients: any[];

/* ---------------- vi.mock:electron ---------------- */
vi.mock("electron", async () => {
  const { createElectronMock } = await import("../helpers/electron-mock");
  const base: ElectronMock = createElectronMock();
  const module = base.module as Record<string, any>;

  let systemLangs: string[] | undefined = [];
  module.app.getPreferredSystemLanguages = () => systemLangs;
  let quitCalls = 0;
  module.app.quit = () => { quitCalls++; };

  const menu = { built: [] as any[][], set: [] as any[] };
  module.Menu.buildFromTemplate = (t: any[]) => { menu.built.push(t); return { template: t }; };
  module.Menu.setApplicationMenu = (m: any) => { menu.set.push(m); };

  const consoleHandlers = new Map<unknown, (event: unknown, ...args: unknown[]) => void>();
  const BaseWin = module.BrowserWindow as new (opts: Record<string, unknown>) => any;
  class Win extends BaseWin {
    constructor(opts: Record<string, unknown>) {
      super(opts);
      const orig = this.webContents;
      this.webContents = {
        ...orig,
        on: (ev: string, cb: (event: unknown, ...args: unknown[]) => void) => {
          if (ev === "console-message") consoleHandlers.set(this, cb);
        },
      };
    }
  }
  (Win as any).fromWebContents = () => null;
  module.BrowserWindow = Win;

  const dialogCalls: unknown[][] = [];
  const origDialog = module.dialog.showOpenDialog as (...a: unknown[]) => Promise<unknown>;
  module.dialog.showOpenDialog = (...a: unknown[]) => { dialogCalls.push(a); return origDialog(...a); };

  const senderEvents: unknown[][] = [];
  let senderDestroyed = false;
  const testSender = {
    send: (ch: string, ...a: unknown[]) => { senderEvents.push([ch, ...a]); },
    isDestroyed: () => senderDestroyed,
  };
  base.invoke = async (channel: string, ...args: unknown[]) => {
    const fn = base.handlers.get(channel);
    if (!fn) throw new Error(`no ipc handler registered: ${channel}`);
    return await fn({ sender: testSender }, ...args);
  };
  base.fire = (channel: string, ...args: unknown[]) => {
    const fn = base.onHandlers.get(channel);
    if (!fn) throw new Error(`no ipc on-handler registered: ${channel}`);
    fn({ sender: testSender }, ...args);
  };

  module.__test = {
    menu,
    dialogCalls,
    consoleHandlers,
    senderEvents,
    quitCalls: () => quitCalls,
    setSenderDestroyed: (v: boolean) => { senderDestroyed = v; },
    setSystemLangs: (v: string[] | undefined) => { systemLangs = v; },
    setSystemLangFn: (fn: (() => string[]) | undefined) => { module.app.getPreferredSystemLanguages = fn; },
    resetSystemLangFn: () => { module.app.getPreferredSystemLanguages = () => systemLangs; },
  };

  em = base;
  T = module.__test;
  BrowserWin = Win;
  clipboardState = base.clipboard;
  dialogState = base.dialog;
  return module;
});

/* ---------------- vi.mock:node-pty ---------------- */
const ptys: any[] = [];
vi.mock("node-pty", () => ({
  spawn: () => {
    const p = {
      written: [] as string[],
      resized: [] as Array<[number, number]>,
      killed: 0,
      throwOnWrite: false,
      dataCbs: [] as Array<(d: string) => void>,
      exitCbs: [] as Array<(e: { exitCode: number }) => void>,
      onData: (cb: (d: string) => void) => { p.dataCbs.push(cb); return { dispose: () => undefined }; },
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exitCbs.push(cb); return { dispose: () => undefined }; },
      write: (d: string) => { if (p.throwOnWrite) throw new Error("pty write boom"); p.written.push(d); },
      resize: (c: number, r: number) => { p.resized.push([c, r]); },
      kill: () => { p.killed++; },
    };
    ptys.push(p);
    return p;
  },
}));

/* ---------------- vi.mock:keytar ---------------- */
const keychain = new Map<string, string>();
let keychainBroken = false;
vi.mock("keytar", () => ({
  default: {
    setPassword: async (svc: string, acct: string, pw: string) => {
      if (keychainBroken) throw new Error("keychain unavailable");
      keychain.set(`${svc}|${acct}`, pw);
    },
    getPassword: async (svc: string, acct: string) => {
      if (keychainBroken) throw new Error("keychain unavailable");
      return keychain.get(`${svc}|${acct}`) ?? null;
    },
    deletePassword: async (svc: string, acct: string) => keychain.delete(`${svc}|${acct}`),
  },
}));

/* ---------------- vi.mock:ssh2 ---------------- */
vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  const { ed25519Blob: makeBlob } = await import("../helpers/keys");
  const blob = makeBlob(1);

  class FakeStream extends EventEmitter {
    writes: string[] = [];
    windowCalls: Array<[number, number]> = [];
    ended = 0;
    throwOnWrite = false;
    stderr = new EventEmitter();
    write(d: string): void { if (this.throwOnWrite) throw new Error("ssh stream write boom"); this.writes.push(d); }
    setWindow(c: number, r: number): void { this.windowCalls.push([c, r]); }
    end(): void { this.ended++; }
  }

  class FakeSftp {
    files = new Map<string, { size: number; mode: number; mtime: number }>();
    calls: Array<[string, ...unknown[]]> = [];
    realpath(p: string, cb: (e: Error | null, abs: string) => void): void { cb(null, p); }
    readdir(_d: string, cb: (e: Error | null, list: Array<{ filename: string; attrs: { size: number; mode: number; mtime: number } }>) => void): void {
      // 真实 readdir 返回的是目录内的"名字",不是完整路径
      cb(null, [...this.files.entries()].map(([p, attrs]) => ({ filename: p.split("/").pop() ?? p, attrs })));
    }
    stat(p: string, cb: (e: Error | null, st: { size: number; mode: number }) => void): void {
      const st = this.files.get(p);
      if (!st) { cb(Object.assign(new Error("No such file"), { code: 2 }), undefined as never); return; }
      cb(null, st);
    }
    mkdir(p: string, cb: (e: Error | null) => void): void { this.calls.push(["mkdir", p]); cb(null); }
    unlink(p: string, cb: (e: Error | null) => void): void { this.calls.push(["unlink", p]); cb(null); }
    rmdir(p: string, cb: (e: Error | null) => void): void { this.calls.push(["rmdir", p]); cb(null); }
    rename(a: string, b: string, cb: (e: Error | null) => void): void { this.calls.push(["rename", a, b]); cb(null); }
    fastPut(_l: string, _r: string, o: { step?: (n: number) => void }, cb: (e: Error | null) => void): void {
      o.step?.(3);
      cb(null);
    }
    fastGet(_r: string, _l: string, o: { step?: (n: number) => void }, cb: (e: Error | null) => void): void {
      o.step?.(2);
      cb(null);
    }
  }

  class FakeClient extends EventEmitter {
    static instances: FakeClient[] = [];
    config: Record<string, unknown> | null = null;
    stream = new FakeStream();
    sftpObj = new FakeSftp();
    ended = 0;
    shellFails = false;
    failSftp = false;
    deferSftp = false;
    pendingSftp: Array<(e: Error | null, s?: FakeSftp) => void> = [];
    sftpCalls = 0;
    unforwardCalls: Array<[string, number]> = [];
    constructor() {
      super();
      FakeClient.instances.push(this);
    }
    connect(cfg: Record<string, unknown>): void {
      this.config = cfg;
      const verifier = cfg.hostVerifier as (key: unknown, cb: (ok: boolean) => void) => void;
      verifier(blob, (ok: boolean) => {
        if (ok) queueMicrotask(() => this.emit("ready"));
        else this.emit("error", new Error("Host denied"));
      });
    }
    shell(_o: unknown, cb: (e: Error | null, s: FakeStream | null) => void): void {
      if (this.shellFails) { cb(new Error("shell failed"), null); return; }
      cb(null, this.stream);
    }
    sftp(cb: (e: Error | null, s?: FakeSftp) => void): void {
      this.sftpCalls++;
      if (this.deferSftp) { this.pendingSftp.push(cb); return; }
      if (this.failSftp) { cb(new Error("Unable to start subsystem: sftp")); return; }
      cb(null, this.sftpObj);
    }
    forwardIn(_a: string, _p: number, cb: (e: Error | null, port: number) => void): void { cb(null, 42000); }
    unforwardIn(a: string, p: number): void { this.unforwardCalls.push([a, p]); }
    end(): void { this.ended++; }
  }
  return { Client: FakeClient, __clients: FakeClient.instances };
});

let addHostKey: typeof import("../../src/main/knownhosts").addHostKey;
let knownHostField: typeof import("../../src/main/knownhosts").knownHostField;

const waitFor = async (pred: () => boolean, what = "condition", tries = 400): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
};

const withPlatform = async (platform: NodeJS.Platform, fn: () => Promise<void> | void): Promise<void> => {
  const orig = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { await fn(); } finally { Object.defineProperty(process, "platform", { value: orig, configurable: true }); }
};

const withEnv = async (patch: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> => {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(patch)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

beforeAll(async () => {
  vi.resetModules();
  const kh = await import("../../src/main/knownhosts");
  addHostKey = kh.addHostKey;
  knownHostField = kh.knownHostField;
  await import("../../src/main/main");
  const ssh2 = (await import("ssh2")) as unknown as { __clients: any[] };
  sshClients = ssh2.__clients;
  await waitFor(() => em.windows.length >= 1, "initial window created");
});

afterAll(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origProfile;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  vi.restoreAllMocks();
  keychain.clear();
  keychainBroken = false;
  ptys.length = 0;
  T.senderEvents.length = 0;
  T.setSenderDestroyed(false);
  T.setSystemLangs([]);
  T.resetSystemLangFn();
});

/* ---------------- 小工具 ---------------- */

const hostInput = (over: Record<string, unknown> = {}) => ({
  name: "cov-host", host: "cov-main.example", port: 22, username: "root",
  authType: "password", ...over,
});

/** 建主机;password 认证默认顺手存一条凭据(大多数用例需要能连上) */
const newHost = async (over: Record<string, unknown> = {}): Promise<any> => {
  const rec = await em.invoke("hosts:create", hostInput(over));
  const authType = (over.authType as string | undefined) ?? "password";
  if (authType === "password") {
    await em.invoke("creds:put", rec.id, { password: (over.secret as string | undefined) ?? "cov-pw" });
  }
  return rec;
};

const known = (host: string, port = 22): void => addHostKey(knownHostField(host, port), KEY_BLOB);

const ensureWindow = async (): Promise<any> => {
  await em.invoke("window:new");
  return em.windows[em.windows.length - 1];
};

const connectKnown = async (id: string): Promise<number> =>
  ((await em.invoke("ssh:connect", id, { cols: 80, rows: 24 })) as { id: number }).id;

const lastClient = (): any => sshClients[sshClients.length - 1];

const prefsSent = (): number => em.webContents.sent.filter(([ch]) => ch === "prefs:open").length;

const clickPrefs = (): void => {
  const template = T.menu.built[T.menu.built.length - 1];
  const appMenu = template[0] as any;
  const item = (appMenu.submenu as any[]).find((x) => x.accelerator === "Cmd+,");
  (item as any).click();
};

const sentSince = (n: number): unknown[][] => em.webContents.sent.slice(n);

/* ======================= 菜单 / 语言 ======================= */

describe("应用菜单", () => {
  it("启动时创建窗口并安装带偏好设置入口(⌘,)的 mac 菜单", async () => {
    expect(em.windows.length).toBeGreaterThanOrEqual(1);
    expect(T.menu.built.length).toBeGreaterThanOrEqual(1);
    const template = T.menu.built[T.menu.built.length - 1] as any[];
    expect(template[0].label).toBe("sshkit");
    expect(template[0].submenu.some((x: any) => x.accelerator === "Cmd+,")).toBe(true);
    /* 菜单现在是完整的 macOS 结构:应用 / 编辑 / 显示 / 窗口 / 帮助。
       编辑菜单的复制粘贴**故意不挂 accelerator**(挂了会被系统吃掉,终端收不到 Cmd+C/V)。 */
    const labels = template.map((x: any) => x.label ?? x.role);
    for (const want of ["Edit", "View", "Help"]) expect(labels).toContain(want);
    const editMenu = template.find((x: any) => x.label === "Edit");
    for (const item of editMenu.submenu.filter((i: any) => ["Copy", "Paste"].includes(i.label))) {
      expect(item.accelerator).toBeUndefined();
    }
    expect(template.find((x: any) => x.role === "windowMenu")).toBeTruthy();
  });

  it("点偏好设置把 prefs:open 发给当前窗口", async () => {
    await ensureWindow();
    const before = prefsSent();
    clickPrefs();
    expect(prefsSent()).toBe(before + 1);
  });

  it("窗口已关闭(mainWindow=null)时点偏好设置不发送", async () => {
    const win = await ensureWindow();
    win.emit("closed");
    const before = prefsSent();
    clickPrefs();
    expect(prefsSent()).toBe(before);
  });

  it("窗口正在销毁时点偏好设置不发送(isDestroyed 保护)", async () => {
    const win = await ensureWindow();
    win.isDestroyed = () => true;
    const before = prefsSent();
    clickPrefs();
    expect(prefsSent()).toBe(before);
  });

  it("语言切到 zh 后重建菜单;非 darwin 平台则清空应用菜单", async () => {
    T.setSystemLangs(["zh-CN"]);
    await em.invoke("settings:setLocale", "zh");
    const zhTemplate = T.menu.built[T.menu.built.length - 1] as any[];
    const zhPrefs = (zhTemplate[0].submenu as any[]).find((x) => x.accelerator === "Cmd+,");
    expect(zhPrefs.label).toBe("偏好设置…");

    await withPlatform("linux", async () => {
      await em.invoke("settings:setLocale", "en");
    });
    expect(T.menu.set[T.menu.set.length - 1]).toBeNull();

    T.setSystemLangs([]);
    await em.invoke("settings:setLocale", "en");
  });
});

describe("系统语言探测", () => {
  it("getPreferredSystemLanguages 返回空数组时回落 en", async () => {
    await em.invoke("settings:setLocale", "system");
    const r = (await em.invoke("settings:getLocale")) as any;
    expect(r.system).toBe("en");
    expect(r.pref).toBe("system");
  });

  it("getPreferredSystemLanguages 不存在时也不崩(?.),仍回落 en", async () => {
    T.setSystemLangFn(undefined);
    try {
      const r = (await em.invoke("settings:getLocale")) as any;
      expect(r.system).toBe("en");
    } finally {
      T.setSystemLangFn(() => []);
    }
  });

  it("system 偏好 + 系统中文 → effective=zh", async () => {
    T.setSystemLangs(["zh-CN"]);
    const r = (await em.invoke("settings:setLocale", "system")) as any;
    expect(r.effective).toBe("zh");
    T.setSystemLangs([]);
  });
});

/* ======================= 窗口 / bench / console ======================= */

describe("窗口与 bench 定位", () => {
  it("SSHKIT_BENCH_BOUNDS 合法时覆盖默认窗口几何", async () => {
    await withEnv({ SSHKIT_BENCH_BOUNDS: "10, 20, 1000, 700" }, async () => {
      const win = await ensureWindow();
      expect(win.options).toMatchObject({ x: 10, y: 20, width: 1000, height: 700 });
    });
  });

  it("bounds 字段数不对时告警并用默认尺寸", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withEnv({ SSHKIT_BENCH_BOUNDS: "10,20,30" }, async () => {
      const win = await ensureWindow();
      expect(win.options).toMatchObject({ width: 1280, height: 800 });
      expect(win.options.x).toBeUndefined();
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("无效"));
  });

  it("bounds 有非数字时同样告警并回落默认", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withEnv({ SSHKIT_BENCH_BOUNDS: "a,b,c,d" }, async () => {
      const win = await ensureWindow();
      expect(win.options.width).toBe(1280);
    });
    expect(warn).toHaveBeenCalled();
  });

  it("非 darwin 平台创建窗口不带 titleBarStyle", async () => {
    await withPlatform("linux", async () => {
      const win = await ensureWindow();
      expect(win.options.titleBarStyle).toBeUndefined();
    });
  });

  it("渲染层 console-message(新式参数)被打平并带来源打印", async () => {
    const win = await ensureWindow();
    const handler = T.consoleHandlers.get(win)!;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    handler({ message: "line1\n   line2", lineNumber: 7, sourceId: "app.js" });
    expect(log).toHaveBeenCalledWith("[renderer]", "line1 line2", "app.js:7");
  });

  it("渲染层 console-message(旧式参数 level,message,line,source)也能打印", async () => {
    const win = await ensureWindow();
    const handler = T.consoleHandlers.get(win)!;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    handler(undefined, 1, "legacy msg", 9, "legacy.js");
    expect(log).toHaveBeenCalledWith("[renderer]", "legacy msg", "legacy.js:9");
    log.mockClear();
    handler({ message: "no-source" });
    expect(log).toHaveBeenCalledWith("[renderer]", "no-source", "");
    log.mockClear();
    handler({ message: "src-but-no-line", sourceId: "only-src.js" });
    expect(log).toHaveBeenCalledWith("[renderer]", "src-but-no-line", "only-src.js:");
    log.mockClear();
    handler(undefined);
    expect(log).toHaveBeenCalledWith("[renderer]", "", "");
  });
});

/* ======================= clipboard / creds ======================= */

describe("clipboard 与 creds", () => {
  it("clipboard:write 传 null 时写空串而不是字符串 null", async () => {
    await em.invoke("clipboard:write", null);
    expect(clipboardState.text).toBe("");
    await expect(em.invoke("clipboard:read")).resolves.toBe("");
  });

  it("creds:has 在钥匙串不可用时返回 false(而不是抛给渲染层)", async () => {
    keychainBroken = true;
    await expect(em.invoke("creds:has", "h_any")).resolves.toBe(false);
  });
});

/* ======================= ssh:connect / 终端 ======================= */

describe("ssh:connect 与终端", () => {
  it("未知 host id 直接拒绝", async () => {
    await expect(em.invoke("ssh:connect", "h_missing", { cols: 80, rows: 24 }))
      .rejects.toThrow(/unknown host id/);
  });

  it("password 认证:凭据来自钥匙串;write/resize/dispose 作用到 ssh 通道", async () => {
    const h = await newHost({ name: "pw", host: "pw-cov.example" });
    await em.invoke("creds:put", h.id, { password: "pw-secret" });
    known(h.host, h.port);
    const sid = await connectKnown(h.id);
    const c = lastClient();
    expect(c.config).toMatchObject({ host: h.host, port: 22, username: "root", password: "pw-secret" });

    em.fire("terminal:write", sid, "ls\r");
    expect(c.stream.writes).toEqual(["ls\r"]);
    em.fire("terminal:resize", sid, 120, 40);
    expect(c.stream.windowCalls.at(-1)).toEqual([40, 120]);
    em.fire("terminal:dispose", sid);
    expect(c.stream.ended).toBe(1);
    expect(c.ended).toBe(1);
  });

  it("key 认证:读私钥文件(~ 展开)并带 passphrase", async () => {
    const keyPath = path.join(HOME, "id_cov");
    fs.writeFileSync(keyPath, "PRIVATE-KEY-COV");
    const h = await newHost({ name: "key", host: "key-cov.example", authType: "key", keyPath: "~/id_cov" });
    await em.invoke("creds:put", h.id, { passphrase: "pp-secret" });
    known(h.host, h.port);
    await connectKnown(h.id);
    const c = lastClient();
    expect(String(c.config.privateKey)).toContain("PRIVATE-KEY-COV");
    expect(c.config.passphrase).toBe("pp-secret");
  });

  it("agent 认证:把 $SSH_AUTH_SOCK 传给 ssh2", async () => {
    await withEnv({ SSH_AUTH_SOCK: "/tmp/cov-agent.sock" }, async () => {
      const h = await newHost({ name: "agent", host: "agent-cov.example", authType: "agent" });
      known(h.host, h.port);
      await connectKnown(h.id);
      expect(lastClient().config.agent).toBe("/tmp/cov-agent.sock");
    });
  });

  it("password 认证但没有保存密码时拒绝,且 client 未发起 connect", async () => {
    const h = (await em.invoke("hosts:create", hostInput({ name: "nopw", host: "nopw-cov.example" }))) as any;
    await expect(em.invoke("ssh:connect", h.id, { cols: 80, rows: 24 }))
      .rejects.toThrow(/no saved password/i);
    // 行为:拒绝发生在建连之前 —— 最后创建的 client 没有拿到连接配置
    expect(lastClient().config).toBeNull();
  });

  it("未知主机:发 knownhost:ask(带 host/指纹),用户 Continue 后连接成功", async () => {
    const h = await newHost({ name: "ask", host: "ask-cov.example" });
    const p = em.invoke("ssh:connect", h.id, { cols: 80, rows: 24 }) as Promise<{ id: number }>;
    await waitFor(() => T.senderEvents.some((e) => e[0] === "knownhost:ask"), "knownhost:ask");
    const ask = T.senderEvents.find((e) => e[0] === "knownhost:ask")![1] as any;
    expect(ask).toMatchObject({ host: "ask-cov.example", status: "unknown" });
    expect(ask.fingerprint).toMatch(/^[A-Za-z0-9+/]+=*$/);
    em.fire("knownhost:answer", ask.reqId, "continue");
    await expect(p).resolves.toMatchObject({ id: expect.any(Number) });
  });

  it("未知主机:用户 Cancel 时连接失败(不建立会话)", async () => {
    const h = await newHost({ name: "cancel", host: "cancel-cov.example" });
    const p = em.invoke("ssh:connect", h.id, { cols: 80, rows: 24 }) as Promise<unknown>;
    await waitFor(() => T.senderEvents.some((e) => e[0] === "knownhost:ask"), "knownhost:ask");
    const ask = T.senderEvents.find((e) => e[0] === "knownhost:ask")![1] as any;
    em.fire("knownhost:answer", ask.reqId, "cancel");
    await expect(p).rejects.toThrow(/Host denied/);
  });

  it("terminal:write 在 pty/ssh 写入抛错时不崩,bench 模式留下日志", async () => {
    process.env.SSHKIT_BENCH = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const created = (await em.invoke("terminal:create", { cols: 80, rows: 24 })) as { id: number };
      ptys.at(-1)!.throwOnWrite = true;
      expect(() => em.fire("terminal:write", created.id, "pty-data")).not.toThrow();

      const h = await newHost({ name: "throw", host: "throw-cov.example" });
      known(h.host, h.port);
      const sid = await connectKnown(h.id);
      lastClient().stream.throwOnWrite = true;
      expect(() => em.fire("terminal:write", sid, "ssh-data")).not.toThrow();

      const lines = log.mock.calls.map((c) => c.map(String).join(" "));
      expect(lines.some((l) => l.includes("pty.write 抛错"))).toBe(true);
      expect(lines.some((l) => l.includes("ssh.write 抛错"))).toBe(true);
    } finally {
      delete process.env.SSHKIT_BENCH;
    }
  });
});

/* ======================= knownhost:import ======================= */

describe("knownhost:import 对话框", () => {
  it("有窗口时用父窗口打开对话框,选中文件后导入并返回 rows", async () => {
    const win = await ensureWindow();
    const src = path.join(HOME, "kh_import_cov");
    fs.writeFileSync(src, `${knownHostField("import-cov.example", 22)} ssh-ed25519 ${KEY_BLOB.toString("base64")}\n`);
    BrowserWin.fromWebContents = () => win;
    try {
      dialogState.openResult = [src];
      const r = (await em.invoke("knownhost:import")) as any;
      expect(r).toMatchObject({ canceled: false, added: 1, file: src });
      expect(r.rows.some((x: any) => x.host === "import-cov.example")).toBe(true);
      const call = T.dialogCalls[T.dialogCalls.length - 1];
      expect(call).toHaveLength(2); // (win, options)
      expect(call[0]).toBe(win);
    } finally {
      BrowserWin.fromWebContents = () => null;
    }
  });

  it("对话框返回空 filePaths 时按取消处理", async () => {
    await ensureWindow();
    dialogState.openResult = [];
    const r = (await em.invoke("knownhost:import")) as any;
    expect(r).toMatchObject({ canceled: true, added: 0 });
  });

  it("没有窗口时用无父窗口对话框;取消返回 canceled", async () => {
    BrowserWin.fromWebContents = () => null;
    dialogState.openResult = null;
    const r = (await em.invoke("knownhost:import")) as any;
    expect(r).toMatchObject({ canceled: true, added: 0 });
    expect(T.dialogCalls[T.dialogCalls.length - 1]).toHaveLength(1); // 只有 options
  });
});

/* ======================= fwd 状态推送 ======================= */

describe("端口转发的状态推送", () => {
  it("remote 规则启动后把 running 状态推给窗口;fwd:* 通道可用", async () => {
    await ensureWindow();
    const h = await newHost({ name: "fwd", host: "fwd-cov.example" });
    known(h.host, h.port);
    await connectKnown(h.id);
    const rule = {
      id: "cov_remote1", hostId: h.id, kind: "remote", bindAddress: "127.0.0.1", port: 0,
      destinationAddress: "127.0.0.1", destinationPort: 80,
    };
    await em.invoke("fwd:save", rule);
    const before = em.webContents.sent.length;
    const st = (await em.invoke("fwd:start", rule)) as any;
    expect(st).toMatchObject({ state: "running", boundPort: 42000 });
    expect(sentSince(before)).toEqual(expect.arrayContaining([
      ["fwd:status", expect.objectContaining({ id: "cov_remote1", state: "running" })],
    ]));
    await expect(em.invoke("fwd:statuses")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "cov_remote1", state: "running" })]),
    );
    await em.invoke("fwd:stop", rule.id);
    expect(await em.invoke("fwd:rules")).toEqual(expect.arrayContaining([expect.objectContaining({ id: "cov_remote1" })]));
  });

  it("窗口已关闭时不再推送 fwd:status", async () => {
    await ensureWindow();
    const h = await newHost({ name: "fwd2", host: "fwd2-cov.example" });
    known(h.host, h.port);
    await connectKnown(h.id);
    const win = em.windows[em.windows.length - 1];
    win.emit("closed"); // mainWindow = null
    const rule = {
      id: "cov_remote2", hostId: h.id, kind: "remote", bindAddress: "127.0.0.1", port: 0,
      destinationAddress: "127.0.0.1", destinationPort: 80,
    };
    await em.invoke("fwd:save", rule);
    const before = em.webContents.sent.length;
    await em.invoke("fwd:start", rule);
    expect(sentSince(before).filter((e) => e[0] === "fwd:status")).toEqual([]);
    await em.invoke("fwd:stop", rule.id);
    await em.invoke("fwd:delete", rule.id);
  });
});

/* ======================= SFTP ======================= */

const ftpEntry = (size: number, mode: number) => ({ size, mode, mtime: 1 });

describe("SFTP 通道与进度推送", () => {
  it("会话上 sftp 可用:list/mkdir/remove/rename/upload/download 都走 IPC;上传进度推给窗口", async () => {
    await ensureWindow();
    const h = await newHost({ name: "sftp", host: "sftp-cov.example" });
    await em.invoke("creds:put", h.id, { password: "sftp-pw" });
    known(h.host, h.port);
    const sid = await connectKnown(h.id);
    const c = lastClient();
    c.sftpObj.files.set("/dir", ftpEntry(0, 0o040755));
    c.sftpObj.files.set("/dir/a.bin", ftpEntry(5, 0o100644));

    const list = (await em.invoke("sftp:list", sid, "/dir")) as any;
    expect(list.path).toBe("/dir");
    expect(list.entries.map((e: any) => e.name)).toContain("a.bin");

    await em.invoke("sftp:mkdir", sid, "/dir/new");
    await em.invoke("sftp:remove", sid, "/dir");
    await em.invoke("sftp:rename", sid, "/dir/a.bin", "/dir/b.bin");
    expect(c.sftpObj.calls).toEqual(expect.arrayContaining([
      ["mkdir", "/dir/new"], ["rmdir", "/dir"], ["rename", "/dir/a.bin", "/dir/b.bin"],
    ]));

    const local = path.join(HOME, "up-cov.txt");
    fs.writeFileSync(local, "12345");
    const before = em.webContents.sent.length;
    const jobId = await em.invoke("sftp:upload", sid, local, "/dir/up.txt");
    expect(jobId).toBeGreaterThan(0);
    const progress = sentSince(before).filter((e) => e[0] === "sftp:progress").map((e) => e[1] as any);
    expect(progress.some((p) => p.state === "active" && p.dir === "up")).toBe(true);
    expect(progress.at(-1)).toMatchObject({ state: "done", dir: "up", total: 5 });

    await em.invoke("sftp:download", sid, "/dir/a.bin", path.join(HOME, "down-cov.bin"));
  });

  it("窗口已关闭时上传进度不再推送", async () => {
    await ensureWindow();
    const h = await newHost({ name: "sftp2", host: "sftp2-cov.example" });
    known(h.host, h.port);
    const sid = await connectKnown(h.id);
    const c = lastClient();
    c.sftpObj.files.set("/f", ftpEntry(1, 0o100644));
    em.windows[em.windows.length - 1].emit("closed");
    const local = path.join(HOME, "up-cov2.txt");
    fs.writeFileSync(local, "x");
    const before = em.webContents.sent.length;
    await em.invoke("sftp:upload", sid, local, "/f");
    expect(sentSince(before).filter((e) => e[0] === "sftp:progress")).toEqual([]);
  });

  it("会话 sftp 不可用时用专用连接回退(带主机凭据)", async () => {
    await ensureWindow();
    const h = await newHost({ name: "fb", host: "fb-cov.example" });
    await em.invoke("creds:put", h.id, { password: "fb-pw" });
    known(h.host, h.port);
    const sid = await connectKnown(h.id);
    const sessionClient = lastClient();
    sessionClient.failSftp = true;
    sessionClient.sftpObj.files.set("/fb.txt", ftpEntry(1, 0o100644));
    const beforeCount = sshClients.length;
    const list = (await em.invoke("sftp:list", sid, "/")) as any;
    expect(list.path).toBe("/");
    expect(sshClients.length).toBe(beforeCount + 1); // 新开了一条专用连接
    const aux = lastClient();
    expect(aux.config).toMatchObject({ host: h.host, password: "fb-pw" });
    // 专用连接上的目录内容才是这次列出的来源(第二次调用命中缓存)
    aux.sftpObj.files.set("/fb.txt", ftpEntry(1, 0o100644));
    const list2 = (await em.invoke("sftp:list", sid, "/")) as any;
    expect(list2.entries.map((e: any) => e.name)).toContain("fb.txt");
  });

  it("回退时主机已被删除 → 返回原始 sftp 错误(不假装空目录)", async () => {
    await ensureWindow();
    const h = await newHost({ name: "fb-gone", host: "fb-gone-cov.example" });
    known(h.host, h.port);
    const sid = await connectKnown(h.id);
    lastClient().failSftp = true;
    await em.invoke("hosts:delete", h.id);
    await expect(em.invoke("sftp:list", sid, "/")).rejects.toThrow(/Unable to start subsystem/i);
  });

  it("回退前会话被 dispose(hostId 查不到) → 返回原始错误", async () => {
    await ensureWindow();
    const h = await newHost({ name: "fb-race", host: "fb-race-cov.example" });
    known(h.host, h.port);
    const sid = await connectKnown(h.id);
    const c = lastClient();
    c.deferSftp = true;
    const p = em.invoke("sftp:list", sid, "/");
    await waitFor(() => c.pendingSftp.length === 1, "sftp request pending");
    em.fire("terminal:dispose", sid); // 会话被用户关掉,hostId 查不到
    c.pendingSftp[0](new Error("subsystem gone"));
    await expect(p).rejects.toThrow(/subsystem gone/);
  });

  it("agent 认证的主机回退时不读钥匙串(secrets 为空对象)", async () => {
    await ensureWindow();
    await withEnv({ SSH_AUTH_SOCK: "/tmp/cov-agent-fb.sock" }, async () => {
      const h = await newHost({ name: "fb-agent", host: "fb-agent-cov.example", authType: "agent" });
      known(h.host, h.port);
      const sid = await connectKnown(h.id);
      const c = lastClient();
      c.failSftp = true;
      await em.invoke("sftp:list", sid, "/"); // 触发回退,建出 agent 专用连接
      const aux = lastClient();
      expect(aux.config.agent).toBe("/tmp/cov-agent-fb.sock");
      aux.sftpObj.files.set("/agent.txt", ftpEntry(1, 0o100644));
      const list = (await em.invoke("sftp:list", sid, "/")) as any;
      expect(list.entries.map((e: any) => e.name)).toContain("agent.txt");
    });
  });
});

/* ======================= app 生命周期 ======================= */

describe("app 生命周期", () => {
  it("activate:有窗口时不新建;窗口全关后新建一个", async () => {
    await ensureWindow();
    const before = em.windows.length;
    em.fire("app:activate");
    expect(em.windows.length).toBe(before);

    em.windows.length = 0; // 模拟窗口全关
    em.fire("app:activate");
    expect(em.windows.length).toBe(1);
  });

  it("window-all-closed → app.quit", async () => {
    const before = T.quitCalls();
    em.fire("app:window-all-closed");
    expect(T.quitCalls()).toBe(before + 1);
  });

  it("before-quit 收掉 pty、ssh 会话与端口转发", async () => {
    await ensureWindow();
    const created = (await em.invoke("terminal:create", { cols: 80, rows: 24 })) as { id: number };
    const pty = ptys.at(-1)!;
    const h = await newHost({ name: "quit", host: "quit-cov.example" });
    known(h.host, h.port);
    const sid = await connectKnown(h.id);
    const c = lastClient();
    const rule = {
      id: "cov_remote_quit", hostId: h.id, kind: "remote", bindAddress: "127.0.0.1", port: 0,
      destinationAddress: "127.0.0.1", destinationPort: 80,
    };
    await em.invoke("fwd:save", rule);
    await em.invoke("fwd:start", rule);

    em.fire("app:before-quit");
    expect(pty.killed).toBe(1);
    expect(c.ended).toBeGreaterThanOrEqual(1);
    expect(c.unforwardCalls.length).toBeGreaterThanOrEqual(1);
    const statuses = (await em.invoke("fwd:statuses")) as any[];
    expect(statuses.find((s) => s.id === "cov_remote_quit")).toMatchObject({ state: "stopped" });
    expect(sid).toBeGreaterThan(0);
  });
});
