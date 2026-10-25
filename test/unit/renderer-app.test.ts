// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRendererDom, flush } from "../helpers/renderer";

/**
 * 渲染层主模块(app.ts)行为测试。
 *
 * app.ts 是"import 即自举"的模块:模块求值时就抓 DOM、挂事件、异步 boot。
 * 所以每个用例都必须:
 *   vi.resetModules() → loadRendererDom() → installBridge(假桥) → 动态 import。
 * 每个用例独立重置 DOM / localStorage / 事件监听,互不串扰。
 *
 * 假桥按 src/preload/preload.ts 的真实 API 实现(方法名/参数/返回值一致);
 * 未知方法与"本用例故意不提供"的能力显式抛错,不静默返回合理值(AGENTS §0.1-8)。
 */

type AnyFn = (...args: any[]) => any;
type CallLog = Record<string, unknown[][]>;

/* 记录搜索插件收到的查询,用于断言搜索栏(输入/回车/箭头)真的把查询交给了插件。
   vi.hoisted:vi.mock 的工厂会被提升到 import 之前,共享数组也必须一起提升。 */
interface SearchCall { kind: "next" | "prev" | "clear"; term: string | null; incremental: boolean }
const searchCalls = vi.hoisted(() => [] as SearchCall[]);

/* jsdom 没有 canvas 2D 上下文;@xterm/addon-canvas 是在 xterm.open() 之后由内部定时器异步激活的,
   抛错发生在产品 try/catch 之外(会变成 uncaught exception)。这里把它换成"构造即失败"的替身,
   与真实环境里 canvas 插件不可用时产品的容错路径一致(产品会退回 DOM 渲染器)。 */
vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class {
    disposed = false;
    constructor() {
      /* 默认构造即失败:jsdom 没有 canvas 2D,产品必须优雅退回 DOM 渲染。
         __canvasOk 时构造成功并把实例记到 globalThis(模块会被 resetModules 重建,
         用全局数组才能跨 boot 观察 dispose/再次挂载)。 */
      if (!(globalThis as { __canvasOk?: boolean }).__canvasOk) throw new Error("canvas addon unavailable under jsdom");
      const g = globalThis as { __canvasInstances?: unknown[] };
      (g.__canvasInstances ??= []).push(this);
    }
    activate(): void {}
    dispose(): void { this.disposed = true; }
  },
}));
/* 搜索插件用真实实现对 jsdom 无害;但产品对"插件加载失败"有容错分支需要可注入失败 */
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    constructor() {
      if ((globalThis as { __failSearchAddon?: boolean }).__failSearchAddon) throw new Error("search addon unavailable");
    }
    /* xterm 6 的 loadAddon 会调用 activate;缺了它产品侧会走"插件不可用"的 catch,搜索栏就没有 addon */
    activate(): void {}
    dispose(): void {}
    findNext(term?: string, opts?: { incremental?: boolean }): void {
      searchCalls.push({ kind: "next", term: term ?? null, incremental: !!opts?.incremental });
    }
    findPrevious(term?: string): void {
      searchCalls.push({ kind: "prev", term: term ?? null, incremental: false });
    }
    clearDecorations(): void { searchCalls.push({ kind: "clear", term: null, incremental: false }); }
  },
}));


interface HostRecord {
  id: string;
  name: string;
  group?: string;
  tags?: string[];
  host: string;
  port: number;
  username: string;
  authType: "password" | "key" | "agent";
  keyPath?: string;
  createdAt: string;
}

const HOST: HostRecord = {
  id: "h_alice",
  name: "alice",
  group: "hosts",
  host: "192.0.2.10",
  port: 22,
  username: "root",
  authType: "password",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeBridge(overrides: Record<string, AnyFn> = {}) {
  const calls: CallLog = {};
  const rec = (name: string, impl: AnyFn) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return impl(...args);
  };
  const o = (name: string, fallback: AnyFn): AnyFn => overrides[name] ?? fallback;

  let nextId = 0;
  const newId = (): number => ++nextId;
  const dataCbs = new Map<number, (data: string) => void>();
  const exitCbs = new Map<number, (info: { exitCode: number; error?: string; reason?: string }) => void>();
  const progressCbs: AnyFn[] = [];
  const askCbs: AnyFn[] = [];
  const askCancelCbs: AnyFn[] = [];
  const prefsCbs: AnyFn[] = [];
  const fwdStatusCbs: AnyFn[] = [];
  const maximizedCbs: AnyFn[] = [];
  const execCbs: AnyFn[] = [];
  const approvalCbs: AnyFn[] = [];

  const api: Record<string, any> = {
    /* preload 暴露的平台:自绘窗口按钮/红绿灯让位按它分支(测试固定 win32) */
    platform: "win32",
    createLocal: rec("createLocal", o("createLocal", async () => ({ id: newId() }))),
    write: rec("write", o("write", () => undefined)),
    resize: rec("resize", o("resize", () => undefined)),
    dispose: rec("dispose", o("dispose", () => undefined)),
    info: rec("info", o("info", async () => ({ version: "0.1.0", platform: "darwin", name: "sshkit" }))),
    settings: {
      getLocale: rec("settings.getLocale", o("settings.getLocale", async () => ({ pref: "system", system: "en", effective: "en" }))),
      setLocale: rec(
        "settings.setLocale",
        o("settings.setLocale", async (pref: "system" | "zh" | "en") => ({
          pref, system: "en", effective: pref === "zh" ? "zh" : "en",
        })),
      ),
    },
    disposeAllSessions: rec("disposeAllSessions", o("disposeAllSessions", () => undefined)),
    clipboard: {
      read: rec("clipboard.read", o("clipboard.read", async () => "")),
      write: rec("clipboard.write", o("clipboard.write", async () => undefined)),
    },
    onOpenPrefs: rec("onOpenPrefs", o("onOpenPrefs", (cb: AnyFn) => { prefsCbs.push(cb); return () => undefined; })),
    onData: rec("onData", o("onData", (id: number, cb: AnyFn) => { dataCbs.set(id, cb); return () => { dataCbs.delete(id); }; })),
    onExit: rec("onExit", o("onExit", (id: number, cb: AnyFn) => { exitCbs.set(id, cb); return () => { exitCbs.delete(id); }; })),
    hosts: {
      exportEncrypted: rec("hosts.exportEncrypted", o("hosts.exportEncrypted", async () => ({ canceled: true, hosts: 0 }))),
      importEncrypted: rec("hosts.importEncrypted", o("hosts.importEncrypted", async () => ({ canceled: true, added: 0, skipped: 0 }))),
      list: rec("hosts.list", o("hosts.list", async () => [])),
      create: rec("hosts.create", o("hosts.create", async (h: unknown) => ({ ...(h as object), id: "h_new", createdAt: "" }))),
      update: rec("hosts.update", o("hosts.update", async (id: string, p: unknown) => ({ ...(p as object), id, createdAt: "" }))),
      remove: rec("hosts.remove", o("hosts.remove", async () => undefined)),
    },
    creds: {
      has: rec("creds.has", o("creds.has", async () => false)),
      put: rec("creds.put", o("creds.put", async () => undefined)),
    },
    ssh: { connect: rec("ssh.connect", o("ssh.connect", async () => ({ id: newId() }))) },
    /* 内置 MCP 服务器(状态/开关/活动流) */
    multiexec: {
      run: rec("multiexec.run", o("multiexec.run", async () => [])),
      cancel: rec("multiexec.cancel", o("multiexec.cancel", async () => 0)),
      onResult: rec("multiexec.onResult", o("multiexec.onResult", () => () => undefined)),
    },
    mcp: {
      status: rec("mcp.status", o("mcp.status", async () => ({
        running: false, port: 7788, token: "tok", clients: [], error: null, activity: [], policy: "full",
      }))),
      set: rec("mcp.set", o("mcp.set", async () => ({
        running: false, port: 7788, token: "tok", clients: [], error: null, activity: [], policy: "full",
      }))),
      regenerateToken: rec("mcp.regenerateToken", o("mcp.regenerateToken", async () => ({
        running: false, port: 7788, token: "tok", clients: [], error: null, activity: [], policy: "full",
      }))),
      clearActivity: rec("mcp.clearActivity", o("mcp.clearActivity", async () => ({
        running: false, port: 7788, token: "tok", clients: [], error: null, activity: [], policy: "full",
      }))),
      abort: rec("mcp.abort", o("mcp.abort", async () => ({
        running: false, port: 7788, token: "tok", clients: [], error: null, activity: [], policy: "full",
      }))),
      answerApproval: rec("mcp.answerApproval", o("mcp.answerApproval", async () => true)),
      onApproval: rec("mcp.onApproval", o("mcp.onApproval", (cb: AnyFn) => { approvalCbs.push(cb); return () => undefined; })),
      onExec: rec("mcp.onExec", o("mcp.onExec", (cb: AnyFn) => { execCbs.push(cb); return () => undefined; })),
      onActivity: rec("mcp.onActivity", o("mcp.onActivity", () => () => undefined)),
      onStatus: rec("mcp.onStatus", o("mcp.onStatus", () => () => undefined)),
    },
    window: {
      create: rec("window.create", o("window.create", async () => true)),
      /* 无边框窗口的自绘按钮(preload 同名 API) */
      minimize: rec("window.minimize", o("window.minimize", () => undefined)),
      toggleMaximize: rec("window.toggleMaximize", o("window.toggleMaximize", () => undefined)),
      close: rec("window.close", o("window.close", () => undefined)),
      onMaximized: rec("window.onMaximized", o("window.onMaximized", (cb: AnyFn) => { maximizedCbs.push(cb); return () => undefined; })),
    },
    snippets: {
      list: rec("snippets.list", o("snippets.list", async () => [])),
      save: rec("snippets.save", o("snippets.save", async (s: unknown) => s)),
      remove: rec("snippets.remove", o("snippets.remove", async () => [])),
    },
    knownhost: {
      list: rec("knownhost.list", o("knownhost.list", async () => [])),
      remove: rec("knownhost.remove", o("knownhost.remove", async () => [])),
      import: rec("knownhost.import", o("knownhost.import", async () => ({ canceled: false, added: 1, skipped: 0 }))),
      answer: rec("knownhost.answer", o("knownhost.answer", () => undefined)),
      onAsk: rec("knownhost.onAsk", o("knownhost.onAsk", (cb: AnyFn) => { askCbs.push(cb); return () => undefined; })),
      onAskCancel: rec("knownhost.onAskCancel", o("knownhost.onAskCancel", (cb: AnyFn) => { askCancelCbs.push(cb); return () => undefined; })),
    },
    fwd: {
      rules: rec("fwd.rules", o("fwd.rules", async () => [])),
      statuses: rec("fwd.statuses", o("fwd.statuses", async () => [])),
      save: rec("fwd.save", o("fwd.save", async (r: unknown) => r)),
      remove: rec("fwd.remove", o("fwd.remove", async () => [])),
      start: rec("fwd.start", o("fwd.start", async (r: any) => ({ id: r.id, state: "running" }))),
      stop: rec("fwd.stop", o("fwd.stop", async () => ({ id: "f", state: "stopped" }))),
      onStatus: rec("fwd.onStatus", o("fwd.onStatus", (cb: AnyFn) => { fwdStatusCbs.push(cb); return () => undefined; })),
    },
    sftp: {
      list: rec("sftp.list", o("sftp.list", async () => ({ path: "/root", entries: [] }))),
      mkdir: rec("sftp.mkdir", o("sftp.mkdir", async () => undefined)),
      remove: rec("sftp.remove", o("sftp.remove", async () => undefined)),
      rename: rec("sftp.rename", o("sftp.rename", async () => undefined)),
      upload: rec("sftp.upload", o("sftp.upload", async () => 1)),
      download: rec("sftp.download", o("sftp.download", async () => 2)),
      onProgress: rec("sftp.onProgress", o("sftp.onProgress", (cb: AnyFn) => { progressCbs.push(cb); return () => undefined; })),
    },
    local: {
      list: rec("local.list", o("local.list", async () => ({ path: "/home/u", entries: [] }))),
      mkdir: rec("local.mkdir", o("local.mkdir", async () => undefined)),
      remove: rec("local.remove", o("local.remove", async () => undefined)),
      rename: rec("local.rename", o("local.rename", async () => undefined)),
    },
  };

  /* 未知桥能力必须显式失败,而不是静默返回 undefined(避免用例把"没接桥"当成"没行为") */
  const guard = <T extends Record<string, any>>(obj: T): T => new Proxy(obj, {
    get(t, p: string | symbol) {
      if (p in t || p === "then") return t[p as keyof T];
      throw new Error(`not in preload bridge: ${String(p)}`);
    },
  }) as T;
  api.settings = guard(api.settings);
  api.clipboard = guard(api.clipboard);
  api.hosts = guard(api.hosts);
  api.creds = guard(api.creds);
  api.ssh = guard(api.ssh);
  api.window = guard(api.window);
  api.snippets = guard(api.snippets);
  api.knownhost = guard(api.knownhost);
  api.fwd = guard(api.fwd);
  api.sftp = guard(api.sftp);
  api.local = guard(api.local);

  const emit = {
    data: (id: number, data: string): void => { dataCbs.get(id)?.(data); },
    exit: (id: number, info: { exitCode: number; error?: string; reason?: string }): void => { exitCbs.get(id)?.(info); },
    progress: (p: unknown): void => { for (const cb of progressCbs) cb(p); },
    hostKeyAsk: (req: unknown): void => { for (const cb of askCbs) cb(req); },
    openPrefs: (): void => { for (const cb of prefsCbs) cb(); },
    maximized: (on: boolean): void => { for (const cb of maximizedCbs) cb(on); },
  };

  return { calls, api: guard(api), emit, execCbs, approvalCbs };
}

/* ---------------- 环境准备 ---------------- */

/* 捕获 ResizeObserver 的回调,使用例能模拟"窗口尺寸变化"(jsdom 没有布局,不会自己触发) */
const resizeCallbacks: Array<() => void> = [];
class FakeResizeObserver {
  constructor(private readonly cb: () => void) { resizeCallbacks.push(cb); }
  observe(): void { /* 由用例显式触发 */ }
  unobserve(): void { /* noop */ }
  disconnect(): void { /* noop */ }
}
const triggerResize = (): void => { for (const cb of resizeCallbacks) cb(); };

type TrackedListener = [EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined];
let tracked: TrackedListener[] = [];

/** 记录 document/window 上的监听器,用例结束后摘掉,避免旧模块实例串到下一个用例 */
function trackListeners(target: EventTarget): void {
  const add = target.addEventListener.bind(target);
  (target as any).addEventListener = (
    type: string,
    fn: EventListenerOrEventListenerObject,
    opts?: boolean | AddEventListenerOptions,
  ): void => {
    tracked.push([target, type, fn, opts]);
    add(type, fn, opts);
  };
}

const captureOf = (opts: boolean | AddEventListenerOptions | undefined): boolean =>
  typeof opts === "boolean" ? opts : !!opts?.capture;

beforeEach(() => {
  tracked = [];
  resizeCallbacks.length = 0;
  searchCalls.length = 0;
  vi.useRealTimers();
  trackListeners(document);
  trackListeners(window);
  (window as any).ResizeObserver = FakeResizeObserver;
  (window as any).matchMedia = () => ({
    matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined,
  });
  Element.prototype.scrollIntoView = () => undefined;
  /* 产品在 canvas 插件不可用时会 console.warn(jsdom 里必然不可用);
     这里吞掉该噪音,需要断言的用例自己读取 mock.calls。 */
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  /* jsdom 没有 canvas 实现:显式返回 null,免得每开一个终端就刷 "Not implemented" 错误 */
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  document.documentElement.innerHTML = "";
  localStorage.clear();
  delete (window as unknown as { __bench?: unknown }).__bench;
});

afterEach(() => {
  bcRestore?.();
  bcRestore = null;
  for (const [target, type, fn, opts] of tracked) {
    try { target.removeEventListener(type, fn, captureOf(opts)); } catch { /* 已随 DOM 消失 */ }
  }
  tracked = [];
  vi.useRealTimers();
  document.body.innerHTML = "";
});

interface BootOptions {
  overrides?: Record<string, AnyFn>;
  storage?: Record<string, string>;
  /** loadRendererDom() 之后、import app 之前改 DOM(用于构造"index.html 缺某个元素"的防御路径) */
  mutateDom?: () => void;
  /** import app 之前改 shared/i18n 的 zh 目录(用于制造 audit() 能发现的缺失文案) */
  mutateZh?: (zh: Record<string, string>) => void;
  /** 让 boot 卡在语言初始化(用于模拟"boot 尚未落地时用户已经点了按钮"的竞态) */
  localeGate?: Promise<{ pref: "system" | "zh" | "en"; system: string; effective: "zh" | "en" }>;
}

async function boot(opts: BootOptions = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(opts.storage ?? {})) localStorage.setItem(k, v);
  loadRendererDom();
  opts.mutateDom?.();
  if (opts.localeGate) opts.overrides = { ...(opts.overrides ?? {}), "settings.getLocale": () => opts.localeGate };
  const bridge = makeBridge(opts.overrides ?? {});
  (window as unknown as { sshkit: unknown }).sshkit = bridge.api;
  if (opts.mutateZh) {
    const i18n = await import("../../src/shared/i18n");
    opts.mutateZh(i18n.zh as unknown as Record<string, string>);
  }
  const app = await import("../../src/renderer/app");
  await flush(6);
  return { ...bridge, app };
}

/** 让挂起的 promise 的 resolve/reject 由用例控制(构造"先切走再完成"的竞态) */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** app 已经 import 完成后(同一模块实例)再取 xterm 真类,用于 spy 边界 API */
async function xtermApis(): Promise<{ Terminal: any; FitAddon: any }> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  return { Terminal, FitAddon };
}

/* ---------------- 查询工具 ---------------- */

const tabEls = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("#tabs .tab-btn")];
const tabKinds = (): string[] => tabEls().map((el) => el.dataset.kind ?? "");
const activeTab = (): HTMLElement | null => document.querySelector<HTMLElement>("#tabs .tab-btn.active");
const tabByKind = (kind: string): HTMLElement => {
  const el = tabEls().find((x) => x.dataset.kind === kind);
  if (!el) throw new Error(`tab not found: ${kind}`);
  return el;
};
const title = (): string => document.querySelector("#term-title")!.textContent ?? "";
const click = (el: Element | null): void => { (el as HTMLElement).click(); };
const callNames = (calls: CallLog): string[] => Object.keys(calls);
const lastCall = (calls: CallLog, name: string): unknown[] | undefined => (calls[name] ?? []).at(-1);

function key(target: EventTarget, init: KeyboardEventInit & { code?: string }): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

/** 等待 bridge promise 链与异步渲染落地(轮询到条件成立或超时) */
async function waitFor(cond: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await flush(2);
  }
  throw new Error("waitFor timeout");
}

/* ================= 跨标签广播输入 ================= */

/** onData 属性替换后的还原(下一个用例前必须还回去) */
let bcRestore: (() => void) | null = null;

describe("广播输入", () => {
  /** 打开两个 ssh 会话并让它们加入广播组;返回收集到的输入回调 */
  async function twoBroadcastSessions(): Promise<{ cbs: AnyFn[]; calls: CallLog }> {
    const { calls } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    const { Terminal } = await xtermApis();
    const cbs: AnyFn[] = [];
    /* onData 是 getter(xterm 内部读 this._core),不能 vi.spyOn —— 直接替换属性 */
    const desc = Object.getOwnPropertyDescriptor(Terminal.prototype, "onData")!;
    Object.defineProperty(Terminal.prototype, "onData", {
      configurable: true,
      value: (cb: AnyFn) => { cbs.push(cb); return { dispose: () => undefined }; },
    });
    bcRestore = () => { Object.defineProperty(Terminal.prototype, "onData", desc); };
    await openSsh();
    /* 第二个会话:Duplicate 会复用同一台主机 */
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Duplicate"));
    await waitFor(() => tabKinds().filter((k) => k === "session").length === 2);
    /* 两个都加入广播组 */
    for (const el of tabEls().filter((x) => x.dataset.kind === "session")) {
      contextMenuOn(el);
      click(tabMenuItem("Join broadcast input"));
    }
    return { cbs, calls };
  }

  it("右键加入/退出:徽章与底部浮条出现;退出后消失", async () => {
    const { calls } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Join broadcast input"));
    await waitFor(() => !!document.getElementById("bc-banner"));
    expect(tabByKind("session").querySelector(".bc-dot")).toBeTruthy();
    expect(document.getElementById("bc-banner")!.textContent).toContain("1");

    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Leave broadcast input"));
    await waitFor(() => !document.getElementById("bc-banner"));
    expect(tabByKind("session").querySelector(".bc-dot")).toBeNull();
    expect(calls["write"]?.length ?? 0).toBe(0);
  });

  it("浮条上的退出按钮:清空广播组并收起浮条", async () => {
    await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Join broadcast input"));
    await waitFor(() => !!document.getElementById("bc-banner"));
    click(document.querySelector("#bc-banner .bc-exit"));
    await waitFor(() => !document.getElementById("bc-banner"));
    expect(tabByKind("session").querySelector(".bc-dot")).toBeNull();
  });

  it("组内输入扇出到两个会话;回车后各自收到", async () => {
    const { cbs, calls } = await twoBroadcastSessions();
    expect(cbs.length).toBeGreaterThanOrEqual(2);
    cbs[0]("uptime");
    cbs[0]("\r");
    await flush(2);
    const writes = (calls["write"] ?? []).map((a) => [a[0], a[1]] as [number, string]);
    const data = writes.map((w) => w[1]);
    expect(data.filter((d) => d === "uptime").length).toBe(2);
    expect(data.filter((d) => d === "\r").length).toBe(2);
  });

  it("危险命令:回车先弹确认;取消则发 Ctrl+U 且不发回车,确认则广播", async () => {
    const { cbs, calls } = await twoBroadcastSessions();
    cbs[0]("rm -rf /tmp/bc-test");
    cbs[0]("\r");
    await waitFor(() => !!document.querySelector(".bc-confirm"));
    expect(document.querySelector(".bc-confirm-cmd")!.textContent).toContain("rm -rf");
    expect(document.querySelector(".bc-confirm-hosts")!.textContent).toContain(HOST.name);
    const before = (calls["write"] ?? []).length;
    click(document.querySelector('.bc-confirm [data-act="deny"]'));
    await flush(2);
    const afterDeny = (calls["write"] ?? []).slice(before).map((a) => a[1]);
    expect(afterDeny.filter((d) => d === "\x15").length).toBe(2);
    expect(afterDeny.filter((d) => d === "\r").length).toBe(0);

    /* 再来一次,这次确认 */
    cbs[0]("rm -rf /tmp/bc-test");
    cbs[0]("\r");
    await waitFor(() => !!document.querySelector(".bc-confirm"));
    const before2 = (calls["write"] ?? []).length;
    click(document.querySelector('.bc-confirm [data-act="allow"]'));
    await flush(2);
    const afterAllow = (calls["write"] ?? []).slice(before2).map((a) => a[1]);
    expect(afterAllow.filter((d) => d === "\r").length).toBe(2);
  });

  it("会话断开后自动移出广播组;组空则浮条消失", async () => {
    let exitCb: ((info: unknown) => void) | null = null;
    await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "onExit": (_id: number, cb: (info: unknown) => void) => { exitCb = cb; return () => undefined; },
      },
    });
    await openSsh();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Join broadcast input"));
    await waitFor(() => !!document.getElementById("bc-banner"));
    exitCb!({ exitCode: 0 });
    await flush(3);
    expect(document.getElementById("bc-banner")).toBeNull();
  });

  it("本地 shell 不提供广播入口(避免误伤本机)", async () => {
    await boot();
    await openLocal();
    contextMenuOn(tabByKind("session"));
    const labels = [...document.querySelectorAll(".tab-menu-item")].map((b) => b.textContent);
    expect(labels.some((l) => l?.includes("broadcast input"))).toBe(false);
  });
});

/* ================= 用例 ================= */

describe("app 自举", () => {
  it("启动后常驻 Vaults/SFTP 两个 tab,默认激活 Vaults 并渲染主机列表", async () => {
    const { calls } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    expect(tabKinds()).toEqual(["vault", "sftp"]);
    expect(activeTab()!.dataset.kind).toBe("vault");
    expect(title()).toBe("Vaults");
    expect(document.body.dataset.chrome).toBe("section");
    /* 常驻 tab 不带关闭按钮(原版这两个 pill 上没有 ✕,⌘W 也关不掉) */
    expect(tabByKind("vault").querySelector(".tab-close")).toBeNull();
    expect(tabByKind("sftp").querySelector(".tab-close")).toBeNull();
    /* #host-list 被搬进 Vaults 视图,主机条目按 list() 的结果渲染 */
    expect(document.querySelector(".tab-pane.active #host-list .host-item .name")!.textContent).toBe("alice");
    expect(calls["settings.getLocale"]?.length).toBe(1);
    expect(calls["hosts.list"]?.length).toBeGreaterThan(0);
  });

  it("启动时按主进程语言偏好渲染(zh)", async () => {
    await boot({ overrides: { "settings.getLocale": async () => ({ pref: "zh", system: "zh-CN", effective: "zh" }) } });
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.querySelector('#rail .rail-item[data-nav="hosts"] .rl')!.textContent).toBe("主机");
    /* 分区名 Vaults 是固定产品名,不随语言变 */
    expect(title()).toBe("Vaults");
  });
});

/* Windows 是无边框窗口(frame:false,与原版一致):窗口按钮由渲染层自绘。
   这里锁"界面真的把点击交给了主进程"以及"最大化状态会切换图标/tooltip"。 */
describe("Windows 无边框窗口:自绘窗口按钮", () => {
  it("启动时把 preload 的平台写到 body,三个按钮都在顶栏里", async () => {
    await boot();
    expect(document.body.dataset.platform).toBe("win32");
    const box = document.querySelector("#topbar #wincontrols");
    expect(box).toBeTruthy();
    expect(box!.querySelector("#wc-min")).toBeTruthy();
    expect(box!.querySelector("#wc-max")).toBeTruthy();
    expect(box!.querySelector("#wc-close")).toBeTruthy();
  });

  it("最小化 / 最大化 / 关闭分别走 window.minimize / toggleMaximize / close", async () => {
    const { calls } = await boot();
    click(document.querySelector("#wc-min"));
    click(document.querySelector("#wc-max"));
    click(document.querySelector("#wc-close"));
    expect(count(calls, "window.minimize")).toBe(1);
    expect(count(calls, "window.toggleMaximize")).toBe(1);
    expect(count(calls, "window.close")).toBe(1);
  });

  it("最大化状态推送:切 body.win-maximized,并把 tooltip 在最大化/还原之间来回切", async () => {
    const { emit } = await boot();
    const max = document.querySelector("#wc-max")!;
    expect(max.getAttribute("data-i18n-title")).toBe("win.maximize");
    expect(max.getAttribute("title")).toBe("Maximize");

    emit.maximized(true);
    expect(document.body.classList.contains("win-maximized")).toBe(true);
    expect(max.getAttribute("data-i18n-title")).toBe("win.restore");
    expect(max.getAttribute("title")).toBe("Restore");

    emit.maximized(false);
    expect(document.body.classList.contains("win-maximized")).toBe(false);
    expect(max.getAttribute("data-i18n-title")).toBe("win.maximize");
    expect(max.getAttribute("title")).toBe("Maximize");
  });
});

/* ---------------- 通用交互工具 ---------------- */

const count = (calls: CallLog, name: string): number => (calls[name] ?? []).length;

const tabMenuItem = (label: string): HTMLButtonElement => {
  const b = [...document.querySelectorAll<HTMLButtonElement>(".tab-menu-item")].find((x) => x.textContent === label);
  if (!b) throw new Error(`tab menu item not found: ${label}`);
  return b;
};

const contextMenuOn = (el: Element): void => {
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }));
};

async function openLocal(): Promise<void> {
  click(document.querySelector("#btn-quick-term"));
  await waitFor(() => title() === "Local shell");
}

async function openSsh(): Promise<void> {
  await waitFor(() => !!document.querySelector(".host-item"));
  click(document.querySelector(".host-item"));
  await waitFor(() => title() === HOST.name);
}

async function openPrefs(): Promise<void> {
  key(document, { code: "Comma", key: ",", metaKey: true });
  await waitFor(() => !!document.querySelector(".prefs"));
}

const prefsBtn = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(`.prefs ${sel}`);
  if (!el) throw new Error(`prefs element not found: ${sel}`);
  return el;
};

/* ================= 标签页 ================= */

describe("标签页", () => {
  it("新建标签页按钮与 ⌘T 都落到 New Tab 落地页", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    expect(activeTab()!.dataset.kind).toBe("newtab");
    expect(title()).toBe("New Tab");
    expect(document.querySelector(".tab-pane.active .newtab input")).toBeTruthy();
    key(document, { code: "KeyT", key: "t", metaKey: true });
    await waitFor(() => tabKinds().filter((k) => k === "newtab").length === 2);
  });

  it("新标签页/命令面板/分屏选择器的文案跟随语言(zh 下没有英文残留)", async () => {
    await boot({
      overrides: {
        "settings.getLocale": async () => ({ pref: "zh", system: "zh-CN", effective: "zh" }),
        "hosts.list": async () => [HOST],
      },
    });
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    await waitFor(() => tabKinds().includes("newtab"));
    expect(title()).toBe("新标签页");
    const input = document.querySelector(".newtab .nt-search input") as HTMLInputElement;
    expect(input.placeholder).toBe("搜索主机或标签页");
    expect(document.querySelector(".newtab .nt-empty h3")!.textContent).toBe("最近会话");
    const hint = document.querySelector(".newtab .nt-empty p")!.textContent ?? "";
    expect(hint).toContain("最近会话会显示在这里");
    expect(hint).toContain("CMD+K");

    /* Cmd+K 命令面板的搜索框 */
    key(document, { code: "KeyK", key: "k", metaKey: true });
    await waitFor(() => !!document.querySelector(".palette-backdrop"));
    expect((document.querySelector(".palette input") as HTMLInputElement).placeholder).toBe("搜索主机或标签页");

    /* 分屏选择器 */
    await openSsh();
    contextMenuOn(tabByKind("session"));
    /* 中文语言下菜单项也是中文:按"分屏"定位(英文是 Split horizontally) */
    click([...document.querySelectorAll<HTMLElement>(".tab-menu-item")].find((b) => b.textContent!.includes("分屏"))!);
    await flush(3);
    expect(document.querySelector(".split-picker .sp-local")!.textContent).toBe("本地终端");
    expect(document.querySelector(".split-picker .sp-connect")!.textContent).toBe("连接");

    /* 分区 tab 标题也跟随语言(不是只有左栏) */
    click(document.querySelector('#rail .rail-item[data-nav="snippets"]'));
    await waitFor(() => tabKinds().includes("snippets"));
    expect(title()).toBe("代码片段");
    click(document.querySelector('#rail .rail-item[data-nav="logs"]'));
    await waitFor(() => tabKinds().includes("logs"));
    expect(title()).toBe("日志");
  });

  it("en 下同一批文案是英文(i18n 两个方向都通)", async () => {
    await boot();
    key(document, { code: "KeyT", key: "t", metaKey: true });
    await waitFor(() => tabKinds().includes("newtab"));
    expect(title()).toBe("New Tab");
    expect((document.querySelector(".newtab .nt-search input") as HTMLInputElement).placeholder).toBe("Search hosts or tabs");
    expect(document.querySelector(".newtab .nt-empty h3")!.textContent).toBe("Recent sessions");
  });

  it("点 tab 切换活动页,标题与 chrome 跟着 tab 类型变;SFTP 无会话时是 Connect to host 空态", async () => {
    const { calls } = await boot();
    click(tabByKind("sftp"));
    await waitFor(() => title() === "SFTP");
    expect(activeTab()!.dataset.kind).toBe("sftp");
    expect(activeTab()!.getAttribute("aria-selected")).toBe("true");
    expect(document.body.dataset.chrome).toBe("sftp");
    await waitFor(() => count(calls, "local.list") > 0);
    expect(count(calls, "sftp.list")).toBe(0); // 无会话时不请求远端
    expect(document.querySelector('.sftp-pane[data-which="remote"] .sftp-empty h3')!.textContent).toBe("Connect to host");
    click(tabByKind("vault"));
    await waitFor(() => title() === "Vaults");
    expect(document.body.dataset.chrome).toBe("section");
  });

  it("tab 上的 ✕ 关闭当前页;⌘W 关活动 tab,但常驻 Vaults / SFTP 关不掉", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    click(tabByKind("newtab").querySelector(".tab-close"));
    await waitFor(() => !tabKinds().includes("newtab"));
    expect(activeTab()!.dataset.kind).toBe("sftp"); // 顺位激活邻居

    click(tabByKind("vault"));
    await waitFor(() => activeTab()!.dataset.kind === "vault");
    const n = tabEls().length;
    key(document, { code: "KeyW", key: "w", metaKey: true });
    await flush(4);
    expect(tabEls().length).toBe(n);
    expect(tabKinds()).toContain("vault");

    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    key(document, { code: "KeyW", key: "w", metaKey: true });
    await waitFor(() => !tabKinds().includes("newtab"));
  });

  it("右键菜单列出 Reconnect/Rename/Duplicate/…/Close;Rename 回车保存、Esc 放弃", async () => {
    await boot();
    contextMenuOn(tabByKind("vault"));
    const menu = document.querySelector(".tab-menu");
    expect(menu).toBeTruthy();
    expect([...menu!.querySelectorAll(".tab-menu-item")].map((b) => b.textContent)).toEqual([
      "Reconnect", "Rename", "Duplicate", "Duplicate in a new window", "Close",
    ]);

    click(tabMenuItem("Rename"));
    const input = document.querySelector(".tab-rename") as HTMLInputElement;
    expect(input.value).toBe("Vaults");
    input.value = "My Vault";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => tabByKind("vault").querySelector(".lbl")!.textContent === "My Vault");

    contextMenuOn(tabByKind("vault"));
    click(tabMenuItem("Rename"));
    const again = document.querySelector(".tab-rename") as HTMLInputElement;
    again.value = "Discarded";
    again.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => tabByKind("vault").querySelector(".lbl")!.textContent === "My Vault");
  });

  it("会话 tab 的 Reconnect 会用同一台主机重新握手;Duplicate 另开一个会话 tab", async () => {
    const { calls } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Reconnect"));
    await waitFor(() => count(calls, "ssh.connect") === 2);
    expect((lastCall(calls, "ssh.connect") as unknown[])[0]).toBe("h_alice");
    expect(calls["dispose"]?.length).toBe(1); // 旧会话先被收掉

    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Duplicate"));
    await waitFor(() => tabKinds().filter((k) => k === "session").length === 2);
    await waitFor(() => count(calls, "ssh.connect") === 3);
  });

  it("Duplicate in a new window 走 bridge.window.create", async () => {
    const { calls } = await boot();
    contextMenuOn(tabByKind("vault"));
    click(tabMenuItem("Duplicate in a new window"));
    await flush(2);
    expect(calls["window.create"]?.length).toBe(1);
  });

  it("工作区视图:竖排 tab 栏渲染、点击切换、✕ 关闭,开关持久化", async () => {
    await boot();
    click(document.querySelector("#btn-tabview"));
    await flush(2);
    expect(document.body.dataset.tabview).toBe("workspace");
    expect(localStorage.getItem("sshkit.tabView")).toBe("workspace");
    const rows = [...document.querySelectorAll<HTMLElement>("#ws-rail .ws-row")];
    expect(rows.map((r) => r.dataset.kind)).toEqual(["vault", "sftp"]);

    click(rows[1]);
    await waitFor(() => activeTab()!.dataset.kind === "sftp");

    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => document.querySelectorAll("#ws-rail .ws-row").length === 3);
    const newRow = [...document.querySelectorAll<HTMLElement>("#ws-rail .ws-row")].find((r) => r.dataset.kind === "newtab")!;
    click(newRow.querySelector(".ws-x"));
    await waitFor(() => !tabKinds().includes("newtab"));

    click(document.querySelector("#btn-tabview"));
    await flush(2);
    expect(document.body.dataset.tabview).toBe("horizontal");
    expect(localStorage.getItem("sshkit.tabView")).toBe("horizontal");
  });

  it("拖拽重排 tab:拖到目标 tab 右半边即插到其后", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    expect(tabKinds()).toEqual(["vault", "sftp", "newtab"]);
    const from = tabByKind("vault");
    const to = tabByKind("sftp");
    from.dispatchEvent(new MouseEvent("dragstart", { bubbles: true, cancelable: true, clientX: 0 }));
    to.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 10 }));
    to.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 10 }));
    await flush(2);
    expect(tabKinds()).toEqual(["sftp", "vault", "newtab"]);
  });

  it("⌘⇧] / ⌘⇧[ 循环切换 tab", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    key(document, { code: "BracketRight", key: "]", metaKey: true, shiftKey: true });
    await waitFor(() => activeTab()!.dataset.kind === "vault");
    key(document, { code: "BracketLeft", key: "[", metaKey: true, shiftKey: true });
    await waitFor(() => activeTab()!.dataset.kind === "newtab");
  });
});

/* ================= 会话 / 分屏 / 断线 ================= */

describe("会话与分屏", () => {
  it("本地终端:发 createLocal、tab 变 on、标题落到 Local shell、SFTP 按钮保持禁用", async () => {
    const { calls } = await boot();
    await openLocal();
    expect(count(calls, "createLocal")).toBe(1);
    const arg = (lastCall(calls, "createLocal") as unknown[])[0] as { cols: number; rows: number };
    expect(typeof arg.cols).toBe("number");
    expect(typeof arg.rows).toBe("number");
    expect(tabByKind("session").classList.contains("on")).toBe(true);
    expect(activeTab()!.dataset.kind).toBe("session");
    expect(document.querySelector("#status-dot")!.className).toBe("on");
    expect((document.querySelector("#btn-sftp") as HTMLButtonElement).disabled).toBe(true);
  });

  it("SSH 会话:发 ssh.connect、SFTP 按钮启用,点它切到 SFTP 并列出远端", async () => {
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "sftp.list": async (sid: unknown, dir: string) => ({
          path: "/root",
          entries: [{ name: "logs", size: 0, isDir: true, mtime: 1_700_000_000, mode: 0o040755 }],
        }),
        "local.list": async () => ({ path: "/home/u", entries: [] }),
      },
    });
    await openSsh();
    expect(count(calls, "ssh.connect")).toBe(1);
    expect((lastCall(calls, "ssh.connect") as unknown[])[0]).toBe("h_alice");
    expect(document.querySelector(".host-item")!.classList.contains("active")).toBe(true);
    const sftpBtn = document.querySelector("#btn-sftp") as HTMLButtonElement;
    expect(sftpBtn.disabled).toBe(false);

    click(sftpBtn);
    await waitFor(() => activeTab()!.dataset.kind === "sftp");
    await waitFor(() => document.querySelectorAll('.sftp-pane[data-which="remote"] .sp-row').length > 0);
    expect((lastCall(calls, "sftp.list") as unknown[])[0]).toBe(1); // sid 来自 ssh.connect 的返回
    expect(document.querySelector('.sftp-pane[data-which="remote"] .sp-row:not(.up) .sp-name .nm')!.textContent).toBe("logs");
    /* 回到会话 tab:该按钮表示"当前 tab 有 ssh 会话",应重新可用 */
    click(tabByKind("session"));
    await waitFor(() => title() === HOST.name);
    expect((document.querySelector("#btn-sftp") as HTMLButtonElement).disabled).toBe(false);
  });

  it("连接失败:横幅显示主进程给出的原因(去掉 invoke 前缀),tab 标为 off", async () => {
    const { calls } = await boot();
    vi.resetModules();
    /* 重新以失败桥启动(换掉 createLocal 实现) */
    document.documentElement.innerHTML = "";
    localStorage.clear();
    loadRendererDom();
    const failed = makeBridge({
      createLocal: async () => { throw new Error("Error invoking remote method 'terminal:create', boom"); },
    });
    (window as unknown as { sshkit: unknown }).sshkit = failed.api;
    await import("../../src/renderer/app");
    await flush(6);
    click(document.querySelector("#btn-quick-term"));
    await waitFor(() => document.querySelector("#banner")!.classList.contains("visible"));
    expect(document.querySelector("#banner")!.textContent).toBe("boom");
    expect(title()).toBe("Local shell (failed)");
    expect(tabByKind("session").classList.contains("off")).toBe(true);
    expect(document.querySelector("#status-dot")!.className).toBe("off");
    expect(failed.calls["createLocal"]?.length).toBe(1);
    expect(calls["createLocal"]?.length ?? 0).toBe(0);
  });

  it("SSH 连接失败:横幅显示原因,SFTP 按钮仍禁用", async () => {
    await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "ssh.connect": async () => { throw new Error("authentication failed"); },
      },
    });
    await waitFor(() => !!document.querySelector(".host-item"));
    click(document.querySelector(".host-item"));
    await waitFor(() => document.querySelector("#banner")!.classList.contains("visible"));
    expect(document.querySelector("#banner")!.textContent).toBe("authentication failed");
    expect(title()).toBe("alice (failed)");
    expect((document.querySelector("#btn-sftp") as HTMLButtonElement).disabled).toBe(true);
  });

  it("活动页是 New Tab 时,连接主机复用该 tab 而不是新开", async () => {
    await boot({ overrides: { "hosts.list": async () => [HOST] } });
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    const n = tabEls().length;
    await openSsh();
    expect(tabEls().length).toBe(n);
    expect(tabKinds().filter((k) => k === "newtab").length).toBe(0);
    expect(tabKinds().filter((k) => k === "session").length).toBe(1);
  });

  it("会话退出:本地退出只标 off;ssh dropped 会弹断线层 + 全局断开条", async () => {
    const { calls, emit } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    const sid = (lastCall(calls, "onExit") as unknown[])[0] as number;
    emit.exit(sid, { exitCode: 0, reason: "dropped" });
    await waitFor(() => !!document.querySelector(".disc"));
    expect(document.querySelector(".disc-title")!.textContent).toBe("Session is disconnected");
    expect(document.querySelector(".disc-reason")!.textContent).toBe("Initiating reconnection...");
    expect(document.querySelector("#disc-bar")!.textContent).toContain("1 session is disconnected");
    expect(tabByKind("session").classList.contains("off")).toBe(true);
  });

  it("Disable reconnecting:停止自动重连,不再发起新连接", async () => {
    const { calls, emit } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    const sid = (lastCall(calls, "onExit") as unknown[])[0] as number;
    vi.useFakeTimers();
    emit.exit(sid, { exitCode: 1, reason: "dropped" });
    await vi.advanceTimersByTimeAsync(1);
    click(document.querySelector(".disc-stop"));
    /* 后台重连循环到点后会看到 autoRetryOff 并停下,不再 connect */
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector(".disc-reason")!.textContent).toBe("Reconnecting disabled");
    expect((document.querySelector(".disc-stop") as HTMLElement).hidden).toBe(true);
    expect(count(calls, "ssh.connect")).toBe(1);
    click(document.querySelector(".disc-close"));
    await vi.advanceTimersByTimeAsync(1);
    expect(tabKinds()).not.toContain("session");
  });

  it("自动重连成功:1s 后重新 connect,断线层消失、状态回到 on", async () => {
    const { calls, emit } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    const sid = (lastCall(calls, "onExit") as unknown[])[0] as number;
    vi.useFakeTimers();
    emit.exit(sid, { exitCode: 0, reason: "dropped" });
    expect(document.querySelector(".disc-reason")!.textContent).toBe("Initiating reconnection...");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector(".disc")).toBeNull();
    expect(count(calls, "ssh.connect")).toBe(2);
    expect(tabByKind("session").classList.contains("on")).toBe(true);
    expect(tabByKind("session").classList.contains("off")).toBe(false);
  });

  it("自动重连失败 3 次:给出 No connection available,断开条可一键关闭所有断线 tab", async () => {
    let connects = 0;
    const { calls, emit } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "ssh.connect": async () => {
          connects++;
          if (connects === 1) return { id: 1 };
          throw new Error("still down");
        },
      },
    });
    await openSsh();
    const sid = (lastCall(calls, "onExit") as unknown[])[0] as number;
    vi.useFakeTimers();
    emit.exit(sid, { exitCode: 0, reason: "dropped" });
    await vi.advanceTimersByTimeAsync(1000); // 第 1 次重试失败
    await vi.advanceTimersByTimeAsync(2000); // 第 2 次
    await vi.advanceTimersByTimeAsync(4000); // 第 3 次
    await vi.advanceTimersByTimeAsync(1);
    expect(count(calls, "ssh.connect")).toBe(4); // 首次 + 3 次重试
    expect(document.querySelector(".disc-reason")!.textContent).toBe("No connection available to reconnect");

    /* 手动 Try again:重新允许尝试并再发起连接 */
    click(document.querySelector(".disc-retry"));
    expect(document.querySelector(".disc-reason")!.textContent).toBe("Initiating reconnection...");
    await vi.advanceTimersByTimeAsync(1000);
    expect(count(calls, "ssh.connect")).toBe(5);

    click(document.querySelector(".db-closeall"));
    await vi.advanceTimersByTimeAsync(5000); // 让后台重试循环看到 tab 已关而退出
    expect(tabKinds()).not.toContain("session");
    expect(document.querySelector("#disc-bar")).toBeNull();
  });

  it("分屏:右键 Split horizontally → 选本地 shell → 建第二个会话;广播开关把输入同时发给两格", async () => {
    const { calls } = await boot({ storage: { "sshkit.bench": "1" } });
    await openLocal();
    contextMenuOn(tabByKind("session"));
    expect(document.querySelector(".tab-menu")!.textContent).toContain("Split horizontally");
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    await waitFor(() => !!document.querySelector(".split-pane"));
    expect(document.querySelector(".split-title")!.textContent).toBe("New pane");
    const bc = document.querySelector(".split-bc input") as HTMLInputElement;
    expect(bc.disabled).toBe(true);

    click(document.querySelector(".sp-local"));
    await waitFor(() => !document.querySelector(".split-picker"));
    expect(count(calls, "createLocal")).toBe(2);
    expect(document.querySelector(".split-title")!.textContent).toBe("Local shell");
    bc.checked = true;
    bc.dispatchEvent(new Event("change"));

    const bench = (window as unknown as { __bench: { tabs: () => Array<Record<string, unknown>>; input: (d: string, pane?: number) => boolean } }).__bench;
    const sessionTab = bench.tabs().find((t) => t.kind === "session")!;
    expect(sessionTab.broadcast).toBe(true);
    expect(sessionTab.splitTermId).not.toBeNull();
    expect(bench.input("ls\r")).toBe(true);
    const writes = (calls["write"] ?? []).filter((a) => a[1] === "ls\r");
    expect(writes.length).toBe(2);
    expect(new Set(writes.map((a) => a[0])).size).toBe(2);

    /* 反向:在分屏格里输入也要按广播扇出回主终端 */
    expect(bench.input("xyz", 1)).toBe(true);
    const fromSplit = (calls["write"] ?? []).filter((a) => a[1] === "xyz");
    expect(fromSplit.length).toBe(2);
    expect(new Set(fromSplit.map((a) => a[0])).size).toBe(2);

    /* 外观变化要同步到分屏那格(此前 applyAppearance 只改了主终端):
       ⌘= 改字号后,分屏终端的 fontSize 必须一起变。 */
    expect(sessionTab.splitSize).toBe(14);
    key(document, { code: "Equal", key: "=", metaKey: true });
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("15");
    expect(bench.tabs().find((t) => t.kind === "session")!.splitSize).toBe(15);

    click(document.querySelector(".split-close"));
    await waitFor(() => !document.querySelector(".split-pane"));
    expect(calls["dispose"]?.length).toBe(1);
  });

  it("没有分屏时 ⌘B 给出 „先分屏再广播“ 提示,而不是假装切换", async () => {
    await boot();
    vi.useFakeTimers();
    key(document, { code: "KeyB", key: "b", metaKey: true });
    expect(document.querySelector(".toast")!.textContent).toBe("Split horizontally before turning on broadcast");
  });
});

/* ================= 外观与设置面板 ================= */

describe("外观与设置面板", () => {
  it("⌘, 打开/再按关闭;点面板外关闭;主进程菜单回调也能打开", async () => {
    const { emit } = await boot();
    key(document, { code: "Comma", key: ",", metaKey: true });
    await flush(2);
    expect(document.querySelector(".prefs")).toBeTruthy();
    key(document, { code: "Comma", key: ",", metaKey: true });
    await flush(2);
    expect(document.querySelector(".prefs")).toBeNull();

    click(document.querySelector("#btn-prefs"));
    await flush(2);
    expect(document.querySelector(".prefs")).toBeTruthy();
    click(document.body);
    await flush(2);
    expect(document.querySelector(".prefs")).toBeNull();

    emit.openPrefs();
    await flush(2);
    expect(document.querySelector(".prefs")).toBeTruthy();
  });

  it("深浅色:写 body.dataset.ui / localStorage,当前模式高亮", async () => {
    await boot();
    await openPrefs();
    expect(document.body.dataset.ui).toBe("dark");
    const light = prefsBtn<HTMLElement>('.ui-mode[data-mode="light"]');
    click(light);
    await flush(2);
    expect(document.body.dataset.ui).toBe("light");
    expect(localStorage.getItem("sshkit.uiTheme")).toBe("light");
    expect(document.querySelector(".ui-theme-val")!.textContent).toBe("Light");
    expect(light.classList.contains("on")).toBe(true);
    click(prefsBtn('.ui-mode[data-mode="dark"]'));
    await flush(2);
    expect(document.body.dataset.ui).toBe("dark");
    expect(localStorage.getItem("sshkit.uiTheme")).toBe("dark");
  });

  it("字号:A−/A+/输入/重置都落盘并刷新读数;下限 4 会夹取", async () => {
    await boot({ storage: { "sshkit.fontSize": "4" } });
    await openPrefs();
    expect(prefsBtn(".ps-val").textContent).toBe("4px");
    expect((prefsBtn(".ps-size") as HTMLInputElement).value).toBe("4");
    click(prefsBtn(".ps-down"));
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("4");
    click(prefsBtn(".ps-up"));
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("5");
    expect(prefsBtn(".ps-val").textContent).toBe("5px");
    const sizeInput = prefsBtn<HTMLInputElement>(".ps-size");
    sizeInput.value = "30";
    sizeInput.dispatchEvent(new Event("change"));
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("30");
    expect((prefsBtn(".ps-size") as HTMLInputElement).value).toBe("30");
    click(prefsBtn(".ps-reset"));
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("14");
    expect(prefsBtn(".ps-val").textContent).toBe("14px");
  });

  it("字号上限 40:已到顶时 A+ 不再增长", async () => {
    await boot({ storage: { "sshkit.fontSize": "40" } });
    await openPrefs();
    click(prefsBtn(".ps-up"));
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("40");
    click(prefsBtn(".ps-down"));
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("39");
  });

  it("选配色:落盘并更新 --term-bg/--term-fg(浅色底自动配深前景)", async () => {
    await boot();
    await openPrefs();
    expect(document.documentElement.style.getPropertyValue("--term-bg")).toBe("#141729");
    expect(document.documentElement.style.getPropertyValue("--term-fg")).toBe("#e6e9ef");
    const schemes = [...document.querySelectorAll<HTMLElement>(".prefs .scheme")];
    expect(schemes.length).toBeGreaterThan(10);
    const light = schemes.find((b) => b.textContent === "Termius Light")!;
    click(light);
    await flush(2);
    expect(localStorage.getItem("sshkit.scheme")).toBe("Termius Light");
    expect(document.documentElement.style.getPropertyValue("--term-bg")).toBe("#d5dde0");
    expect(document.documentElement.style.getPropertyValue("--term-fg")).toBe("#1f2430");
  });

  /* 期望行为:设置面板是"连续调参"的地方(主题→字号→字体),选一个配色不应把面板关掉。
     当前实现 bug:按钮 handler 里 drawList() 同步重建了列表,点击目标节点已脱离文档;
     事件继续冒泡到 app.ts 的 document "点面板外关闭" 监听时 el.contains(target) 变成 false,
     面板被 remove。产品修复点:只有 target 仍在文档内且确实在面板外时才关闭。 */
  it("选配色后面板应保持打开,并高亮当前方案(连续调主题不应每次关面板)", async () => {
    await boot();
    await openPrefs();
    const light = [...document.querySelectorAll<HTMLElement>(".prefs .scheme")]
      .find((b) => b.textContent === "Termius Light")!;
    click(light);
    await flush(2);
    expect(document.querySelector(".prefs")).toBeTruthy();
    expect([...document.querySelectorAll(".prefs .scheme.on")].map((b) => b.textContent)).toEqual(["Termius Light"]);
  });

  it("默认字体按平台分:Windows 用系统等宽(Cascadia/Consolas),其余平台用随包 Meslo", async () => {
    const { app } = await boot();
    /* 期望变更(2026-10-22):原来 Windows 也默认随包 Meslo,是错误的 —— 它作为网页字体
       在 xterm 的 canvas 字形图集里会回退成细体 Courier New(用户反馈"字体很难看"),
       系统等宽字体在同一条渲染路径下清晰锐利。 */
    expect(app.defaultFontFamily("win32")).toContain("Cascadia Mono");
    expect(app.defaultFontFamily("win32")).toContain("Consolas");
    expect(app.defaultFontFamily("darwin")).toContain("MesloLGS NF");
  });

  it("字体选择落盘,并同步到已打开终端的 options", async () => {
    const { } = await boot({ storage: { "sshkit.bench": "1" } });
    await openLocal();
    const bench = (window as unknown as { __bench: { tabs: () => Array<Record<string, unknown>> } }).__bench;
    const termFont = (): unknown => bench.tabs().find((t) => t.kind === "session")!.font;
    /* 测试桥的 platform 是 win32 → 默认系统等宽字体 */
    expect(String(termFont())).toContain("Cascadia Mono");
    await openPrefs();
    const sel = prefsBtn<HTMLSelectElement>(".ps-font");
    expect(sel.options.length).toBeGreaterThan(3);
    const target = sel.options[0].value;   // MesloLGS NF(随包字体)
    sel.value = target;
    sel.dispatchEvent(new Event("change"));
    await flush(2);
    expect(localStorage.getItem("sshkit.fontFamily")).toBe(target);
    expect(termFont()).toBe(target);
  });

  it("渲染器判定:随包网页字体强制 DOM,系统字体可用 canvas,用户可强制 dom", async () => {
    const { app } = await boot();
    const MESLO = '"MesloLGS NF", "MesloLGS Nerd Font Mono", monospace';
    const SYS = '"Cascadia Mono", Consolas, "Microsoft YaHei", monospace';
    expect(app.isBundledWebFont(MESLO)).toBe(true);
    expect(app.isBundledWebFont(SYS)).toBe(false);
    expect(app.useCanvasRenderer(SYS, null)).toBe(true);
    expect(app.useCanvasRenderer(SYS, "dom")).toBe(false);
    expect(app.useCanvasRenderer(MESLO, null)).toBe(false);
  });

  it("切到随包 Meslo 时 dispose canvas(退回 DOM),切回系统字体再挂上 canvas", async () => {
    const g = globalThis as { __canvasOk?: boolean; __canvasInstances?: Array<{ disposed: boolean }> };
    g.__canvasOk = true;
    g.__canvasInstances = [];
    try {
      await boot();
      await openLocal();
      /* win32 默认系统字体 → 终端挂 canvas */
      expect(g.__canvasInstances).toHaveLength(1);
      await openPrefs();
      const sel = prefsBtn<HTMLSelectElement>(".ps-font");
      sel.value = '"MesloLGS NF", "MesloLGS Nerd Font Mono", monospace';
      sel.dispatchEvent(new Event("change"));
      await flush(2);
      /* 网页字体在 canvas 图集里会回退 → 必须退回 DOM 渲染 */
      expect(g.__canvasInstances![0].disposed).toBe(true);

      sel.value = '"Cascadia Mono", Consolas, "Microsoft YaHei", monospace';
      sel.dispatchEvent(new Event("change"));
      await flush(2);
      /* 系统字体 → 重新挂一个 canvas 渲染器 */
      expect(g.__canvasInstances).toHaveLength(2);
      expect(g.__canvasInstances![1].disposed).toBe(false);
    } finally {
      g.__canvasOk = false;
      g.__canvasInstances = undefined;
    }
  });

  it("⌘= 放大终端字号并落盘", async () => {
    await boot();
    key(document, { code: "Equal", key: "=", metaKey: true });
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("15");
    key(document, { code: "Minus", key: "-", metaKey: true });
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("14");
  });

  it("切中文:setLocale 落盘 + applyDom 翻译 + 面板以新语言重建;可切回英文", async () => {
    const { calls } = await boot();
    await openPrefs();
    click(prefsBtn('.lang-mode[data-lang="zh"]'));
    await waitFor(() => document.documentElement.lang === "zh-CN");
    expect((lastCall(calls, "settings.setLocale") as unknown[])[0]).toBe("zh");
    expect(document.querySelector('#rail .rail-item[data-nav="hosts"] .rl')!.textContent).toBe("主机");
    expect(document.querySelector(".prefs h4")!.textContent).toBe("界面");
    expect(document.querySelector('.prefs .lang-mode[data-lang="zh"]')!.classList.contains("on")).toBe(true);

    click(document.querySelector('.prefs .lang-mode[data-lang="en"]')!);
    await waitFor(() => document.documentElement.lang === "en");
    expect((lastCall(calls, "settings.setLocale") as unknown[])[0]).toBe("en");
    expect(document.querySelector('#rail .rail-item[data-nav="hosts"] .rl')!.textContent).toBe("Hosts");
  });

  it("语言切换失败时不改变界面(错误被记录,不把界面切一半)", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a); });
    try {
      await boot({ overrides: { "settings.setLocale": async () => { throw new Error("settings write failed"); } } });
      await openPrefs();
      click(prefsBtn('.lang-mode[data-lang="zh"]'));
      await flush(4);
      expect(errors.length).toBe(1);
      expect(document.documentElement.lang).toBe("en");
      expect(document.querySelector('#rail .rail-item[data-nav="hosts"] .rl')!.textContent).toBe("Hosts");
      expect(document.querySelector(".prefs")).toBeTruthy(); // 面板没被拆掉
    } finally {
      spy.mockRestore();
    }
  });

  it("启动时恢复上次的界面主题/工作区视图/侧栏开关", async () => {
    await boot({ storage: { "sshkit.uiTheme": "light", "sshkit.tabView": "workspace", "sshkit.sidePanel": "1" } });
    expect(document.body.dataset.ui).toBe("light");
    expect(document.body.dataset.tabview).toBe("workspace");
    expect(document.body.dataset.panel).toBe("1");
    expect(document.querySelector("#btn-panel")!.classList.contains("on")).toBe(true);
  });
});

/* ================= 终端侧栏 / 提示条 ================= */

const lastToast = (): string | null => {
  const toasts = [...document.querySelectorAll(".toast")];
  return toasts.length ? toasts[toasts.length - 1].textContent : null;
};

describe("终端侧栏与提示条", () => {
  it("随包字体(JetBrainsMono/FiraCode)算可用,且强制 DOM 渲染", async () => {
    await boot();
    const app = await import("../../src/renderer/app");
    expect(app.BUNDLED_WEB_FONTS).toContain("JetBrainsMono Nerd Font Mono");
    expect(app.BUNDLED_WEB_FONTS).toContain("FiraCode Nerd Font Mono");
    for (const f of app.BUNDLED_WEB_FONTS) {
      expect(app.isBundledWebFont(`"${f}", monospace`)).toBe(true);
      expect(app.useCanvasRenderer(`"${f}", monospace`, null)).toBe(false);   // 网页字体 → DOM 渲染
    }
    expect(app.isBundledWebFont("Menlo, monospace")).toBe(false);
    expect(app.useCanvasRenderer("Menlo, monospace", null)).toBe(true);
  });

  it("字体选择器:未安装的字体置灰不可选,随包 Meslo 始终可用", async () => {
    await boot({ overrides: { "hosts.list": async () => [HOST] } });
    /* 伪造 canvas 度量(必须在 boot 之后:boot 会把 getContext 重置成 null)。
       只有 "Menlo" 与缺失基线宽度不同(视为已安装),其它都等于基线(未安装) */
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({
      font: "",
      /* 必须是普通函数:fontAvailable 用 c.measureText(...) 调用,this 指向上下文 */
      measureText(this: { font: string }) { return { width: this.font.includes("Menlo") ? 120 : 100 }; },
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      key(document, { code: "Period", key: ".", metaKey: true });
      await waitFor(() => document.body.dataset.panel === "1");
      click(document.querySelector("#panel-font"));
      await flush(3);
      expect(document.querySelector(".font-picker")).toBeTruthy();
      expect(document.querySelectorAll(".fp-row").length).toBeGreaterThan(5);

      const row = (prefix: string): HTMLButtonElement =>
        [...document.querySelectorAll<HTMLButtonElement>(".fp-row")].find((r) => r.dataset.font!.includes(prefix))!;
      expect(row("Menlo").disabled).toBe(false);
      expect(row("MesloLGS").disabled).toBe(false);          // 网页字体特例
      const missing = [...document.querySelectorAll<HTMLButtonElement>(".fp-row")].find((r) => r.disabled && !r.dataset.font!.includes("Meslo"));
      expect(missing).toBeTruthy();
      expect(missing!.querySelector(".fp-preview")!.textContent).toBe("not installed");
      missing!.click();
      await flush(2);
      expect(localStorage.getItem("sshkit.fontFamily")).not.toBe(missing!.dataset.font);   // 点了也不生效
      expect(document.querySelector(".font-picker")).toBeTruthy();                          // 也不关闭
    } finally {
      HTMLCanvasElement.prototype.getContext = orig;
    }
  });

  it("侧栏外观区可操作:Font 行只开不关(不再重复绑定);字号 A−/A+/输入框都生效且夹在 4–40", async () => {
    await boot({ overrides: { "hosts.list": async () => [HOST] } });
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => document.body.dataset.panel === "1");

    /* 已存在一层时再打开:旧的先被清掉,不会叠出两层 */
    const stale = document.createElement("div");
    stale.className = "font-picker-backdrop";
    document.body.append(stale);
    click(document.querySelector("#panel-font"));
    await flush(3);
    expect(stale.isConnected).toBe(false);      // 旧的那层被清掉
    expect(document.querySelector(".font-picker")).toBeNull();
    click(document.querySelector("#panel-font")); // 再点一次才真正打开
    await flush(3);
    expect(document.querySelectorAll(".font-picker-backdrop").length).toBe(1);
    expect(document.querySelector(".font-picker")).toBeTruthy();
    /* 点弹框内部不关闭 */
    click(document.querySelector(".font-picker .fp-title"));
    await flush(2);
    expect(document.querySelector(".font-picker")).toBeTruthy();
    /* 点遮罩关闭,给后续字号操作让出界面 */
    click(document.querySelector(".font-picker-backdrop"));
    await flush(2);
    expect(document.querySelector(".font-picker")).toBeNull();

    /* 字号:A+ 增大并落盘、A− 减小、输入框直接设定、越界夹紧 */
    const input = document.querySelector("#panel-font-size") as HTMLInputElement;
    expect(input.value).toBe("14");
    click(document.querySelector("#sidepanel .ps-up"));
    await flush(2);
    expect(input.value).toBe("15");
    expect(localStorage.getItem("sshkit.fontSize")).toBe("15");
    click(document.querySelector("#sidepanel .ps-down"));
    await flush(2);
    expect(input.value).toBe("14");

    input.value = "22";
    input.dispatchEvent(new Event("change"));
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("22");

    click(document.querySelector("#sidepanel .ps-up"));
    click(document.querySelector("#sidepanel .ps-up"));
    await flush(2);
    input.value = "99";
    input.dispatchEvent(new Event("change"));
    await flush(2);
    expect(Number(localStorage.getItem("sshkit.fontSize"))).toBe(40);   // 上限
    input.value = "1";
    input.dispatchEvent(new Event("change"));
    await flush(2);
    expect(Number(localStorage.getItem("sshkit.fontSize"))).toBe(4);    // 下限
  });

  it("侧栏 tab:代码片段是独立 tab,切换后内容与选中态跟着变并记住", async () => {
    await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "snippets.list": async () => [{ id: "s1", name: "Deploy", command: "make deploy" }],
      },
    });
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => document.body.dataset.panel === "1");
    const visible = (): string => {
      const v = [...document.querySelectorAll<HTMLElement>("#sidepanel .sp-view")].find((x) => !x.hidden);
      return v?.dataset.view ?? "";
    };
    expect(visible()).toBe("appearance");

    click(document.querySelector('#sidepanel .sp-tab[data-sp-tab="snippets"]'));
    await flush(2);
    expect(visible()).toBe("snippets");
    expect(document.querySelector('#sidepanel .sp-tab.on')!.getAttribute("data-sp-tab")).toBe("snippets");
    expect(document.querySelector("#snip-list .sp-nm")!.textContent).toBe("Deploy");
    expect(localStorage.getItem("sshkit.panelTab")).toBe("snippets");

    click(document.querySelector('#sidepanel .sp-tab[data-sp-tab="jump"]'));
    await flush(2);
    expect(visible()).toBe("jump");
    expect(document.querySelector("#jump-list .sp-item")).toBeTruthy();

    /* 关掉再开:停在上次的 tab */
    key(document, { code: "Period", key: ".", metaKey: true });
    await flush(2);
    key(document, { code: "Period", key: ".", metaKey: true });
    await flush(2);
    expect(visible()).toBe("jump");
  });

  it("侧栏外观区:Font 行 + Themes 缩略色卡;点主题立即应用并落盘", async () => {
    /* 自定义字体族(不在清单里):启动时读 localStorage,Font 行应直接把该串当名字 */
    await boot({
      overrides: { "hosts.list": async () => [HOST] },
      storage: { "sshkit.fontFamily": "Some Custom Mono" },
    });
    /* 用快捷键开侧栏(与其它侧栏用例一致,避免依赖按钮所在视图) */
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => document.body.dataset.panel === "1");
    const themes = [...document.querySelectorAll<HTMLElement>(".sp-theme-row")];
    expect(themes.length).toBeGreaterThan(10);
    expect(themes[0].querySelectorAll(".sp-thumb i").length).toBe(5);
    const current = themes.find((t) => t.querySelector(".sp-theme-badge")!.textContent === "current")!;
    expect(current).toBeTruthy();
    /* 默认主题不落盘,所以"未设置"时也要认 Termius Dark */
    expect(current.dataset.theme).toBe(localStorage.getItem("sshkit.scheme") ?? "Termius Dark");

    /* Font 行:自定义字体的回退显示;点击只弹字体选择器(不是整个偏好设置) */
    expect(document.querySelector("#panel-font .sp-font-name")!.textContent).toBe("Some Custom Mono");
    click(document.querySelector("#panel-font"));
    await flush(3);
    expect(document.querySelector(".font-picker")).toBeTruthy();
    expect(document.querySelector(".prefs")).toBeNull();
    expect(document.querySelectorAll(".font-picker .fp-row").length).toBeGreaterThan(3);
    click(document.querySelectorAll(".font-picker .fp-row")[1] as HTMLElement);   // 选第二项(与当前不同)
    await flush(2);
    expect(document.querySelector(".font-picker")).toBeNull();
    expect(localStorage.getItem("sshkit.fontFamily")).toBeTruthy();
    /* 侧栏字体名要同步成新选的字体,不能还显示旧的 */
    const picked = (localStorage.getItem("sshkit.fontFamily") ?? "").replace(/^"|".*$/g, "");
    expect(document.querySelector("#panel-font .sp-font-name")!.textContent).toBe(picked);

    const other = [...document.querySelectorAll<HTMLElement>(".sp-theme-row")]
      .find((t) => t.dataset.theme !== current.dataset.theme)!;
    other.click();
    await flush(2);
    expect(localStorage.getItem("sshkit.scheme")).toBe(other.dataset.theme);
    const after = [...document.querySelectorAll<HTMLElement>(".sp-theme-row")]
      .find((t) => t.dataset.theme === other.dataset.theme)!;
    expect(after.className).toContain("on");
    expect(after.querySelector(".sp-theme-badge")!.textContent).toBe("current");
  });

  it("⌘. 开关侧栏并渲染 Jump to / Snippets;点主机连它,点片段发到当前会话,可删除片段", async () => {
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "snippets.list": async () => [
          { id: "s1", name: "Deploy", command: "make deploy" },
          { id: "s2", name: "Newline", command: "echo hi\n" },
        ],
      },
    });
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => document.body.dataset.panel === "1");
    await waitFor(() => document.querySelectorAll("#jump-list .sp-item").length === 1);
    expect(document.querySelector("#jump-list .sp-nm")!.textContent).toBe("alice");
    expect(document.querySelector("#jump-list .sp-sub")!.textContent).toBe("root@192.0.2.10");
    expect(document.querySelector("#snip-list .sp-nm")!.textContent).toBe("Deploy");

    /* 点主机 = Jump to:活动页是 Vaults(非会话),按语义新开一个 ssh 会话 */
    click(document.querySelector("#jump-list .sp-item"));
    await waitFor(() => title() === HOST.name);
    expect((lastCall(calls, "ssh.connect") as unknown[])[0]).toBe("h_alice");

    /* 点片段 = 把命令(补回车)写到当前会话 */
    await waitFor(() => !!document.querySelector("#snip-list .sp-item"));
    click(document.querySelector("#snip-list .sp-item"));
    await flush(2);
    expect((lastCall(calls, "write") as unknown[])[1]).toBe("make deploy\r");
    /* 片段自带换行时只换成回车,避免多发一次空行 */
    click(document.querySelectorAll("#snip-list .sp-item")[1]);
    await flush(2);
    expect((lastCall(calls, "write") as unknown[])[1]).toBe("echo hi\r");

    /* 片段行内 ✕ 删除后重拉列表 */
    click(document.querySelector("#snip-list .sp-del"));
    await waitFor(() => count(calls, "snippets.remove") === 1);
    expect((lastCall(calls, "snippets.remove") as unknown[])[0]).toBe("s1");
    await waitFor(() => count(calls, "snippets.list") >= 2);

    click(document.querySelector(".sp-close"));
    await flush(2);
    expect(document.body.dataset.panel).toBe("0");
  });

  it("侧栏新建片段:保存桥参数、清空输入、重拉列表;空表单不保存", async () => {
    const { calls } = await boot();
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => document.body.dataset.panel === "1");
    click(document.querySelector(".snip-save"));
    await flush(3);
    expect(count(calls, "snippets.save")).toBe(0);

    (document.querySelector(".snip-name") as HTMLInputElement).value = "Greet";
    (document.querySelector(".snip-cmd") as HTMLInputElement).value = "echo hi";
    click(document.querySelector(".snip-save"));
    await waitFor(() => count(calls, "snippets.save") === 1);
    expect((lastCall(calls, "snippets.save") as unknown[])[0]).toEqual({ name: "Greet", command: "echo hi" });
    await waitFor(() => (document.querySelector(".snip-name") as HTMLInputElement).value === "");
    expect((document.querySelector(".snip-cmd") as HTMLInputElement).value).toBe("");
  });

  it("⌘J / ⌘⇧S 打开侧栏并定位到对应分区(高亮闪一下)", async () => {
    await boot();
    key(document, { code: "KeyJ", key: "j", metaKey: true });
    await waitFor(() => !!document.querySelector("#sidepanel .sp-sec.sp-flash"));
    expect(document.body.dataset.panel).toBe("1");
    expect(document.querySelector("#sidepanel .sp-sec.sp-flash .sp-title")!.textContent).toBe("Jump to");

    key(document, { code: "KeyS", key: "s", metaKey: true, shiftKey: true });
    await waitFor(() => [...document.querySelectorAll("#sidepanel .sp-sec.sp-flash .sp-title")]
      .some((e) => e.textContent === "Snippets"));
  });

  it("toast:立即出现、2.6s 后淡出、3.2s 后移除", async () => {
    await boot();
    vi.useFakeTimers();
    /* 串口功能已移除,改用仍然存在的"未实现"快捷键(Cmd+S 保存工作区模板)触发 toast */
    key(document, { code: "KeyS", key: "s", metaKey: true });
    expect(lastToast()).toBe("\"Save Workspace Template\" is not implemented yet");
    await vi.advanceTimersByTimeAsync(2700);
    expect(document.querySelector(".toast")!.classList.contains("out")).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("Vaults pill 的下拉箭头提示只有一个保管库", async () => {
    await boot();
    click(tabByKind("vault").querySelector(".tchev"));
    expect(lastToast()).toBe("Switching vaults: only one local vault for now");
  });

  it("beforeunload 收掉本次界面开的全部会话", async () => {
    const { calls } = await boot();
    window.dispatchEvent(new Event("beforeunload"));
    expect(count(calls, "disposeAllSessions")).toBe(1);
  });
});

/* ================= 分区屏 ================= */

describe("分区屏", () => {
  const nav = (name: string): HTMLElement => document.querySelector(`#rail .rail-item[data-nav="${name}"]`)!;

  it("左栏六个分区入口:各开一个 tab,重复点击只激活不重复创建", async () => {
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "snippets.list": async () => [{ id: "s1", name: "Deploy", command: "make deploy" }],
        "creds.has": async () => true,
        "knownhost.list": async () => [{ host: "192.0.2.10", keyType: "ssh-ed25519", fingerprint: "SHA256:abc", hashed: false }],
      },
    });

    click(nav("forwarding"));
    await waitFor(() => tabKinds().includes("fwd"));
    expect(activeTab()!.dataset.kind).toBe("fwd");
    await waitFor(() => count(calls, "fwd.rules") > 0);
    await waitFor(() => !!document.querySelector(".tab-pane.active .fwd-empty h3"));
    expect(document.querySelector(".tab-pane.active .fwd-empty h3")!.textContent).toBe("Set up port forwarding");
    click(nav("forwarding"));
    await flush(3);
    expect(tabKinds().filter((k) => k === "fwd").length).toBe(1);

    click(nav("knownhosts"));
    await waitFor(() => tabKinds().includes("kh"));
    await waitFor(() => !!document.querySelector(".tab-pane.active .kh-row"));
    click(nav("knownhosts"));
    await flush(3);
    expect(tabKinds().filter((k) => k === "kh").length).toBe(1);

    click(nav("snippets"));
    await waitFor(() => tabKinds().includes("snippets"));
    await waitFor(() => document.querySelectorAll(".tab-pane.active .sec-row").length > 0);
    expect(document.querySelector(".tab-pane.active .sec-row .nm")!.textContent).toBe("Deploy");

    click(nav("logs"));
    await waitFor(() => tabKinds().includes("logs"));
    expect(document.querySelector(".tab-pane.active .sec-empty-title")!.textContent).toBe("No logs yet");
    expect(nav("logs").classList.contains("on")).toBe(true);

    click(nav("hosts"));
    await waitFor(() => activeTab()!.dataset.kind === "vault");
    expect(nav("hosts").classList.contains("on")).toBe(true);
  });

  it("终端字体就绪闸门:字体没加载完不建终端(避免行距不一致)", async () => {
    /* 用一个可控的 FontFaceSet 替身:load/ready 由用例决定何时完成 */
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((r) => { releaseLoad = r; });
    const fakeFonts = {
      load: () => loadGate,
      ready: Promise.resolve(),
      check: () => true,
      add() { /* noop */ }, delete() { /* noop */ }, clear() { /* noop */ },
      addEventListener() { /* noop */ }, removeEventListener() { /* noop */ }, dispatchEvent() { return true; },
      forEach() { /* noop */ }, entries() { return [][Symbol.iterator](); }, keys() { return [][Symbol.iterator](); },
      values() { return [][Symbol.iterator](); }, [Symbol.iterator]() { return [][Symbol.iterator](); },
      size: 0, status: "loading", onloadingdone: null, onloadingerror: null, onloading: null,
    };
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: fakeFonts });
    try {
      const { calls } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
      click(document.querySelector(".host-item"));
      await flush(6);
      /* 字体还在加载:会话没发起 */
      expect(count(calls, "ssh.connect")).toBe(0);
      releaseLoad();
      await waitFor(() => count(calls, "ssh.connect") === 1);
      expect(title()).toBe(HOST.name);
    } finally {
      if (desc) Object.defineProperty(Document.prototype, "fonts", desc);
      else delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  it("字体加载失败也照样能开会话(只是不等待)", async () => {
    const fakeFonts = {
      /* 用 getter 惰性创建:直接写 Promise.reject(...) 会在字面量求值时立刻产生
         未处理的 rejection(vitest 会把它当测试失败)。 */
      get load() { return () => Promise.reject(new Error("font boom")); },
      get ready() { return Promise.reject(new Error("ready boom")); },
      check: () => false, add() {}, delete() {}, clear() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      forEach() {}, entries() { return [][Symbol.iterator](); }, keys() { return [][Symbol.iterator](); },
      values() { return [][Symbol.iterator](); }, [Symbol.iterator]() { return [][Symbol.iterator](); },
      size: 0, status: "error", onloadingdone: null, onloadingerror: null, onloading: null,
    };
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: fakeFonts });
    try {
      const { calls } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
      click(document.querySelector(".host-item"));
      await waitFor(() => count(calls, "ssh.connect") === 1);
    } finally {
      if (desc) Object.defineProperty(Document.prototype, "fonts", desc);
      else delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  it("顶栏没有通知铃铛(产品没有通知系统,不摆假入口)", async () => {
    await boot();
    expect(document.getElementById("btn-bell")).toBeNull();
    /* 顶栏右侧仍有侧栏开关与窗口按钮,只是不再有铃铛 */
    expect(document.getElementById("btn-panel-top")).toBeTruthy();
  });

  /* ---------- 主机簿加密备份(导出/导入都要手输密码) ---------- */
  const openVaultMenu = async (): Promise<void> => {
    click(document.querySelector("#host-more"));
    await waitFor(() => !!document.querySelector(".vault-menu"));
  };
  const openVaultPassword = async (index: 0 | 1): Promise<HTMLInputElement> => {
    await openVaultMenu();
    click([...document.querySelectorAll<HTMLElement>(".vault-menu-item")][index]);
    await waitFor(() => !!document.querySelector(".vault-pass-dlg"));
    return document.querySelector(".vault-pass-dlg .pd-input") as HTMLInputElement;
  };

  it("主机簿加密备份:更多菜单两项;导出要密码(太短不放行),成功后 toast 路径", async () => {
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "hosts.exportEncrypted": async () => ({ canceled: false, path: "/tmp/backup.sshkitvault", hosts: 2 }),
      },
    });
    await openVaultMenu();
    expect([...document.querySelectorAll(".vault-menu-item")].map((b) => b.textContent)).toEqual([
      "Export host book…", "Import host book…",
    ]);
    const input = await openVaultPassword(0);
    input.value = "short";
    click(document.querySelector(".vault-pass-dlg .dd-ok"));
    await flush(2);
    expect((document.querySelector(".vault-pass-dlg .vault-pass-err") as HTMLElement).hidden).toBe(false);
    expect(calls["hosts.exportEncrypted"]).toBeUndefined();
    input.value = "long-enough-pass";
    click(document.querySelector(".vault-pass-dlg .dd-ok"));
    await waitFor(() => (calls["hosts.exportEncrypted"]?.length ?? 0) === 1);
    expect((calls["hosts.exportEncrypted"].at(-1) as unknown[])[0]).toBe("long-enough-pass");
    await waitFor(() => (lastToast() ?? "").includes("/tmp/backup.sshkitvault"));
  });

  it("主机簿加密备份:导入成功后 toast 计数并刷新主机列表", async () => {
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "hosts.importEncrypted": async () => ({ canceled: false, added: 3, skipped: 1 }),
      },
    });
    const before = calls["hosts.list"].length;
    const input = await openVaultPassword(1);
    input.value = "p";
    click(document.querySelector(".vault-pass-dlg .dd-ok"));
    await waitFor(() => (calls["hosts.importEncrypted"]?.length ?? 0) === 1);
    expect((calls["hosts.importEncrypted"].at(-1) as unknown[])[0]).toBe("p");
    await waitFor(() => (lastToast() ?? "").includes("3"));
    expect(calls["hosts.list"].length).toBeGreaterThan(before);
  });

  it("备份密码弹窗:深色样式、密码可见性切换", async () => {
    await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openVaultMenu();
    click([...document.querySelectorAll<HTMLElement>(".vault-menu-item")][0]);
    await waitFor(() => !!document.querySelector(".vault-pass-dlg"));
    const dlg = document.querySelector(".vault-pass-dlg")!;
    /* 复用 SFTP 的深色卡片类,而不是白底 discard 框 */
    expect(dlg.className).toContain("prompt-dlg");
    expect(dlg.querySelector(".vault-lock")).toBeTruthy();
    const input = dlg.querySelector(".pd-input") as HTMLInputElement;
    input.value = "secret-value";
    expect(input.type).toBe("password");
    const eye = dlg.querySelector(".vault-eye") as HTMLButtonElement;
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    click(eye);
    expect(input.type).toBe("text");
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    expect((dlg.querySelector(".i-eye") as HTMLElement).hasAttribute("hidden")).toBe(true);
    expect((dlg.querySelector(".i-eye-off") as HTMLElement).hasAttribute("hidden")).toBe(false);
    click(eye);
    expect(input.type).toBe("password");
    expect((dlg.querySelector(".i-eye") as HTMLElement).hasAttribute("hidden")).toBe(false);
  });

  it("主机簿加密备份:桥报错时弹失败提示", async () => {
    await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "hosts.exportEncrypted": async () => { throw new Error("no hosts to export"); },
      },
    });
    const input = await openVaultPassword(0);
    input.value = "long-enough-pass";
    click(document.querySelector(".vault-pass-dlg .dd-ok"));
    await waitFor(() => (lastToast() ?? "").includes("no hosts to export"));
  });

  it("主机簿加密备份:取消密码框 / 桥返回 canceled 都不提示成功", async () => {
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "hosts.exportEncrypted": async () => ({ canceled: true, hosts: 0 }),
      },
    });
    /* 取消密码框:不调桥 */
    await openVaultPassword(0);
    click(document.querySelector(".vault-pass-dlg .dd-cancel"));
    await flush(2);
    expect(calls["hosts.exportEncrypted"]).toBeUndefined();
    /* 导入:取消密码框同样不调桥 */
    const importInput = await openVaultPassword(1);
    click(document.querySelector(".vault-pass-dlg .dd-cancel"));
    await flush(2);
    expect(calls["hosts.importEncrypted"]).toBeUndefined();

    /* 桥返回 canceled:调用了但不 toast */
    const input = await openVaultPassword(0);
    input.value = "long-enough-pass";
    click(document.querySelector(".vault-pass-dlg .dd-ok"));
    await waitFor(() => (calls["hosts.exportEncrypted"]?.length ?? 0) === 1);
    await flush(3);
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("主机簿加密备份:导入 canceled 不刷新;导入失败提示原因", async () => {
    /* canceled:不 toast、不刷新 */
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "hosts.importEncrypted": async () => ({ canceled: true, added: 0, skipped: 0 }),
      },
    });
    const before = calls["hosts.list"].length;
    let input = await openVaultPassword(1);
    input.value = "p";
    click(document.querySelector(".vault-pass-dlg .dd-ok"));
    await waitFor(() => (calls["hosts.importEncrypted"]?.length ?? 0) === 1);
    await flush(3);
    expect(document.querySelector(".toast")).toBeNull();
    expect(calls["hosts.list"].length).toBe(before);
    void input;
  });

  it("主机簿加密备份:导入抛错(密码错)提示原因", async () => {
    await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "hosts.importEncrypted": async () => { throw new Error("invalid passphrase or corrupted vault file"); },
      },
    });
    const input = await openVaultPassword(1);
    input.value = "wrong-pass";
    click(document.querySelector(".vault-pass-dlg .dd-ok"));
    await waitFor(() => (lastToast() ?? "").includes("invalid passphrase"));
  });

  it("备份密码弹窗与菜单的关闭方式:Escape / 关闭按钮 / 点遮罩 / 点菜单内部都不误触", async () => {
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "hosts.exportEncrypted": async () => ({ canceled: false, hosts: 1 }),
      },
    });
    /* 菜单:点内部不关闭,Esc 关闭 */
    await openVaultMenu();
    document.querySelector(".vault-menu-item")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush(2);
    expect(document.querySelector(".vault-menu")).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush(2);
    expect(document.querySelector(".vault-menu")).toBeNull();
    /* 菜单:点外部关闭 */
    await openVaultMenu();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush(2);
    expect(document.querySelector(".vault-menu")).toBeNull();

    /* 密码框:✕ / 点遮罩 / Escape 都能关 */
    await openVaultPassword(0);
    click(document.querySelector(".vault-pass-dlg .dd-x"));
    await flush(2);
    expect(document.querySelector(".vault-pass-dlg")).toBeNull();
    await openVaultPassword(0);
    click(document.querySelector(".vault-pass-dlg"));
    await flush(2);
    expect(document.querySelector(".vault-pass-dlg")).toBeNull();
    const input = await openVaultPassword(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush(2);
    expect(document.querySelector(".vault-pass-dlg")).toBeNull();
    /* 回车提交 */
    const again = await openVaultPassword(0);
    again.value = "long-enough-pass";
    again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => (calls["hosts.exportEncrypted"]?.length ?? 0) === 1);
  });

  it("多主机执行:工具栏按钮打开面板,主机来自 hosts.list", async () => {
    const { calls } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    click(document.querySelector("#btn-multiexec"));
    await waitFor(() => !!document.querySelector(".me-overlay"));
    expect(document.querySelectorAll(".me-host input").length).toBe(1);
    expect(calls["hosts.list"].length).toBeGreaterThan(0);
    click(document.querySelector('.me-overlay [data-act="close"]'));
    await waitFor(() => !document.querySelector(".me-overlay"));
  });

  it("AI 执行回放:收到 exec 事件就开标签页,输出逐段追加,结束显示退出码;接管按钮可用", async () => {
    const { execCbs, calls } = await boot({
      overrides: { "hosts.list": async () => [HOST] },
    });
    const execCb = execCbs.at(-1) as (ev: unknown) => void;
    execCb({ id: "e1", hostName: HOST.name, command: "echo hi" });
    await waitFor(() => tabKinds().includes("mcp-exec"));
    await waitFor(() => !!document.querySelector(".tab-pane.active .mcp-exec-cmd"));
    expect(document.querySelector(".tab-pane.active .mcp-exec-cmd")!.textContent).toContain("echo hi");
    expect(document.querySelector(".tab-pane.active .mcp-exec-host")!.textContent).toBe(HOST.name);

    execCb({ id: "e1", hostName: HOST.name, command: "echo hi", chunk: "hi\n", stream: "out" });
    execCb({ id: "e1", hostName: HOST.name, command: "echo hi", chunk: "oops\n", stream: "err" });
    execCb({ id: "e1", hostName: HOST.name, command: "echo hi", done: true, exitCode: 3 });
    await flush(2);
    const out = document.querySelector(".tab-pane.active .mcp-exec-out")!;
    expect(out.textContent).toContain("hi");
    expect(out.querySelector(".err")!.textContent).toContain("oops");
    expect(out.textContent).toContain("3");

    /* 再来一次 exec:复用同一个标签页(不新建);chunk 先于 head 到达时安全忽略 */
    execCb({ id: "e2", hostName: HOST.name, command: "ls" });
    execCb({ id: "e2", hostName: HOST.name, command: "ls", chunk: "x", stream: "out" });
    await flush(2);
    expect(tabKinds().filter((k) => k === "mcp-exec").length).toBe(1);
    expect(document.querySelector(".tab-pane.active .mcp-exec-cmd")!.textContent).toContain("ls");

    /* 结束事件不带 exitCode 时按 0 显示 */
    execCb({ id: "e2", hostName: HOST.name, command: "ls", done: true });
    await flush(2);
    expect(document.querySelector(".tab-pane.active .mcp-exec-out")!.textContent).toContain("0");

    /* 接管:按主机名反查 id 后开真实会话 */
    const takeover = [...document.querySelectorAll<HTMLElement>(".tab-pane.active .sec-band button")]
      .find((b) => b.textContent === "Take over");
    takeover!.click();
    await waitFor(() => count(calls, "ssh.connect") === 1);
  });

  it("AI 执行回放:主机名对不上时,接管按钮是 no-op", async () => {
    const { execCbs, calls } = await boot();
    const execCb = execCbs.at(-1) as (ev: unknown) => void;
    execCb({ id: "e9", hostName: "no-such-host", command: "id" });
    await waitFor(() => tabKinds().includes("mcp-exec"));
    const takeover = [...document.querySelectorAll<HTMLElement>(".tab-pane.active .sec-band button")]
      .find((b) => b.textContent === "Take over");
    takeover!.click();
    await flush(3);
    expect(count(calls, "ssh.connect")).toBe(0);
  });

  it("AI 执行回放:接管时主机已被删掉,点击是 no-op", async () => {
    let deleted = false;
    const { execCbs, calls } = await boot({
      overrides: {
        /* 回放反查时主机还在;点"接管"前把它删掉 → 列表为空 */
        "hosts.list": async () => (deleted ? [] : [HOST]),
      },
    });
    const execCb = execCbs.at(-1) as (ev: unknown) => void;
    execCb({ id: "e10", hostName: HOST.name, command: "id" });
    await waitFor(() => tabKinds().includes("mcp-exec"));
    await flush(4);
    deleted = true;
    const takeover = [...document.querySelectorAll<HTMLElement>(".tab-pane.active .sec-band button")]
      .find((b) => b.textContent === "Take over");
    takeover!.click();
    await flush(3);
    expect(count(calls, "ssh.connect")).toBe(0);
  });

  it("标准档批准:onApproval 事件弹出允许/拒绝,点击回传主进程", async () => {
    const { approvalCbs, calls } = await boot();
    /* 批准弹层由 MCP 分区挂载时订阅:先打开分区 */
    click(document.querySelector('#rail .rail-item[data-nav="mcp"]') as HTMLElement);
    await waitFor(() => tabKinds().includes("mcp"));
    await waitFor(() => approvalCbs.length > 0);
    const approvalCb = approvalCbs.at(-1) as (req: unknown) => void;
    approvalCb({ id: "ap1", tool: "sftp_write_file", args: '{"host":"prod"}' });
    await waitFor(() => !!document.querySelector(".mcp-approve"));
    (document.querySelector('.mcp-approve [data-act="allow"]') as HTMLElement).click();
    await waitFor(() => count(calls, "mcp.answerApproval") === 1);
    expect(calls["mcp.answerApproval"][0]).toEqual(["ap1", true]);
  });

  it("MCP 分区:显示服务器状态与活动流;工具条可清空记录;重复点击只激活", async () => {
    const { calls } = await boot({
      overrides: {
        "mcp.status": async () => ({
          running: true, port: 7788, token: "tok", clients: ["Claude Code 2.0"], error: null,
          activity: [{ id: 1, at: Date.now(), client: "Claude Code 2.0", method: "tools/call", tool: "sftp_list",
            status: "ok", ms: 3, args: '{"host":"prod","path":"/var/www"}', result: "ok" }],
        }),
        "mcp.clearActivity": async () => ({
          running: true, port: 7788, token: "tok", clients: [], error: null, activity: [],
        }),
      },
    });
    click(nav("mcp"));
    await waitFor(() => tabKinds().includes("mcp"));
    expect(activeTab()!.dataset.kind).toBe("mcp");
    await waitFor(() => !!document.querySelector(".tab-pane.active .mcp-act"));
    expect(document.querySelector(".tab-pane.active .mcp-act .mcp-act-title")!.textContent).toContain("sftp_list");
    expect(nav("mcp").classList.contains("on")).toBe(true);

    const clearBtn = [...document.querySelectorAll<HTMLElement>(".tab-pane.active .sec-band button")]
      .find((b) => b.textContent === "Clear calls");
    clearBtn!.click();
    await waitFor(() => count(calls, "mcp.clearActivity") === 1);

    click(nav("mcp"));
    await flush(3);
    expect(tabKinds().filter((k) => k === "mcp").length).toBe(1);
  });

  it("Snippets 分区:无会话时提示,有会话时把命令写进会话;删除走桥", async () => {
    const { calls } = await boot({
      overrides: { "snippets.list": async () => [{ id: "s1", name: "Deploy", command: "make deploy" }] },
    });
    click(nav("snippets"));
    await waitFor(() => !!document.querySelector(".tab-pane.active .sec-row"));
    click(document.querySelector(".tab-pane.active .sec-send"));
    await flush(2);
    expect(lastToast()).toBe("No active session to send to");

    click(document.querySelector("#btn-quick-term"));
    await waitFor(() => title() === "Local shell");
    click(nav("snippets"));
    await waitFor(() => activeTab()!.dataset.kind === "snippets");
    click(document.querySelector(".tab-pane.active .sec-send"));
    await waitFor(() => count(calls, "write") === 1);
    expect((lastCall(calls, "write") as unknown[])[1]).toBe("make deploy\r");
    expect(lastToast()).toBe("Sent to Local shell");

    click(document.querySelector(".tab-pane.active .sec-del"));
    await waitFor(() => count(calls, "snippets.remove") === 1);
    expect((lastCall(calls, "snippets.remove") as unknown[])[0]).toBe("s1");
  });

  it("Snippets 分区的新建按钮打开侧栏编辑区;Shell History 给出未支持原因", async () => {
    await boot();
    click(nav("snippets"));
    await waitFor(() => !!document.querySelector(".tab-pane.active .sec-band"));
    const toolbarBtn = (label: string): HTMLElement =>
      [...document.querySelectorAll<HTMLElement>(".tab-pane.active .sec-band .tb-btn")]
        .find((b) => b.textContent === label)!;
    click(toolbarBtn("New snippet"));
    await waitFor(() => document.body.dataset.panel === "1");
    click(toolbarBtn("Shell History"));
    expect(lastToast()).toBe("Shell History needs per-session recording; not supported yet");
  });

  it("Known Hosts:行渲染成卡片、Import 走桥、行内删除走桥", async () => {
    const { calls } = await boot({
      overrides: {
        "knownhost.list": async () => [{ host: "192.0.2.10", keyType: "ssh-ed25519", fingerprint: "SHA256:abc", hashed: false }],
      },
    });
    click(nav("knownhosts"));
    await waitFor(() => !!document.querySelector(".tab-pane.active .kh-row"));
    expect(document.querySelector(".tab-pane.active .kh-host")!.textContent).toBe("192.0.2.10");
    /* 卡片化:主机名可见,指纹/类型收进 title 悬停可见 */
    await waitFor(() => (document.querySelector(".tab-pane.active .kh-row")!.getAttribute("title") ?? "").includes("SHA256:abc"));
    click(document.querySelector(".tab-pane.active .sec-band .tb-btn"));
    await waitFor(() => count(calls, "knownhost.import") === 1);
    click(document.querySelector(".tab-pane.active .kh-del"));
    await waitFor(() => count(calls, "knownhost.remove") === 1);
    expect((lastCall(calls, "knownhost.remove") as unknown[])[0]).toBe("192.0.2.10");
  });

  it("Port Forwarding:工具栏 New forwarding 打开向导,Skip wizard 关闭", async () => {
    await boot();
    click(nav("forwarding"));
    await waitFor(() => !!document.querySelector(".tab-pane.active .sec-band"));
    click(document.querySelector(".tab-pane.active .sec-band .tb-btn"));
    await waitFor(() => !!document.querySelector(".fwd-wiz"));
    expect(document.querySelector(".fwd-wiz .crumb")!.textContent).not.toBe("");
    click(document.querySelector(".fwd-wiz .wiz-skip"));
    await waitFor(() => !document.querySelector(".fwd-wiz"));
  });

  it("主机表单可从 Vaults 工具条打开;未做任何输入时点取消直接关闭,不弹放弃确认", async () => {
    await boot();
    click(document.querySelector("#btn-new-host"));
    await waitFor(() => document.querySelector("#form-backdrop")!.classList.contains("visible"));
    expect(document.querySelector("#form-heading")!.textContent).toBe("New host");
    /* 期望行为:表单"脏"的判据是用户**改过内容**,不是"字段恰好非空"
       (端口默认值 22、必填项为空都不算改动)。刚打开就取消应当直接关闭。 */
    click(document.querySelector("#btn-cancel"));
    await flush(4);
    expect(document.querySelector(".discard-dlg")).toBeNull();
    expect(document.querySelector("#form-backdrop")!.classList.contains("visible")).toBe(false);
  });

  it("主机表单改过内容后取消:先出现放弃确认,确认后才关闭", async () => {
    await boot();
    click(document.querySelector("#btn-new-host"));
    await waitFor(() => document.querySelector("#form-backdrop")!.classList.contains("visible"));
    (document.querySelector("#f-name") as HTMLInputElement).value = "x";
    click(document.querySelector("#btn-cancel"));
    await waitFor(() => !!document.querySelector(".discard-dlg"));
    expect(document.querySelector(".discard-dlg .dd-head span")!.textContent).toBe("Do you want to discard changes?");
    /* 出现确认框时表单仍开着,要点确认才丢弃 */
    expect(document.querySelector("#form-backdrop")!.classList.contains("visible")).toBe(true);
    click(document.querySelector(".discard-dlg .dd-ok"));
    await waitFor(() => !document.querySelector("#form-backdrop")!.classList.contains("visible"));
  });

  it("主机密钥询问:弹出对话框并可 Add and continue 回答主进程", async () => {
    const { calls, emit } = await boot();
    emit.hostKeyAsk({
      reqId: "req-1", host: "192.0.2.10", status: "unknown", keyType: "ssh-ed25519", fingerprint: "SHA256:abc",
    });
    await waitFor(() => !!document.querySelector(".hk-backdrop"));
    expect(document.querySelector(".hk-backdrop h3")!.textContent).toBe("Are you sure you want to connect?");
    expect(document.querySelector(".hk-backdrop .hk-body")!.textContent).toContain("SHA256:abc");
    const addContinue = [...document.querySelectorAll<HTMLButtonElement>(".hk-backdrop .hk-actions .btn")]
      .find((b) => b.textContent === "Add and continue")!;
    click(addContinue);
    expect((lastCall(calls, "knownhost.answer") as unknown[]).slice(0, 2)).toEqual(["req-1", "add"]);
    expect(document.querySelector(".hk-backdrop")).toBeNull();
  });
});

/* ================= 终端内行为 / SFTP tab 集成 ================= */

describe("终端与 SFTP tab 集成", () => {
  it("会话里 ⌘F 打开/收起终端搜索栏,Escape 清空并收起", async () => {
    await boot();
    await openLocal();
    const bar = document.querySelector(".term-search") as HTMLElement;
    expect(bar.hidden).toBe(true);
    key(document, { code: "KeyF", key: "f", metaKey: true });
    await flush(2);
    expect(bar.hidden).toBe(false);
    const input = bar.querySelector("input")! as HTMLInputElement;
    expect(input.placeholder).toBe("Search terminal - ⌘ + F");
    input.value = "abc";
    input.dispatchEvent(new Event("input"));
    await flush(2);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush(2);
    expect(bar.hidden).toBe(true);
    expect(input.value).toBe("");
  });

  it("SFTP 按钮是常驻单例 tab:重复点只激活,不会开第二个", async () => {
    await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    click(document.querySelector("#btn-sftp"));
    await waitFor(() => activeTab()!.dataset.kind === "sftp");
    /* 再点一次(此时按钮在 SFTP tab 上是禁用态,先回到会话 tab 再点) */
    click(tabByKind("session"));
    await waitFor(() => activeTab()!.dataset.kind === "session");
    click(document.querySelector("#btn-sftp"));
    await waitFor(() => activeTab()!.dataset.kind === "sftp");
    expect(tabKinds().filter((k) => k === "sftp").length).toBe(1);
  });

  it("SFTP 传输进度:新任务出现进度条,按 bytes/total 算百分比,done 后显示完成", async () => {
    const { emit } = await boot();
    emit.progress({ sid: 1, jobId: 7, dir: "up", file: "a.txt", bytes: 512, total: 1024, state: "active" });
    await flush(2);
    const job = document.querySelector(".sftp-queue .job")!;
    expect(job.querySelector(".jname")!.textContent).toBe("⬆ a.txt");
    expect((job.querySelector(".jfill") as HTMLElement).style.width).toBe("50%");
    expect(job.querySelector(".jstat")!.textContent).toBe("512 B / 1.0 KB");

    emit.progress({ sid: 1, jobId: 7, dir: "up", file: "a.txt", bytes: 1024, total: 1024, state: "done" });
    await flush(2);
    const done = document.querySelector(".sftp-queue .job")!;
    expect(done.className).toBe("job done");
    expect(done.querySelector(".jstat")!.textContent).toBe("1.0 KB done");
  });

  it("SFTP 传输失败:任务行显示 failed 与原因", async () => {
    const { emit } = await boot();
    emit.progress({ sid: 1, jobId: 9, dir: "down", file: "b.bin", bytes: 0, total: 0, state: "error", error: "permission denied" });
    await flush(2);
    const job = document.querySelector(".sftp-queue .job")!;
    expect(job.className).toBe("job err");
    expect(job.querySelector(".jstat")!.textContent).toBe("permission denied");
    expect(job.querySelector(".jname")!.textContent).toBe("⬇ b.bin");
  });

  it("命令面板 ⌘K:列出 tab 与动作、按输入过滤、回车执行第一项、Esc 关闭", async () => {
    await boot();
    key(document, { code: "KeyK", key: "k", metaKey: true });
    await waitFor(() => !!document.querySelector(".palette-backdrop"));
    const input = document.querySelector(".palette-backdrop input")! as HTMLInputElement;
    const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".pal-row")];
    expect(rows().some((r) => r.querySelector(".pal-label")!.textContent === "Vaults")).toBe(true);
    expect(rows().some((r) => r.querySelector(".pal-label")!.textContent === "Open Local Terminal")).toBe(true);
    const localRow = rows().find((r) => r.querySelector(".pal-label")!.textContent === "Open Local Terminal")!;
    expect(localRow.querySelector(".pal-hint")!.textContent).toBe("Cmd+L");
    input.value = "Vaults";
    input.dispatchEvent(new Event("input"));
    await flush(2);
    expect(rows().length).toBe(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => !document.querySelector(".palette-backdrop"));
    expect(activeTab()!.dataset.kind).toBe("vault");

    key(document, { code: "KeyK", key: "k", metaKey: true });
    await waitFor(() => !!document.querySelector(".palette-backdrop"));
    document.querySelector(".palette-backdrop input")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await waitFor(() => !document.querySelector(".palette-backdrop"));
  });

  it("命令面板里未实现的动作给出显式提示,而不是静默失败", async () => {
    await boot();
    key(document, { code: "KeyK", key: "k", metaKey: true });
    await waitFor(() => !!document.querySelector(".palette-backdrop"));
    const row = [...document.querySelectorAll<HTMLElement>(".pal-row")]
      .find((r) => r.querySelector(".pal-label")!.textContent === "Save Workspace Template")!;
    /* 期望行为:英文界面里不能出现中文。当前实现把 "未实现" 硬编码在 app.ts:1694,
       应改用 tr("toast.notImplemented") → "Not implemented"(AGENTS §5:所有用户可见文案走 i18n)。 */
    expect(row.querySelector(".pal-hint")!.textContent).toBe("Not implemented");
    click(row);
    expect(lastToast()).toBe("\"Save Workspace Template\" is not implemented yet");
  });
});



/* ================= 快捷键矩阵 / 边界路径 ================= */

describe("快捷键矩阵与边界路径", () => {
  it("⌘L / ⌘. / ⌘⇧M / ⌘P / ⌘S / ⌘⌥S / ⌘V 各自落到对应行为", async () => {
    const { calls } = await boot({ overrides: { "clipboard.read": async () => "pasted" } });

    key(document, { code: "KeyL", key: "l", metaKey: true });
    await waitFor(() => title() === "Local shell");
    expect(tabKinds()).toContain("session");

    key(document, { code: "Period", key: ".", metaKey: true });
    await flush(2);
    expect(document.body.dataset.panel).toBe("1");
    key(document, { code: "Period", key: ".", metaKey: true });
    await flush(2);
    expect(document.body.dataset.panel).toBe("0");

    key(document, { code: "KeyM", key: "m", metaKey: true, shiftKey: true });
    await flush(2);
    expect(document.body.dataset.tabview).toBe("workspace");

    key(document, { code: "KeyP", key: "p", metaKey: true });
    await waitFor(() => tabKinds().includes("fwd"));

    key(document, { code: "KeyS", key: "s", metaKey: true });
    expect(lastToast()).toBe("\"Save Workspace Template\" is not implemented yet");
    /* Cmd+Alt+S(原版"打开串口连接")已移除绑定:不该再产生任何 toast(回归保护) */
    const toastBefore = lastToast();
    key(document, { code: "KeyS", key: "s", metaKey: true, altKey: true });
    expect(lastToast()).toBe(toastBefore);

    /* 剪贴板:有读无写(无选中文本时不写回) */
    key(document, { code: "KeyV", key: "v", metaKey: true });
    await waitFor(() => count(calls, "clipboard.read") === 1);
    key(document, { code: "KeyC", key: "c", metaKey: true });
    await flush(2);
    expect(count(calls, "clipboard.write")).toBe(0);
    /* 终端级选择/清屏快捷键不抛错(焦点/终端是否存在都不能崩) */
    key(document, { code: "KeyA", key: "a", metaKey: true });
  });

  it("主进程语言偏好读取失败时启动不中断(仍渲染分区并记录 warn)", async () => {
    await boot({ overrides: { "settings.getLocale": async () => { throw new Error("settings unreadable"); } } });
    expect(tabKinds()).toEqual(["vault", "sftp"]);
    expect(activeTab()!.dataset.kind).toBe("vault");
    const warns = vi.mocked(console.warn).mock.calls.map((a) => String(a[0]));
    expect(warns.some((w) => w.includes("[i18n] 语言初始化失败"))).toBe(true);
  });

  it("字体探测抛错时按可用处理,设置面板不崩", async () => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => { throw new Error("canvas boom"); }) as typeof HTMLCanvasElement.prototype.getContext;
    try {
      await boot();
      await openPrefs();
      const options = [...document.querySelectorAll<HTMLOptionElement>(".prefs .ps-font option")];
      expect(options.length).toBeGreaterThan(3);
      expect(options.every((o) => !o.disabled)).toBe(true);
    } finally {
      HTMLCanvasElement.prototype.getContext = orig;
    }
  });

  it("关闭非活动 tab:用 tab 条上的 ✕ 关掉它,活动页不受影响", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    click(tabByKind("vault"));
    await waitFor(() => activeTab()!.dataset.kind === "vault");
    click(tabByKind("newtab").querySelector(".tab-close"));
    await waitFor(() => !tabKinds().includes("newtab"));
    expect(activeTab()!.dataset.kind).toBe("vault");
    expect(tabKinds()).toContain("sftp");
  });

  it("Duplicate 分区 tab:SFTP / 转发 / Known Hosts 都复用现有 tab,不重复创建", async () => {
    await boot();
    const dup = (tabEl: HTMLElement): void => {
      contextMenuOn(tabEl);
      click(tabMenuItem("Duplicate"));
    };
    click(tabByKind("sftp"));
    await waitFor(() => activeTab()!.dataset.kind === "sftp");
    dup(tabByKind("sftp"));
    await flush(3);
    expect(tabKinds().filter((k) => k === "sftp").length).toBe(1);

    click(document.querySelector('#rail .rail-item[data-nav="forwarding"]'));
    await waitFor(() => tabKinds().includes("fwd"));
    dup(tabByKind("fwd"));
    await flush(3);
    expect(tabKinds().filter((k) => k === "fwd").length).toBe(1);

    click(document.querySelector('#rail .rail-item[data-nav="knownhosts"]'));
    await waitFor(() => tabKinds().includes("kh"));
    dup(tabByKind("kh"));
    await flush(3);
    expect(tabKinds().filter((k) => k === "kh").length).toBe(1);
    expect(activeTab()!.dataset.kind).toBe("kh");
  });

  it("重命名 tab 失焦即保存(blur 提交)", async () => {
    await boot();
    contextMenuOn(tabByKind("vault"));
    click(tabMenuItem("Rename"));
    const input = document.querySelector(".tab-rename") as HTMLInputElement;
    input.value = "Blurred";
    input.dispatchEvent(new Event("blur"));
    await waitFor(() => tabByKind("vault").querySelector(".lbl")!.textContent === "Blurred");
  });

  it("会话 tab Reconnect 失败:标题标为 failed、tab 转 off", async () => {
    let n = 0;
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "ssh.connect": async () => {
          n++;
          if (n === 1) return { id: 1 };
          throw new Error("connection refused");
        },
      },
    });
    await openSsh();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Reconnect"));
    await waitFor(() => title() === "alice (failed)");
    expect(tabByKind("session").classList.contains("off")).toBe(true);
    expect((lastCall(calls, "ssh.connect") as unknown[])[0]).toBe("h_alice");
  });

  it("两路断线:全局断开条用复数文案,Close all disconnected terminals 一次清掉", async () => {
    const HOST2 = { ...HOST, id: "h_bob", name: "bob", host: "192.0.2.11" };
    let connects = 0;
    const { calls, emit } = await boot({
      overrides: {
        "hosts.list": async () => [HOST, HOST2],
        /* 前两次是正常建连;之后重连一律失败,断线条才会保留 */
        "ssh.connect": async () => {
          connects++;
          if (connects <= 2) return { id: connects };
          throw new Error("still down");
        },
      },
    });
    await waitFor(() => document.querySelectorAll(".host-item").length === 2);
    click(document.querySelector(".host-item[data-id='h_alice']"));
    await waitFor(() => title() === "alice");
    click(document.querySelector(".host-item[data-id='h_bob']"));
    await waitFor(() => title() === "bob");
    const exits = (calls["onExit"] ?? []).map((a) => a[0] as number);
    expect(exits.length).toBe(2);
    vi.useFakeTimers();
    emit.exit(exits[0], { exitCode: 0, reason: "dropped" });
    emit.exit(exits[1], { exitCode: 0, reason: "dropped" });
    expect(document.querySelector("#disc-bar")!.textContent).toContain("2 sessions are disconnected");
    const beforeForce = count(calls, "ssh.connect");
    click(document.querySelector(".db-force"));
    await vi.advanceTimersByTimeAsync(1000); // 强制重连会对每个断线 tab 再发起一次 connect
    expect(count(calls, "ssh.connect")).toBeGreaterThan(beforeForce);
    click(document.querySelector(".db-closeall"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(tabKinds()).not.toContain("session");
    expect(document.querySelector("#disc-bar")).toBeNull();
  });

  it("侧栏片段在没有会话时把标题置为 no session,不写终端", async () => {
    const { calls } = await boot({
      overrides: { "snippets.list": async () => [{ id: "s1", name: "Deploy", command: "make deploy" }] },
    });
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => document.querySelectorAll("#snip-list .sp-item").length === 1);
    click(document.querySelector("#snip-list .sp-item"));
    await flush(2);
    expect(title()).toBe("no session");
    expect(count(calls, "write")).toBe(0);
  });

  it("侧栏 Jump to 在活动会话里复用当前 tab(重连到所选主机)", async () => {
    const { calls } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openLocal();
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => document.querySelectorAll("#jump-list .sp-item").length === 1);
    click(document.querySelector("#jump-list .sp-item"));
    await waitFor(() => title() === HOST.name);
    expect(count(calls, "ssh.connect")).toBe(1);
    expect(tabKinds().filter((k) => k === "session").length).toBe(1); // 复用,不新开
  });

  it("分屏选择主机:select 填入主机、连线走 ssh.connect,退出时分屏 termId 清空", async () => {
    const { calls, emit } = await boot({
      overrides: { "hosts.list": async () => [HOST] },
      storage: { "sshkit.renderer": "dom", "sshkit.bench": "1" },
    });
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    await waitFor(() => !!document.querySelector(".split-pane"));
    await waitFor(() => document.querySelectorAll(".sp-host option").length === 1);
    const sel = document.querySelector(".sp-host") as HTMLSelectElement;
    expect(sel.options[0].textContent).toContain("alice");
    sel.value = "h_alice";
    sel.dispatchEvent(new Event("change"));
    const connectBtn = document.querySelector(".sp-connect") as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(false);
    click(connectBtn);
    await waitFor(() => count(calls, "ssh.connect") === 1);
    await waitFor(() => !document.querySelector(".split-picker"));
    expect(document.querySelector(".split-title")!.textContent).toBe("alice");

    /* 分屏会话退出:只清分屏自己的 termId,不影响主终端 */
    const bench = (window as unknown as { __bench: { tabs: () => Array<Record<string, unknown>> } }).__bench;
    const sessionTab = bench.tabs().find((t) => t.kind === "session")!;
    const splitId = sessionTab.splitTermId as number;
    const mainId = sessionTab.termId as number;
    expect(splitId).not.toBeNull();
    emit.exit(splitId, { exitCode: 0 });
    await flush(3);
    const after = bench.tabs().find((t) => t.kind === "session")!;
    expect(after.splitTermId).toBeNull();
    expect(after.termId).toBe(mainId);
  });

  it("分屏连接失败:分屏选择器保留,可换一台再试", async () => {
    await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "ssh.connect": async () => { throw new Error("handshake failed"); },
      },
    });
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    await waitFor(() => document.querySelectorAll(".sp-host option").length === 1);
    const sel = document.querySelector(".sp-host") as HTMLSelectElement;
    sel.value = "h_alice";
    sel.dispatchEvent(new Event("change"));
    click(document.querySelector(".sp-connect"));
    await flush(4);
    expect(document.querySelector(".split-picker")).toBeTruthy();
  });

  it("拖拽 tab 的视觉状态:拖动中加 .dragging,dragend/dragleave 清干净", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    const from = tabByKind("vault");
    const over = tabByKind("sftp");
    from.dispatchEvent(new MouseEvent("dragstart", { bubbles: true, clientX: 0 }));
    expect(from.classList.contains("dragging")).toBe(true);
    over.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 10 }));
    expect(over.classList.contains("drop-after") || over.classList.contains("drop-before")).toBe(true);
    over.dispatchEvent(new MouseEvent("dragleave", { bubbles: true }));
    expect(over.classList.contains("drop-after")).toBe(false);
    expect(over.classList.contains("drop-before")).toBe(false);
    from.dispatchEvent(new MouseEvent("dragend", { bubbles: true }));
    expect(from.classList.contains("dragging")).toBe(false);
  });

  it("分区工具条右侧图标:筛选聚焦搜索框、布局切换列表/网格、面板开关", async () => {
    await boot();
    click(document.querySelector('#rail .rail-item[data-nav="snippets"]'));
    await waitFor(() => !!document.querySelector(".tab-pane.active .sec-band"));
    const icons = [...document.querySelectorAll<HTMLElement>(".tab-pane.active .sec-band .tb-icon")];
    expect(icons.length).toBe(3);
    click(icons[0]); // Filter → 聚焦主机搜索
    expect(document.activeElement).toBe(document.querySelector("#host-search"));
    click(icons[1]); // Change layout → hosts 列表切网格
    expect(document.querySelector("#host-list")!.classList.contains("grid")).toBe(true);
    click(icons[2]); // Terminal side-panel
    await flush(2);
    expect(document.body.dataset.panel).toBe("1");
  });

  it("⌘F 搜索栏的关闭按钮也能收起", async () => {
    await boot();
    await openLocal();
    key(document, { code: "KeyF", key: "f", metaKey: true });
    await flush(2);
    const bar = document.querySelector(".term-search") as HTMLElement;
    expect(bar.hidden).toBe(false);
    click(bar.querySelector('[data-nav="close"]'));
    await flush(2);
    expect(bar.hidden).toBe(true);
  });

  it("命令面板可执行已实现的动作(Open Terminal Search)", async () => {
    await boot();
    await openLocal();
    key(document, { code: "KeyK", key: "k", metaKey: true });
    await waitFor(() => !!document.querySelector(".palette-backdrop"));
    const input = document.querySelector(".palette-backdrop input")! as HTMLInputElement;
    input.value = "Open Terminal Search";
    input.dispatchEvent(new Event("input"));
    await flush(2);
    const rows = [...document.querySelectorAll<HTMLElement>(".pal-row")];
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector(".pal-hint")!.textContent).toBe("Cmd+F");
    click(rows[0]);
    await waitFor(() => !document.querySelector(".palette-backdrop"));
    expect((document.querySelector(".term-search") as HTMLElement).hidden).toBe(false);
  });

  it("Duplicate 本地终端另开一个本地会话 tab", async () => {
    const { calls } = await boot();
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Duplicate"));
    await waitFor(() => tabKinds().filter((k) => k === "session").length === 2);
    expect(count(calls, "createLocal")).toBe(2);
  });

  it("⌘K 已打开时不重复叠加面板", async () => {
    await boot();
    key(document, { code: "KeyK", key: "k", metaKey: true });
    await waitFor(() => !!document.querySelector(".palette-backdrop"));
    key(document, { code: "KeyK", key: "k", metaKey: true });
    await flush(2);
    expect(document.querySelectorAll(".palette-backdrop").length).toBe(1);
  });
});

/* ================= Logs 分区 ================= */

describe("Logs 分区", () => {
  const logsRail = (): HTMLElement => document.querySelector('#rail .rail-item[data-nav="logs"]')!;

  it("会话正常退出后 Logs 出现一行(时间 + info 级别 + 原因),打开时即时重渲染", async () => {
    const { calls, emit } = await boot();
    await openLocal();
    const sid = (lastCall(calls, "onExit") as unknown[])[0] as number;
    click(logsRail());
    await waitFor(() => document.querySelector(".tab-pane.active .sec-empty-title")?.textContent === "No logs yet");

    emit.exit(sid, { exitCode: 0, reason: "closed" });
    await waitFor(() => !!document.querySelector(".tab-pane.active .sec-row.log"));
    const row = document.querySelector(".tab-pane.active .sec-row.log")!;
    expect(row.className).toContain("info");
    expect(row.querySelector(".tx")!.textContent).toBe("Local shell · exit code 0");
    expect(row.querySelector(".at")!.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("ssh 会话异常退出记为 error 级别(带主进程给的错误原因)", async () => {
    const { calls, emit } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    const sid = (lastCall(calls, "onExit") as unknown[])[0] as number;
    emit.exit(sid, { exitCode: 1, error: "auth failed", reason: "auth" });
    click(logsRail());
    await waitFor(() => !!document.querySelector(".tab-pane.active .sec-row.log.error"));
    const row = document.querySelector(".tab-pane.active .sec-row.log.error")!;
    expect(row.querySelector(".tx")!.textContent).toBe("alice · auth failed");
  });

  /* 期望行为:Logs 空态文案承诺 "Connection and disconnect events will appear here.",
     所以成功连上一台主机就该有一条 connected 记录(与退出记录对称)。 */
  it("连接成功后 Logs 分区应出现 connected 记录", async () => {
    await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    click(logsRail());
    await flush(4);
    const texts = [...document.querySelectorAll(".tab-pane.active .sec-row.log .tx")].map((n) => n.textContent ?? "");
    expect(texts.join("\n")).toContain("connected");
  });
});

/* ================= 容错与集成边界 ================= */

describe("容错与集成边界", () => {
  it("字体可用性探测:按 canvas 量宽判断缺失字体并禁用/标注选项", async () => {
    HTMLCanvasElement.prototype.getContext = (() => ({
      font: "",
      measureText: (text: string) => ({ width: text === "mmmmmmmmmmlliWW" ? 100 : 50 }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    await boot();
    await openPrefs();
    const options = [...document.querySelectorAll<HTMLOptionElement>(".prefs .ps-font option")];
    /* 量宽相同 ⇒ 判定本机没装:禁用并标注 (not installed);bundled / generic 两族不受影响 */
    expect(options.some((o) => o.disabled && (o.textContent ?? "").includes("(not installed)"))).toBe(true);
    expect(options.filter((o) => !o.disabled).length).toBeGreaterThanOrEqual(2);
  });

  it("搜索插件加载失败时会话仍能建立,只记录 warn", async () => {
    (globalThis as { __failSearchAddon?: boolean }).__failSearchAddon = true;
    try {
      await boot();
      await openLocal();
      const warns = vi.mocked(console.warn).mock.calls.map((a) => String(a[0]));
      expect(warns.some((w) => w.includes("[term] 搜索插件不可用"))).toBe(true);
      expect(tabByKind("session").classList.contains("on")).toBe(true);
    } finally {
      (globalThis as { __failSearchAddon?: boolean }).__failSearchAddon = false;
    }
  });

  it("Vaults 工具条的 New host 下拉箭头等价于点 New host", async () => {
    await boot();
    click(document.querySelector("#btn-new-host-caret"));
    await waitFor(() => document.querySelector("#form-backdrop")!.classList.contains("visible"));
    expect(document.querySelector("#form-heading")!.textContent).toBe("New host");
    click(document.querySelector("#btn-cancel")); // 空白表单直接关
    await waitFor(() => !document.querySelector("#form-backdrop")!.classList.contains("visible"));
  });

  it("SFTP tab 空态的 Select host(app 集成):没有会话时给出原因", async () => {
    await boot();
    /* 无会话时 #btn-sftp 是禁用态(禁用按钮不触发 click),直接点常驻 SFTP tab */
    click(tabByKind("sftp"));
    await waitFor(() => activeTab()!.dataset.kind === "sftp");
    await waitFor(() => !!document.querySelector('.sftp-pane[data-which="remote"] .sp-select'));
    click(document.querySelector('.sftp-pane[data-which="remote"] .sp-select'));
    await flush(2);
    const banners = [...document.querySelectorAll(".sftp-queue .jname")].map((n) => n.textContent);
    expect(banners.at(-1)).toBe("No session available yet — connect a host from the host list first");
  });
});

/* ================= 生命周期竞态 / boot 未落地 ================= */

describe("生命周期竞态", () => {
  it("boot 尚未落地时新建并关掉唯一的 New Tab:回退到新的落地页而不是空白主区", async () => {
    vi.resetModules();
    loadRendererDom();
    const gate = deferred<{ pref: "system"; system: string; effective: "en" }>();
    const b = makeBridge({ "settings.getLocale": () => gate.promise });
    (window as unknown as { sshkit: unknown }).sshkit = b.api;
    await import("../../src/renderer/app");

    click(document.querySelector("#btn-new-tab"));
    expect(tabKinds()).toEqual(["newtab"]);
    click(tabByKind("newtab").querySelector(".tab-close"));
    /* 关掉的是当前唯一 tab:没有邻居可激活,产品应给一个新的 New Tab 落地页 */
    expect(tabKinds()).toEqual(["newtab"]);
    expect(activeTab()!.dataset.kind).toBe("newtab");

    gate.resolve({ pref: "system", system: "en", effective: "en" });
    await flush(8);
    expect(tabKinds()).toContain("vault");
    expect(tabKinds()).toContain("sftp");
    expect(activeTab()!.dataset.kind).toBe("vault");
  });

  it("连接在用户切走后才成功:后台 tab 变 on,但不抢标题/状态灯", async () => {
    const d = deferred<{ id: number }>();
    const { calls } = await boot({ overrides: { createLocal: () => d.promise } });
    click(document.querySelector("#btn-quick-term"));
    await flush(2); // tab 已建、connect 未决
    click(tabByKind("vault"));
    await waitFor(() => activeTab()!.dataset.kind === "vault");

    d.resolve({ id: 7 });
    await flush(6);
    expect(count(calls, "createLocal")).toBe(1);
    expect(title()).toBe("Vaults");
    expect(document.querySelector("#status-dot")!.className).toBe("");
    const sessionTab = tabEls().find((t) => t.dataset.kind === "session")!;
    expect(sessionTab.classList.contains("on")).toBe(true);
    expect(sessionTab.classList.contains("active")).toBe(false);
  });

  it("连接在用户切走后才失败:后台 tab 标 off,但不在活动页上弹横幅/改标题", async () => {
    const d = deferred<never>();
    await boot({ overrides: { createLocal: () => d.promise } });
    click(document.querySelector("#btn-quick-term"));
    await flush(2);
    click(tabByKind("vault"));
    await waitFor(() => activeTab()!.dataset.kind === "vault");

    d.reject(new Error("spawn failed"));
    await flush(6);
    expect(title()).toBe("Vaults");
    expect(document.querySelector("#banner")!.classList.contains("visible")).toBe(false);
    expect(tabEls().find((t) => t.dataset.kind === "session")!.classList.contains("off")).toBe(true);
  });

  it("连接失败时主进程给的是字符串(非 Error):横幅显示原始原因", async () => {
    await boot({ overrides: { createLocal: async () => { throw "local spawn failed"; } } });
    click(document.querySelector("#btn-quick-term"));
    await waitFor(() => document.querySelector("#banner")!.classList.contains("visible"));
    expect(document.querySelector("#banner")!.textContent).toBe("local spawn failed");
    expect(title()).toBe("Local shell (failed)");
  });

  it("会话 tab 的 Reconnect 在已断开(termId 为空)且非活动页时:只重连、不 dispose、不抢标题", async () => {
    const HOST2 = { ...HOST, id: "h_bob", name: "bob", host: "192.0.2.11" };
    let connects = 0;
    const { calls, emit } = await boot({
      overrides: {
        "hosts.list": async () => [HOST, HOST2],
        "ssh.connect": async () => ({ id: ++connects }),
      },
    });
    await waitFor(() => document.querySelectorAll(".host-item").length === 2);
    click(document.querySelector('.host-item[data-id="h_alice"]'));
    await waitFor(() => title() === "alice");
    click(document.querySelector('.host-item[data-id="h_bob"]'));
    await waitFor(() => title() === "bob");

    /* alice 的会话自然退出(auth 失败不走自动重连):termId 归 null,tab 转为 off */
    emit.exit(1, { exitCode: 1, error: "auth failed", reason: "auth" });
    await flush(3);
    /* 切到 Vaults 分区屏(Vaults 是 section:状态灯应为空) */
    click(tabByKind("vault"));
    await waitFor(() => activeTab()!.dataset.kind === "vault");
    expect(document.querySelector("#status-dot")!.className).toBe("");

    contextMenuOn(tabByKind("session")); // 第一个 session tab = alice
    click(tabMenuItem("Reconnect"));
    await waitFor(() => count(calls, "ssh.connect") === 3);

    expect(calls["dispose"]).toBeUndefined(); // termId 为空:没有旧会话可 dispose
    /* 后台 tab 重连成功不得改写前台 chrome:活动页仍是 Vaults,状态灯不被置为 on */
    expect(activeTab()!.dataset.kind).toBe("vault");
    expect(document.querySelector("#status-dot")!.className).toBe("");
    expect(tabEls().find((el) => el.title === "alice")!.classList.contains("on")).toBe(true);
  });

  it("Reconnect 失败且主进程给的是字符串:终端里写出的原因不是 undefined", async () => {
    let n = 0;
    await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "ssh.connect": async () => { n++; if (n === 1) return { id: 1 }; throw "dial tcp timeout"; },
      },
    });
    const { Terminal } = await xtermApis();
    const written: unknown[] = [];
    const writeSpy = vi.spyOn(Terminal.prototype, "write").mockImplementation((data: unknown) => {
      written.push(data);
      return undefined as never;
    });
    try {
      await openSsh();
      contextMenuOn(tabByKind("session"));
      click(tabMenuItem("Reconnect"));
      await waitFor(() => title() === "alice (failed)");
      expect(written.some((d) => String(d).includes("dial tcp timeout"))).toBe(true);
      expect(written.some((d) => String(d).includes("undefined"))).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("关闭两个会话里靠前的活动 tab:顺位激活后面的邻居", async () => {
    const HOST2 = { ...HOST, id: "h_bob", name: "bob", host: "192.0.2.11" };
    let n = 0;
    await boot({
      overrides: {
        "hosts.list": async () => [HOST, HOST2],
        "ssh.connect": async () => ({ id: ++n }),
      },
    });
    await waitFor(() => document.querySelectorAll(".host-item").length === 2);
    click(document.querySelector('.host-item[data-id="h_alice"]'));
    await waitFor(() => title() === "alice");
    click(document.querySelector('.host-item[data-id="h_bob"]'));
    await waitFor(() => title() === "bob");
    /* 回到 alice(索引处于中间),再关闭它。注意不能用主机卡片(那会新开 tab),点 tab pill 才是激活 */
    click(tabEls().find((el) => el.title === "alice")!);
    await waitFor(() => title() === "alice");
    key(document, { code: "KeyW", key: "w", metaKey: true });
    await waitFor(() => tabKinds().filter((k) => k === "session").length === 1);
    expect(title()).toBe("bob");
    expect(activeTab()!.dataset.kind).toBe("session");
  });

  it("关闭仍持有会话的 tab:先 dispose 掉 pty 再移除", async () => {
    const { calls } = await boot();
    await openLocal();
    click(tabByKind("session").querySelector(".tab-close"));
    await waitFor(() => !tabKinds().includes("session"));
    expect(lastCall(calls, "dispose")).toEqual([1]);
  });

  /* 501 次真实"掉线→自动重连"才能验证环形缓冲上限,单条用例耗时数秒,故单独放宽超时 */
  /* Windows runner 上 501 次假定时器推进实测会超过 30s(annotations 里就是 Test timed out in 30000ms),
     放宽到 120s;断言本身不变。 */
  it("Logs 环形缓冲只保留最近 500 条(第 501 条挤掉最旧一条)", { timeout: 120000 }, async () => {
    const { calls, emit } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    vi.useFakeTimers();
    try {
      let sid = (lastCall(calls, "onExit") as unknown[])[0] as number;
      for (let i = 0; i < 501; i++) {
        emit.exit(sid, { exitCode: 0, reason: "dropped" });
        await vi.advanceTimersByTimeAsync(1000); // 1s 重连退避 + 微任务链
        sid = (lastCall(calls, "onExit") as unknown[])[0] as number;
      }
    } finally {
      vi.useRealTimers();
    }

    click(document.querySelector('#rail .rail-item[data-nav="logs"]'));
    await waitFor(() => tabKinds().includes("logs"));
    await waitFor(() => document.querySelectorAll(".tab-pane.active .sec-row.log").length === 500);
    expect(document.querySelectorAll(".tab-pane.active .sec-row.log").length).toBe(500);
    /* 最新的在最上面 */
    expect(document.querySelector(".tab-pane.active .sec-row.log .tx")!.textContent).toContain("connected");
  });

  it("旧的会话退出事件迟到时被忽略,不会重复关会话/记日志", async () => {
    const { calls, emit } = await boot();
    await openLocal();
    const sid = (lastCall(calls, "onExit") as unknown[])[0] as number;
    emit.exit(sid, { exitCode: 0, reason: "closed" });
    await flush(3);
    emit.exit(sid, { exitCode: 0, reason: "closed" }); // 迟到事件:tab.termId 已是 null
    await flush(3);

    click(document.querySelector('#rail .rail-item[data-nav="logs"]'));
    await waitFor(() => !!document.querySelector(".tab-pane.active .sec-row.log"));
    expect(document.querySelectorAll(".tab-pane.active .sec-row.log").length).toBe(1);
    expect(tabEls().find((t) => t.dataset.kind === "session")!.classList.contains("off")).toBe(true);
  });

  it("对照台钩子:活动 tab 没有终端时 input() 返回 false(而不是崩)", async () => {
    await boot({ storage: { "sshkit.bench": "1" } });
    const bench = (window as unknown as { __bench: { input: (d: string, p?: number) => boolean } }).__bench;
    expect(bench.input("hello")).toBe(false); // 活动页是 Vaults,没有 term
  });
});

/* ================= 分屏边界 ================= */

describe("分屏边界", () => {
  it("未接会话就关分屏:不 dispose 主会话;重复点已摘除的关闭按钮是无操作", async () => {
    const { calls } = await boot();
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    await waitFor(() => !!document.querySelector(".split-pane"));
    const closeBtn = document.querySelector(".split-close") as HTMLButtonElement;
    click(closeBtn);
    await waitFor(() => !document.querySelector(".split-pane"));
    expect(calls["dispose"]).toBeUndefined(); // 分屏从未连接,主会话也还活着

    expect(() => closeBtn.click()).not.toThrow(); // 第二次调用命中 !split 守卫
    expect(document.querySelector(".split-pane")).toBeNull();
    expect(calls["dispose"]).toBeUndefined();
  });

  it("分屏被关掉后才返回的「选本地 shell」不会把会话接到已消失的分屏", async () => {
    const { calls } = await boot();
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    await waitFor(() => !!document.querySelector(".split-pane"));
    const localBtn = document.querySelector(".sp-local") as HTMLButtonElement;
    click(document.querySelector(".split-close"));
    await waitFor(() => !document.querySelector(".split-pane"));

    localBtn.click(); // 已脱离文档的按钮:connectSplit 命中 !split 守卫
    await flush(3);
    expect(count(calls, "createLocal")).toBe(1); // 只有主终端
  });

  it("分屏选主机后、点连接前主机会列表变空:不发连接,选择器保留", async () => {
    let n = 0;
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => { n++; return n === 3 ? [] : [HOST]; },
        "ssh.connect": async () => ({ id: 99 }),
      },
    });
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    await waitFor(() => document.querySelectorAll(".sp-host option").length === 1);
    const sel = document.querySelector(".sp-host") as HTMLSelectElement;
    sel.value = "h_alice";
    sel.dispatchEvent(new Event("change"));
    click(document.querySelector(".sp-connect"));
    await flush(4);
    expect(count(calls, "ssh.connect")).toBe(0);
    expect(document.querySelector(".split-picker")).toBeTruthy();
  });

  it("广播关闭时:主终端与分屏各自只写自己的会话", async () => {
    const { calls } = await boot({ storage: { "sshkit.bench": "1" } });
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    click(document.querySelector(".sp-local"));
    await waitFor(() => !document.querySelector(".split-picker"));

    const bench = (window as unknown as { __bench: { tabs: () => Array<Record<string, unknown>>; input: (d: string, p?: number) => boolean } }).__bench;
    const tab = bench.tabs().find((t) => t.kind === "session")!;
    const mainId = tab.termId as number;
    const splitId = tab.splitTermId as number;
    expect(tab.broadcast).toBe(false);

    expect(bench.input("m")).toBe(true);
    const mainWrites = (calls["write"] ?? []).filter((a) => a[1] === "m");
    expect(mainWrites).toEqual([[mainId, "m"]]);

    expect(bench.input("s", 1)).toBe(true);
    const splitWrites = (calls["write"] ?? []).filter((a) => a[1] === "s");
    expect(splitWrites).toEqual([[splitId, "s"]]);
  });

  it("主终端与分屏的 xterm resize 都转发成 bridge.resize(sid, cols, rows)", async () => {
    const { calls } = await boot();
    const { Terminal } = await xtermApis();
    const terms: any[] = [];
    const origOpen = Terminal.prototype.open;
    /* 捕获真实 Terminal 实例,再用 xterm 自己的 resize() 驱动 onResize 事件(不伪造事件) */
    const spy = vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: any, parent: HTMLElement) {
      terms.push(this);
      return origOpen.call(this, parent);
    });
    try {
      await openLocal();
      terms[0].resize(100, 30);
      await flush(2);
      expect(lastCall(calls, "resize")).toEqual([1, 100, 30]);

      contextMenuOn(tabByKind("session"));
      click(tabMenuItem("Split horizontally"));
      await flush(3);
      click(document.querySelector(".sp-local"));
      await waitFor(() => !document.querySelector(".split-picker"));
      terms[1].resize(90, 20);
      await flush(2);
      expect(lastCall(calls, "resize")).toEqual([2, 90, 20]);
    } finally {
      spy.mockRestore();
    }
  });

  it("主进程推来的终端输出被写进 xterm(bridge.onData → term.write)", async () => {
    const { emit } = await boot();
    const { Terminal } = await xtermApis();
    const writeSpy = vi.spyOn(Terminal.prototype, "write");
    try {
      await openLocal();
      emit.data(1, "hello from pty");
      await flush(2);
      expect(writeSpy.mock.calls.some((c) => c[0] === "hello from pty")).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("⌘B 在已有分屏时切换广播开关(否则给出先分屏提示)", async () => {
    await boot({ storage: { "sshkit.bench": "1" } });
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    click(document.querySelector(".sp-local"));
    await waitFor(() => !document.querySelector(".split-picker"));
    const box = document.querySelector(".split-bc input") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);

    key(document, { code: "KeyB", key: "b", metaKey: true });
    await flush(2);
    expect(box.checked).toBe(true);
    const bench = (window as unknown as { __bench: { tabs: () => Array<Record<string, unknown>> } }).__bench;
    expect(bench.tabs().find((t) => t.kind === "session")!.broadcast).toBe(true);
  });

  it("切换 tab 视图模式时会重新 fit 已打开的分屏终端", async () => {
    await boot();
    const { FitAddon } = await xtermApis();
    const fitSpy = vi.spyOn(FitAddon.prototype, "fit");
    try {
      await openLocal();
      contextMenuOn(tabByKind("session"));
      click(tabMenuItem("Split horizontally"));
      await flush(3);
      await waitFor(() => !!document.querySelector(".split-pane"));
      const before = fitSpy.mock.calls.length;
      click(document.querySelector("#btn-tabview"));
      await flush(3);
      expect(document.body.dataset.tabview).toBe("workspace");
      expect(fitSpy.mock.calls.length).toBeGreaterThan(before);
    } finally {
      fitSpy.mockRestore();
    }
  });

  it("窗口尺寸变化时 ResizeObserver 会重新 fit 活动终端", async () => {
    await boot();
    const { FitAddon } = await xtermApis();
    const fitSpy = vi.spyOn(FitAddon.prototype, "fit");
    try {
      triggerResize(); // 活动页是 Vaults(没有终端):t?.fit 为 false 的分支
      await flush(2);
      await openLocal();
      const before = fitSpy.mock.calls.length;
      triggerResize();
      await flush(2);
      expect(fitSpy.mock.calls.length).toBeGreaterThan(before);
    } finally {
      fitSpy.mockRestore();
    }
  });

  it("分屏连接失败且原因是字符串:分屏内写出原因,选择器保留可重试", async () => {
    await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "ssh.connect": async () => { throw "handshake string"; },
      },
    });
    const { Terminal } = await xtermApis();
    const written: unknown[] = [];
    const writeSpy = vi.spyOn(Terminal.prototype, "write").mockImplementation((data: unknown) => {
      written.push(data);
      return undefined as never;
    });
    try {
      await openLocal();
      contextMenuOn(tabByKind("session"));
      click(tabMenuItem("Split horizontally"));
      await flush(3);
      await waitFor(() => document.querySelectorAll(".sp-host option").length === 1);
      const sel = document.querySelector(".sp-host") as HTMLSelectElement;
      sel.value = "h_alice";
      sel.dispatchEvent(new Event("change"));
      click(document.querySelector(".sp-connect"));
      await flush(4);
      expect(written.some((d) => String(d).includes("handshake string"))).toBe(true);
      expect(document.querySelector(".split-picker")).toBeTruthy();
    } finally {
      writeSpy.mockRestore();
    }
  });
});

/* ================= 覆盖率补强:防御守卫 / DOM 结构缺项 ================= */

describe("防御守卫", () => {
  it("侧栏开关按钮缺失时 ⌘. 仍能切换侧栏状态(只是没有按钮高亮)", async () => {
    await boot();
    document.getElementById("btn-panel")!.remove();
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => document.body.dataset.panel === "1");
    expect(document.getElementById("btn-panel")).toBeNull();
    expect(document.querySelector(".sp-close")).toBeTruthy();
  });

  it("侧栏分区标题被移除时 ⌘J 不崩、也不会闪不存在的分区", async () => {
    const { calls } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    document.querySelectorAll("#sidepanel .sp-title").forEach((n) => n.remove());
    key(document, { code: "KeyJ", key: "j", metaKey: true });
    await waitFor(() => document.body.dataset.panel === "1");
    await flush(4);
    expect(document.querySelector(".sp-flash")).toBeNull();
    expect(count(calls, "hosts.list")).toBeGreaterThan(0);
  });

  it("侧栏列表容器缺失时打开侧栏直接早退,不再拉主机/片段", async () => {
    const { calls } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    const hostsBefore = count(calls, "hosts.list");
    document.getElementById("snip-list")!.remove();
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => document.body.dataset.panel === "1");
    await flush(4);
    expect(count(calls, "hosts.list")).toBe(hostsBefore); // renderSidePanel 在守卫处返回
    expect(document.getElementById("snip-list")).toBeNull();
  });

  it("工作区竖排栏容器缺失时新建 tab 不崩(renderWsRail 早退)", async () => {
    await boot();
    document.getElementById("ws-rail")!.remove();
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    expect(document.getElementById("ws-rail")).toBeNull();
    expect(activeTab()!.dataset.kind).toBe("newtab");
  });

  it("index.html 缺少可选顶栏元素时启动不崩(Vaults 仍渲染,只是少几处按钮绑定)", async () => {
    await boot({
      mutateDom: () => {
        /* 这几个是可选的顶栏/工具条按钮;移除后 boot 里的 ?.addEventListener 应安静跳过 */
        for (const id of ["btn-panel-top", "btn-quick-term", "btn-new-host-caret"]) {
          document.getElementById(id)?.remove();
        }
      },
    });
    expect(tabKinds()).toEqual(["vault", "sftp"]);
    expect(activeTab()!.dataset.kind).toBe("vault");
    expect(title()).toBe("Vaults");
    expect(document.getElementById("btn-panel-top")).toBeNull();
    expect(document.getElementById("btn-quick-term")).toBeNull();
    expect(tabByKind("vault")).toBeTruthy();
  });

  it("#term-head 在运行中被移除后切 tab:applyChrome 跳过标题栏也不崩", async () => {
    await boot();
    const titleEl = document.getElementById("term-title")!;
    document.getElementById("term-head")!.remove(); // 整个标题栏(含 btn-panel/tab-sftp 等)一起没了
    expect(titleEl.textContent).toBe("Vaults");
    click(tabByKind("sftp"));
    await waitFor(() => activeTab()!.dataset.kind === "sftp");
    expect(document.body.dataset.chrome).toBe("sftp"); // chrome 仍按 tab 类型切
    expect(document.getElementById("term-title")).toBeNull(); // 但没有可写的标题元素(守卫跳过写入)
  });


});

/* ================= 覆盖率补强:tab 拖拽 / 菜单 / 改名 ================= */

describe("tab 拖拽边界", () => {
  it("没有 dragstart 的 dragover/drop 不产生拖放指示、也不重排", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    const target = tabByKind("sftp");
    target.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 999 }));
    expect(target.classList.contains("drop-before")).toBe(false);
    expect(target.classList.contains("drop-after")).toBe(false);
    const before = tabKinds();
    target.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 999 }));
    await flush(2);
    expect(tabKinds()).toEqual(before);
  });

  it("拖到目标左半边:插到它前面(而不是后面)", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    const newtab = tabByKind("newtab");
    newtab.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    const sftp = tabByKind("sftp");
    sftp.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 0 }));
    await flush(3);
    await waitFor(() => tabKinds()[1] === "newtab");
    expect(tabKinds()).toEqual(["vault", "newtab", "sftp"]);
  });

  it("拖拽源 tab 在 drop 前被关掉:drop 是无操作", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    const newtab = tabByKind("newtab");
    newtab.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    click(newtab.querySelector(".tab-close")); // 源 tab 消失,但 dragTabId 还留着
    await waitFor(() => !tabKinds().includes("newtab"));
    tabByKind("sftp").dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 999 }));
    await flush(2);
    expect(tabKinds()).toEqual(["vault", "sftp"]);
  });

  it("目标 tab 在 drop 前被关掉(源还在):移到末尾而不是崩", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    click(document.querySelector("#btn-new-tab"));
    const [first, second] = tabEls().filter((el) => el.dataset.kind === "newtab");
    const stale = second;
    first.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    click(stale.querySelector(".tab-close")); // 目标被关掉(元素引用仍在)
    await waitFor(() => tabKinds().filter((k) => k === "newtab").length === 1);
    stale.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 999 }));
    await flush(2);
    /* from 被移到最后(target 不存在 → 末尾兜底) */
    expect(tabKinds().at(-1)).toBe("newtab");
    expect(tabKinds().filter((k) => k === "newtab").length).toBe(1);
  });
});

describe("tab 右键菜单边界", () => {
  it("连续右键两个 tab 只保留最后一个菜单", async () => {
    await boot();
    contextMenuOn(tabByKind("vault"));
    contextMenuOn(tabByKind("sftp"));
    expect(document.querySelectorAll(".tab-menu").length).toBe(1);
  });

  it("菜单 Close 项关闭对应 tab", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    contextMenuOn(tabByKind("newtab"));
    click(tabMenuItem("Close"));
    await waitFor(() => !tabKinds().includes("newtab"));
    expect(document.querySelector(".tab-menu")).toBeNull();
  });

  it("点菜单内部不关;点页面其它地方关", async () => {
    await boot();
    contextMenuOn(tabByKind("vault"));
    await flush(3); // 让 setTimeout 里的"点外部"监听器挂上
    const menu = document.querySelector(".tab-menu")!;
    menu.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".tab-menu")).toBeTruthy();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush(2);
    expect(document.querySelector(".tab-menu")).toBeNull();
  });

  it("tab 在菜单打开期间被关掉:点 Rename / Close 都是安全无操作,点已摘除的 tab 也不激活", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    const el = tabByKind("newtab");
    contextMenuOn(el);
    key(document, { code: "KeyW", key: "w", metaKey: true }); // 关掉该 tab(菜单仍开着)
    await waitFor(() => !tabKinds().includes("newtab"));
    const activeKind = activeTab()!.dataset.kind;

    el.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 已摘除元素的点击 → activateTab 找不到 id
    await flush(2);
    expect(activeTab()!.dataset.kind).toBe(activeKind);

    click(tabMenuItem("Rename")); // startRenameTab 找不到 .lbl → 早退
    await flush(2);
    expect(document.querySelector(".tab-rename")).toBeNull();

    /* 再开一个会被关掉的 tab,验证 Close 菜单项对"已关闭 id"的守卫 */
    click(document.querySelector("#btn-new-tab"));
    const el2 = tabByKind("newtab");
    contextMenuOn(el2);
    key(document, { code: "KeyW", key: "w", metaKey: true });
    await waitFor(() => !tabKinds().includes("newtab"));
    const kinds = tabKinds();
    click(tabMenuItem("Close"));
    await flush(2);
    expect(tabKinds()).toEqual(kinds);
  });

  it("重命名输入框里的点击/按下不冒泡到 tab(否则输入框会被重建)", async () => {
    await boot();
    contextMenuOn(tabByKind("vault"));
    click(tabMenuItem("Rename"));
    const input = document.querySelector(".tab-rename") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush(2);
    expect(document.querySelector(".tab-rename")).toBe(input); // 同一个节点,没被重建
    expect(activeTab()!.dataset.kind).toBe("vault");
  });

  it("Duplicate 在非会话/非分区 tab(New Tab)上回退到 Vaults,而不是开第二个 New Tab", async () => {
    await boot();
    click(document.querySelector("#btn-new-tab"));
    await waitFor(() => tabKinds().includes("newtab"));
    contextMenuOn(tabByKind("newtab"));
    click(tabMenuItem("Duplicate"));
    await waitFor(() => activeTab()!.dataset.kind === "vault");
    expect(tabKinds().filter((k) => k === "vault").length).toBe(1);
    expect(tabKinds().filter((k) => k === "newtab").length).toBe(1);
  });
});

/* ================= 覆盖率补强:分区屏 / 快照 ================= */

describe("分区屏边界", () => {
  it("片段没有名字时用命令作为显示名", async () => {
    await boot({
      overrides: {
        "snippets.list": async () => [{ id: "s1", name: "", command: "echo hi" }],
      },
    });
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => !!document.querySelector("#snip-list .sp-nm"));
    expect(document.querySelector("#snip-list .sp-nm")!.textContent).toBe("echo hi");
  });

  it("Snippets 分区发送以换行结尾的命令时只补一个回车", async () => {
    const { calls } = await boot({
      overrides: { "snippets.list": async () => [{ id: "s1", name: "NL", command: "echo hi\n" }] },
    });
    await openLocal();
    click(document.querySelector('#rail .rail-item[data-nav="snippets"]'));
    await waitFor(() => !!document.querySelector(".tab-pane.active .sec-row"));
    click(document.querySelector(".tab-pane.active .sec-send"));
    await flush(2);
    expect((lastCall(calls, "write") as unknown[])[1]).toBe("echo hi\r");
  });

  it("Known Hosts 卡片绘制对陌生行结构容错,且重复绘制不会重画已上色图标", async () => {
    await boot({
      overrides: {
        "knownhost.list": async () => [{ host: "192.0.2.10", keyType: "ssh-ed25519", fingerprint: "SHA256:abc", hashed: false }],
      },
    });
    click(document.querySelector('#rail .rail-item[data-nav="knownhosts"]'));
    await waitFor(() => !!document.querySelector(".tab-pane.active .kh-row"));
    const root = document.querySelector(".tab-pane.active .kh")!;
    await waitFor(() => row_title());

    function row_title(): boolean {
      return (root.querySelector(".kh-row")!.getAttribute("title") ?? "").includes("SHA256:abc");
    }

    /* 注入两种陌生行:一个完全没有 .kh-ico/.kh-main/.kh-type;一个 .kh-main 只有一个子节点 */
    root.insertAdjacentHTML("beforeend",
      '<div class="kh-row"></div><div class="kh-row"><span class="kh-ico"></span><span class="kh-main"><span>only-child</span></span></div>');
    await flush(3); // MutationObserver → paint
    expect(root.querySelectorAll(".kh-row").length).toBe(3);
    expect(root.querySelectorAll(".kh-row")[1].getAttribute("title")).toBeNull();

    /* 再触发一次 mutation:已有行的图标已标记 painted,不会重画 */
    root.append(document.createElement("div"));
    await flush(3);
    expect(document.querySelector(".tab-pane.active .kh-type")!.style.display).toBe("none");
    expect(root.querySelectorAll(".kh-row").length).toBe(3);
  });

  it("Snippets 分区在删除请求返回前被关掉:迟到刷新安全早退", async () => {
    const d = deferred<void>();
    const { calls } = await boot({
      overrides: {
        "snippets.list": async () => [{ id: "s1", name: "Deploy", command: "make deploy" }],
        "snippets.remove": () => d.promise,
      },
    });
    click(document.querySelector('#rail .rail-item[data-nav="snippets"]'));
    await waitFor(() => !!document.querySelector(".tab-pane.active .sec-row"));
    const listId = document.querySelector(".tab-pane.active .sec-list")!.id;
    click(document.querySelector(".tab-pane.active .sec-del"));
    await waitFor(() => count(calls, "snippets.remove") === 1);
    click(tabByKind("snippets").querySelector(".tab-close")); // 关掉分区 tab
    await waitFor(() => !tabKinds().includes("snippets"));
    d.resolve();
    await flush(4);
    expect(document.getElementById(listId)).toBeNull(); // 没有把已关 tab 的列表复活
  });
});

/* ================= 覆盖率补强:外观 / 设置面板 ================= */

describe("外观与设置边界", () => {
  it("localStorage 里的配色名不存在时回退到第一套配色", async () => {
    await boot({ storage: { "sshkit.scheme": "NoSuchScheme" } });
    const { TERM_SCHEMES } = await import("../../src/renderer/themes");
    expect(document.documentElement.style.getPropertyValue("--term-bg")).toBe(TERM_SCHEMES[0].background);
  });

  it("配色数据坏掉(非 hex 背景)时前景色回退,tab 不染色但界面不崩", async () => {
    await boot();
    await openLocal();
    const { TERM_SCHEMES } = await import("../../src/renderer/themes");
    const first = TERM_SCHEMES[0];
    const original = first.background;
    first.background = "transparent";
    try {
      await openPrefs();
      const schemeBtn = [...document.querySelectorAll<HTMLElement>(".prefs .scheme")]
        .find((b) => b.textContent?.includes(first.name))!;
      click(schemeBtn);
      await flush(3);
      /* pickOnColor 回退:浅色底自动配深前景的兜底色 */
      expect(document.documentElement.style.getPropertyValue("--term-fg")).toBe("#e6e9ef");

      click(tabByKind("session"));
      await flush(2);
      const sessionTab = tabByKind("session");
      expect(sessionTab.style.background).toBe("");
    } finally {
      first.background = original;
    }
  });

  it("#term-head 缺失时设置面板挂到 body 上", async () => {
    await boot();
    document.getElementById("term-head")!.remove();
    await openPrefs();
    expect(document.querySelector(".prefs")!.parentElement).toBe(document.body);
  });

  it("语言按钮缺 data-lang 属性时按 system 处理", async () => {
    const { calls } = await boot();
    await openPrefs();
    const en = prefsBtn('.lang-mode[data-lang="en"]');
    en.removeAttribute("data-lang");
    click(en);
    await waitFor(() => count(calls, "settings.setLocale") >= 1);
    expect((lastCall(calls, "settings.setLocale") as unknown[])[0]).toBe("system");
  });

  it("字号输入非法(空/非数字)时回落到 14", async () => {
    await boot();
    await openPrefs();
    const input = prefsBtn<HTMLInputElement>(".ps-size");
    input.value = "abc";
    input.dispatchEvent(new Event("change"));
    await flush(2);
    expect(localStorage.getItem("sshkit.fontSize")).toBe("14");
    expect(prefsBtn(".ps-val").textContent).toBe("14px");
  });

  it("顶栏侧栏按钮能开关面板;外观入口只保留侧栏与 ⌘,(旧齿轮已移除)", async () => {
    await boot();
    click(document.querySelector("#btn-panel"));
    expect(document.body.dataset.panel).toBe("1");
    click(document.querySelector("#btn-panel-top"));
    expect(document.body.dataset.panel).toBe("0");

    /* 主机页右上角不再有旧「设置/样式」齿轮 */
    expect(document.getElementById("btn-appearance")).toBeNull();
    /* 偏好设置仍可通过 ⌘, 打开(侧栏外观 tab 也可用) */
    key(document, { code: "Comma", key: ",", metaKey: true });
    await waitFor(() => !!document.querySelector(".prefs"));
    expect(prefsBtn(".scheme-list")).toBeTruthy();
  });

  it("侧栏关闭状态下点 .sp-close 不反向打开面板", async () => {
    await boot();
    expect(document.body.dataset.panel).toBe("0");
    click(document.querySelector(".sp-close"));
    await flush(2);
    expect(document.body.dataset.panel).toBe("0");
  });

  it("片段保存时名字为空:用命令补名字,不存空标题", async () => {
    const { calls } = await boot();
    key(document, { code: "Period", key: ".", metaKey: true });
    await waitFor(() => document.body.dataset.panel === "1");
    (document.querySelector(".snip-name") as HTMLInputElement).value = "";
    (document.querySelector(".snip-cmd") as HTMLInputElement).value = "ls -la";
    click(document.querySelector(".snip-save"));
    await waitFor(() => count(calls, "snippets.save") === 1);
    expect((lastCall(calls, "snippets.save") as unknown[])[0]).toEqual({ name: "ls -la", command: "ls -la" });
  });

  it("点设置面板里的纯文本节点不算「点外部」,面板保持打开", async () => {
    await boot();
    await openPrefs();
    const h4 = document.querySelector(".prefs h4")!;
    h4.firstChild!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush(2);
    expect(document.querySelector(".prefs")).toBeTruthy();
  });

  it("i18n 自检:启动时发现 zh 缺键会 console.warn 列出键名", async () => {
    await boot({ mutateZh: (zh) => { delete zh["rail.hosts"]; } });
    const warn = vi.mocked(console.warn);
    const hit = warn.mock.calls.some((c) => String(c[0]).includes("[i18n] 缺少文案") && String(c[1]).includes("rail.hosts"));
    expect(hit).toBe(true);
  });

  it("切语言时也会重新跑 i18n 自检并报告缺键", async () => {
    await boot();
    const i18n = await import("../../src/shared/i18n");
    delete (i18n.zh as unknown as Record<string, string>)["rail.hosts"];
    await openPrefs();
    click(prefsBtn('.lang-mode[data-lang="zh"]'));
    await waitFor(() => document.documentElement.lang === "zh-CN");
    const warn = vi.mocked(console.warn);
    const hit = warn.mock.calls.some((c) => String(c[0]).includes("[i18n] 缺少文案") && String(c[1]).includes("rail.hosts"));
    expect(hit).toBe(true);
  });
});

/* ================= 覆盖率补强:搜索栏 / 剪贴板 / 快捷命令 ================= */

describe("搜索栏与终端快捷键", () => {
  it("搜索栏:回车下一个、Shift+回车上一个、箭头按钮、非 Escape 键不收起", async () => {
    await boot();
    await openLocal();
    key(document, { code: "KeyF", key: "f", metaKey: true });
    await flush(2);
    const bar = document.querySelector(".term-search") as HTMLElement;
    const input = bar.querySelector("input") as HTMLInputElement;
    input.value = "needle";
    input.dispatchEvent(new Event("input"));
    await flush(2);
    expect(searchCalls.at(-1)).toEqual({ kind: "next", term: "needle", incremental: true });

    const before = searchCalls.length;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(searchCalls.slice(before).at(-1)).toEqual({ kind: "next", term: "needle", incremental: false });
    expect(bar.hidden).toBe(false);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(searchCalls.at(-1)).toEqual({ kind: "prev", term: "needle", incremental: false });

    click(bar.querySelector('[data-nav="prev"]'));
    expect(searchCalls.at(-1)).toEqual({ kind: "prev", term: "needle", incremental: false });
    click(bar.querySelector('[data-nav="next"]'));
    expect(searchCalls.at(-1)).toEqual({ kind: "next", term: "needle", incremental: false });

    const settled = searchCalls.length;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    expect(searchCalls.length).toBe(settled); // 非 Enter/Escape 不触发搜索也不收起
    expect(bar.hidden).toBe(false);
  });

  it("⌘F 在非会话 tab 上不打开搜索栏", async () => {
    await boot();
    key(document, { code: "KeyF", key: "f", metaKey: true });
    await flush(2);
    expect(document.querySelector(".term-search")).toBeNull();
    expect(activeTab()!.dataset.kind).toBe("vault");
  });

  it("⌘C 有选中文本时写入剪贴板,并计入对照台计数器", async () => {
    const { calls } = await boot({ storage: { "sshkit.bench": "1" } });
    const { Terminal } = await xtermApis();
    const selSpy = vi.spyOn(Terminal.prototype, "getSelection").mockReturnValue("picked text");
    try {
      await openLocal();
      key(document, { code: "KeyC", key: "c", metaKey: true });
      await flush(2);
      expect(calls["clipboard.write"]!.at(-1)).toEqual(["picked text"]);
      const counters = (window as unknown as { __bench: { counters: Record<string, number> } }).__bench.counters;
      expect(counters.copyFromTerminal).toBe(1);
    } finally {
      selSpy.mockRestore();
    }
  });

  it("⌘C 没有选中文本时不写剪贴板(无对照台钩子也不崩)", async () => {
    const { calls } = await boot();
    const { Terminal } = await xtermApis();
    const selSpy = vi.spyOn(Terminal.prototype, "getSelection").mockReturnValue(undefined);
    try {
      await openLocal();
      key(document, { code: "KeyC", key: "c", metaKey: true });
      key(document, { code: "KeyV", key: "v", metaKey: true }); // 没有对照台钩子也不崩(计数器分支不走)
      await flush(2);
      expect(calls["clipboard.write"]).toBeUndefined();
    } finally {
      selSpy.mockRestore();
    }
  });

  it("⌘V 读取剪贴板并粘贴进终端,并计入对照台计数器", async () => {
    await boot({
      storage: { "sshkit.bench": "1" },
      overrides: { "clipboard.read": async () => "pasted" },
    });
    const { Terminal } = await xtermApis();
    const pasteSpy = vi.spyOn(Terminal.prototype, "paste").mockImplementation(() => undefined);
    try {
      await openLocal();
      key(document, { code: "KeyV", key: "v", metaKey: true });
      await waitFor(() => pasteSpy.mock.calls.length > 0);
      expect(pasteSpy.mock.calls.at(-1)).toEqual(["pasted"]);
      const counters = (window as unknown as { __bench: { counters: Record<string, number> } }).__bench.counters;
      expect(counters.pasteToTerminal).toBe(1);
    } finally {
      pasteSpy.mockRestore();
    }
  });

  it("命令面板执行 Clear Terminal Buffer(没有加速键的项也能通过面板触发)", async () => {
    await boot();
    const { Terminal } = await xtermApis();
    const clearSpy = vi.spyOn(Terminal.prototype, "clear").mockImplementation(() => undefined);
    try {
      await openLocal();
      key(document, { code: "KeyK", key: "k", metaKey: true });
      await waitFor(() => !!document.querySelector(".palette-backdrop"));
      const input = document.querySelector(".palette-backdrop input") as HTMLInputElement;
      input.value = "Clear Terminal Buffer";
      input.dispatchEvent(new Event("input"));
      await flush(2);
      click(document.querySelector(".palette-backdrop .pal-row"));
      await flush(2);
      expect(clearSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      clearSpy.mockRestore();
    }
  });

  it("点命令面板遮罩关闭面板", async () => {
    await boot();
    key(document, { code: "KeyK", key: "k", metaKey: true });
    await waitFor(() => !!document.querySelector(".palette-backdrop"));
    const back = document.querySelector(".palette-backdrop")!;
    back.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush(2);
    expect(document.querySelector(".palette-backdrop")).toBeNull();
  });
});

/* ================= 覆盖率补强:分屏的迟到事件 / 断线覆盖层兜底 ================= */

describe("分屏与断线的迟到事件", () => {
  it("分屏会话的输出被写进分屏终端", async () => {
    const { emit } = await boot({ storage: { "sshkit.bench": "1" } });
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    click(document.querySelector(".sp-local"));
    await waitFor(() => !document.querySelector(".split-picker"));
    const { Terminal } = await xtermApis();
    const writeSpy = vi.spyOn(Terminal.prototype, "write").mockImplementation(() => undefined);
    try {
      const bench = (window as unknown as { __bench: { tabs: () => Array<Record<string, unknown>> } }).__bench;
      const splitId = bench.tabs().find((t) => t.kind === "session")!.splitTermId as number;
      emit.data(splitId, "pane output");
      await flush(2);
      expect(writeSpy.mock.calls.some((c) => c[0] === "pane output")).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("分屏会话的迟到退出事件只写一次 [pane session closed]", async () => {
    const { emit } = await boot({ storage: { "sshkit.bench": "1" } });
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    click(document.querySelector(".sp-local"));
    await waitFor(() => !document.querySelector(".split-picker"));
    const { Terminal } = await xtermApis();
    const writes: unknown[] = [];
    const writeSpy = vi.spyOn(Terminal.prototype, "write").mockImplementation((data: unknown) => {
      writes.push(data);
      return undefined as never;
    });
    try {
      const bench = (window as unknown as { __bench: { tabs: () => Array<Record<string, unknown>> } }).__bench;
      const splitId = bench.tabs().find((t) => t.kind === "session")!.splitTermId as number;
      emit.exit(splitId, { exitCode: 0, reason: "closed" });
      await flush(2);
      emit.exit(splitId, { exitCode: 0, reason: "closed" }); // 迟到事件:termId 已为 null
      await flush(2);
      expect(writes.filter((d) => String(d).includes("[pane session closed]")).length).toBe(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("分屏连接在用户切走后成功:不抢焦点但仍标记会话", async () => {
    const d = deferred<{ id: number }>();
    let connectCalls = 0;
    await boot({
      storage: { "sshkit.bench": "1" },
      overrides: {
        "hosts.list": async () => [HOST],
        "ssh.connect": () => { connectCalls++; return connectCalls === 1 ? d.promise : Promise.resolve({ id: 5 }); },
      },
    });
    await openLocal();
    contextMenuOn(tabByKind("session"));
    click(tabMenuItem("Split horizontally"));
    await flush(3);
    await waitFor(() => document.querySelectorAll(".sp-host option").length === 1);
    const sel = document.querySelector(".sp-host") as HTMLSelectElement;
    sel.value = "h_alice";
    sel.dispatchEvent(new Event("change"));
    click(document.querySelector(".sp-connect"));
    await flush(2);
    click(tabByKind("sftp")); // 切走
    await waitFor(() => activeTab()!.dataset.kind === "sftp");

    d.resolve({ id: 6 });
    await flush(6);
    const bench = (window as unknown as { __bench: { tabs: () => Array<Record<string, unknown>> } }).__bench;
    expect(bench.tabs().find((t) => t.kind === "session")!.splitTermId).toBe(6);
    expect(activeTab()!.dataset.kind).toBe("sftp");
  });

  it("自动重连成功时 tab 已非活动:状态回到 on 但不抢前台 chrome", async () => {
    const HOST2 = { ...HOST, id: "h_bob", name: "bob", host: "192.0.2.11" };
    let n = 0;
    const { calls, emit } = await boot({
      overrides: {
        "hosts.list": async () => [HOST, HOST2],
        "ssh.connect": async () => ({ id: ++n }),
      },
    });
    await waitFor(() => document.querySelectorAll(".host-item").length === 2);
    click(document.querySelector('.host-item[data-id="h_alice"]'));
    await waitFor(() => title() === "alice");
    /* 再开 bob(他会成为活动 tab);随后 alice 掉线时自动重连发生在后台 */
    click(document.querySelector('.host-item[data-id="h_bob"]'));
    await waitFor(() => title() === "bob");

    vi.useFakeTimers();
    try {
      emit.exit(1, { exitCode: 0, reason: "dropped" }); // alice 掉线 → 自动重连
      await vi.advanceTimersByTimeAsync(1100);
    } finally {
      vi.useRealTimers();
    }
    expect(count(calls, "ssh.connect")).toBe(3);
    expect(activeTab()!.dataset.kind).toBe("session");
    expect(title()).toBe("bob"); // 后台重连不抢标题
    expect(tabEls().find((el) => el.title === "alice")!.classList.contains("on")).toBe(true);
  });

  it("xterm 元素缺失时断线覆盖层退回到 tab.pane(仍然可见)", async () => {
    const { emit } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    const { Terminal } = await xtermApis();
    const terms: any[] = [];
    const origOpen = Terminal.prototype.open;
    const openSpy = vi.spyOn(Terminal.prototype, "open").mockImplementation(function (this: any, parent: HTMLElement) {
      terms.push(this);
      return origOpen.call(this, parent);
    });
    try {
      await openSsh();
      Object.defineProperty(terms[0], "element", { value: null, configurable: true });
      vi.useFakeTimers();
      try {
        emit.exit(1, { exitCode: 0, reason: "dropped" });
        await vi.advanceTimersByTimeAsync(10);
      } finally {
        vi.useRealTimers();
      }
      const disc = document.querySelector(".disc")!;
      expect(disc).toBeTruthy();
      expect(disc.parentElement!.classList.contains("tab-pane")).toBe(true);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("Reconnect 对非会话 tab 是无操作(菜单项不区分 tab 类型)", async () => {
    const { calls } = await boot();
    contextMenuOn(tabByKind("vault"));
    click(tabMenuItem("Reconnect"));
    await flush(3);
    expect(count(calls, "ssh.connect")).toBe(0);
    expect(tabKinds()).toEqual(["vault", "sftp"]);
  });
});
