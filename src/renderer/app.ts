import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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

async function startSession(kind: "local" | "ssh", host?: HostRecord): Promise<void> {
  hideBanner();
  await disposeCurrent();

  const fit = new FitAddon();
  const t = new Terminal({
    fontFamily: "Menlo, DejaVu Sans Mono, monospace",
    fontSize: 13,
    theme: { background: "#101418", foreground: "#d8dee9", cursor: "#88c0d0" },
  });
  t.loadAddon(fit);
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
