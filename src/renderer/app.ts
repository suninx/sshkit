import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { bridge, initHostPanel, markActiveHost } from "./hosts";
import { createSftpView, type CurrentSession, type SftpView } from "./sftp";
import { createFwdView } from "./fwd";
import { createKnownHostsView, installHostKeyDialog } from "./knownhosts";
import { installShortcuts, MAC_SHORTCUTS, type ShortcutDef } from "./keys";
import { TERM_SCHEMES, toXtermTheme, type TermScheme } from "./themes";
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
  kind: "session" | "newtab" | "sftp" | "fwd" | "kh";
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
  /** T8:断线重连要能重建同一台主机的会话 */
  host?: HostRecord;
  /** T8:该 tab 当前的断开状态(用于全局断开条) */
  disconnected?: { reason: string };
  /** T2:右键重命名后的显示名(原版动作名 SINGLE_TERMINAL_TAB_RENAMED) */
  customLabel?: string;
  retries?: number;
  /** T8:正在自动重连中,避免并发跑出第二个重试循环 */
  retrying?: boolean;
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
      el.dataset.kind = t.kind; // 便于对照台断言,也便于排查

      /* T2:拖拽重排。原版有 over-horizontal-tab / over-horizontal-tabs-area / over-draft-horizontal-tab
         三种拖放态,说明 tab 可拖到别的 tab 上(插入其位置)也可拖到条上(移到最后)。 */
      el.draggable = true;
      el.addEventListener("dragstart", (ev) => {
        dragTabId = t.id;
        ev.dataTransfer?.setData("text/plain", t.id);
        el.classList.add("dragging");
      });
      el.addEventListener("dragend", () => {
        dragTabId = null;
        document.querySelectorAll(".tab-btn").forEach((n) => n.classList.remove("dragging", "drop-before", "drop-after"));
      });
      el.addEventListener("dragover", (ev) => {
        if (!dragTabId || dragTabId === t.id) return;
        ev.preventDefault();
        const r = el.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2;
        el.classList.toggle("drop-after", after);
        el.classList.toggle("drop-before", !after);
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
      el.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const from = dragTabId;
        el.classList.remove("drop-before", "drop-after");
        if (!from || from === t.id) return;
        const r = el.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2;
        moveTab(from, t.id, after);
      });
      // 右键:原版有 TAB_CONTEXT_MENU_OPENED;菜单项取有据可查的 Rename / Duplicate / Close
      el.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        openTabMenu(t, ev.clientX, ev.clientY);
      });

      const dotEl = document.createElement("span");
      dotEl.className = `dot${t.state === "on" ? " on" : ""}`;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = t.customLabel ?? t.label;

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

let dragTabId: string | null = null;

/** 把 from 移到 target 的前/后;拖到条空白处则移到最后 */
function moveTab(from: string, target: string, after: boolean): void {
  const i = tabs.findIndex((t) => t.id === from);
  if (i < 0) return;
  const [moved] = tabs.splice(i, 1);
  let j = tabs.findIndex((t) => t.id === target);
  if (j < 0) j = tabs.length - 1;
  tabs.splice(after ? j + 1 : j, 0, moved);
  renderTabs();
}

function openTabMenu(t: Tab, x: number, y: number): void {
  document.querySelectorAll(".tab-menu").forEach((n) => n.remove());
  const menu = document.createElement("div");
  menu.className = "tab-menu";
  menu.style.left = `${Math.round(x)}px`;
  menu.style.top = `${Math.round(y)}px`;
  const item = (label: string, fn: () => void): void => {
    const b = document.createElement("button");
    b.className = "tab-menu-item";
    b.textContent = label;
    b.addEventListener("click", () => { menu.remove(); fn(); });
    menu.append(b);
  };
  item("Rename", () => startRenameTab(t));
  item("Duplicate", () => duplicateTab(t));
  item("Close", () => closeTab(t.id));
  document.body.append(menu);
  setTimeout(() => document.addEventListener("click", function once(ev) {
    if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("click", once); }
  }), 0);
}

/** 原版动作名 SINGLE_TERMINAL_TAB_RENAMED:tab 可重命名 */
function startRenameTab(t: Tab): void {
  activateTab(t.id);
  const el = document.querySelector(`.tab-btn[data-tab-id="${t.id}"]`);
  const lbl = el?.querySelector(".lbl") as HTMLElement | null;
  if (!lbl) return;
  const input = document.createElement("input");
  input.className = "tab-rename";
  input.value = t.customLabel ?? t.label;
  lbl.replaceChildren(input);
  input.focus();
  input.select();
  const commit = (save: boolean): void => {
    if (save && input.value.trim()) t.customLabel = input.value.trim();
    renderTabs();
  };
  // 关键:输入框内的点击/按下不能冒泡到 tab,否则 activateTab→renderTabs 会把输入框重建掉(实测踩到)
  for (const type of ["click", "mousedown", "mouseup", "dblclick"]) {
    input.addEventListener(type, (ev) => ev.stopPropagation());
  }
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // 别让 Cmd+W 之类在输入框里误触发
    if (ev.key === "Enter") commit(true);
    if (ev.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

/** 复制一个 tab:同主机再连一个会话(session tab)或同类型视图 */
function duplicateTab(t: Tab): void {
  if (t.kind === "session" && t.host) { void openSession("ssh", t.host); return; }
  if (t.kind === "session" && t.label === "Local shell") { void openSession("local"); return; }
  if (t.kind === "sftp") { openSftpTab(); return; }
  if (t.kind === "fwd") { openFwdTab(); return; }
  if (t.kind === "kh") { openKnownHostsTab(); return; }
  newTabPage();
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
  if (t.kind === "sftp" || t.kind === "fwd" || t.kind === "kh") t.view?.onShow();
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
  t.disconnected = undefined;
  disposeTab(t);
  renderDiscBar();
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
/* T1:字体 / 字号 / 配色都可选。配色数据来自原版 colorSchemesArray(见 themes.ts)。
   原版字号范围 4–40、字体打包 12 个等宽族;我方只随包内置 MesloLGS NF(其余为系统回退),记为缺口。 */
const FONT_CHOICES = [
  { id: '"MesloLGS NF", Menlo, monospace', label: "MesloLGS NF" },
  { id: 'Menlo, monospace', label: "Menlo" },
  { id: '"DejaVu Sans Mono", monospace', label: "DejaVu Sans Mono" },
  { id: 'ui-monospace, monospace', label: "System monospace" },
];
let TERM_FONT = FONT_CHOICES[0].id;
let TERM_FONT_SIZE = 14; // 原版 defaultFontSize=14,实机同;可选范围 4–40
const TERM_LINE_HEIGHT = 1.05; // 目标格高 18px(原版光标墨迹盒实测 8×18;1.1→19、1.05→18)
let TERM_THEME: Record<string, string> = {
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

/** T3:端口转发面板(原版是左栏一级导航的目的地;我方以 tab 承载,与 SFTP 同理)。 */
function openFwdTab(): void {
  const existing = tabs.find((t) => t.kind === "fwd");
  if (existing) { activateTab(existing.id); return; }
  const pane = makePane();
  const view = createFwdView();
  pane.append(view.el);
  const t: Tab = { id: `t${++seq}`, kind: "fwd", label: "Port Forwarding", state: "idle", pane,
    term: null, fit: null, termId: null, disposers: [], sftp: null, view: view as unknown as SftpView };
  tabs.push(t);
  activateTab(t.id);
}

/** T6:已知主机视图(原版为左栏一级导航 Known Hosts)。 */
function openKnownHostsTab(): void {
  const existing = tabs.find((t) => t.kind === "kh");
  if (existing) { activateTab(existing.id); return; }
  const pane = makePane();
  const view = createKnownHostsView();
  pane.append(view.el);
  const t: Tab = { id: `t${++seq}`, kind: "kh", label: "Known Hosts", state: "idle", pane,
    term: null, fit: null, termId: null, disposers: [], sftp: null, view: view as unknown as SftpView };
  tabs.push(t);
  activateTab(t.id);
}

/** 在(当前空的新 tab 或新建的 tab)里开会话。原版行为:点主机即在 tab 内连接。 */
/* ---------- T1:外观(配色 / 字号 / 字体) ---------- */

let schemeName = localStorage.getItem("sshkit.scheme") || "Termius Dark";
let fontSize = Number(localStorage.getItem("sshkit.fontSize") || 14);
let fontFamily = localStorage.getItem("sshkit.fontFamily") || FONT_CHOICES[0].id;

function scheme(): TermScheme {
  return TERM_SCHEMES.find((s) => s.name === schemeName) ?? TERM_SCHEMES[0];
}

/** 应用外观:所有活动终端 + 窗口 chrome(tab 条底色随主题,原版实测如此) */
function applyAppearance(): void {
  const sc = scheme();
  TERM_THEME = toXtermTheme(sc);
  TERM_FONT = fontFamily;
  TERM_FONT_SIZE = Math.min(40, Math.max(4, fontSize));
  document.documentElement.style.setProperty("--term-bg", sc.background);
  for (const tab of tabs) {
    const term = tab.term;
    if (!term) continue;
    term.options.theme = TERM_THEME;
    term.options.fontFamily = TERM_FONT;
    term.options.fontSize = TERM_FONT_SIZE;
    try { tab.fit?.fit(); } catch { /* transient */ }
  }
}

/** 统一入口:改字号 → 存盘 → 应用到所有终端 */
function setFontSize(next: number): void {
  fontSize = Math.min(40, Math.max(4, Math.round(next)));
  localStorage.setItem("sshkit.fontSize", String(fontSize));
  applyAppearance();
  const i = document.querySelector(".ps-size") as HTMLInputElement | null;
  if (i) i.value = String(fontSize);
  const v = document.querySelector(".ps-val");
  if (v) v.textContent = `${fontSize}px`;
}

function openPrefs(): void {
  const existing = document.querySelector(".prefs");
  if (existing) { existing.remove(); return; }
  const host = document.querySelector("#term-head")?.parentElement ?? document.body;
  const el = document.createElement("div");
  el.className = "prefs";
  el.innerHTML = `
    <div><h4>Theme</h4><div class="scheme-list"></div></div>
    <div><h4>Font size</h4><div class="prefs-row">
      <button class="btn ps-down">A−</button>
      <input type="number" class="ps-size" min="4" max="40" step="1">
      <button class="btn ps-up">A+</button>
      <button class="btn ps-reset" title="Reset terminal font size to default">Reset</button>
      <span style="flex:1"></span><span class="ps-val" style="font-size:12px;color:var(--fg-dim)"></span>
    </div></div>
    <div><h4>Font</h4><div class="prefs-row"><select class="ps-font"></select></div></div>`;

  const list = el.querySelector(".scheme-list")! as HTMLElement;
  const drawList = (): void => {
    list.replaceChildren(...TERM_SCHEMES.map((sc) => {
      const b = document.createElement("button");
      b.className = `scheme${sc.name === schemeName ? " on" : ""}`;
      const sw = document.createElement("span");
      sw.className = "swatches";
      // 用背景 + 前 8 色做个小色带,便于一眼认出
      for (const c of [sc.background, ...sc.palette.slice(0, 7)]) {
        const i = document.createElement("i");
        i.style.background = c;
        sw.append(i);
      }
      const nm = document.createElement("span");
      nm.textContent = sc.name;
      nm.style.flex = "1";
      b.append(sw, nm);
      b.addEventListener("click", () => {
        schemeName = sc.name;
        localStorage.setItem("sshkit.scheme", schemeName);
        applyAppearance();
        drawList();
      });
      return b;
    }));
  };
  drawList();

  const size = el.querySelector(".ps-size")! as HTMLInputElement;
  const val = el.querySelector(".ps-val")! as HTMLElement;
  const syncSize = (): void => {
    size.value = String(fontSize);
    val.textContent = `${fontSize}px`;
  };
  size.addEventListener("change", () => {
    fontSize = Math.min(40, Math.max(4, Number(size.value) || 14));
    localStorage.setItem("sshkit.fontSize", String(fontSize));
    applyAppearance();
    syncSize();
  });
  (el.querySelector(".ps-up")! as HTMLElement).addEventListener("click", () => { setFontSize(fontSize + 1); syncSize(); });
  (el.querySelector(".ps-down")! as HTMLElement).addEventListener("click", () => { setFontSize(fontSize - 1); syncSize(); });
  (el.querySelector(".ps-reset")! as HTMLElement).addEventListener("click", () => { setFontSize(14); syncSize(); });
  syncSize();

  const fontSel = el.querySelector(".ps-font")! as HTMLSelectElement;
  for (const f of FONT_CHOICES) {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = f.label;
    fontSel.append(o);
  }
  fontSel.value = fontFamily;
  fontSel.addEventListener("change", () => {
    fontFamily = fontSel.value;
    localStorage.setItem("sshkit.fontFamily", fontFamily);
    applyAppearance();
  });

  host.append(el);
}

document.getElementById("btn-prefs")!.addEventListener("click", (ev) => {
  ev.stopPropagation();
  openPrefs();
});
document.addEventListener("click", (ev) => {
  const el = document.querySelector(".prefs");
  if (el && !el.contains(ev.target as Node) && (ev.target as HTMLElement).id !== "btn-prefs") el.remove();
});

/* ---------- T8:断线与重连 ---------- */

interface ExitInfo { exitCode: number; error?: string; reason?: string }

/** 会话与界面接线(首次连接与重连共用) */
function wireSession(tab: Tab, t: Terminal, id: number, kind: "local" | "ssh", host?: HostRecord): void {
  tab.termId = id;
  tab.host = host ?? tab.host;
  t.onData((d) => bridge.write(id, d));
  t.onResize(({ cols, rows }) => bridge.resize(id, cols, rows));
  tab.disposers.push(bridge.onData(id, (d) => t.write(d)));
  tab.disposers.push(bridge.onExit(id, (info: ExitInfo) => {
    if (tab.termId !== id) return; // 上一个会话的迟到事件
    tab.termId = null;
    tab.state = "off";
    tab.sftp = null;
    if (active === tab.id) { setSftpSession(null); setStatus("off"); }
    renderTabs();
    const detail = info.error ?? `exit code ${info.exitCode}`;
    t.write(`\r\n\x1b[90m[session closed — ${detail}]\x1b[0m\r\n`);
    // T8:由主进程给出的 reason 判定,不再靠退出码猜。
    // "dropped"(连接断了)才给重连入口;auth 失败重试也没用,只报错。
    const dropped = kind === "ssh" && (info.reason === "dropped" || info.reason === "error");
    if (dropped) {
      tab.disconnected = { reason: detail };
      showDisconnected(tab, t, detail);
      renderDiscBar();
      void autoReconnect(tab, t);
    }
  }));
}

/** 断线覆盖层。文案取自原版自身(见 F19):Initiating reconnection... / No connection available to reconnect / Try again */
function showDisconnected(tab: Tab, t: Terminal, reason: string, retrying = false): void {
  clearDisconnected(tab);
  const wrap = t.element?.parentElement ?? tab.pane;
  const el = document.createElement("div");
  el.className = "disc";
  el.innerHTML = `
    <div class="disc-card">
      <div class="disc-title">Session is disconnected</div>
      <div class="disc-reason"></div>
      <div class="disc-actions">
        <button class="btn primary disc-retry">Try again</button>
        <button class="btn danger disc-close">Close</button>
      </div>
    </div>`;
  (el.querySelector(".disc-reason")! as HTMLElement).textContent = retrying ? "Initiating reconnection..." : reason;
  const retry = el.querySelector(".disc-retry")! as HTMLButtonElement;
  const close = el.querySelector(".disc-close")! as HTMLButtonElement;
  retry.disabled = retrying;
  retry.addEventListener("click", () => { void autoReconnect(tab, t, true); });
  close.addEventListener("click", () => closeTab(tab.id));
  wrap.append(el);
}

function clearDisconnected(tab: Tab): void {
  tab.pane.querySelectorAll(".disc").forEach((e) => e.remove());
}

/** 最多 3 次(1s/2s/4s)。原版亦为自动重连,并用 "Initiating reconnection..." 提示。 */
async function autoReconnect(tab: Tab, t: Terminal, manual = false): Promise<void> {
  if (!tab.host || tab.termId !== null || tab.retrying) return;
  tab.retrying = true;
  const max = 3;
  if (manual) tab.retries = 0;
  for (let i = tab.retries ?? 0; i < max; i++) {
    tab.retries = i + 1;
    showDisconnected(tab, t, "", true);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    if (!tabs.includes(tab)) { tab.retrying = false; return; } // tab 已被关掉
    try {
      const { id } = await bridge.ssh.connect(tab.host.id, { cols: t.cols, rows: t.rows });
      clearDisconnected(tab);
      tab.retries = 0;
      tab.disconnected = undefined;
      tab.state = "on";
      tab.sftp = { sid: id, label: `${tab.host.name} (${tab.host.host})` };
      lastSession = tab.sftp;
      wireSession(tab, t, id, "ssh", tab.host);
      renderTabs();
      renderDiscBar();
      if (active === tab.id) { setStatus("on"); setSftpSession(tab.sftp); }
      tab.retrying = false;
      t.write("\x1b[90m[reconnected]\x1b[0m\r\n");
      t.focus();
      return;
    } catch { /* 继续下一次 */ }
  }
  tab.retrying = false;
  tab.disconnected = { reason: "No connection available to reconnect" };
  showDisconnected(tab, t, "No connection available to reconnect");
  renderDiscBar();
}

/** 全局断开条:原版有 "N session is disconnected" + Force reconnect / Close all disconnected terminals */
function renderDiscBar(): void {
  const n = tabs.filter((t) => t.disconnected).length;
  let bar = document.getElementById("disc-bar");
  if (!n) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "disc-bar";
    bar.innerHTML = `<span class="db-text"></span><span style="flex:1"></span>
      <button class="btn db-force">Force reconnect terminals</button>
      <button class="btn danger db-closeall">Close all disconnected terminals</button>`;
    document.body.prepend(bar);
    (bar.querySelector(".db-force")! as HTMLElement).addEventListener("click", () => {
      for (const t of tabs) if (t.disconnected && t.term) { t.retries = 0; void autoReconnect(t, t.term, true); }
    });
    (bar.querySelector(".db-closeall")! as HTMLElement).addEventListener("click", () => {
      for (const t of tabs.filter((x) => x.disconnected)) closeTab(t.id);
    });
  }
  (bar.querySelector(".db-text")! as HTMLElement).textContent =
    n === 1 ? "1 session is disconnected" : `${n} sessions are disconnected`;
}

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

    wireSession(tab, t, id, kind, host);

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
    // 原版 View 菜单:字号增减/复原(CmdOrCtrl+Plus / CmdOrCtrl+-;复原无加速键)
    increaseTerminalFontSize: () => setFontSize(fontSize + 1),
    decreaseTerminalFontSize: () => setFontSize(fontSize - 1),
    forwarding: () => openFwdTab(),
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
  document.querySelectorAll<HTMLButtonElement>("#nav .nav-item").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#nav .nav-item").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      if (b.dataset.nav === "forwarding") openFwdTab();
      else if (b.dataset.nav === "knownhosts") openKnownHostsTab();
      else if (active && ["fwd", "kh"].includes(tabs.find((t) => t.id === active)?.kind ?? "")) newTabPage();
    });
  });
  // T8:reload/关窗时收掉本次界面开的会话(否则主进程留孤儿)
  window.addEventListener("beforeunload", () => { try { bridge.disposeAllSessions(); } catch { /* ignore */ } });
  applyAppearance();
  installHostKeyDialog();
  installAllShortcuts();
  newTabPage(); // 与原版一致:起始于一个 New Tab 落地页,而不是直接开 shell
})();
