import { bridge } from "./hosts";
import type { SftpEntry, TransferProgress } from "../shared/sftp";

/* T5 复刻 —— SFTP 作为**一个 tab**,栏内是左右双栏(Local | 远端)。
   原版实测的结构与尺寸(与主题无关的部分照抄):
     栏标题 14px/450、面包屑 14px/450、列头 12px/700(y=164,高 18)、
     行两行式(文件名 + 权限串 10px)、行距 47、列 x 偏移(相对栏)20/299/450/551、
     栏间 1px 分隔线;远端未绑会话时显示 "Connect to host" + "Select host" 空态(18px/500)。
   原版那些**颜色**是在其浅色 UI 下测的(分隔 #e6ebed、权限字 #798c94),
   我方是深色 UI,故颜色映射到本应用主题变量,尺寸与结构照抄 —— 见 bench/FINDINGS.md F15。 */

export interface CurrentSession {
  sid: number;
  label: string;
}

export interface SftpView {
  el: HTMLElement;
  /** tab 被激活时调用:按当前会话刷新两侧 */
  onShow: () => void;
}

interface PaneState {
  which: "local" | "remote";
  dir: string;
  entries: SftpEntry[];
  sel: SftpEntry | null;
  filter: string;
  /** 原版默认不显示隐藏文件(其本地栏以 ".." 开头,随后直接是 Applications/Desktop…),故默认关闭 */
  showHidden: boolean;
  rowsEl: HTMLElement;
  crumbsEl: HTMLElement;
  titleEl: HTMLElement;
}

const PERM_BITS = ["r", "w", "x"];

/** st_mode → `drwxr-xr-x`(原版本地文件还会带 @ 表示扩展属性,此处不含) */
function permString(mode: number, isDir: boolean): string {
  let s = isDir ? "d" : "-";
  for (let g = 2; g >= 0; g--) {
    const m = (mode >> (g * 3)) & 0o7;
    for (let b = 2; b >= 0; b--) s += m & (1 << b) ? PERM_BITS[2 - b] : "-";
  }
  return s;
}

/** 原版日期形如 `8/14/2026, 12:43 AM` */
function fmtDate(sec: number): string {
  if (!sec) return "-";
  const d = new Date(sec * 1000);
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}, ${h}:${String(d.getMinutes()).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function joinPath(dir: string, name: string): string {
  if (dir === "~") return `~/${name}`;
  if (dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function parentOf(dir: string): string {
  if (dir === "~") return "~";
  if (dir === "." || dir === "..") return "..";
  const trim = dir.replace(/\/+$/, "");
  const cut = trim.lastIndexOf("/");
  return cut <= 0 ? "/" : trim.slice(0, cut);
}

const pick = (msg: string): string => msg.replace(/^Error invoking remote method '[^']+',\s*/, "");
const byDirsThenName = (a: SftpEntry, b: SftpEntry): number =>
  (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1) || a.name.localeCompare(b.name);

export function createSftpView(
  getSession: () => CurrentSession | null,
  listSessions: () => CurrentSession[] = () => [],
): SftpView {
  /* SFTP tab 自身没有会话,故:优先用显式绑定的会话,否则用"最近活动会话"。
     这与原版一致 —— 原版 SFTP 也是独立 tab,未绑定时显示 Connect to host / Select host。 */
  let bound: CurrentSession | null = null;
  const session = (): CurrentSession | null => bound ?? getSession();
  const root = document.createElement("div");
  root.className = "sftp";
  root.innerHTML = `
    <div class="sftp-pane" data-which="local"></div>
    <div class="sftp-pane" data-which="remote"></div>
    <div class="sftp-queue"></div>`;
  const queueEl = root.querySelector(".sftp-queue")! as HTMLElement;

  const mkPane = (which: "local" | "remote", title: string): PaneState => {
    const host = root.querySelector(`.sftp-pane[data-which="${which}"]`)! as HTMLElement;
    host.innerHTML = `
      <div class="sp-head">
        <span class="sp-title">${title}</span>
        <span style="flex:1"></span>
        <button class="sp-btn" data-act="filter">🔍 Filter</button>
        <button class="sp-btn" data-act="actions">Actions ⌄</button>
      </div>
      <div class="sp-filter" hidden><input placeholder="Filter by name" spellcheck="false"></div>
      <div class="sp-crumbs"></div>
      <div class="sp-cols">
        <span class="sp-cname">Name</span><span class="sp-cdate">Date Modified</span>
        <span class="sp-csize">Size</span><span class="sp-ckind">Kind</span>
      </div>
      <div class="sp-body"><div class="sp-rows"></div></div>`;
    const st: PaneState = {
      which, dir: which === "local" ? "~" : ".", entries: [], sel: null, filter: "", showHidden: false,
      rowsEl: host.querySelector(".sp-rows")! as HTMLElement,
      crumbsEl: host.querySelector(".sp-crumbs")! as HTMLElement,
      titleEl: host.querySelector(".sp-title")! as HTMLElement,
    };
    const filterBox = host.querySelector(".sp-filter")! as HTMLElement;
    const filterInput = filterBox.querySelector("input")! as HTMLInputElement;
    filterInput.addEventListener("input", () => { st.filter = filterInput.value.trim().toLowerCase(); render(st); });
    host.querySelector('[data-act="filter"]')!.addEventListener("click", () => {
      filterBox.hidden = !filterBox.hidden;
      if (!filterBox.hidden) filterInput.focus();
      else { filterInput.value = ""; st.filter = ""; render(st); }
    });
    host.querySelector('[data-act="actions"]')!.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openActions(st, ev.currentTarget as HTMLElement);
    });
    return st;
  };

  const local = mkPane("local", "Local");
  const remote = mkPane("remote", "Remote");

  /* ---------- listing ---------- */

  async function refresh(st: PaneState): Promise<void> {
    try {
      if (st.which === "local") {
        const r = await bridge.local.list(st.dir);
        st.dir = r.path; st.entries = r.entries; st.sel = null;
        st.titleEl.textContent = "Local";
      } else {
        const s = session();
        if (!s) { renderEmpty(st); return; }
        const r = await bridge.sftp.list(s.sid, st.dir);
        st.dir = r.path; st.entries = r.entries; st.sel = null;
        st.titleEl.textContent = s.label;
      }
      render(st);
    } catch (err) {
      banner(pick(String((err as Error).message ?? err)));
      render(st);
    }
  }

  function renderEmpty(st: PaneState): void {
    st.crumbsEl.textContent = "";
    const body = st.rowsEl.parentElement!;
    body.innerHTML = `
      <div class="sftp-empty">
        <div class="sp-empty-ico">🗂</div>
        <h3>Connect to host</h3>
        <p>Start by connecting to a saved host<br>to manage your files with SFTP.</p>
        <button class="sp-select">Select host</button>
      </div>`;
    body.querySelector(".sp-select")?.addEventListener("click", (ev) => {
      const list = listSessions();
      if (!list.length) { banner("还没有可用会话:先从左侧主机列表连接一台主机"); return; }
      const anchor = ev.currentTarget as HTMLElement;
      menuAt(anchor, list.map((x) => [x.label, () => { bound = x; void refresh(st); }] as [string, () => void]),
        "选择要绑定的会话");
    });
  }

  function renderCrumbs(st: PaneState): void {
    st.crumbsEl.textContent = "";
    const back = document.createElement("button");
    back.className = "sp-arrow"; back.textContent = "‹"; back.title = "Up";
    back.addEventListener("click", () => { st.dir = parentOf(st.dir); void refresh(st); });
    const fwd = document.createElement("button");
    fwd.className = "sp-arrow"; fwd.textContent = "›"; fwd.title = "Reload";
    fwd.addEventListener("click", () => void refresh(st));
    st.crumbsEl.append(back, fwd);

    const sep = st.which === "local" ? "/" : "/";
    const parts = st.dir.split(sep).filter((p) => p.length > 0);
    let acc = st.dir.startsWith("/") ? "" : "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : (st.dir.startsWith("/") ? `/${p}` : p);
      const seg = document.createElement("span");
      seg.className = "seg";
      seg.innerHTML = `<span class="seg-ico"></span>${p}`;
      const target = acc;
      seg.addEventListener("click", () => { st.dir = target; void refresh(st); });
      st.crumbsEl.append(seg);
    }
  }

  function render(st: PaneState): void {
    renderCrumbs(st);
    st.rowsEl.textContent = "";
    const list = st.entries
      .slice()
      .sort(byDirsThenName)
      .filter((e) => (st.showHidden || !e.name.startsWith(".")))
      .filter((e) => !st.filter || e.name.toLowerCase().includes(st.filter));

    // 原版每栏首行是 ".."(点击即回上级)
    if (!st.filter && st.dir !== "/" && !(st.which === "local" && st.dir === "~")) {
      const up = document.createElement("div");
      up.className = "sp-row up";
      const nm = document.createElement("span");
      nm.className = "sp-name";
      nm.innerHTML = `<span class="sp-ico dir"></span><span class="sp-label"><span class="nm">..</span><span class="pm"></span></span>`;
      up.append(nm, document.createElement("span"), document.createElement("span"), document.createElement("span"));
      up.addEventListener("click", () => { st.dir = parentOf(st.dir); void refresh(st); });
      st.rowsEl.append(up);
    }

    for (const e of list) {
      const row = document.createElement("div");
      row.className = "sp-row";
      const nm = document.createElement("span");
      nm.className = "sp-name";
      nm.innerHTML = `<span class="sp-ico ${e.isDir ? "dir" : "file"}"></span>
        <span class="sp-label"><span class="nm"></span><span class="pm"></span></span>`;
      (nm.querySelector(".nm")! as HTMLElement).textContent = e.name;
      (nm.querySelector(".pm")! as HTMLElement).textContent = permString(e.mode ?? 0, e.isDir);
      const dt = document.createElement("span");
      dt.className = "sp-date"; dt.textContent = fmtDate(e.mtime);
      const sz = document.createElement("span");
      sz.className = "sp-size"; sz.textContent = e.isDir ? "-" : fmtSize(e.size);
      const kd = document.createElement("span");
      kd.className = "sp-kind"; kd.textContent = e.isDir ? "folder" : "file";
      row.append(nm, dt, sz, kd);
      row.addEventListener("click", () => {
        st.sel = e;
        st.rowsEl.querySelectorAll(".sp-row").forEach((n) => n.classList.remove("sel"));
        row.classList.add("sel");
      });
      row.addEventListener("dblclick", () => {
        if (!e.isDir) return;
        st.dir = joinPath(st.dir, e.name);
        void refresh(st);
      });
      st.rowsEl.append(row);
    }
  }

  /* ---------- Actions 菜单(把原有操作收进原版的 IA) ---------- */

  function menuAt(anchor: HTMLElement, items: Array<[string, () => void]>, title?: string): void {
    document.querySelectorAll(".sp-menu").forEach((n) => n.remove());
    const menu = document.createElement("div");
    menu.className = "sp-menu";
    if (title) {
      const h = document.createElement("div");
      h.className = "sp-menu-title"; h.textContent = title;
      menu.append(h);
    }
    for (const [label, fn] of items) {
      const b = document.createElement("button");
      b.className = "sp-menu-item";
      b.textContent = label;
      b.addEventListener("click", () => { menu.remove(); fn(); });
      menu.append(b);
    }
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    document.body.append(menu);
    setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
  }

  function openActions(st: PaneState, anchor: HTMLElement): void {
    const items: Array<[string, () => void]> = [
      ["Go up", () => { st.dir = parentOf(st.dir); void refresh(st); }],
      ["New folder", () => void op(st, "mkdir")],
      ["Rename", () => void op(st, "rename")],
      ["Delete", () => void op(st, "remove")],
      [st.showHidden ? "Hide hidden files" : "Show hidden files", () => { st.showHidden = !st.showHidden; render(st); }],
    ];
    if (st.which === "local") items.push(["Upload →", () => void transfer("up")]);
    else items.push(["← Download", () => void transfer("down")]);
    menuAt(anchor, items);
  }

  async function op(st: PaneState, kind: "mkdir" | "rename" | "remove"): Promise<void> {
    const s = session();
    if (st.which === "remote" && !s) { banner("远端未绑定会话"); return; }
    try {
      if (kind === "mkdir") {
        const name = prompt("New directory name:");
        if (name) {
          if (st.which === "local") await bridge.local.mkdir(joinPath(st.dir, name));
          else await bridge.sftp.mkdir(s!.sid, joinPath(st.dir, name));
        }
      } else {
        const p = st.sel;
        if (!p) { banner(`先在${st.which === "local" ? "左" : "右"}栏选中一项`); return; }
        const rel = joinPath(st.dir, p.name);
        if (kind === "remove") {
          if (!confirm(`Delete ${st.which} ${p.name}?`)) return;
          if (st.which === "local") await bridge.local.remove(rel);
          else await bridge.sftp.remove(s!.sid, rel);
        } else {
          const next = prompt("Rename to:", p.name);
          if (!next) return;
          if (st.which === "local") await bridge.local.rename(rel, joinPath(st.dir, next));
          else await bridge.sftp.rename(s!.sid, rel, joinPath(st.dir, next));
        }
      }
      await refresh(st);
    } catch (err) { banner(pick(String((err as Error).message ?? err))); }
  }

  async function transfer(dir: "up" | "down"): Promise<void> {
    const s = session();
    if (!s) { banner("远端未绑定会话"); return; }
    const from = dir === "up" ? local : remote;
    const to = dir === "up" ? remote : local;
    const f = from.sel;
    if (!f || f.isDir) { banner("先选中一个文件(暂不支持目录传输)"); return; }
    const src = joinPath(from.dir, f.name);
    const dst = joinPath(to.dir, f.name);
    try {
      if (dir === "up") await bridge.sftp.upload(s.sid, src, dst);
      else await bridge.sftp.download(s.sid, src, dst);
      await refresh(to);
    } catch (err) { banner(pick(String((err as Error).message ?? err))); }
  }

  /* ---------- 传输进度 ---------- */

  const jobEls = new Map<number, HTMLElement>();
  bridge.sftp.onProgress((p: TransferProgress) => {
    let row = jobEls.get(p.jobId);
    if (!row) {
      row = document.createElement("div");
      row.className = "job";
      row.innerHTML = `<span class="jname"></span><span class="jbar"><span class="jfill"></span></span><span class="jstat"></span>`;
      (row.querySelector(".jname")! as HTMLElement).textContent = `${p.dir === "up" ? "⬆" : "⬇"} ${p.file}`;
      queueEl.prepend(row);
      jobEls.set(p.jobId, row);
      while (jobEls.size > 8) {
        const oldest = [...jobEls.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).pop();
        if (!oldest) break;
        oldest[1].remove(); jobEls.delete(oldest[0]);
      }
    }
    const pct = p.total > 0 ? Math.min(100, Math.round((p.bytes / p.total) * 100)) : (p.state === "done" ? 100 : 0);
    (row.querySelector(".jfill")! as HTMLElement).style.width = `${pct}%`;
    const stat = row.querySelector(".jstat")! as HTMLElement;
    if (p.state === "error") { row.className = "job err"; stat.textContent = p.error ?? "failed"; }
    else if (p.state === "done") {
      row.className = "job done"; stat.textContent = `${fmtSize(p.bytes)} done`;
      setTimeout(() => { row!.remove(); jobEls.delete(p.jobId); }, 4000);
    } else stat.textContent = `${fmtSize(p.bytes)} / ${fmtSize(p.total)}`;
  });

  function banner(text: string): void {
    const row = document.createElement("div");
    row.className = "job err";
    const s = document.createElement("span");
    s.className = "jname"; s.style.flex = "1"; s.textContent = text;
    row.append(s);
    queueEl.prepend(row);
    setTimeout(() => row.remove(), 6000);
  }

  return {
    el: root,
    onShow: () => { void refresh(local); void refresh(remote); },
  };
}
