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
    expect(document.querySelector('.sftp-pane[data-which="remote"] .sp-name .nm')!.textContent).toBe("logs");
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

  it("选配色:落盘、更新 --term-bg/--term-fg(浅色底自动配深前景)、高亮当前项", async () => {
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

