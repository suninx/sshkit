import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { bridge, initHostPanel, markActiveHost } from "./hosts";
import { createSftpView, type CurrentSession, type SftpView } from "./sftp";
import { installShortcuts, MAC_SHORTCUTS, type ShortcutDef } from "./keys";
import type { HostRecord } from "../shared/host";

const stage = document.getElementById("stage")!;
const tabsEl = document.getElementById("tabs")!;
const btnNewTab = document.getElementById("btn-new-tab")! as HTMLButtonElement;
const titleEl = document.getElementById("term-title")!;
const bannerEl = document.getElementById("banner")!;
const dot = document.getElementById("status-dot")!;

const btnSftp = document.getElementById("btn-sftp")! as HTMLButtonElement;

/* ---------- T2:标签页模型 ----------
   一个 tab = 一个独立会话(pane 里有自己的 Terminal 与 xterm 会话 id)。
   主进程/桥接层本就按 id 区分会话,故多 tab 主要是渲染层的事。
   原版对齐点:条高 51px、底色=终端主题底色、tab 30px/圆角 10、
   非活动 tab 5% 白叠加、活动会话 tab 绿 20% 叠加、关闭按钮在 tab 内右侧。 */

type TabState = "idle" | "on" | "off";
type Tab = {
  id: string;
  kind: "session" | "newtab" | "sftp";
  label: string;
  state: TabState;
  pane: HTMLDivElement;
  term: Terminal | null;
  fit: FitAddon | null;
  termId: number | null;
  disposers: Array<() => void>;
  sftp: CurrentSession | null;
  view?: SftpView; // sftp tab 用
  search?: SearchAddon;   // T4:终端内搜索(Cmd+F)
  searchBar?: HTMLElement;
};

let tabs: Tab[] = [];
let active: string | null = null;
let seq = 0;
/* SFTP tab 自身没有会话,故记住"最近活动的会话"给它用 */
let lastSession: CurrentSession | null = null;

const activeTab = (): Tab | null => tabs.find((t) => t.id === active) ?? null;

function setStatus(state: TabState): void {
  dot.className = state === "off" ? "off" : state === "on" ? "on" : "";
}

function setTitle(text: string): void {
  titleEl.textContent = text;
}

function showBanner(message: string): void {
  bannerEl.textContent = message;
  bannerEl.classList.add("visible");
}

function hideBanner(): void {
  bannerEl.classList.remove("visible");
}

function setSftpSession(s: CurrentSession | null): void {
  // SFTP 已改为 tab(T5),此按钮只表示"当前 tab 有可用的 ssh 会话"
  btnSftp.disabled = !s;
}

function renderTabs(): void {
  tabsEl.replaceChildren(
    ...tabs.map((t) => {
      const el = document.createElement("div");
      el.className = `tab-btn${t.kind === "session" ? " session" : ""}${t.id === active ? " active" : ""}`;
      el.title = t.label;
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", t.id === active ? "true" : "false");
      el.dataset.tabId = t.id;

      const dotEl = document.createElement("span");
      dotEl.className = `dot${t.state === "on" ? " on" : ""}`;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = t.label;

      if (t.kind === "session") {
        // 原版实测:会话 tab 的关闭按钮在**左侧**(close-tab x=264,而该 tab 起于 259)
        const x = document.createElement("button");
        x.className = "tab-close";
        x.textContent = "✕";
        x.title = "Close Tab (⌘W)";
        x.setAttribute("aria-label", "close-tab");
        x.addEventListener("click", (ev) => { ev.stopPropagation(); closeTab(t.id); });
        el.append(x, dotEl, lbl);
      } else {
        el.append(dotEl, lbl);
      }
      el.addEventListener("click", () => activateTab(t.id));
      return el;
    }),
  );
}

function activateTab(id: string): void {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  active = id;
  for (const x of tabs) x.pane.classList.toggle("active", x.id === id);
  renderTabs();
  setStatus(t.state);
  setTitle(t.kind === "session" ? t.label : "New Tab");
  setSftpSession(t.sftp);
  if (t.kind === "session" && t.sftp) lastSession = t.sftp;
  if (t.fit) { try { t.fit.fit(); } catch { /* transient */ } }
  if (t.kind === "sftp") t.view?.onShow();
  else if (t.kind === "newtab") t.pane.querySelector("input")?.focus();
  else t.term?.focus();
}

function makePane(): HTMLDivElement {
  const p = document.createElement("div");
  p.className = "tab-pane";
  stage.append(p);
  return p;
}

/** 新 tab 落地页:对齐原版实测结构(居中搜索/连接框 + ⌘+K 提示 + Recent sessions 空态)。 */
function newTabPage(): Tab {
  const pane = makePane();
  pane.innerHTML = `
    <div class="newtab">
      <div class="nt-search">
        <input placeholder="Search hosts or tabs" spellcheck="false" autocomplete="off">
        <span class="kbd">⌘+K</span>
      </div>
      <div class="nt-empty">
        <div class="nt-icon">⚡</div>
        <h3>Recent sessions</h3>
        <p>Your recent sessions will be visible here.<br>In the meantime, start connecting with CMD+K</p>
      </div>
    </div>`;
  const t: Tab = { id: `t${++seq}`, kind: "newtab", label: "New Tab", state: "idle", pane,
    term: null, fit: null, termId: null, disposers: [], sftp: null };
  tabs.push(t);
  activateTab(t.id);
  return t;
}

function disposeTab(t: Tab): void {
  t.disposers.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  t.disposers = [];
  if (t.termId !== null) { try { bridge.dispose(t.termId); } catch { /* ignore */ } }
  t.termId = null;
  t.fit = null;
  if (t.term) { try { t.term.dispose(); } catch { /* already gone */ } t.term = null; }
  t.pane.remove();
}

function closeTab(id: string): void {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  disposeTab(t);
  if (active === id) {
    const next = tabs[i] ?? tabs[i - 1] ?? null;
    if (next) activateTab(next.id);
    else newTabPage();
  } else {
    renderTabs();
  }
}

function cycleTab(delta: number): void {
  if (tabs.length < 2 || !active) return;
  const i = tabs.findIndex((t) => t.id === active);
  activateTab(tabs[(i + delta + tabs.length) % tabs.length].id);
}

/* T1 复刻 —— 取值来源:原版自身 ui-process 里的 colorSchemesArray 中 "Termius Dark" 条目
   (defaultFontSize=14、backgroundColor #141729、foreground/cursor #21b568、
    selectionColor #21b56880、以及 16 色 colorPaletteOverrides)。这是权威值;
   早先我用像素反推的表有几处偏差(如 white 误记 #6b6d7a),已作废。
   另:像素对照证明两侧渲染管线等价 —— 同一真彩色在双方成像一致(见 bench/FINDINGS.md F12)。 */
const TERM_FONT = '"MesloLGS NF", Menlo, "DejaVu Sans Mono", monospace';
const TERM_FONT_SIZE = 14; // 原版 defaultFontSize=14,实机同
const TERM_LINE_HEIGHT = 1.05; // 目标格高 18px(原版光标墨迹盒实测 8×18;1.1→19、1.05→18)
const TERM_THEME = {
  background: "#141729",
  foreground: "#21b568",
  cursor: "#21b568",
  selectionBackground: "#21b56880",
  black: "#343851",
  red: "#f24e50",
  green: "#008463",
  yellow: "#eca855",
  blue: "#08639f",
  magenta: "#c13282",
  cyan: "#2091f6",
  white: "#e2e3e8",
  brightBlack: "#8d91a5",
  brightRed: "#ff7375",
  brightGreen: "#3ed7be",
  brightYellow: "#fdc47d",
  brightBlue: "#6ba0c3",
  brightMagenta: "#ff7dc5",
  brightCyan: "#44a7ff",
  brightWhite: "#ffffff",
};

/** T5:SFTP 是**一个 tab**(原版亦然,Vaults/SFTP 是常驻 tab)。全局单例,重复点击即激活。 */
function openSftpTab(): void {
  const existing = tabs.find((t) => t.kind === "sftp");
  if (existing) { activateTab(existing.id); return; }
  const pane = makePane();
  const view = createSftpView(
    () => lastSession,
    () => tabs.filter((x) => x.kind === "session" && x.sftp).map((x) => x.sftp!),
  );
  pane.append(view.el);
  const t: Tab = { id: `t${++seq}`, kind: "sftp", label: "SFTP", state: "idle", pane,
    term: null, fit: null, termId: null, disposers: [], sftp: null, view };
  tabs.push(t);
  activateTab(t.id);
}

/** 在(当前空的新 tab 或新建的 tab)里开会话。原版行为:点主机即在 tab 内连接。 */
async function openSession(kind: "local" | "ssh", host?: HostRecord): Promise<void> {
  hideBanner();
  const label = host ? host.name : "Local shell";
  let tab = activeTab();
  if (!tab || tab.kind !== "newtab") {
    tab = { id: `t${++seq}`, kind: "session", label, state: "idle", pane: makePane(),
      term: null, fit: null, termId: null, disposers: [], sftp: null };
    tabs.push(tab);
  }
  tab.kind = "session";
  tab.label = label;
  tab.state = "idle";

  const hostWrap = document.createElement("div");
  hostWrap.className = "term-host";
  tab.pane.replaceChildren(hostWrap);

  const fit = new FitAddon();
  const t = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: TERM_FONT_SIZE,
    lineHeight: TERM_LINE_HEIGHT,
    theme: TERM_THEME,
  });
  t.loadAddon(fit);
  /* 原版终端用 canvas 渲染(四层 text/selection/link/cursor,格宽量化为整数 8px);
     我方默认 DOM 渲染保留小数格宽(8.429)。这里尝试同款 canvas 插件 ——
     但 @xterm/addon-canvas 0.7.0 的 peer 是 xterm ^5(我们是 6.0.0),故必须容错:
     失败就退回 DOM 渲染,不能让终端起不来。 */
  try {
    t.loadAddon(new CanvasAddon());
  } catch (e) {
    console.warn("[term] canvas 插件不可用,退回 DOM 渲染:", e);
  }
  t.open(hostWrap);
  tab.term = t;
  tab.fit = fit;

  /* T4:终端搜索。原版实测:Cmd+F 在终端区右上出现搜索栏,占位符 "Search terminal - ⌘ + F",
     右侧有上/下箭头。插件是 xterm 官方 addon(与 canvas 插件同理,peer 声明较旧,故容错)。 */
  try {
    const search = new SearchAddon();
    t.loadAddon(search);
    tab.search = search;
  } catch (e) {
    console.warn("[term] 搜索插件不可用:", e);
  }
  const bar = document.createElement("div");
  bar.className = "term-search";
  bar.hidden = true;
  bar.innerHTML = `
    <span class="ts-ico"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="6.6" cy="6.6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.2 10.2 L14.4 14.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
    <input placeholder="Search terminal - ⌘ + F" spellcheck="false" autocomplete="off">
    <button class="ts-btn" data-nav="prev" title="Previous match">⌃</button>
    <button class="ts-btn" data-nav="next" title="Next match">⌄</button>
    <button class="ts-btn" data-nav="close" title="Close">✕</button>`;
  hostWrap.append(bar);
  tab.searchBar = bar;
  const sInput = bar.querySelector("input")! as HTMLInputElement;
  sInput.addEventListener("input", () => tab.search?.findNext(sInput.value, { incremental: true }));
  sInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.shiftKey ? tab.search?.findPrevious(sInput.value) : tab.search?.findNext(sInput.value); }
    if (ev.key === "Escape") toggleSearch(tab);
  });
  bar.querySelector('[data-nav="prev"]')!.addEventListener("click", () => tab.search?.findPrevious(sInput.value));
  bar.querySelector('[data-nav="next"]')!.addEventListener("click", () => tab.search?.findNext(sInput.value));
  bar.querySelector('[data-nav="close"]')!.addEventListener("click", () => toggleSearch(tab));

  activateTab(tab.id);
  try { fit.fit(); } catch { /* transient */ }

  setTitle(`${label} (connecting…)`);
  markActiveHost(host?.id ?? "local");

  try {
    const { id } = kind === "local"
      ? await bridge.createLocal({ cols: t.cols, rows: t.rows })
      : await bridge.ssh.connect(host!.id, { cols: t.cols, rows: t.rows });

    tab.termId = id;
    t.onData((d) => bridge.write(id, d));
    t.onResize(({ cols, rows }) => bridge.resize(id, cols, rows));
    tab.disposers.push(bridge.onData(id, (d) => t.write(d)));
    tab.disposers.push(bridge.onExit(id, (info) => {
      if (tab.termId !== id) return; // stale exit from a previous session
      tab.termId = null;
      tab.state = "off";
      tab.sftp = null;
      if (active === tab.id) { setSftpSession(null); setStatus("off"); }
      renderTabs();
      if (info.error) showBanner(info.error);
      t.write(`\r\n\x1b[90m[session closed — ${info.error ?? `exit code ${info.exitCode}`}]\x1b[0m\r\n`);
    }));

    tab.state = "on";
    tab.sftp = kind === "ssh" ? { sid: id, label: `${host!.name} (${host!.host})` } : null;
    if (tab.sftp) lastSession = tab.sftp;
    renderTabs();
    if (active === tab.id) {
      setStatus("on");
      setTitle(label);
      setSftpSession(tab.sftp);
    }
    t.focus();
  } catch (err) {
    tab.state = "off";
    renderTabs();
    const msg = String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+',\s*/, "");
    if (active === tab.id) {
      setStatus("off");
      showBanner(msg);
      setTitle(`${label} (failed)`);
    }
  }
}

/* ---------- T4:快捷键 ---------- */

function toggleSearch(tab: Tab): void {
  const bar = tab.searchBar;
  if (!bar) return;
  bar.hidden = !bar.hidden;
  const input = bar.querySelector("input")! as HTMLInputElement;
  if (bar.hidden) { input.value = ""; tab.search?.clearDecorations(); tab.term?.focus(); }
  else { input.focus(); input.select(); }
}

function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.classList.add("out"), 2600);
  setTimeout(() => el.remove(), 3200);
}

/** Cmd+K 命令面板(原版:Cmd+K 开命令面板;其新 tab 落地页也提示 "start connecting with CMD+K") */
function openPalette(): void {
  if (document.querySelector(".palette-backdrop")) return;
  const show = (): void => {
    const el = document.createElement("div");
    el.className = "palette-backdrop";
    el.innerHTML = `<div class="palette">
        <input placeholder="Search hosts or tabs" spellcheck="false" autocomplete="off">
        <div class="pal-list"></div></div>`;
    document.body.append(el);
    const input = el.querySelector("input")! as HTMLInputElement;
    const list = el.querySelector(".pal-list")! as HTMLElement;

    type Item = { label: string; hint?: string; run: () => void };
    const items: Item[] = [
      ...tabs.map((t) => ({ label: t.label, hint: t.kind === "session" ? "tab" : t.kind, run: () => activateTab(t.id) })),
      ...MAC_SHORTCUTS.map((d) => ({
        label: d.name,
        hint: shortcuts[d.id] ? (d.accel ?? "") : "未实现",
        run: () => (shortcuts[d.id] ? shortcuts[d.id]() : toast(`「${d.name}」尚未实现`)),
      })),
    ];
    const render = (q: string): void => {
      const ql = q.trim().toLowerCase();
      const shown = items.filter((it) => !ql || it.label.toLowerCase().includes(ql)).slice(0, 12);
      list.replaceChildren(...shown.map((it) => {
        const row = document.createElement("div");
        row.className = "pal-row";
        row.innerHTML = `<span class="pal-label"></span><span class="pal-hint"></span>`;
        (row.querySelector(".pal-label")! as HTMLElement).textContent = it.label;
        (row.querySelector(".pal-hint")! as HTMLElement).textContent = it.hint ?? "";
        row.addEventListener("click", () => { close(); it.run(); });
        return row;
      }));
    };
    const close = (): void => { el.remove(); };
    render("");
    input.addEventListener("input", () => render(input.value));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
      if (ev.key === "Enter") {
        const first = list.querySelector(".pal-row") as HTMLElement | null;
        first?.click();
      }
    });
    el.addEventListener("click", (ev) => { if (ev.target === el) close(); });
    input.focus();
  };
  show();
}

let shortcuts: Record<string, () => void> = {};

function installAllShortcuts(): void {
  shortcuts = {
    copyFromTerminal: () => {
      const sel = activeTab()?.term?.getSelection();
      if (sel) void bridge.clipboard.write(sel);
    },
    pasteToTerminal: () => { void bridge.clipboard.read().then((txt) => activeTab()?.term?.paste(txt)); },
    selectAllInTerminal: () => activeTab()?.term?.selectAll(),
    clearTerminalBuffer: () => activeTab()?.term?.clear(),
    openTerminalSearch: () => { const t = activeTab(); if (t?.kind === "session") toggleSearch(t); },
    newTab: () => newTabPage(),
    close: () => { if (active) closeTab(active); },
    bottom: () => cycleTab(1),
    top: () => cycleTab(-1),
    localTerminal: () => void openSession("local"),
    commandPalette: () => openPalette(),
  };
  installShortcuts(shortcuts, (def: ShortcutDef) => {
    toast(`「${def.name}」尚未实现${def.accel ? `(${def.accel})` : "(原版亦未设默认键)"}`);
  });
}

btnNewTab.addEventListener("click", () => newTabPage());
btnSftp.addEventListener("click", () => openSftpTab());

new ResizeObserver(() => {
  const t = activeTab();
  if (t?.fit) { try { t.fit.fit(); } catch { /* transient */ } }
}).observe(stage);

void (async () => {
  initHostPanel((host) => void openSession(host ? "ssh" : "local", host ?? undefined));
  installAllShortcuts();
  newTabPage(); // 与原版一致:起始于一个 New Tab 落地页,而不是直接开 shell
})();
