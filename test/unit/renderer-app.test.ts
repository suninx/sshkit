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

/* jsdom 没有 canvas 2D 上下文;@xterm/addon-canvas 是在 xterm.open() 之后由内部定时器异步激活的,
   抛错发生在产品 try/catch 之外(会变成 uncaught exception)。这里把它换成"构造即失败"的替身,
   与真实环境里 canvas 插件不可用时产品的容错路径一致(产品会退回 DOM 渲染器)。 */
vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class {
    constructor() { throw new Error("canvas addon unavailable under jsdom"); }
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

  const api: Record<string, any> = {
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
    window: { create: rec("window.create", o("window.create", async () => true)) },
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
  };

  return { calls, api: guard(api), emit };
}

/* ---------------- 环境准备 ---------------- */

class FakeResizeObserver {
  observe(): void { /* jsdom 没有布局,不触发回调 */ }
  unobserve(): void { /* noop */ }
  disconnect(): void { /* noop */ }
}

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
});

afterEach(() => {
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
}

async function boot(opts: BootOptions = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(opts.storage ?? {})) localStorage.setItem(k, v);
  loadRendererDom();
  const bridge = makeBridge(opts.overrides ?? {});
  (window as unknown as { sshkit: unknown }).sshkit = bridge.api;
  const app = await import("../../src/renderer/app");
  await flush(6);
  return { ...bridge, app };
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

  it("Disable reconnecting:断线层改为已停止,并隐藏该按钮", async () => {
    const { calls, emit } = await boot({ overrides: { "hosts.list": async () => [HOST] } });
    await openSsh();
    const sid = (lastCall(calls, "onExit") as unknown[])[0] as number;
    emit.exit(sid, { exitCode: 1, reason: "dropped" });
    await waitFor(() => !!document.querySelector(".disc"));
    click(document.querySelector(".disc-stop"));
    await waitFor(() => document.querySelector(".disc-reason")!.textContent === "Reconnecting disabled");
    expect((document.querySelector(".disc-stop") as HTMLElement).hidden).toBe(true);
    /* 关掉 tab 收尾:让后台那次 1s 定时器醒来时看到 tab 已不在 */
    click(document.querySelector(".disc-close"));
    await waitFor(() => !tabKinds().includes("session"));
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
    click(document.querySelector(".db-closeall"));
    await vi.advanceTimersByTimeAsync(1);
    expect(tabKinds()).not.toContain("session");
    expect(document.querySelector("#disc-bar")).toBeNull();
  });

  it("分屏:右键 Split horizontally → 选本地 shell → 建第二个会话;广播开关把输入同时发给两格", async () => {
    const { calls } = await boot({ storage: { "sshkit.bench": "1" } });
    await openLocal();
    contextMenuOn(tabByKind("session"));
    expect(document.querySelector(".tab-menu")!.textContent).toContain("Split horizontally");
    click(tabMenuItem("Split horizontally"));
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

    const bench = (window as unknown as { __bench: { tabs: () => Array<Record<string, unknown>>; input: (d: string) => boolean } }).__bench;
    const sessionTab = bench.tabs().find((t) => t.kind === "session")!;
    expect(sessionTab.broadcast).toBe(true);
    expect(sessionTab.splitTermId).not.toBeNull();
    expect(bench.input("ls\r")).toBe(true);
    const writes = (calls["write"] ?? []).filter((a) => a[1] === "ls\r");
    expect(writes.length).toBe(2);
    expect(new Set(writes.map((a) => a[0])).size).toBe(2);

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

  it("字体选择落盘,并同步到已打开终端的 options", async () => {
    const { } = await boot({ storage: { "sshkit.bench": "1" } });
    await openLocal();
    const bench = (window as unknown as { __bench: { tabs: () => Array<Record<string, unknown>> } }).__bench;
    const termFont = (): unknown => bench.tabs().find((t) => t.kind === "session")!.font;
    expect(String(termFont())).toContain("MesloLGS");
    await openPrefs();
    const sel = prefsBtn<HTMLSelectElement>(".ps-font");
    expect(sel.options.length).toBeGreaterThan(3);
    const target = sel.options[sel.options.length - 1].value;
    sel.value = target;
    sel.dispatchEvent(new Event("change"));
    await flush(2);
    expect(localStorage.getItem("sshkit.fontFamily")).toBe(target);
    expect(termFont()).toBe(target);
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
  it("⌘. 开关侧栏并渲染 Jump to / Snippets;点主机连它,点片段发到当前会话,可删除片段", async () => {
    const { calls } = await boot({
      overrides: {
        "hosts.list": async () => [HOST],
        "snippets.list": async () => [{ id: "s1", name: "Deploy", command: "make deploy" }],
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

  it("toast:立即出现、2.6s 后淡出、3.2s 后移除;串口按钮给出明确原因", async () => {
    await boot();
    vi.useFakeTimers();
    click(document.querySelector("#btn-quick-serial"));
    expect(lastToast()).toBe("Serial is not supported: it needs a native serial dependency and a real device");
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

    click(nav("keychain"));
    await waitFor(() => tabKinds().includes("keychain"));
    await waitFor(() => document.querySelectorAll(".tab-pane.active .sec-row").length > 0);
    expect(document.querySelector(".tab-pane.active .sec-row .nm")!.textContent).toBe("alice");

    click(nav("logs"));
    await waitFor(() => tabKinds().includes("logs"));
    expect(document.querySelector(".tab-pane.active .sec-empty-title")!.textContent).toBe("No logs yet");
    expect(nav("logs").classList.contains("on")).toBe(true);

    click(nav("hosts"));
    await waitFor(() => activeTab()!.dataset.kind === "vault");
    expect(nav("hosts").classList.contains("on")).toBe(true);
  });

  it("Keychain:空态文案 + 按钮给出明确提示(不假装实现)", async () => {
    await boot();
    click(nav("keychain"));
    await waitFor(() => document.querySelector(".tab-pane.active .sec-empty-title")?.textContent === "Add credentials");
    const btn = (label: string): HTMLElement => {
      const el = [...document.querySelectorAll<HTMLElement>(".tab-pane.active .sec-band .tb-btn, .tab-pane.active .sec-band .sec-chip")]
        .find((b) => b.textContent === label);
      if (!el) throw new Error(`keychain button not found: ${label}`);
      return el;
    };
    click(btn("New key"));
    expect(lastToast()).toBe("New key: importing a private key is enough; not wired up yet");
    click(btn("Touch ID"));
    expect(lastToast()).toBe("Touch ID needs system biometric authorization; not wired up yet");
    click(btn("Certificate"));
    expect(lastToast()).toBe("Certificate: not supported yet");
    click(btn("FIDO2"));
    expect(lastToast()).toBe("FIDO2 needs a hardware key; not wired up yet");
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
    key(document, { code: "KeyS", key: "s", metaKey: true, altKey: true });
    expect(lastToast()).toBe("Serial is not supported: it needs a native serial dependency and a real device");

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
    const { calls, emit } = await boot({ overrides: { "hosts.list": async () => [HOST, HOST2] } });
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
    click(document.querySelector(".db-closeall"));
    await vi.advanceTimersByTimeAsync(1);
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
