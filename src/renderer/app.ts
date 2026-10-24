import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { bridge, initHostPanel, markActiveHost } from "./hosts";
import { createSftpView, type CurrentSession, type SftpView } from "./sftp";
import { mountMcpSection, policyLabel } from "./mcp";
import { openMultiExec } from "./multiexec";
import {
  CLEAR_LINE, createBroadcastState, planWrite, removeFromBroadcast, toggleBroadcast,
} from "./broadcast";
import { applyDom, audit, getLocale, resolveLocale, setLocale as setI18nLocale, tr, type LocalePref } from "../shared/i18n";
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

/* 平台标记:Windows 用无边框窗口(frame:false,与原版一致)—— CSS 据此把「红绿灯让位」归零,
   并在顶栏右端显示自绘的最小化/最大化/关闭按钮(见 index.html #wincontrols)。
   放在模块顶层(而不是异步 boot 里),避免首帧先按 macOS 的 78px 缩进闪一下。 */
document.body.dataset.platform = String(bridge.platform);

/* ---------- T2:标签页模型 ----------
   一个 tab = 一个独立会话(pane 里有自己的 Terminal 与 xterm 会话 id)。
   主进程/桥接层本就按 id 区分会话,故多 tab 主要是渲染层的事。
   原版对齐点:条高 51px、底色=终端主题底色、tab 30px/圆角 10、
   非活动 tab 5% 白叠加、活动会话 tab 绿 20% 叠加、关闭按钮在 tab 内右侧。 */

type TabState = "idle" | "on" | "off";
type Tab = {
  id: string;
  /* 分区类 tab:原版把一级导航的分区也做成主区视图(Vaults / Snippets / Keychain / Logs …) */
  kind: "session" | "newtab" | "sftp" | "fwd" | "kh" | "vault" | "snippets" | "logs" | "mcp" | "mcp-exec";
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
  /** 已挂上的 canvas 渲染器(切到随包网页字体时要 dispose 掉,退回 DOM 渲染) */
  canvasAddon?: CanvasAddon;
  /** T8:断线重连要能重建同一台主机的会话 */
  host?: HostRecord;
  /** T8:该 tab 当前的断开状态(用于全局断开条) */
  disconnected?: { reason: string };
  /** T2:水平分屏。原版 tab 右键菜单里有 `Split horizontally`(同处还有 Start multiplayer / Duplicate in a new window)。
      分屏是独立的一格终端(自己的会话),可与主终端互相广播输入。 */
  split?: {
    pane: HTMLElement;
    term: Terminal;
    fit: FitAddon;
    termId: number | null;
    host?: HostRecord;
    broadcast: boolean;
    disposers: Array<() => void>;
    canvasAddon?: CanvasAddon;
  };
  /** T8:重连日志。原版有 `Attempting reconnection to server with ID …` 这类提示,这里逐条记录并展示 */
  recLog?: string[];
  /** T8:用户点了 `Disable reconnecting` —— 自动重连停止,只留手动 `Try again` */
  autoRetryOff?: boolean;
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

/* T4:终端侧栏(原版 `Show terminal side-panel`,动作 toggleSidepanel)。
   实现 `Jump to`(把当前终端切到某台主机)与 `Snippets`(把片段发到终端)。
   原版还有 `Serial` 分区 —— 本项目**不做串口**(2026-10-22 决定并移除全部入口)。 */
let PANEL_OPEN = localStorage.getItem("sshkit.sidePanel") === "1";

/** 侧栏当前 tab(外观/片段/跳转);记住上次选择 */
let panelTab: "appearance" | "snippets" | "jump" =
  (localStorage.getItem("sshkit.panelTab") as "appearance" | "snippets" | "jump") || "appearance";

function paintPanelTab(): void {
  for (const b of document.querySelectorAll<HTMLElement>("#sidepanel .sp-tab")) {
    b.classList.toggle("on", b.dataset.spTab === panelTab);
  }
  for (const v of document.querySelectorAll<HTMLElement>("#sidepanel .sp-view")) {
    v.hidden = v.dataset.view !== panelTab;
  }
}

/* 侧栏外观区交互:Font 行打开偏好设置;字号 A−/A+/输入框直接改字号。
   只在第一次打开面板时绑一次 —— 每次重渲染都绑的话,一次点击会跑两次回调
   (openPrefs 自己把自己关掉),用户看到的就是"字体点了没反应"。 */
let panelActionsBound = false;
function bindPanelActions(): void {
  if (panelActionsBound) return;
  panelActionsBound = true;
  const fontRow = document.getElementById("panel-font");
  /* 字体行只开"字体选择器"(不弹整个偏好设置,免得里面还有颜色/主题让人困惑)。
     必须 stopPropagation:document 上有"点外部关闭"的监听,否则刚开的弹框会被同一次点击关掉。 */
  fontRow?.addEventListener("click", (ev) => { ev.stopPropagation(); openFontPicker(); });
  const sizeInput = document.getElementById("panel-font-size") as HTMLInputElement;
  const syncSize = (): void => { sizeInput.value = String(fontSize); };
  /* 与偏好设置共用 setFontSize:夹紧 4–40、落盘、应用到所有终端 */
  const setSize = (n: number): void => { setFontSize(n); syncSize(); };
  document.querySelector("#sidepanel .ps-down")?.addEventListener("click", () => setSize(fontSize - 1));
  document.querySelector("#sidepanel .ps-up")?.addEventListener("click", () => setSize(fontSize + 1));
  sizeInput.addEventListener("change", () => { setSize(Number(sizeInput.value)); });
  syncSize();
}

function applyPanel(): void {
  document.body.dataset.panel = PANEL_OPEN ? "1" : "0";
  const b = document.getElementById("btn-panel");
  if (b) { b.classList.toggle("on", PANEL_OPEN); b.title = PANEL_OPEN ? "Hide terminal side-panel" : "Show terminal side-panel"; }
  if (PANEL_OPEN) { bindPanelActions(); paintPanelTab(); void renderSidePanel(); }
  const t = activeTab();
  if (t?.fit) { try { t.fit.fit(); } catch { /* 布局未稳 */ } }
}

function togglePanel(): void {
  PANEL_OPEN = !PANEL_OPEN;
  localStorage.setItem("sshkit.sidePanel", PANEL_OPEN ? "1" : "0");
  applyPanel();
}

/** 打开侧栏并定位到某个分区(等渲染完成再定位) */
function showPanelSection(title: string): void {
  if (!PANEL_OPEN) togglePanel();
  void renderSidePanel().then(() => focusPanelSection(title));
}

/** 把侧栏滚到某个分区并高亮一下(供 Cmd+J / Cmd+Shift+S 这类"打开某面板"的快捷键用) */
function focusPanelSection(title: string): void {
  const sec = [...document.querySelectorAll("#sidepanel .sp-sec")]
    .find((e) => e.querySelector(".sp-title")?.textContent === title);
  if (!sec) return;
  sec.scrollIntoView({ block: "nearest" });
  sec.classList.add("sp-flash");
  setTimeout(() => sec.classList.remove("sp-flash"), 900);
}

/** 侧栏内容。Jump to / Snippets 都从各自的存储实时读,避免两处状态不同步。 */
async function renderSidePanel(): Promise<void> {
  const jump = document.getElementById("jump-list");
  const snips = document.getElementById("snip-list");
  if (!jump || !snips) return;

  /* 外观区(原版终端右侧栏的 Font / Themes):先渲染,再渲染主机与片段。
     注意:事件绑定放在面板初始化里(font 行只在启动时绑一次),
     否则每次重渲染都会叠一个 listener,点一下会"开了又立刻关掉"。 */
  const fontRow = document.getElementById("panel-font");
  const fontName = fontRow?.querySelector(".sp-font-name") as HTMLElement | null;
  if (fontName) {
    /* fontFamily 一定是 FONT_CHOICES 里的 id 或同值字符串,找不到时直接把 id 当名字显示 */
    fontName.textContent = FONT_CHOICES.find((f) => f.id === fontFamily)?.label ?? fontFamily;
  }
  const themeList = document.getElementById("panel-theme-list")!;
  {
    const draw = (): void => {
      themeList.replaceChildren(...TERM_SCHEMES.map((sc) => {
        const b = document.createElement("button");
        const cur = sc.name === schemeName;
        b.className = `sp-theme-row${cur ? " on" : ""}`;
        b.dataset.theme = sc.name;
        const thumb = schemeSwatches(sc, "sp-thumb");
        const meta = document.createElement("span");
        meta.className = "sp-theme-meta";
        const nm = document.createElement("span");
        nm.className = "sp-theme-name";
        nm.textContent = sc.name;
        const badge = document.createElement("span");
        badge.className = "sp-theme-badge";
        badge.textContent = cur ? tr("panel.current") : "";
        meta.append(nm, badge);
        b.append(thumb, meta);
        b.addEventListener("click", () => {
          schemeName = sc.name;
          localStorage.setItem("sshkit.scheme", schemeName);
          applyAppearance();
          draw();
        });
        return b;
      }));
    };
    draw();
  }

  const hosts = await bridge.hosts.list();
  jump.replaceChildren(
    ...hosts.map((h) => {
      const el = document.createElement("div");
      el.className = "sp-item";
      el.dataset.hostId = h.id;
      el.innerHTML = `<span class="sp-nm"></span><span class="sp-sub"></span>`;
      (el.querySelector(".sp-nm")! as HTMLElement).textContent = h.name;
      (el.querySelector(".sp-sub")! as HTMLElement).textContent = `${h.username}@${h.host}`;
      el.addEventListener("click", () => { void jumpTo(h); });
      return el;
    }),
  );

  const items = await bridge.snippets.list();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "sp-sub";
    empty.textContent = tr("panel.noSnippets");
    snips.replaceChildren(empty);
  } else {
    snips.replaceChildren(
      ...items.map((sn) => {
        const el = document.createElement("div");
        el.className = "sp-item";
        el.dataset.snippetId = sn.id;
        el.title = sn.command;
        el.innerHTML = `<span class="sp-nm"></span><button class="sp-del" title="${tr("menu.delete")}">✕</button>`;
        (el.querySelector(".sp-nm")! as HTMLElement).textContent = sn.name || sn.command;
        el.addEventListener("click", () => { void sendSnippet(sn.command); });
        (el.querySelector(".sp-del")! as HTMLElement).addEventListener("click", async (ev) => {
          ev.stopPropagation();
          await bridge.snippets.remove(sn.id);
          await renderSidePanel();
        });
        return el;
      }),
    );
  }
}

/** 把片段发到当前终端(原版跳转/片段都是"作用于当前终端")。命令末尾补回车,等价用户按回车。 */
async function sendSnippet(command: string): Promise<void> {
  const tab = activeTab();
  if (!tab || tab.kind !== "session" || tab.termId === null) {
    setTitle("no session");
    return;
  }
  /* 命令末尾补回车,等价用户按回车;片段自带换行时只换成回车,避免多发一次空行 */
  const text = command.endsWith("\n") ? `${command.slice(0, -1)}\r` : `${command}\r`;
  bridge.write(tab.termId, text);
  tab.term?.focus();
}

/** Jump to:把当前 tab 的会话切到所选主机(终端复用,不新开 tab);没有会话 tab 时新开一个。 */
async function jumpTo(host: HostRecord): Promise<void> {
  const tab = activeTab();
  if (!tab || tab.kind !== "session" || !tab.term) { await openSession("ssh", host); return; }
  tab.host = host;
  tab.label = host.name;
  tab.customLabel = undefined;
  await reconnectTab(tab);
}

/** 用同一个终端重新握手(原版 tab 菜单第一项就是 `Reconnect`)。 */
async function reconnectTab(tab: Tab): Promise<void> {
  if (!tab.term || !tab.host) return;
  const host = tab.host;
  const t = tab.term;
  if (tab.termId !== null) { try { bridge.dispose(tab.termId); } catch { /* 已断开 */ } }
  for (const d of tab.disposers) { try { d(); } catch { /* ignore */ } }
  tab.disposers = [];
  tab.termId = null;
  tab.retries = 0;
  tab.autoRetryOff = false;
  tab.disconnected = undefined;
  tab.sftp = null;
  clearDisconnected(tab);
  setTitle(`${host.name} (connecting…)`);
  renderTabs();
  try {
    const { id } = await bridge.ssh.connect(host.id, { cols: t.cols, rows: t.rows });
    wireSession(tab, t, id, "ssh", host);
    tab.state = "on";
    tab.sftp = { sid: id, label: `${host.name} (${host.host})` };
    lastSession = tab.sftp;
    setTitle(host.name);   // 与 openSession 的成功路径一致:连上后标题不能停在 (connecting…)
    renderTabs();
    renderDiscBar();
    if (active === tab.id) { setStatus("on"); setSftpSession(tab.sftp); }
    t.focus();
  } catch (e) {
    tab.state = "off";
    setTitle(`${host.name} (failed)`);
    renderTabs();
    t.write(`\r\n\x1b[31m${tr("term.connectFailed", { msg: String((e as Error).message ?? e) })}\x1b[0m\r\n`);
  }
}

/* T2:工作区视图模式。原版有 tabVariant `workspaceVerticalTab`(竖排)与 `horizontalTab`(横排),
   以及动作 `toggleWorkspaceViewMode`;这里按此实现两种视图并持久化选择。 */
let TABVIEW: "horizontal" | "workspace" = localStorage.getItem("sshkit.tabView") === "workspace" ? "workspace" : "horizontal";

function applyTabView(): void {
  document.body.dataset.tabview = TABVIEW;
  /* #btn-tabview 是 index.html 的静态元素(模块初始化时就 addEventListener,不存在缺失态) */
  const btn = document.getElementById("btn-tabview")!;
  btn.classList.toggle("on", TABVIEW === "workspace");
  btn.title = TABVIEW === "workspace" ? "Horizontal tabs" : "Workspace view";
  // 布局变了,终端要重新 fit(否则 pty 的 cols 还是旧宽度)
  const t = activeTab();
  if (t?.fit) { try { t.fit.fit(); } catch { /* 布局未稳 */ } }
  if (t?.split?.fit) { try { t.split.fit.fit(); } catch { /* ignore */ } }
}

function toggleTabView(): void {
  TABVIEW = TABVIEW === "workspace" ? "horizontal" : "workspace";
  localStorage.setItem("sshkit.tabView", TABVIEW);
  applyTabView();
  renderTabs();
}

/** 工作区视图下的左侧竖排 tab 栏(active 态对应原版 `active-workspace-tab`) */
function renderWsRail(): void {
  const rail = document.getElementById("ws-rail");
  if (!rail) return;
  /* tabs 永远非空:Vaults/SFTP 是常驻 tab(closeTab 明确拒绝关闭),而 renderTabs 第一次被调用
     是在 openVaultTab() 把 Vaults 入栈之后 —— 所以原先的 "No open tabs" 空态分支不可达。 */
  rail.replaceChildren(
    ...tabs.map((t) => {
      const row = document.createElement("div");
      row.className = `ws-row${t.id === active ? " active" : ""}`;
      row.dataset.tabId = t.id;
      row.dataset.kind = t.kind;
      row.innerHTML = `<span class="ws-ico"></span><span class="ws-lbl"></span><button class="ws-x" title="${tr("menu.close")}">✕</button>`;
      (row.querySelector(".ws-ico")! as HTMLElement).textContent =
        t.kind === "session" ? (t.disconnected ? "⚠" : "›_") : t.kind === "sftp" ? "⇄" : "＋";
      (row.querySelector(".ws-lbl")! as HTMLElement).textContent = t.customLabel ?? t.label;
      row.addEventListener("click", () => activateTab(t.id));
      (row.querySelector(".ws-x")! as HTMLElement).addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeTab(t.id);
      });
      return row;
    }),
  );
}

/* ===== 跨标签广播输入(右键单个加入;危险命令回车前确认) ===== */
const bcState = createBroadcastState();

/** 顶部浮条:显示广播组与退出入口(不改变布局,避免抖动) */
function renderBroadcastBanner(): void {
  const old = document.getElementById("bc-banner");
  if (bcState.ids.size === 0) { old?.remove(); return; }
  const bar = old ?? document.createElement("div");
  bar.id = "bc-banner";
  bar.className = "bc-banner";
  /* 组内 id 一定有对应 tab(关闭/断开会移出),所以直接按 tab 取名 */
  const names = tabs.filter((t) => t.termId !== null && bcState.ids.has(t.termId)).map((t) => t.label);
  bar.textContent = `${tr("bc.active", { n: String(bcState.ids.size) })}:${names.join(" / ")}`;
  const exit = document.createElement("button");
  exit.className = "bc-exit";
  exit.textContent = tr("bc.exit");
  exit.addEventListener("click", () => {
    for (const id of [...bcState.ids]) removeFromBroadcast(bcState, id);
    renderBroadcastBanner();
    renderTabs();
  });
  bar.append(exit);
  if (!old) document.body.append(bar);
}

/** 危险命令确认:回车先扣住,用户点确认才广播 */
function confirmDangerousBroadcast(line: string): Promise<boolean> {
  return new Promise((resolve) => {
    const names = tabs.filter((t) => t.termId !== null && bcState.ids.has(t.termId)).map((t) => t.label);
    const wrap = document.createElement("div");
    wrap.className = "bc-confirm";
    wrap.innerHTML = `<div class="bc-confirm-box">
      <div class="bc-confirm-title"></div>
      <pre class="bc-confirm-cmd"></pre>
      <div class="bc-confirm-hosts"></div>
      <div class="bc-confirm-actions">
        <button class="mcp-btn ghost" data-act="deny"></button>
        <button class="mcp-btn danger" data-act="allow"></button>
      </div>
    </div>`;
    (wrap.querySelector(".bc-confirm-title") as HTMLElement).textContent = tr("bc.dangerTitle");
    (wrap.querySelector(".bc-confirm-cmd") as HTMLElement).textContent = line;
    (wrap.querySelector(".bc-confirm-hosts") as HTMLElement).textContent = `${tr("bc.dangerHosts")}:${names.join(" / ")}`;
    const btn = (a: string): HTMLElement => wrap.querySelector(`[data-act="${a}"]`) as HTMLElement;
    (btn("deny")).textContent = tr("bc.cancel");
    (btn("allow")).textContent = tr("bc.confirm");
    const close = (ok: boolean): void => { wrap.remove(); resolve(ok); };
    btn("deny").addEventListener("click", () => close(false));
    btn("allow").addEventListener("click", () => close(true));
    document.body.append(wrap);
  });
}

/** 一次输入:按广播计划扇出;危险命令先确认,拒绝则发 Ctrl+U 清行 */
function handleSessionInput(sourceId: number, data: string): void {
  const plan = planWrite(bcState, sourceId, data);
  if (plan.confirm) {
    const { line } = plan.confirm;
    void confirmDangerousBroadcast(line).then((ok) => {
      if (ok) { for (const id of plan.targets) bridge.write(id, data); return; }
      for (const id of plan.targets) bridge.write(id, CLEAR_LINE);
    });
    return;
  }
  for (const id of plan.targets) bridge.write(id, data);
}

function renderTabs(): void {
  renderWsRail();
  tabsEl.replaceChildren(
    ...tabs.map((t) => {
      const el = document.createElement("div");
      /* 状态类必须挂在 pill 上:原版会话 tab 的"已连接"是整颗 pill 变绿(底色取自该会话终端底 + 约 14% 绿),
         之前只把 on 挂在里面的小圆点上,所以绿色样式一直没生效。 */
      el.className = `tab-btn${t.kind === "session" ? " session" : ""}`
        + `${t.kind === "session" && t.state === "on" ? " on" : ""}`
        + `${t.kind === "session" && t.state === "off" ? " off" : ""}`
        + `${t.id === active ? " active" : ""}`;
      /* 绿色是"当前活动会话"的标志:原版非活动会话 pill 就是普通深色(只有头像+白字),没有绿调。
         所以绿调填充只在**活动**的会话 tab 上给。 */
      if (t.kind === "session" && t.state === "on" && t.id === active) {
        const bg = (t.term?.options.theme as { background?: string } | undefined)?.background;
        /* TERM_THEME 由 toXtermTheme() 生成,background 字段必然存在(非法值也只是非 hex 字符串) */
        const m = /^#?([0-9a-f]{6})$/i.exec(bg as string);
        if (m) {
          const v = parseInt(m[1], 16);
          const mix = (c: number, g: number): number => Math.round(c * 0.86 + g * 0.14);
          el.style.background = `rgb(${mix((v >> 16) & 255, 53)}, ${mix((v >> 8) & 255, 211)}, ${mix(v & 255, 154)})`;
        }
      }
      el.title = t.label;
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", t.id === active ? "true" : "false");
      el.dataset.tabId = t.id;
      el.dataset.kind = t.kind; // 便于对照台断言,也便于排查
      const ico = document.createElement("span");
      ico.className = "tico";
      ico.innerHTML = TICON[t.kind];
      el.append(ico);
      if (t.termId !== null && bcState.ids.has(t.termId)) {
        const dot = document.createElement("span");
        dot.className = "bc-dot";
        dot.title = tr("bc.badge");
        dot.textContent = "⇢";
        el.append(dot);
      }
      let chev: HTMLElement | null = null;
      if (t.kind === "vault") {
        /* 原版 `Vaults` pill 是 [图标][标签][▾](箭头在标签**之后**),不是紧跟图标 */
        const chevEl = document.createElement("span");
        chevEl.className = "tchev";
        chevEl.title = "Switch vault";
        chevEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg>';
        chevEl.addEventListener("click", (ev) => { ev.stopPropagation(); toast(tr("toast.oneVault")); });
        chev = chevEl;
      }

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

      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = t.customLabel ?? t.label;
      const mkClose = (): HTMLButtonElement => {
        const x = document.createElement("button");
        x.className = "tab-close";
        x.textContent = "✕";
        x.title = tr("menu.closeTab");
        x.setAttribute("aria-label", "close-tab");
        x.addEventListener("click", (ev) => { ev.stopPropagation(); closeTab(t.id); });
        return x;
      };
      /* 会话 tab 的结构按原版实测排:
         活动 pill(259..498)= [✕ 269..278][标签 290..349]………[会话徽标 469..488],标签与 ✕ 同为 #42b16e;
         非活动 pill = [主机头像][标签]。所以 ✕ 在**左槽**(静止时该槽显示头像,悬停/活动换成 ✕),
         右槽在活动时出现会话徽标。原来我把 [图标][✕][状态点][标签] 排在一起,位置自然不对;
         状态点也是我多出来的,原版没有。 */
      if (t.kind === "session") {
        /* 左槽原版是**主机头像**(圆角方块,约 24px,用的就是该主机卡片上的那枚图标);
           本地 shell 没有主机,用终端图形。 */
        ico.className = "tico tav";
        ico.innerHTML = t.host
          ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7.5" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="7.5" cy="16.5" r="1" fill="currentColor" stroke="none"/></svg>'
          : TICON.session;
        el.append(ico, mkClose(), lbl);
        const badge = document.createElement("span");
        badge.className = "tbadge";
        /* 原版右槽是"终端会话"徽标(实测 19px 宽、色 #2c674c) */
        badge.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2.5" y="4" width="19" height="13" rx="3"/><path d="M7 8.5l2.6 2.2L7 13M12.5 13h4"/><circle cx="16" cy="20" r="2.4"/><path d="M12.4 22.4c.6-1.4 2-2.2 3.6-2.2s3 .8 3.6 2.2"/></svg>';
        el.append(badge);
      } else {
        el.append(ico, lbl);
        if (chev) el.append(chev);
        else if (t.kind !== "vault" && t.kind !== "sftp") el.append(mkClose());  // 常驻 tab 无 ✕
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

/** 在 tab 内水平分出一格(原版 `Split horizontally`)。新格先给选择器:本地终端或某台主机。 */
async function splitTab(tab: Tab): Promise<void> {
  /* 前置条件由唯一调用方保证:菜单项只在 `t.kind === "session" && !t.split` 时加入,
     且菜单点击时先 remove 菜单再回调(不存在并发二次进入);每个 tab 创建时都带 pane。 */
  const pane = document.createElement("div");
  pane.className = "split-pane";
  pane.innerHTML = `
    <div class="split-head">
      <span class="split-title">New pane</span>
      <span style="flex:1"></span>
      <label class="split-bc" title="Run in all panes"><input type="checkbox" disabled> Broadcast</label>
      <button class="btn split-close" title="${tr("menu.closePane")}">✕</button>
    </div>
    <div class="split-picker">
      <button class="btn primary sp-local">${tr("split.localShell")}</button>
      <select class="sp-host"></select>
      <button class="btn sp-connect" disabled>${tr("split.connect")}</button>
    </div>
    <div class="split-body"></div>`;
  tab.pane.append(pane);

  await ensureTermFontReady();
  const term = new Terminal({
    fontFamily: TERM_FONT, fontSize: TERM_FONT_SIZE, theme: TERM_THEME,
    /* lineHeight 必须与分屏终端一致 —— 之前只给分屏设了,主终端漏了,
       结果主终端格高 16 而不是原版的 18(14px + 1.05 → 18)。 */
    lineHeight: TERM_LINE_HEIGHT,
    cursorBlink: true, allowProposedApi: true, scrollback: 5000, macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  /* 渲染器跟着字体走(见 syncRenderer):网页字体必须 DOM;用户可用
     localStorage["sshkit.renderer"]==="dom" 强制 DOM。 */
  const split = { pane, term, fit, termId: null as number | null, host: undefined as HostRecord | undefined,
    broadcast: false, disposers: [] as Array<() => void>, canvasAddon: undefined as CanvasAddon | undefined };
  syncRenderer(term, split);
  const body = pane.querySelector(".split-body")! as HTMLElement;
  term.open(body);
  try { fit.fit(); } catch { /* 布局未稳 */ }

  tab.split = split;

  const bcBox = pane.querySelector(".split-bc input")! as HTMLInputElement;
  bcBox.addEventListener("change", () => { split.broadcast = bcBox.checked; });
  pane.querySelector(".split-close")!.addEventListener("click", () => closeSplit(tab));
  pane.querySelector(".sp-local")!.addEventListener("click", () => { void connectSplit(tab, null); });

  const sel = pane.querySelector(".sp-host")! as HTMLSelectElement;
  const connectBtn = pane.querySelector(".sp-connect")! as HTMLButtonElement;
  void bridge.hosts.list().then((hosts) => {
    for (const h of hosts) {
      const o = document.createElement("option");
      o.value = h.id;
      o.textContent = `${h.name} — ${h.username}@${h.host}`;
      sel.append(o);
    }
    connectBtn.disabled = hosts.length === 0;
  });
  sel.addEventListener("change", () => { connectBtn.disabled = !sel.value; });
  connectBtn.addEventListener("click", () => {
    void bridge.hosts.list().then((hs) => {
      const h = hs.find((x) => x.id === sel.value);
      if (h) void connectSplit(tab, h);
    });
  });

  try { tab.fit?.fit(); } catch { /* ignore */ }
  try { fit.fit(); } catch { /* ignore */ }
  term.focus();
}

/** 给分屏格接一个会话(本地或 ssh),并把输入广播逻辑接上 */
async function connectSplit(tab: Tab, host: HostRecord | null): Promise<void> {
  const split = tab.split;
  if (!split) return;
  const { term, fit } = split;
  const picker = split.pane.querySelector(".split-picker") as HTMLElement | null;
  try {
    const opts = { cols: term.cols, rows: term.rows };
    const { id } = host ? await bridge.ssh.connect(host.id, opts) : await bridge.createLocal(opts);
    split.termId = id;
    split.host = host ?? undefined;
    picker?.remove();
    const title = split.pane.querySelector(".split-title")! as HTMLElement;
    title.textContent = host ? `${host.name}` : "Local shell";
    (split.pane.querySelector(".split-bc input")! as HTMLInputElement).disabled = false;

    term.onData((d) => {
      bridge.write(id, d);
      if (split.broadcast && tab.termId !== null) bridge.write(tab.termId, d);
    });
    term.onResize(({ cols, rows }) => bridge.resize(id, cols, rows));
    split.disposers.push(bridge.onData(id, (d) => term.write(d)));
    split.disposers.push(bridge.onExit(id, () => {
      if (split.termId !== id) return;
      split.termId = null;
      term.write("\r\n\x1b[90m[pane session closed]\x1b[0m\r\n");
    }));
    try { fit.fit(); } catch { /* ignore */ }
    if (active === tab.id) term.focus();
  } catch (e) {
    term.write(`\r\n\x1b[31m${tr("term.connectFailed", { msg: String((e as Error).message ?? e) })}\x1b[0m\r\n`);
  }
}

function closeSplit(tab: Tab): void {
  const split = tab.split;
  if (!split) return;
  if (split.termId !== null) bridge.dispose(split.termId);
  for (const d of split.disposers) { try { d(); } catch { /* ignore */ } }
  try { split.term.dispose(); } catch { /* ignore */ }
  split.pane.remove();
  tab.split = undefined;
  try { tab.fit?.fit(); } catch { /* ignore */ }
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
  /* 菜单项与顺序取自原版自身字面量(F41 实测整段挖出):
     Reconnect / Rename / Duplicate / Duplicate in a new window / Split horizontally / Start multiplayer / Close */
  item(tr("menu.reconnect"), () => { void reconnectTab(t); });
  item(tr("menu.rename"), () => startRenameTab(t));
  item(tr("menu.duplicate"), () => duplicateTab(t));
  item(tr("menu.duplicateWindow"), () => { void bridge.window.create(); });
  if (t.kind === "session" && !t.split) item(tr("menu.splitH"), () => { void splitTab(t); });
  if (t.kind === "session" && t.host && t.termId !== null) {
    const inGroup = bcState.ids.has(t.termId);
    item(inGroup ? tr("menu.unbroadcast") : tr("menu.broadcast"), () => {
      toggleBroadcast(bcState, t.termId!);
      renderBroadcastBanner();
      renderTabs();
    });
  }
  item(tr("menu.close"), () => closeTab(t.id));
  document.body.append(menu);
  setTimeout(() => document.addEventListener("click", function once(ev) {
    /* document 上的 click 事件目标必然是 Node(非 Node 目标的事件不会派发到 document) */
    const target = ev.target as unknown as Node;
    /* 目标已被重绘移除时不算"点外部"(同 .prefs 的守卫) */
    if ((target as Node & { isConnected?: boolean }).isConnected === false) return;
    if (!menu.contains(target)) { menu.remove(); document.removeEventListener("click", once); }
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
  openVaultTab();    // 原版首屏是 `Vaults`(主机列表),不是空白页
}

function activateTab(id: string): void {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  active = id;
  for (const x of tabs) x.pane.classList.toggle("active", x.id === id);
  renderTabs();
  setStatus(t.state);
  setTitle(t.label);
  syncRail(t.kind);
  applyChrome(t.kind);
  setSftpSession(t.sftp);
  if (t.kind === "session" && t.sftp) lastSession = t.sftp;
  if (t.fit) { try { t.fit.fit(); } catch { /* transient */ } }
  if (t.kind === "sftp" || t.kind === "fwd" || t.kind === "kh") t.view?.onShow();
  else if (t.kind === "newtab") t.pane.querySelector("input")?.focus();
  else t.term?.focus();
}

/* ============ 对齐原版:tab 图标 / 分区视图 / 连接日志 ============ */
/* 每个 Tab["kind"] 都必须有图标:Record 的键集由类型强制,漏一种就编译不过(无需运行时兜底) */
const TICON: Record<Tab["kind"], string> = {
  session: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 7l4 5-4 5M13 17h6"/></svg>',
  sftp: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
  vault: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/></svg>',
  fwd: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 8h13l-3-3M21 16H8l3 3"/></svg>',
  kh: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3Z"/></svg>',
  snippets: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M9 4c-2 0-2 3-2 4s0 3-2 4c2 1 2 3 2 4s0 4 2 4M15 4c2 0 2 3 2 4s0 3 2 4c-2 1-2 3-2 4s0 4-2 4"/></svg>',
  logs: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  "mcp-exec": '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 7l4 5-4 5M13 17h6"/></svg>',
  mcp: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="2.6"/><path d="M12 3v3.2M12 17.8V21M3 12h3.2M17.8 12H21M5.6 5.6l2.3 2.3M16.1 16.1l2.3 2.3M18.4 5.6l-2.3 2.3M7.9 16.1l-2.3 2.3"/></svg>',
  newtab: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 5v14M5 12h14"/></svg>',
};

/* Logs 分区的数据:连接/断开/重连这些"会话事件"的环形缓冲(最近 500 条) */
type LogRow = { at: number; level: "info" | "warn" | "error"; text: string };
const LOGS: LogRow[] = [];
function pushLog(level: LogRow["level"], text: string): void {
  LOGS.push({ at: Date.now(), level, text });
  if (LOGS.length > 500) LOGS.shift();
  if (tabs.find((t) => t.id === active)?.kind === "logs") renderLogsSection();
}
function fmtTime(t: number): string {
  const d = new Date(t);
  const p = (x: number): string => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 分区视图的通用外壳 */
type TabKind = Tab["kind"];

/* ===== 分区屏外壳(对齐原版实测)=====
   原版各分区屏顶部都有一条工具条带(底色 #282b3d):单行区高 56px(19+30+7),
   Hosts/Vaults 是两行(搜索 36 + 工具条 30)共 100px;右侧固定 3 个图标(筛选/布局/侧栏)。
   空态:60×60 描边圆角块(不是实底)+ 15px 白标题 + 13px 灰说明,整体居中。 */
const ICON_FILTER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';
const ICON_LAYOUT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="2.2"/><rect x="13" y="3" width="8" height="8" rx="2.2"/><rect x="3" y="13" width="8" height="8" rx="2.2"/><rect x="13" y="13" width="8" height="8" rx="2.2"/></svg>';
const ICON_PANEL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/></svg>';
const ICON_CARET = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg>';

function secToolbar(host: HTMLElement, buttons: Array<{ label: string; icon?: string; caret?: boolean; onClick: () => void }>): void {
  for (const b of buttons) {
    const el = document.createElement("button");
    el.className = "tb-btn";   /* chip 样式随"证书/触控 ID/FIDO2"一起下线 */
    el.innerHTML = (b.icon ?? "") + `<span>${b.label}</span>`;
    if (b.caret) {
      const c = document.createElement("span");
      c.className = "tb-caret";
      c.innerHTML = ICON_CARET;
      el.append(c);
    }
    el.addEventListener("click", b.onClick);
    host.append(el);
  }
  const sp = document.createElement("span");
  sp.style.flex = "1";
  host.append(sp);
  const ic = (svg: string, title: string, fn: () => void): void => {
    const b = document.createElement("button");
    b.className = "tb-icon";
    b.title = title;
    b.innerHTML = svg;
    b.addEventListener("click", fn);
    host.append(b);
  };
  ic(ICON_FILTER, "Filter", () => document.getElementById("host-search")?.focus());
  ic(ICON_LAYOUT, "Change layout", () => document.getElementById("host-layout")?.click());
  ic(ICON_PANEL, "Terminal side-panel", () => togglePanel());
}

function secEmpty(title: string, desc: string, icon: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sec-empty-wrap";
  wrap.innerHTML = `<div class="sec-empty-ico">${icon}</div>
    <div class="sec-empty-title">${title}</div>
    <div class="sec-empty-desc">${desc}</div>`;
  return wrap;
}

const SEC_ICONS = {
  snippet: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 4c-2 0-2 3-2 4s0 3-2 4c2 1 2 3 2 4s0 4 2 4M15 4c2 0 2 3 2 4s0 3 2 4c-2 1-2 3-2 4s0 4-2 4"/></svg>',
  key: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="4"/><path d="M11 11l8 8M16.5 16.5l2-2M14 14l2-2"/></svg>',
  clock: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  fwd: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8h13l-3-3M21 16H8l3 3"/></svg>',
};

/** 打开一个分区屏(单行工具条带版) */
function openSection(kind: TabKind, label: string, build: (body: HTMLElement) => void,
                     buttons: Array<{ label: string; icon?: string; caret?: boolean; onClick: () => void }> = []): void {
  const existing = tabs.find((t) => t.kind === kind);
  if (existing) { activateTab(existing.id); return; }
  const pane = makePane();
  const sec = document.createElement("div");
  sec.className = "sec";
  const band = document.createElement("div");
  band.className = "sec-band";
  secToolbar(band, buttons);
  const body = document.createElement("div");
  body.className = "sec-body";
  /* 没按钮就不渲染工具条带:钥匙串页现在只有只读列表(假按钮全删了),
     再留一条空白带子会显得像加载失败。日志页同样受益。
     注意顺序:波段要么带按钮一起挂,要么不挂 —— body 仍必须先挂进文档再 build(踩过)。 */
  if (buttons.length > 0) sec.append(band);
  sec.append(body);
  pane.append(sec);
  build(body);
  const t: Tab = { id: `t${++seq}`, kind, label, state: "idle", pane,
    term: null, fit: null, termId: null, disposers: [], sftp: null };
  tabs.push(t);
  activateTab(t.id);
}

/** Hosts / Vaults:把 #vault-src 里的节点移动进"工具条带"(id 不变,原绑定继续有效) */
function openVaultTab(): void {
  const existing = tabs.find((t) => t.kind === "vault");
  if (existing) { activateTab(existing.id); return; }
  const pane = makePane();
  const sec = document.createElement("div");
  sec.className = "sec vault";
  const band = document.createElement("div");
  band.className = "sec-band";
  /* 关键顺序:必须**先在文档里**取到列表引用,再把 #vault-src 的子节点挪进 band。
     因为 band 此刻是游离节点,一旦把子节点移进去,它们就脱离文档树,
     之后再 document.getElementById("host-list") 会返回 null(踩过:列表留在带里、带高被撑到 556)。
     #vault-src/#host-list 是 index.html 的静态结构,且 Vaults tab 只在 boot 时创建一次,
     所以这里不存在"容器缺失"的可达分支(hosts.initHostPanel 在更早的 boot 里已同步依赖它们)。 */
  const src = document.getElementById("vault-src")!;
  const body = document.createElement("div");
  body.className = "sec-body";
  const list = document.getElementById("host-list")!;
  band.append(...Array.from(src.children));
  body.append(list);
  sec.append(band, body);
  pane.append(sec);
  const t: Tab = { id: `t${++seq}`, kind: "vault", label: "Vaults", state: "idle", pane,
    term: null, fit: null, termId: null, disposers: [], sftp: null };
  tabs.push(t);
  activateTab(t.id);
}

function openSnippetsTab(): void {
  openSection("snippets", tr("rail.snippets"), (body) => {
    body.innerHTML = `<div id="snip-sec-list" class="sec-list"></div>`;
    void renderSnippetsSection("snip-sec-list");
  }, [
    { label: tr("sec.newSnippet"), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>', caret: true,
      onClick: () => openSnippetEditor() },
    { label: tr("sec.shellHistory"), icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
      onClick: () => toast(tr("toast.shellHistory")) },
  ]);
}

/** 新建 snippet 的极简表单(原版是 "New snippet" 按钮打开编辑面板) */
function openSnippetEditor(): void {
  /* Electron 渲染进程不支持 window.prompt,改走侧栏已有的 Snippets 编辑区 */
  showPanelSection("Snippets");
  setTimeout(() => (document.querySelector(".snip-name") as HTMLInputElement | null)?.focus(), 60);
}

async function renderSnippetsSection(boxId: string): Promise<void> {
  const box = document.getElementById(boxId);
  if (!box) return;
  const items = await bridge.snippets.list();
  if (!items.length) {
    box.replaceChildren(secEmpty(tr("empty.snippetTitle"), tr("empty.snippetDesc"), SEC_ICONS.snippet));
    box.classList.add("is-empty");
    return;
  }
  box.classList.remove("is-empty");
  box.replaceChildren(...items.map((sn) => {
    const row = document.createElement("div");
    row.className = "sec-row";
    row.innerHTML = `<span class="nm"></span><span class="cm"></span>
      <button class="btn sec-send">${tr("snippets.sendToTerminal")}</button><button class="btn danger sec-del">✕</button>`;
    (row.querySelector(".nm") as HTMLElement).textContent = sn.name;
    (row.querySelector(".cm") as HTMLElement).textContent = sn.command;
    (row.querySelector(".sec-send") as HTMLElement).addEventListener("click", () => {
      const target = [...tabs].reverse().find((t) => t.kind === "session" && t.termId !== null);
      if (!target || target.termId === null) { toast(tr("toast.noActiveSession")); return; }
      bridge.write(target.termId, sn.command.endsWith("\n") ? sn.command.slice(0, -1) + "\r" : sn.command + "\r");
      toast(tr("toast.sentTo", { target: target.label }));
    });
    (row.querySelector(".sec-del") as HTMLElement).addEventListener("click", () => {
      void bridge.snippets.remove(sn.id).then(() => renderSnippetsSection(boxId));
    });
    return row;
  }));
}

/* 钥匙串页已于 2026-10-22 移除(用户:"也没啥用")。凭据本身仍由系统钥匙串(keytar)保存,
   主机表单里的"Password (saved in Keychain)"照旧生效 —— 删掉的只是那个只读列表页。
 */

function renderLogsSection(): void {
  /* 调用方只有两个:openLogsTab 的 build(刚插入 #logs-list)与 pushLog(仅当活动 tab 是 logs,
     而 logs tab 的 #logs-list 自创建起一直挂在文档里)—— 所以容器必然存在。 */
  const box = document.getElementById("logs-list")!;
  if (!LOGS.length) {
    /* 原版这一屏是"套餐门控"提示;我方日志是本地免费功能,保留同样的空态版式、用诚实文案。 */
    box.replaceChildren(secEmpty(tr("empty.logsTitle"), tr("empty.logsDesc"), SEC_ICONS.clock));
    box.classList.add("is-empty");
    return;
  }
  box.classList.remove("is-empty");
  box.replaceChildren(...[...LOGS].reverse().map((l) => {
    const row = document.createElement("div");
    row.className = `sec-row log ${l.level}`;
    row.innerHTML = `<span class="at"></span><span class="tx"></span>`;
    (row.querySelector(".at") as HTMLElement).textContent = fmtTime(l.at);
    (row.querySelector(".tx") as HTMLElement).textContent = l.text;
    return row;
  }));
}

function openLogsTab(): void {
  openSection("logs", tr("rail.logs"), (body) => {
    body.innerHTML = '<div id="logs-list" class="sec-list"></div>';
    renderLogsSection();
  });
}

const NAV_OF_KIND: Record<string, string> = {
  vault: "hosts", fwd: "forwarding", kh: "knownhosts", snippets: "snippets",
  logs: "logs", mcp: "mcp",
};

/** 导航栏高亮跟随当前 tab(原版:Vaults tab 活动时左栏 Hosts 高亮) */
function syncRail(kind: string): void {
  const nav = NAV_OF_KIND[kind];
  if (!nav) return;
  for (const b of document.querySelectorAll<HTMLElement>("#rail .rail-item")) {
    b.classList.toggle("on", b.dataset.nav === nav);
  }
}

/** 外层 chrome 随 tab 类型切换:
 *  会话/SFTP → 隐藏左栏、顶栏跟随终端底色(原版实测);
 *  分区屏(Vaults / Port Forwarding / …)→ 显示左栏、顶栏为 #313443。
 *  原来的会话头整行不再出现 —— 原版会话屏里没有这一行。 */
function applyChrome(kind: string): void {
  document.body.dataset.chrome = kind === "session" || kind === "sftp" ? kind : "section";
  const head = document.getElementById("term-head");
  if (head) head.style.display = "none";
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
        <input placeholder="${tr("newtab.search")}" spellcheck="false" autocomplete="off">
        <span class="kbd">⌘+K</span>
      </div>
      <div class="nt-empty">
        <div class="nt-icon">⚡</div>
        <h3>${tr("newtab.recent")}</h3>
        <p>${tr("newtab.empty")}<br>${tr("newtab.hint")}</p>
      </div>
    </div>`;
  const t: Tab = { id: `t${++seq}`, kind: "newtab", label: tr("tab.newTab"), state: "idle", pane,
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

function closeTab(id: string | null): void {
  /* Vaults / SFTP 是常驻 tab:原版这两个 pill 上没有关闭按钮,⌘W 也关不掉。 */
  const t0 = tabs.find((x) => x.id === id);
  if (t0 && (t0.kind === "vault" || t0.kind === "sftp")) return;
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  t.disconnected = undefined;
  disposeTab(t);
  renderDiscBar();
  if (active === id) {
    /* 关掉之后 active 还有邻居就激活它;只有一种情况 tabs 会真的空:
       boot 尚未落地时用户就新开了 tab 并关掉它(此时 Vaults/SFTP 还没创建)——
       这时回退到一个新的 New Tab 落地页,而不是让主区空白。 */
    const next = i < tabs.length ? tabs[i] : (tabs[i - 1] ?? null);
    if (next) activateTab(next.id);
    else newTabPage();
  } else {
    renderTabs();
  }
}

function cycleTab(delta: number): void {
  /* boot 结束后 tabs 至少含 Vaults/SFTP 且 active 必被赋值;active 为 null 时 findIndex 返回 -1,
     取模后仍是合法下标,不需要额外守卫。 */
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
/* T1:字体清单。**族名有据** —— 原版随包的等宽字体全是 Nerd Font 修补版,共 11 族(实测文件名):
   AnonymicePro / CaskaydiaCove / DejaVuSansM / DroidSansM / FiraCode / FiraMono /
   Inconsolata / JetBrainsMono / MesloLGS / SauceCodePro / UbuntuMono (均 *NerdFontMono*)。
   处理方式:清单按同一份族名给出;字体**文件**不取自原版包(那是闭源产物的一部分),
   本包只随 MesloLGS NF(上游开源的 Nerd Font),其余族**从系统已装字体解析**,
   没装的在选项里标注并禁用 —— 这样"可选族名"与原版对齐,又不夹带他人资产。 */
const FONT_CHOICES: Array<{ id: string; label: string; bundled?: boolean; generic?: boolean }> = [
  { id: '"MesloLGS NF", "MesloLGS Nerd Font Mono", monospace', label: "MesloLGS NF", bundled: true },
  { id: '"AnonymicePro Nerd Font Mono", monospace', label: "AnonymicePro Nerd Font Mono" },
  { id: '"CaskaydiaCove Nerd Font Mono", monospace', label: "CaskaydiaCove Nerd Font Mono" },
  { id: '"DejaVuSansM Nerd Font Mono", monospace', label: "DejaVuSansM Nerd Font Mono" },
  { id: '"DroidSansM Nerd Font Mono", monospace', label: "DroidSansM Nerd Font Mono" },
  { id: '"FiraCode Nerd Font Mono", monospace', label: "FiraCode Nerd Font Mono" },
  { id: '"FiraMono Nerd Font Mono", monospace', label: "FiraMono Nerd Font Mono" },
  { id: '"Inconsolata Nerd Font Mono", monospace', label: "Inconsolata Nerd Font Mono" },
  { id: '"JetBrainsMono Nerd Font Mono", monospace', label: "JetBrainsMono Nerd Font Mono" },
  { id: '"SauceCodePro Nerd Font Mono", monospace', label: "SauceCodePro Nerd Font Mono" },
  { id: '"UbuntuMono Nerd Font Mono", monospace', label: "UbuntuMono Nerd Font Mono" },
  { id: 'Menlo, monospace', label: "Menlo" },
  { id: 'ui-monospace, monospace', label: "System monospace", generic: true },
];

/* Windows 默认字体:随包的 MesloLGS NF 是**网页字体**,在 canvas 渲染器的字形图集里
   会被回退(14px 下渲染成细而宽的 Courier New,用户反馈"很难看");系统等宽字体在同一
   路径下清晰锐利。Cascadia Mono 随 Windows Terminal/VS 提供,Consolas 是系统必备,
   未装 Cascadia 的机器自动落到 Consolas;补 "Microsoft YaHei" 让中文不落到宋体。
   Meslo 仍保留在可选清单里(偏好设置 → 字体)。 */
const WIN_FONT = '"Cascadia Mono", Consolas, "Microsoft YaHei", monospace';

/** 默认终端字体:Windows 用系统等宽字体,其余平台沿用随包 Meslo(纯函数,便于覆盖两个平台分支)。 */
export function defaultFontFamily(platform: string): string {
  return platform === "win32" ? WIN_FONT : FONT_CHOICES[0].id;
}

FONT_CHOICES.push({ id: WIN_FONT, label: "Cascadia Mono", generic: true });

/** 某个字体族在本机是否可用:用 canvas 量一段测试串,与"必然不存在的族"对比宽度。
    (比 document.fonts.check 更可靠:后者对系统已装字体不总是返回 true。) */
function fontAvailable(family: string): boolean {
  try {
    const c = document.createElement("canvas").getContext("2d");
    if (!c) return true;
    const probe = "mmmmmmmmmmlliWW";
    /* 基线也要带同样的 generic 回退(monospace):否则"未知字体 → 浏览器默认字体"和
       "未知字体 → monospace"宽度天然不同,所有字体都会被误判为已安装。 */
    c.font = `72px "__sshkit_missing_font__", monospace`;
    const base = c.measureText(probe).width;
    c.font = `72px ${family}`;
    return Math.abs(c.measureText(probe).width - base) > 0.5;
  } catch {
    return true;
  }
}
let TERM_FONT = FONT_CHOICES[0].id;

/** 随包附带的 MesloLGS NF 是网页字体(@font-face)。canvas 渲染器的字形图集拿不到网页字体,
    Windows 上会静默回退成细体 Courier New —— 选中它时必须改用 DOM 渲染器。 */
export function isBundledWebFont(family: string): boolean {
  return family.includes("MesloLGS NF");
}

/** 是否该用 canvas 渲染器:用户没强制 dom,且当前字体不是随包网页字体。 */
export function useCanvasRenderer(family: string, rendererPref: string | null): boolean {
  return rendererPref !== "dom" && !isBundledWebFont(family);
}

/** 让终端渲染器跟随字体:网页字体 → dispose canvas 退回 DOM;系统字体 → 重新挂上 canvas。
    holder 存着当前 CanvasAddon(主终端在 tab 上,分屏在自己的对象上)。 */
function syncRenderer(term: Terminal, holder: { canvasAddon?: CanvasAddon }): void {
  const want = useCanvasRenderer(TERM_FONT, localStorage.getItem("sshkit.renderer"));
  if (want && !holder.canvasAddon) {
    try {
      const addon = new CanvasAddon();
      term.loadAddon(addon);
      holder.canvasAddon = addon;
    } catch (e) { /* 插件不可用:保持 DOM 渲染 */
      console.warn("[term] canvas 插件不可用,退回 DOM 渲染:", e);
    }
  } else if (!want && holder.canvasAddon) {
    /* CanvasAddon.dispose() 会把 renderer 恢复成默认(DOM) */
    holder.canvasAddon.dispose();
    holder.canvasAddon = undefined;
  }
}
/** 终端字体就绪闸门:随包 Meslo 是 @font-face 网页字体,xterm 在创建时按当时量到的字高
    算格高。第一个终端若在字体加载完成前创建,行距会和后面的不一致(用户反馈"两个窗口
    行间距不同")。所以**创建终端前**显式等字体加载完;字体/字号变更后重置闸门。 */
let termFontReady: Promise<void> | null = null;
function ensureTermFontReady(): Promise<void> {
  termFontReady ??= (async () => {
    try { await document.fonts?.load(`${TERM_FONT_SIZE}px ${TERM_FONT}`); } catch { /* 没有 FontFaceSet 就跳过 */ }
    try { await document.fonts?.ready; } catch { /* 同上 */ }
  })();
  return termFontReady;
}

let TERM_FONT_SIZE = 14; // 原版 defaultFontSize=14,实机同;可选范围 4–40
/* 目标格高 18px(原版实测格 8×18)。注意 xterm 会对"字体量出高 × lineHeight"取整,
   14px MesloLGS 的自然高约 15.5-16,所以 1.05 推不上一行(实测仍 16)。可用
   localStorage["sshkit.lineHeight"] 覆盖以便对照测量。 */
const TERM_LINE_HEIGHT = Number(localStorage.getItem("sshkit.lineHeight") || 1.15);
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

/** T5:SFTP 是**一个 tab**(原版亦然,Vaults/SFTP 是常驻 tab),在 boot 里创建一次(不抢焦点)。 */
function createSftpTab(): void {
  const pane = makePane();
  const view = createSftpView(
    () => lastSession,
    /* 只要 session tab 持有 sftp 句柄,lastSession 必然同步非空;这里保持 filter+map 的语义,
       但写成 map→filter 让每台 tab 都经过一次映射(无逻辑分支)。 */
    () => tabs.map((x) => x.sftp).filter((s): s is CurrentSession => s !== null),
  );
  pane.append(view.el);
  const t: Tab = { id: `t${++seq}`, kind: "sftp", label: "SFTP", state: "idle", pane,
    term: null, fit: null, termId: null, disposers: [], sftp: null, view };
  tabs.push(t);
  renderTabs();
}

/** 全局单例:重复点击/复制只激活已存在的常驻 SFTP tab。
    不存在"还不存在"的情况:boot 在创建 Vaults 后立刻创建它,而唯一的用户入口(顶栏 SFTP 按钮)
    在此之前一直是 disabled(index.html 带 disabled,setSftpSession 只有会话存在才启用)。 */
function openSftpTab(): void {
  activateTab(tabs.find((t) => t.kind === "sftp")!.id);
}

/** T3:端口转发面板(原版是左栏一级导航的目的地;我方以 tab 承载,与 SFTP 同理)。 */
/* ===== AI 执行回放:ssh_exec 的输出实时打到这个标签页,并可一键接管 ===== */
let execHostId: string | null = null;
let execOut: HTMLElement | null = null;
let execHead: HTMLElement | null = null;

/** 打开(或复用)「AI 执行」标签页 */
function openMcpExecTab(): void {
  const existing = tabs.find((t) => t.kind === "mcp-exec");
  if (existing) { activateTab(existing.id); return; }
  openSection("mcp-exec", tr("mcp.execTab"), (body) => {
    body.innerHTML = `<div class="mcp-exec">
      <div class="mcp-exec-head"><span class="mcp-exec-host"></span><span class="mcp-exec-cmd"></span></div>
      <pre class="mcp-exec-out"></pre>
    </div>`;
    execOut = body.querySelector(".mcp-exec-out");
    execHead = body.querySelector(".mcp-exec-head");
  }, [
    { label: tr("mcp.takeover"), onClick: () => {
      if (!execHostId) return;
      void bridge.hosts.list().then((hs) => {
        const host = hs.find((h) => h.id === execHostId);
        if (host) void openSession("ssh", host);
      });
    } },
  ]);
}

/** 收到一次 exec 事件:开标签页 → 写命令行 → 追加输出 → 结束显示退出码 */
function onMcpExec(ev: { id: string; hostName: string; command: string; chunk?: string; stream?: "out" | "err"; done?: boolean; exitCode?: number }): void {
  if (!ev.chunk && !ev.done) {
    /* 主机 id 供"接管"用:按名字反查(主机名唯一,列表很小) */
    void bridge.hosts.list().then((hs) => {
      execHostId = hs.find((h) => h.name === ev.hostName)?.id ?? execHostId;
    });
    openMcpExecTab();
    /* 标签页刚建好,这两个 ref 一定存在(构建回调里赋的) */
    execHead!.querySelector(".mcp-exec-host")!.textContent = ev.hostName;
    execHead!.querySelector(".mcp-exec-cmd")!.textContent = `$ ${ev.command}`;
    execOut!.textContent = "";
    return;
  }
  /* 头部事件一定先到(onMcpExec 里先开标签页再追加),所以这里 execOut 必然存在 */
  const out = execOut!;
  if (ev.chunk) {
    const span = document.createElement("span");
    if (ev.stream === "err") span.className = "err";
    span.textContent = ev.chunk;
    out.append(span);
  }
  if (ev.done) {
    const line = document.createElement("div");
    line.className = "mcp-exec-done";
    line.textContent = `—— ${tr("mcp.execDone", { code: String(ev.exitCode ?? 0) })}`;
    out.append(line);
  }
}

/** MCP 分区:服务器状态 + 调用活动流(用户要求"AI 通过 MCP 操作,但我看得见") */
function openMcpTab(): void {
  openSection("mcp", tr("rail.mcp"), (body) => {
    mountMcpSection(body);
  }, [
    { label: tr("mcp.clear"), onClick: () => { void bridge.mcp.clearActivity(); } },
  ]);
}

function openFwdTab(): void {
  const existing = tabs.find((t) => t.kind === "fwd");
  if (existing) { activateTab(existing.id); return; }
  const pane = makePane();
  const view = createFwdView();
  const sec = document.createElement("div");
  sec.className = "sec";
  const band = document.createElement("div");
  band.className = "sec-band";
  secToolbar(band, [
    { label: tr("fwd.newCta"), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>', caret: true,
      onClick: () => (view.el.querySelector(".fwd-new-main") as HTMLElement | null)?.click() },
  ]);
  const body = document.createElement("div");
  body.className = "sec-body";
  body.append(view.el);
  sec.append(band, body);
  pane.append(sec);
  /* 视图自带的头部(fwd-bar)被工具条带取代 —— 原版这些分区屏的按钮就在顶部那条带上 */
  (view.el.querySelector(".fwd-bar") as HTMLElement | null)?.style.setProperty("display", "none");
  const t: Tab = { id: `t${++seq}`, kind: "fwd", label: tr("fwd.title"), state: "idle", pane,
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
  const sec = document.createElement("div");
  sec.className = "sec";
  const band = document.createElement("div");
  band.className = "sec-band";
  secToolbar(band, [
    { label: tr("sec.import"), onClick: () => (view.el.querySelector(".kh-import") as HTMLElement | null)?.click() },
  ]);
  const body = document.createElement("div");
  body.className = "sec-body";
  const group = document.createElement("div");
  group.className = "group-label";
  group.textContent = tr("knownHosts.group");
  body.append(group, view.el);
  sec.append(band, body);
  pane.append(sec);
  (view.el.querySelector(".kh-bar") as HTMLElement | null)?.style.setProperty("display", "none");
  /* 行改成原版的卡片形态:蓝色图标块 + 名称(指纹收进 title,悬停可见) */
  const paint = (): void => {
    for (const row of view.el.querySelectorAll<HTMLElement>(".kh-row")) {
      const ico = row.querySelector<HTMLElement>(".kh-ico");
      if (ico && !ico.dataset.painted) {
        ico.dataset.painted = "1";
        ico.textContent = "";
        ico.innerHTML = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9"><circle cx="8" cy="8" r="4"/><path d="M11 11l8 8"/></svg>';
      }
      /* 原版卡片一行只显示主机名;指纹与类型收进 title(悬停可见),信息不丢 */
      const main = row.querySelector<HTMLElement>(".kh-main");
      if (main) {
        const parts = [...main.children] as HTMLElement[];
        if (parts.length > 1) {
          if (!row.title) row.title = parts.map((p) => p.textContent!.trim()).filter(Boolean).join("  ");
          for (const p of parts.slice(1)) p.style.display = "none";
        }
      }
      const type = row.querySelector<HTMLElement>(".kh-type");
      if (type) type.style.display = "none";
    }
  };
  paint();
  const mo = new MutationObserver(paint);
  mo.observe(view.el, { childList: true, subtree: true });
  const t: Tab = { id: `t${++seq}`, kind: "kh", label: "Known Hosts", state: "idle", pane,
    term: null, fit: null, termId: null, disposers: [], sftp: null, view: view as unknown as SftpView };
  tabs.push(t);
  activateTab(t.id);
}

/** 在(当前空的新 tab 或新建的 tab)里开会话。原版行为:点主机即在 tab 内连接。 */
/* 对照台钩子。**默认不存在**:只有 localStorage.sshkit.bench === "1" 时才挂。
   为什么需要它:CDP 无法向 xterm 注入文本(key/char 事件能到 textarea 但 xterm 不产出输入,
   合成 paste 事件被忽略,Cmd+V 又被 Electron 的默认菜单在 OS 层吃掉)—— 而没有文本输入,
   "广播""键入回显"这类行为就没法做端到端复验。这里只暴露"把文本喂进终端"这一个口子,
   走的是 xterm 自己的 paste 管线(即真实输入路径),不额外新增能力。 */
if (localStorage.getItem("sshkit.bench") === "1") {
  (window as unknown as Record<string, unknown>).__bench = {
    input: (data: string, pane = 0): boolean => {
      const tab = activeTab();
      const term = pane === 0 ? tab?.term : tab?.split?.term;
      if (!term) return false;
      /* 用 xterm 的 input() 而不是 paste():
         - paste() 会加**括号粘贴**包装(ESC[200~ … ESC[201~),里面的换行不会被执行;
         - input() 把数据原样交给 onData,等价于"终端收到这些字节",
           因此也**完整经过产品自己的输入扇出**(广播才会按真实语义生效)。
         这一步只用于对照台复验,不改变产品任何行为。 */
      term.input(data);
      return true;
    },
    /* 计数器:用来判定某条快捷键是否真的到达了渲染层(此前用 window.sshkit 上的代理
       判断过,但那个对象是冻结的,代理根本没装上 —— 结论无效)。 */
    counters: { pasteToTerminal: 0, copyFromTerminal: 0 },
    tabs: () => tabs.map((t) => ({ id: t.id, kind: t.kind, label: t.customLabel ?? t.label,
      termId: t.termId, splitTermId: t.split?.termId ?? null, broadcast: t.split?.broadcast ?? null,
      cols: t.term?.cols ?? null, rows: t.term?.rows ?? null,
      font: t.term?.options.fontFamily ?? null,
      splitFont: t.split?.term.options.fontFamily ?? null,
      splitSize: t.split?.term.options.fontSize ?? null })),
  };
}

/* ---------- T1:外观(配色 / 字号 / 字体) ---------- */

let schemeName = localStorage.getItem("sshkit.scheme") || "Termius Dark";
let fontSize = Number(localStorage.getItem("sshkit.fontSize") || 14);
let fontFamily = localStorage.getItem("sshkit.fontFamily") || defaultFontFamily(String(bridge.platform));

function scheme(): TermScheme {
  return TERM_SCHEMES.find((s) => s.name === schemeName) ?? TERM_SCHEMES[0];
}

/** 一套配色的小色带(背景 + 前景色 + 前几个 ANSI 色)。prefs 与终端侧栏共用。 */
function schemeSwatches(sc: TermScheme, cls: string): HTMLElement {
  const sw = document.createElement("span");
  sw.className = cls;
  for (const c of [sc.background, sc.palette[1], sc.palette[7], sc.palette[3], sc.palette[4]]) {
    const i = document.createElement("i");
    i.style.background = c;
    sw.append(i);
  }
  return sw;
}

/** 应用外观:所有活动终端 + 窗口 chrome(tab 条底色随主题,原版实测如此) */
/** 按背景亮度选前景色(简单相对亮度,阈值 0.55)。 */
function pickOnColor(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return "#e6e9ef";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? "#1f2430" : "#e6e9ef";
}

function applyAppearance(): void {
  const sc = scheme();
  TERM_THEME = toXtermTheme(sc);
  TERM_FONT = fontFamily;
  TERM_FONT_SIZE = Math.min(40, Math.max(4, fontSize));
  termFontReady = null;      // 字体或字号变了:下次建终端重新等字体
  document.documentElement.style.setProperty("--term-bg", sc.background);
  /* tab 条底色跟随终端主题(原版实测如此),所以其**文字色必须按该底色的明暗来定** ——
     否则界面切浅色时(tab 条仍是终端底色)会变成"深字黑底",标签几乎看不见。实测踩到过。 */
  document.documentElement.style.setProperty("--term-fg", pickOnColor(sc.background));
  for (const tab of tabs) {
    if (!tab.term) continue;
    /* 主终端与分屏都要跟着改(此前漏了分屏:改字号/字体后分屏那格不更新) */
    const apply = (t: Terminal, holder: { canvasAddon?: CanvasAddon }): void => {
      t.options.theme = TERM_THEME;
      t.options.fontFamily = TERM_FONT;
      t.options.fontSize = TERM_FONT_SIZE;
      /* 字体决定渲染器:选回/切走随包网页字体时,已打开的终端要跟着换渲染器 */
      syncRenderer(t, holder);
    };
    apply(tab.term, tab);
    if (tab.split) apply(tab.split.term, tab.split);
    try { tab.fit?.fit(); } catch { /* transient */ }
  }
}

/** 统一入口:改字号 → 存盘 → 应用到所有终端 */
function setFontSize(next: number): void {
  fontSize = Math.min(40, Math.max(4, Math.round(next)));
  localStorage.setItem("sshkit.fontSize", String(fontSize));
  applyAppearance();
  const i = document.querySelector(".ps-size") as HTMLInputElement | null;
  if (i) i.value = String(fontSize);   // 偏好设置没打开时不存在,这里保持可选
  const v = document.querySelector(".ps-val");
  if (v) v.textContent = `${fontSize}px`;
}

/* 主机面板的句柄:语言/主题变化后要重建它 —— 面板里的空态文案是渲染时定死的,
   不重建就会停在旧语言(实测:中文界面里出现英文 "No SSH hosts yet.")。 */
let hostsView!: { refresh: () => Promise<void> };

/** 当前语言偏好(与主进程 settings.json 同步;启动时由 boot 填入) */
let LOCALE_PREF: LocalePref = "system";

/** 切换语言:存盘 → 应用到主/渲染 → 重渲染动态文案。返回是否成功。 */
async function setLanguage(pref: LocalePref): Promise<void> {
  try {
    const r = await bridge.settings.setLocale(pref);
    LOCALE_PREF = r.pref;
    setI18nLocale(resolveLocale(r.pref, r.system));
    applyDom();                       // 静态标记(侧栏/工具条/占位符/提示)
    renderTabs();                     // tab 标题也随语言
    void hostsView.refresh();         // 主机面板(空态/分组标题/排序菜单)是动态渲染的,必须重建
    const cur = tabs.find((x) => x.id === active);
    cur?.view?.relabel?.();           // SFTP 双栏的表头/列名/空态
    /* 面板本身也是用 tr() 一次性渲染的:语言变了要重建,否则"界面/语言/字号"仍是旧语言 */
    const openPanel = document.querySelector(".prefs");
    if (openPanel) { openPanel.remove(); openPrefs(); }
    const missing = audit();
    if (missing.length) console.warn("[i18n] 缺少文案:", missing.join(", "));
  } catch (err) {
    console.error("[i18n] 切换语言失败:", err);
  }
}

/* T5/T1:界面主题(深色 / 浅色)。**注意**:终端配色(scheme)与界面主题是两件事 ——
   原版里终端 scheme 决定终端底色,界面主题决定 chrome;这里保持同样的分工。
   浅色值本身是自设计的(原版界面调色板未取到,见 index.html 注释)。 */
let UI_THEME: "dark" | "light" = localStorage.getItem("sshkit.uiTheme") === "light" ? "light" : "dark";

function applyUiTheme(): void {
  document.body.dataset.ui = UI_THEME;
  const box = document.querySelector(".ui-theme-val");
  if (box) box.textContent = UI_THEME === "light" ? "Light" : "Dark";
  for (const b of document.querySelectorAll<HTMLElement>(".ui-mode")) {
    b.classList.toggle("on", b.dataset.mode === UI_THEME);
  }
}

/** 字体选择器:只列字体,选中即应用(侧栏「字体」行用) */
function openFontPicker(): void {
  /* 只留一层:之前打开过的先清掉(查询遮罩类,避免只删了内层留下空遮罩) */
  const existing = document.querySelector(".font-picker-backdrop");
  if (existing) { existing.remove(); return; }
  const wrap = document.createElement("div");
  wrap.className = "font-picker-backdrop";
  const box = document.createElement("div");
  box.className = "font-picker";
  const title = document.createElement("div");
  title.className = "fp-title";
  title.textContent = tr("prefs.font");
  box.append(title);
  for (const f of FONT_CHOICES) {
    const row = document.createElement("button");
    row.className = `fp-row${f.id === fontFamily ? " on" : ""}`;
    row.dataset.font = f.id;
    /* 随包 Meslo 是网页字体,canvas 量不出来,但确实可用;其余字体要本机装了才算可用,
       没装就置灰 + 标「未安装」—— 否则用户选了它字体只会静默回退,看起来像"没换" */
    const usable = isBundledWebFont(f.id) || f.id === fontFamily || fontAvailable(f.id);
    row.disabled = !usable;
    if (!usable) row.title = tr("panel.fontMissing");
    const nm = document.createElement("span");
    nm.textContent = f.label;
    const preview = document.createElement("span");
    preview.className = "fp-preview";
    preview.textContent = usable ? "Aa 0123" : tr("panel.fontMissing");
    preview.style.fontFamily = f.id;
    row.append(nm, preview);
    /* 不可用的行是 disabled,浏览器不会派发 click,不需要额外守卫 */
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      fontFamily = f.id;
      localStorage.setItem("sshkit.fontFamily", fontFamily);
      applyAppearance();
      wrap.remove();
    });
    box.append(row);
  }
  wrap.append(box);
  wrap.addEventListener("click", (ev) => { if (ev.target === wrap) wrap.remove(); });
  document.body.append(wrap);
}

function openPrefs(): void {
  const existing = document.querySelector(".prefs");
  if (existing) { existing.remove(); return; }
  const host = document.querySelector("#term-head")?.parentElement ?? document.body;
  const el = document.createElement("div");
  el.className = "prefs";
  el.innerHTML = `
    <div><h4>${tr("prefs.interface")}</h4><div class="prefs-row">
      <button class="btn ui-mode" data-mode="dark">${tr("prefs.dark")}</button>
      <button class="btn ui-mode" data-mode="light">${tr("prefs.light")}</button>
      <span style="flex:1"></span><span class="ui-theme-val" style="font-size:12px;color:var(--fg-dim)"></span>
    </div></div>
    <div><h4>${tr("prefs.language")}</h4><div class="prefs-row prefs-lang">
      <button class="btn lang-mode${LOCALE_PREF === "system" ? " on" : ""}" data-lang="system">${tr("prefs.langSystem")}</button>
      <button class="btn lang-mode${LOCALE_PREF === "zh" ? " on" : ""}" data-lang="zh">中文</button>
      <button class="btn lang-mode${LOCALE_PREF === "en" ? " on" : ""}" data-lang="en">English</button>
    </div></div>
    <div><h4>${tr("prefs.theme")}</h4><div class="scheme-list"></div></div>
    <div><h4>${tr("prefs.fontSize")}</h4><div class="prefs-row">
      <button class="btn ps-down">A−</button>
      <input type="number" class="ps-size" min="4" max="40" step="1">
      <button class="btn ps-up">A+</button>
      <button class="btn ps-reset" title="${tr("prefs.resetFont")}" data-i18n-title="prefs.resetFont">${tr("prefs.reset")}</button>
      <span style="flex:1"></span><span class="ps-val" style="font-size:12px;color:var(--fg-dim)"></span>
    </div></div>
    <div><h4>${tr("prefs.font")}</h4><div class="prefs-row"><select class="ps-font"></select></div></div>`;

  for (const b of el.querySelectorAll<HTMLElement>(".ui-mode")) {
    b.addEventListener("click", () => {
      UI_THEME = b.dataset.mode === "light" ? "light" : "dark";
      localStorage.setItem("sshkit.uiTheme", UI_THEME);
      applyUiTheme();
    });
  }
  for (const b of el.querySelectorAll<HTMLElement>(".lang-mode")) {
    b.addEventListener("click", () => { void setLanguage((b.dataset.lang ?? "system") as LocalePref); });
  }
  applyUiTheme();
  const list = el.querySelector(".scheme-list")! as HTMLElement;
  const drawList = (): void => {
    list.replaceChildren(...TERM_SCHEMES.map((sc) => {
      const b = document.createElement("button");
      b.className = `scheme${sc.name === schemeName ? " on" : ""}`;
      const sw = schemeSwatches(sc, "swatches");
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
    /* 可用性:本包随附的那族必然可用;其余从系统已装字体解析,没装的标注并禁用
       (选了也只是回退到 monospace,不如直接说清)。 */
    // generic 是 CSS 关键字(ui-monospace/monospace),永远可用,不能拿它做字体探测
    const ok = f.bundled || f.generic || fontAvailable(f.id.split(",")[0]);
    o.textContent = ok ? f.label : `${f.label} (not installed)`;
    o.disabled = !ok;
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

/* T2:工作区视图开关(原版动作 toggleWorkspaceViewMode) */
document.getElementById("btn-tabview")!.addEventListener("click", () => toggleTabView());
document.getElementById("btn-panel")!.addEventListener("click", () => togglePanel());
for (const b of document.querySelectorAll<HTMLElement>("#sidepanel .sp-tab")) {
  b.addEventListener("click", () => {
    panelTab = b.dataset.spTab as typeof panelTab;
    localStorage.setItem("sshkit.panelTab", panelTab);
    paintPanelTab();
  });
}
document.querySelector(".sp-close")!.addEventListener("click", () => { if (PANEL_OPEN) togglePanel(); });
document.querySelector(".snip-save")!.addEventListener("click", () => {
  const name = (document.querySelector(".snip-name") as HTMLInputElement).value.trim();
  const command = (document.querySelector(".snip-cmd") as HTMLInputElement).value;
  if (!name && !command) return;
  void bridge.snippets.save({ name: name || command, command }).then(() => {
    (document.querySelector(".snip-name") as HTMLInputElement).value = "";
    (document.querySelector(".snip-cmd") as HTMLInputElement).value = "";
    return renderSidePanel();
  });
});

/* 标准入口:⌘, 打开外观/设置面板(macOS 惯例)。会话屏里没有工具条,
   之前只有 Vaults 屏的图标能开,等于会话中断开了设置入口。 */
document.addEventListener("keydown", (ev) => {
  /* macOS 用 ⌘,;Windows/Linux 惯例是 Ctrl+,(两者都接受,Ctrl 在 macOS 不影响) */
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key === ",") {
    ev.preventDefault();
    openPrefs();
  }
});
/* macOS 菜单栏 sshkit → 偏好设置(⌘,)也走同一条路 */
try { bridge.onOpenPrefs?.(() => openPrefs()); } catch { /* 老预加载没有此通道 */ }

document.getElementById("btn-prefs")!.addEventListener("click", (ev) => {
  ev.stopPropagation();
  openPrefs();
});
document.addEventListener("click", (ev) => {
  const el = document.querySelector(".prefs");
  if (!el) return;
  const t = ev.target instanceof Element ? ev.target : null;
  /* 点击目标已被"重绘"掉(例如点配色方案时 drawList() 会 replaceChildren 重建列表,
     被点的按钮已经脱离文档)时,el.contains(t) 必然是 false —— 若不加这个守卫,用户每选
     一个主题/字号,整个设置面板就会被当成"点了外部"关掉,没法连续调整。 */
  if (!t || !t.isConnected) return;
  /* 白名单必须包含**所有**开启者。之前只写了 #btn-prefs,而 Vaults 工具条上的开启者是
     #btn-appearance —— 于是点它时:自己的监听先开、紧接着这个"点外部关闭"又把它关掉,
     表现为"按钮点了没反应"(踩过)。 */
  if (el.contains(t) || t.closest("#btn-prefs, #btn-appearance")) return;
  el.remove();
});

/* ---------- T8:断线与重连 ---------- */

interface ExitInfo { exitCode: number; error?: string; reason?: string }

/** 会话与界面接线(首次连接与重连共用) */
function wireSession(tab: Tab, t: Terminal, id: number, kind: "local" | "ssh", host?: HostRecord): void {
  tab.termId = id;
  tab.host = host ?? tab.host;
  t.onData((d) => {
    /* 跨标签广播:组内输入扇出到全组;危险命令回车前确认(见 broadcast.ts) */
    handleSessionInput(id, d);
    // T2 广播:原版 `Broadcast` / RUN_IN_ALL_ACTIVE_TABS —— 输入同时发到同 tab 的其它格
    const sp = tab.split;
    if (sp?.broadcast && sp.termId !== null) bridge.write(sp.termId, d);
  });
  t.onResize(({ cols, rows }) => bridge.resize(id, cols, rows));
  tab.disposers.push(bridge.onData(id, (d) => t.write(d)));
  tab.disposers.push(bridge.onExit(id, (info: ExitInfo) => {
    if (tab.termId !== id) return; // 上一个会话的迟到事件
    if (removeFromBroadcast(bcState, id)) { renderBroadcastBanner(); renderTabs(); }
    tab.termId = null;
    tab.state = "off";
    tab.sftp = null;
    if (active === tab.id) { setSftpSession(null); setStatus("off"); }
    renderTabs();
    const detail = info.error ?? `exit code ${info.exitCode}`;
    t.write(`\r\n\x1b[90m[session closed — ${detail}]\x1b[0m\r\n`);
    /* Logs 分区此前是"永远空态":pushLog 定义了却没人调用。会话的结束就是最该记录的事件。 */
    pushLog(info.reason === "closed" ? "info" : "error", tr("log.exit", { host: tab.label, detail }));
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
      <div class="disc-log"></div>
      <div class="disc-actions">
        <button class="btn primary disc-retry">Try again</button>
        <button class="btn disc-stop">Disable reconnecting</button>
        <button class="btn danger disc-close">Close</button>
      </div>
    </div>`;
  (el.querySelector(".disc-reason")! as HTMLElement).textContent = retrying ? "Initiating reconnection..." : reason;
  const logBox = el.querySelector(".disc-log")! as HTMLElement;
  if (tab.recLog?.length) {
    for (const line of tab.recLog.slice(-6)) {
      const row = document.createElement("div");
      row.className = "disc-log-line";
      row.textContent = line;
      logBox.append(row);
    }
  }
  const retry = el.querySelector(".disc-retry")! as HTMLButtonElement;
  const stop = el.querySelector(".disc-stop")! as HTMLButtonElement;
  const close = el.querySelector(".disc-close")! as HTMLButtonElement;
  retry.disabled = retrying;
  /* 原版文案 `Disable reconnecting`:只在"正在自动重连"时有意义(否则没什么可关的) */
  stop.hidden = !retrying;
  stop.addEventListener("click", () => {
    tab.autoRetryOff = true;         // 循环下一轮会看到并停下
    showDisconnected(tab, t, "Reconnecting disabled", false);
  });
  retry.addEventListener("click", () => {
    tab.autoRetryOff = false;        // 手动重试 = 重新允许尝试
    void autoReconnect(tab, t, true);
  });
  close.addEventListener("click", () => closeTab(tab.id));
  wrap.append(el);
}

function clearDisconnected(tab: Tab): void {
  tab.pane.querySelectorAll(".disc").forEach((e) => e.remove());
}

/** 最多 3 次(1s/2s/4s)。原版亦为自动重连,并用 "Initiating reconnection..." 提示。 */
async function autoReconnect(tab: Tab, t: Terminal, manual = false): Promise<void> {
  if (!tab.host || tab.termId !== null || tab.retrying) return;
  const host = tab.host;
  tab.retrying = true;
  const max = 3;
  if (manual) tab.retries = 0;
  for (let i = tab.retries ?? 0; i < max; i++) {
    tab.retries = i + 1;
    /* 原版文案形如 `Attempting reconnection to server with ID <id>`(F19 已验证字符串) */
    tab.recLog = [...(tab.recLog ?? []), `Attempting reconnection to server with ID ${host.id} (${tab.retries}/${max})`].slice(-20);
    showDisconnected(tab, t, "", true);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    if (!tabs.includes(tab)) { tab.retrying = false; return; } // tab 已被关掉
    if (tab.autoRetryOff) {                                    // 用户点了 Disable reconnecting
      tab.retrying = false;
      tab.retries = max;
      showDisconnected(tab, t, "Reconnecting disabled", false);
      return;
    }
    try {
      const { id } = await bridge.ssh.connect(host.id, { cols: t.cols, rows: t.rows });
      pushLog("info", tr("log.connected", { host: tab.label }));
      clearDisconnected(tab);
      tab.recLog = [];   // 连上了就清掉旧的尝试记录
      tab.retries = 0;
      tab.disconnected = undefined;
      tab.state = "on";
      tab.sftp = { sid: id, label: `${host.name} (${host.host})` };
      lastSession = tab.sftp;
      wireSession(tab, t, id, "ssh", host);
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

  /* 字体没就绪就建终端 → 格高和后续窗口不一致,见 ensureTermFontReady 注释 */
  await ensureTermFontReady();
  const fit = new FitAddon();
  const t = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: TERM_FONT_SIZE,
    lineHeight: TERM_LINE_HEIGHT,
    theme: TERM_THEME,
  });
  t.loadAddon(fit);
  /* 原版终端用 canvas 渲染(四层 text/selection/link/cursor,格宽量化为整数 8px);
     但 @xterm/addon-canvas 0.7.0 的 peer 是 xterm ^5(我们是 6.0.0),故必须容错:
     失败就退回 DOM 渲染,不能让终端起不来。
     另外随包 Meslo 是网页字体、canvas 图集用不了 → 选它时走 DOM(见 syncRenderer)。 */
  syncRenderer(t, tab);
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
    <input placeholder="${tr("search.terminal")}" spellcheck="false" autocomplete="off">
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

    /* Logs 分区要真的记录"连接"事件:此前只有自动重连成功才写,首次连接永远是空白,
       与空态文案 "Connection and disconnect events will appear here." 不符。 */
    /* 只有 ssh 会话进 Logs;本地 shell 不算"连接事件"(用 && 而非 if,避免一个恒假的空分支) */
    kind === "ssh" && pushLog("info", tr("log.connected", { host: label }));

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
  /* searchBar 在 openSession 里、activateTab 之前同步设置;能拿到 session tab 的入口
     (⌘F / 搜索栏自身按钮)都只可能发生在它落地之后,所以这里不会有"没有搜索栏"的状态。 */
  const bar = tab.searchBar!;
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
        <input placeholder="${tr("newtab.search")}" spellcheck="false" autocomplete="off">
        <div class="pal-list"></div></div>`;
    document.body.append(el);
    const input = el.querySelector("input")! as HTMLInputElement;
    const list = el.querySelector(".pal-list")! as HTMLElement;

    type Item = { label: string; hint: string; run: () => void };
    const items: Item[] = [
      ...tabs.map((t) => ({ label: t.label, hint: t.kind === "session" ? "tab" : t.kind, run: () => activateTab(t.id) })),
      ...MAC_SHORTCUTS.map((d) => ({
        label: d.name,
        hint: shortcuts[d.id] ? (d.accel ?? "") : tr("toast.notImplemented"),
        run: () => (shortcuts[d.id] ? shortcuts[d.id]() : toast(tr("toast.featureNotImplemented", { name: d.name }))),
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
        (row.querySelector(".pal-hint")! as HTMLElement).textContent = it.hint;
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
      const c = (window as unknown as { __bench?: { counters: Record<string, number> } }).__bench?.counters;
      if (c) c.copyFromTerminal++;
      const sel = activeTab()?.term?.getSelection();
      if (sel) void bridge.clipboard.write(sel);
    },
    pasteToTerminal: () => {
      const c = (window as unknown as { __bench?: { counters: Record<string, number> } }).__bench?.counters;
      if (c) c.pasteToTerminal++;
      void bridge.clipboard.read().then((txt) => activeTab()?.term?.paste(txt));
    },
    selectAllInTerminal: () => activeTab()?.term?.selectAll(),
    clearTerminalBuffer: () => activeTab()?.term?.clear(),
    openTerminalSearch: () => { const t = activeTab(); if (t?.kind === "session") toggleSearch(t); },
    newTab: () => newTabPage(),
    /* active 为 null(仅 boot 完成前)时交给 closeTab 的"找不到 id"分支直接返回 */
    close: () => closeTab(active),
    bottom: () => cycleTab(1),
    top: () => cycleTab(-1),
    localTerminal: () => void openSession("local"),
    commandPalette: () => openPalette(),
    // 原版 View 菜单:字号增减/复原(CmdOrCtrl+Plus / CmdOrCtrl+-;复原无加速键)
    increaseTerminalFontSize: () => setFontSize(fontSize + 1),
    decreaseTerminalFontSize: () => setFontSize(fontSize - 1),
    forwarding: () => openFwdTab(),
    /* 以下 5 条原先因为"功能还不存在"而未接线(F16 时只有显式提示)。功能补齐后接上实体行为。 */
    toggleSidepanel: () => togglePanel(),
    toggleWorkspaceViewMode: () => toggleTabView(),
    toggleSplitViewBroadcastMode: () => {
      const t = activeTab();
      const box = document.querySelector(".split-bc input") as HTMLInputElement | null;
      if (!t?.split || !box) { toast(tr("toast.splitFirst")); return; }
      box.click();
    },
    /* 注意时序:面板刚打开时 renderSidePanel 还没跑完,必须等它 resolve 再去找分区
       (否则 focusPanelSection 找不到元素,表现为"按了没反应")。 */
    snippets: () => showPanelSection("Snippets"),
    jumpTo: () => showPanelSection("Jump to"),
  };
  installShortcuts(shortcuts, (def: ShortcutDef) => {
    toast(tr("toast.featureNotImplemented", { name: def.name }));
  });
}

btnNewTab.addEventListener("click", () => newTabPage());
btnSftp.addEventListener("click", () => openSftpTab());

/* Windows 无边框窗口:窗口按钮由渲染层自绘,点击交给主进程(IPC window:*);
   最大化状态由主进程推上来,用来切换 □ / ❐ 图标与 tooltip。 */
function installWindowControls(): void {
  const min = document.getElementById("wc-min")!;
  const max = document.getElementById("wc-max")!;
  const close = document.getElementById("wc-close")!;
  min.addEventListener("click", () => bridge.window.minimize());
  max.addEventListener("click", () => bridge.window.toggleMaximize());
  close.addEventListener("click", () => bridge.window.close());
  bridge.window.onMaximized((on) => {
    document.body.classList.toggle("win-maximized", on);
    const key = on ? "win.restore" : "win.maximize";
    max.title = tr(key);
    /* 同步 data-i18n-title:切换语言时 applyDom() 会按它重刷 title,否则会退回"最大化" */
    max.dataset.i18nTitle = key;
  });
}

new ResizeObserver(() => {
  const t = activeTab();
  if (t?.fit) { try { t.fit.fit(); } catch { /* transient */ } }
}).observe(stage);

void (async () => {
  /* hosts.ts 的列表项只可能是有记录的主机(没有 "Local shell" 伪条目),故只会以 ssh 打开会话。 */
  /* 语言:与主进程共用 settings.json,必须在任何界面渲染之前决定(主机面板在下面几行就渲染了) */
  try {
    const loc = await bridge.settings.getLocale();
    LOCALE_PREF = loc.pref;
    setI18nLocale(resolveLocale(loc.pref, loc.system));
    applyDom();
    const missing = audit();
    if (missing.length) console.warn("[i18n] 缺少文案:", missing.join(", "));
  } catch (err) { console.warn("[i18n] 语言初始化失败:", err); }

  /* Windows 自绘窗口按钮:语言已就位,title 能取到正确文案 */
  installWindowControls();

  hostsView = initHostPanel((host) => void openSession("ssh", host));
  /* 新建:左导航栏(184px,6 项)。原版这 6 项是一级导航,点击后主区切到对应分区
     (Hosts 分区就是原版的 `Vaults` tab;转发/Known Hosts 等各自成为主区视图)。 */
  document.getElementById("btn-panel-top")?.addEventListener("click", () => togglePanel());
  document.getElementById("btn-quick-term")?.addEventListener("click", () => { void openSession("local"); });
  document.getElementById("btn-appearance")?.addEventListener("click", () => openPrefs());
  document.getElementById("btn-new-host-caret")?.addEventListener("click", () => {
    document.getElementById("btn-new-host")?.click();
  });

  /* 多主机命令面板 */
  document.getElementById("btn-multiexec")?.addEventListener("click", () => {
    void bridge.hosts.list().then((hs) => openMultiExec(hs));
  });

  /* MCP:AI 执行回放 */
  bridge.mcp.onExec((ev) => { onMcpExec(ev as Parameters<typeof onMcpExec>[0]); });

  document.querySelectorAll<HTMLElement>("#rail .rail-item").forEach((b) => {
    b.addEventListener("click", () => {
      switch (b.dataset.nav) {
        case "hosts": openVaultTab(); break;
        case "forwarding": openFwdTab(); break;
        case "knownhosts": openKnownHostsTab(); break;
        case "snippets": openSnippetsTab(); break;
        case "mcp": openMcpTab(); break;
        case "logs": openLogsTab(); break;
      }
    });
  });

  /* 旧版左栏 `#nav .nav-item` 的绑定块已删除:index.html 里只有 `#rail .rail-item`
     (grep `id="nav"` / `class="nav-item"` 在 DOM 中 0 命中,.nav-item 只剩历史 CSS 规则),
     所以 querySelectorAll 恒为空,该块永远不会执行 —— 属于死代码而非分支。 */
  // T8:reload/关窗时收掉本次界面开的会话(否则主进程留孤儿)
  window.addEventListener("beforeunload", () => { try { bridge.disposeAllSessions(); } catch { /* ignore */ } });
  applyAppearance();
  applyUiTheme();   // T5:恢复界面主题(深色 / 浅色)
  applyTabView();   // T2:恢复上次的 tab 视图模式(横排 / 工作区竖排)
  applyPanel();     // T4:恢复终端侧栏开关
  installHostKeyDialog();
  installAllShortcuts();
  openVaultTab();   // 原版首屏是 `Vaults`(主机列表),不是空白页 // 与原版一致:起始于一个 New Tab 落地页,而不是直接开 shell
  createSftpTab(); // 原版顶栏里 `SFTP` 是常驻 tab(证据:未连接 SFTP 时它也在,且显示 Connect to host 空态)
})();
