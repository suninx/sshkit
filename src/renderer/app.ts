import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { bridge, initHostPanel, markActiveHost } from "./hosts";
import { initSftpPane, type CurrentSession } from "./sftp";
import type { HostRecord } from "../shared/host";

const stage = document.getElementById("stage")!;
const tabsEl = document.getElementById("tabs")!;
const btnNewTab = document.getElementById("btn-new-tab")! as HTMLButtonElement;
const titleEl = document.getElementById("term-title")!;
const bannerEl = document.getElementById("banner")!;
const dot = document.getElementById("status-dot")!;

const btnSftp = document.getElementById("btn-sftp")! as HTMLButtonElement;
const sftpBackdrop = document.getElementById("sftp-backdrop")!;

/* ---------- T2:标签页模型 ----------
   一个 tab = 一个独立会话(pane 里有自己的 Terminal 与 xterm 会话 id)。
   主进程/桥接层本就按 id 区分会话,故多 tab 主要是渲染层的事。
   原版对齐点:条高 51px、底色=终端主题底色、tab 30px/圆角 10、
   非活动 tab 5% 白叠加、活动会话 tab 绿 20% 叠加、关闭按钮在 tab 内右侧。 */

type TabState = "idle" | "on" | "off";
type Tab = {
  id: string;
  kind: "session" | "newtab";
  label: string;
  state: TabState;
  pane: HTMLDivElement;
  term: Terminal | null;
  fit: FitAddon | null;
  termId: number | null;
  disposers: Array<() => void>;
  sftp: CurrentSession | null;
};

let tabs: Tab[] = [];
let active: string | null = null;
let seq = 0;

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
  btnSftp.disabled = !s;
  if (!s && sftpBackdrop.classList.contains("visible")) sftpBackdrop.classList.remove("visible");
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
  if (t.fit) { try { t.fit.fit(); } catch { /* transient */ } }
  if (t.kind === "newtab") t.pane.querySelector("input")?.focus();
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

/* ---------- 快捷键:取自原版自身的 shortcut_schemes(Mac 方案) ---------- */
window.addEventListener("keydown", (e) => {
  if (!e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "t" && !e.shiftKey) { e.preventDefault(); newTabPage(); return; }
  if (k === "w" && !e.shiftKey) { e.preventDefault(); if (active) closeTab(active); return; }
  if (e.shiftKey && (e.key === "]" || e.key === "}")) { e.preventDefault(); cycleTab(1); return; }
  if (e.shiftKey && (e.key === "[" || e.key === "{")) { e.preventDefault(); cycleTab(-1); }
});

btnNewTab.addEventListener("click", () => newTabPage());

new ResizeObserver(() => {
  const t = activeTab();
  if (t?.fit) { try { t.fit.fit(); } catch { /* transient */ } }
}).observe(stage);

void (async () => {
  initHostPanel((host) => void openSession(host ? "ssh" : "local", host ?? undefined));
  initSftpPane(() => activeTab()?.sftp ?? null);
  newTabPage(); // 与原版一致:起始于一个 New Tab 落地页,而不是直接开 shell
})();
