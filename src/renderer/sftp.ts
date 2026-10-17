import { bridge } from "./hosts";
import type { SftpEntry, TransferProgress } from "../shared/sftp";

interface PaneState {
  dir: string;
  entries: SftpEntry[];
  sel: SftpEntry | null;
}

export interface CurrentSession {
  sid: number;
  label: string;
}

const local: PaneState = { dir: "~", entries: [], sel: null };
const remote: PaneState = { dir: ".", entries: [], sel: null };
let session: CurrentSession | null = null;
let queueEl: HTMLElement;
const jobEls = new Map<number, HTMLElement>();

export function initSftpPane(getSession: () => CurrentSession | null): void {
  const backdrop = document.getElementById("sftp-backdrop")!;
  queueEl = document.getElementById("sftp-queue")!;

  document.getElementById("btn-sftp")!.addEventListener("click", async () => {
    session = getSession();
    if (!session) return;
    (document.getElementById("sftp-title")! as HTMLElement).textContent = `SFTP — ${session.label}`;
    backdrop.classList.add("visible");
    local.dir = "~";
    remote.dir = ".";
    await refresh("local");
    await refresh("remote");
  });
  document.getElementById("btn-sftp-close")!.addEventListener("click", () => backdrop.classList.remove("visible"));
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.classList.remove("visible"); });

  bindNav("go-local", "p-local-path", () => { local.dir = readPath("p-local-path", "~"); void refresh("local"); });
  bindNav("go-remote", "p-remote-path", () => { remote.dir = readPath("p-remote-path", "."); void refresh("remote"); });

  document.getElementById("l-mkdir")!.addEventListener("click", () => opLocal("mkdir"));
  document.getElementById("l-rename")!.addEventListener("click", () => opLocal("rename"));
  document.getElementById("l-del")!.addEventListener("click", () => opLocal("remove"));
  document.getElementById("r-mkdir")!.addEventListener("click", () => opRemote("mkdir"));
  document.getElementById("r-rename")!.addEventListener("click", () => opRemote("rename"));
  document.getElementById("r-del")!.addEventListener("click", () => opRemote("remove"));

  document.getElementById("btn-upload")!.addEventListener("click", () => void doUpload());
  document.getElementById("btn-download")!.addEventListener("click", () => void doDownload());

  bridge.sftp.onProgress(onProgress);
}

/* ---------- listings ---------- */

async function refresh(which: "local" | "remote"): Promise<void> {
  try {
    if (which === "local") {
      const r = await bridge.local.list(local.dir);
      local.dir = r.path; local.entries = r.entries; local.sel = null;
      setPath("p-local-path", r.path);
    } else {
      if (!session) return;
      const r = await bridge.sftp.list(session.sid, remote.dir);
      remote.dir = r.path; remote.entries = r.entries; remote.sel = null;
      setPath("p-remote-path", r.path);
    }
  } catch (err) {
    bannerInQueue(String((err as Error).message ?? err));
  }
  renderList(which);
}

function renderList(which: "local" | "remote"): void {
  const st = which === "local" ? local : remote;
  const el = document.getElementById(which === "local" ? "list-local" : "list-remote")!;
  el.textContent = "";
  el.appendChild(virtualRow("..", () => { st.dir = parentOf(st.dir); void refresh(which); }));
  for (const e of st.entries.slice().sort(byDirsThenName)) {
    const row = document.createElement("div");
    row.className = "fe";
    row.innerHTML = `<span class="fn">${e.isDir ? "📁" : "📄"} ${escapeHtml(e.name)}</span><span class="fs">${e.isDir ? "" : fmtSize(e.size)}</span>`;
    row.addEventListener("click", () => {
      st.sel = e;
      el.querySelectorAll(".fe").forEach((n) => n.classList.remove("sel"));
      row.classList.add("sel");
    });
    row.addEventListener("dblclick", () => {
      if (!e.isDir) return;
      st.dir = joinPath(st.dir, e.name);
      void refresh(which);
    });
    el.appendChild(row);
  }
}

function virtualRow(label: string, onClick: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "fe";
  row.innerHTML = `<span class="fn">📂 ${label}</span><span class="fs"></span>`;
  row.addEventListener("dblclick", onClick);
  return row;
}

/* ---------- ops ---------- */

async function opLocal(op: "mkdir" | "rename" | "remove"): Promise<void> {
  try {
    if (op === "mkdir") {
      const name = prompt("New directory name:");
      if (name) await bridge.local.mkdir(joinPath(local.dir, name));
    } else {
      const p = local.sel;
      const rel = p ? joinPath(local.dir, p.name) : null;
      if (!rel) { alert(pick("select something in the left pane first")); return; }
      if (op === "remove") {
        if (!confirm(`Delete local ${p!.name}?`)) return;
        await bridge.local.remove(rel);
      } else {
        const next = prompt("Rename to:", p!.name);
        if (next) await bridge.local.rename(rel, joinPath(local.dir, next));
      }
    }
    await refresh("local");
  } catch (err) { alert(pick(String((err as Error).message ?? err))); }
}

async function opRemote(op: "mkdir" | "rename" | "remove"): Promise<void> {
  if (!session) return;
  try {
    if (op === "mkdir") {
      const name = prompt("New directory name:");
      if (name) await bridge.sftp.mkdir(session.sid, joinPath(remote.dir, name));
    } else {
      const p = remote.sel;
      const rel = p ? joinPath(remote.dir, p.name) : null;
      if (!rel) { alert(pick("select something in the right pane first")); return; }
      if (op === "remove") {
        if (!confirm(`Delete remote ${p!.name}?`)) return;
        await bridge.sftp.remove(session.sid, rel);
      } else {
        const next = prompt("Rename to:", p!.name);
        if (next) await bridge.sftp.rename(session.sid, rel, joinPath(remote.dir, next));
      }
    }
    await refresh("remote");
  } catch (err) { alert(pick(String((err as Error).message ?? err))); }
}

async function doUpload(): Promise<void> {
  if (!session) return;
  const f = local.sel;
  if (!f || f.isDir) { alert(pick("select a FILE in the left pane (directory transfer not supported yet)")); return; }
  const target = joinPath(remote.dir, f.name);
  try { await bridge.sftp.upload(session.sid, joinPath(local.dir, f.name), target); await refresh("remote"); }
  catch (err) { bannerInQueue(pick(String((err as Error).message ?? err))); }
}

async function doDownload(): Promise<void> {
  if (!session) return;
  const f = remote.sel;
  if (!f || f.isDir) { alert(pick("select a FILE in the right pane (directory transfer not supported yet)")); return; }
  const target = joinPath(local.dir, f.name);
  try { await bridge.sftp.download(session.sid, joinPath(remote.dir, f.name), target); await refresh("local"); }
  catch (err) { bannerInQueue(pick(String((err as Error).message ?? err))); }
}

/* ---------- transfer progress ---------- */

function onProgress(p: TransferProgress): void {
  let row = jobEls.get(p.jobId);
  if (!row) {
    row = document.createElement("div");
    row.className = "job";
    row.innerHTML = `<span class="jname">${p.dir === "up" ? "⬆" : "⬇"} ${escapeHtml(p.file)}</span>
      <span class="jbar"><span class="jfill"></span></span><span class="jstat"></span>`;
    queueEl.prepend(row);
    jobEls.set(p.jobId, row);
    while (jobEls.size > 12) {
      const oldest = [...jobEls.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).pop();
      if (!oldest) break;
      oldest[1].remove(); jobEls.delete(oldest[0]);
    }
  }
  const pct = p.total > 0 ? Math.min(100, Math.round((p.bytes / p.total) * 100)) : (p.state === "done" ? 100 : 0);
  (row.querySelector(".jfill")! as HTMLElement).style.width = `${pct}%`;
  const stat = row.querySelector(".jstat")! as HTMLElement;
  if (p.state === "error") {
    row.className = "job err"; stat.textContent = p.error ?? "failed";
  } else if (p.state === "done") {
    row.className = "job done"; stat.textContent = `${fmtSize(p.bytes)} done`;
    setTimeout(() => { row!.remove(); jobEls.delete(p.jobId); }, 4000);
  } else {
    stat.textContent = `${fmtSize(p.bytes)} / ${fmtSize(p.total)}`;
  }
}

function bannerInQueue(text: string): void {
  const row = document.createElement("div");
  row.className = "job err";
  row.innerHTML = `<span class="jname" style="flex:1">${escapeHtml(text)}</span>`;
  queueEl.prepend(row);
  setTimeout(() => row.remove(), 6000);
}

/* ---------- small utils ---------- */

function bindNav(_id: string, inputId: string, go: () => void): void {
  const input = document.getElementById(inputId)! as HTMLInputElement;
  document.getElementById(_id)!.addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
}

function readPath(id: string, fallback: string): string {
  return (document.getElementById(id)! as HTMLInputElement).value.trim() || fallback;
}
function setPath(id: string, v: string): void {
  (document.getElementById(id)! as HTMLInputElement).value = v;
}

function parentOf(dir: string): string {
  if (dir === "~" || dir === "./") return dir === "~" ? "~" : "..";
  if (dir === "." || dir === "..") return "..";
  const trim = dir.replace(/\/+$/, "");
  const cut = trim.lastIndexOf("/");
  return cut <= 0 ? "/" : trim.slice(0, cut);
}

function joinPath(dir: string, name: string): string {
  if (dir === "~") return `~/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

const byDirsThenName = (a: SftpEntry, b: SftpEntry): number =>
  (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1) || a.name.localeCompare(b.name);

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function pick(msg: string): string {
  return msg.replace(/^Error invoking remote method '[^']+',\s*/, "");
}
