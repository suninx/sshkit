import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { bridge, initHostPanel, markActiveHost } from "./hosts";
import { initSftpPane, type CurrentSession } from "./sftp";
import type { HostRecord } from "../shared/host";

const termWrap = document.getElementById("term")!;
const titleEl = document.getElementById("term-title")!;
const bannerEl = document.getElementById("banner")!;
const dot = document.getElementById("status-dot")!;

let term: Terminal | null = null;
let termId: number | null = null;
let currentFit: FitAddon | null = null;
let sftpSession: CurrentSession | null = null;
let disposers: Array<() => void> = [];

const btnSftp = document.getElementById("btn-sftp")! as HTMLButtonElement;
const sftpBackdrop = document.getElementById("sftp-backdrop")!;

function setSftpSession(s: CurrentSession | null): void {
  sftpSession = s;
  btnSftp.disabled = !s;
  if (!s && sftpBackdrop.classList.contains("visible")) sftpBackdrop.classList.remove("visible");
}

function setStatus(state: "idle" | "on" | "off"): void {
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

async function disposeCurrent(): Promise<void> {
  disposers.forEach((fn) => fn());
  disposers = [];
  if (termId !== null) bridge.dispose(termId);
  termId = null;
  currentFit = null;
  if (term) { try { term.dispose(); } catch { /* already gone */ } term = null; }
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

async function startSession(kind: "local" | "ssh", host?: HostRecord): Promise<void> {
  hideBanner();
  await disposeCurrent();

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
  t.open(termWrap);
  fit.fit();
  term = t;
  currentFit = fit;

  const label = host ? `${host.name} — ${host.username}@${host.host}` : "local shell";
  setStatus("idle");
  setTitle(`${label} (connecting…)`);
  markActiveHost(host?.id ?? "local");

  try {
    const { id } = kind === "local"
      ? await bridge.createLocal({ cols: t.cols, rows: t.rows })
      : await bridge.ssh.connect(host!.id, { cols: t.cols, rows: t.rows });

    termId = id;
    t.onData((d) => bridge.write(id, d));
    t.onResize(({ cols, rows }) => bridge.resize(id, cols, rows));
    disposers.push(bridge.onData(id, (d) => term?.write(d)));
    disposers.push(bridge.onExit(id, (info) => {
      if (termId !== id) return; // stale exit from a previous session
      termId = null;
      setSftpSession(null);
      setStatus("off");
      if (info.error) showBanner(info.error);
      t.write(`\r\n\x1b[90m[session closed — ${info.error ?? `exit code ${info.exitCode}`}]\x1b[0m\r\n`);
    }));

    setStatus("on");
    setTitle(label);
    if (kind === "ssh") setSftpSession({ sid: id, label: `${host!.name} (${host!.host})` });
    else setSftpSession(null);
    t.focus();
  } catch (err) {
    setStatus("off");
    const msg = String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+',\s*/, "");
    showBanner(msg);
    setTitle(`${label} (failed)`);
  }
}

new ResizeObserver(() => { try { currentFit?.fit(); } catch { /* transient */ } }).observe(termWrap);

void (async () => {
  initHostPanel((host) => void startSession(host ? "ssh" : "local", host ?? undefined));
  initSftpPane(() => sftpSession);
  await startSession("local");
})();
