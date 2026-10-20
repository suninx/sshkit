import { bridge } from "./hosts";
import type { SftpEntry, TransferProgress } from "../shared/sftp";
import { applyDom, tr } from "../shared/i18n";

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
  /** 切换语言后重新应用文案(表头/列名/空态/错误态) */
  relabel: () => void;
}

type SortKey = "name" | "date" | "size" | "kind";

/* T5:栏间拖拽传输。原版 SFTP 是双栏,拖到对面栏即传输(左→右=上传、右→左=下载)。
   拖拽源放在模块级:HTML5 的 dragstart/drop 分属两个元素,靠它传递"谁被拖了"。 */
let dragSrc: { which: "local" | "remote"; entry: SftpEntry } | null = null;

interface PaneState {
  which: "local" | "remote";
  dir: string;
  entries: SftpEntry[];
  sel: SftpEntry | null;
  filter: string;
  /* T5:排序。原版默认 sortBy=null(即不排序,用目录原顺序)、sortDirection=ASC,且**每栏各自独立**
     (其 store 里 left/right 各有 sorting;动作名 SET_SFTP_SORTING)。列头指示器:ASC 上三角、DESC 下三角,
     只在当前排序列显示。 */
  sortBy: SortKey | null;
  sortDir: "ASC" | "DESC";
  /* T5:多选。sel 仍是"主选中项"(现有下载/删除等按它工作),selSet 是集合。 */
  selSet: Set<string>;
  anchor: string | null;
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
        <span class="sp-pico">${which === "local"
          ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M8 10.5l2.2 2L8 14.5M12.5 14.5H16"/></svg>'
          : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/></svg>'}</span>
        <span class="sp-title">${tr(which === "local" ? "sftp.local" : "sftp.remote")}</span>
        <span style="flex:1"></span>
        <button class="sp-btn" data-act="filter"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg><span data-i18n="sftp.filter">${tr("sftp.filter")}</span></button>
        <button class="sp-btn" data-act="actions"><span data-i18n="sftp.actions">${tr("sftp.actions")}</span> ⌄</button>
      </div>
      <div class="sp-filter" hidden><input placeholder="${tr("sftp.filterBy")}" data-i18n-placeholder="sftp.filterBy" spellcheck="false"></div>
      <div class="sp-crumbs"></div>
      <div class="sp-cols">
        <button class="sp-col sp-cname" data-sort="name" data-i18n="sftp.colName">${tr("sftp.colName")}</button>
        <button class="sp-col sp-cdate" data-sort="date" data-i18n="sftp.colDate">${tr("sftp.colDate")}</button>
        <button class="sp-col sp-csize" data-sort="size" data-i18n="sftp.colSize">${tr("sftp.colSize")}</button>
        <button class="sp-col sp-ckind" data-sort="kind" data-i18n="sftp.colKind">${tr("sftp.colKind")}</button>
      </div>
      <div class="sp-body"><div class="sp-rows"></div></div>`;
    const st: PaneState = {
      which, dir: which === "local" ? "~" : ".", entries: [], sel: null, filter: "", showHidden: false,
      sortBy: null, sortDir: "ASC", selSet: new Set<string>(), anchor: null,
      rowsEl: host.querySelector(".sp-rows")! as HTMLElement,
      crumbsEl: host.querySelector(".sp-crumbs")! as HTMLElement,
      titleEl: host.querySelector(".sp-title")! as HTMLElement,
    };
    // T5:把"对面栏"当放置目标(同栏内拖动不触发传输)
    const bodyEl = host.querySelector(".sp-body")! as HTMLElement;
    bodyEl.addEventListener("dragover", (ev) => {
      if (!dragSrc || dragSrc.which === st.which) return;
      ev.preventDefault();
      bodyEl.classList.add("drop-hot");
    });
    bodyEl.addEventListener("dragleave", () => bodyEl.classList.remove("drop-hot"));
    bodyEl.addEventListener("drop", (ev) => {
      ev.preventDefault();
      bodyEl.classList.remove("drop-hot");
      if (!dragSrc || dragSrc.which === st.which) return;
      void dropTransfer(st, dragSrc);
    });

    const filterBox = host.querySelector(".sp-filter")! as HTMLElement;
    const filterInput = filterBox.querySelector("input")! as HTMLInputElement;
    filterInput.addEventListener("input", () => { st.filter = filterInput.value.trim().toLowerCase(); render(st); });
    host.querySelector('[data-act="filter"]')!.addEventListener("click", () => {
      filterBox.hidden = !filterBox.hidden;
      if (!filterBox.hidden) filterInput.focus();
      else { filterInput.value = ""; st.filter = ""; render(st); }
    });
    host.querySelectorAll<HTMLButtonElement>(".sp-col").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.sort as SortKey;
        if (st.sortBy === key) st.sortDir = st.sortDir === "ASC" ? "DESC" : "ASC";
        else { st.sortBy = key; st.sortDir = "ASC"; }
        render(st);
      });
    });
    // "Select All" / "Clear selection"(文案取自原版字符串;焦点在该栏内时生效)
    host.addEventListener("keydown", (ev) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.key.toLowerCase() !== "a") return;
      ev.preventDefault();
      const shown = visibleEntries(st);
      st.selSet = new Set(shown.map((e) => e.name));
      render(st);
    });
    host.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      st.selSet.clear(); st.sel = null; render(st);
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
        st.titleEl.textContent = tr("sftp.local");
      } else {
        const s = session();
        if (!s) { renderEmpty(st); return; }
        const r = await bridge.sftp.list(s.sid, st.dir);
        st.dir = r.path; st.entries = r.entries; st.sel = null;
        st.titleEl.textContent = s.label;
      }
      render(st);
    } catch (err) {
      const msg = pick(String((err as Error).message ?? err));
      banner(msg);
      /* 远端失败要显示错误态(带原因与 Retry),不能停在"Connect to host"空态 —— 那是"没有会话"的语义。 */
      if (st.which === "remote" && session()) renderError(st, msg);
      else render(st);
    }
  }

  function renderEmpty(st: PaneState): void {
    st.crumbsEl.textContent = "";
    const cols = st.rowsEl.closest(".sftp-pane")?.querySelector(".sp-cols") as HTMLElement | null;
    if (cols) cols.style.display = "none";   // 原版空态不显示列表头
    const body = st.rowsEl.parentElement!;
    /* 注意:这里必须**保留** .sp-rows 容器并在之后重新取回 st.rowsEl。
       之前直接 body.innerHTML = 空态,把 st.rowsEl 所在的容器整个换掉 →
       st.rowsEl 成了游离节点,之后所有 render() 都写进脱离文档的节点,
       面板就永远停在 "Connect to host"(实测:Reload 报通道错误但界面纹丝不动)。 */
    body.innerHTML = `
      <div class="sftp-empty">
        <div class="sp-empty-ico"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#e3e7e9" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg></div>
        <h3>${tr("sftp.emptyTitle")}</h3>
        <p>${tr("sftp.emptyDesc").replace("\n", "<br>")}</p>
        <button class="sp-select">${tr("sftp.emptySelect")}</button>
      </div>
      <div class="sp-rows"></div>`;
    st.rowsEl = body.querySelector(".sp-rows")! as HTMLElement;
    body.querySelector(".sp-select")?.addEventListener("click", (ev) => {
      const list = listSessions();
      if (!list.length) { banner(tr("sftp.noSession")); return; }
      const anchor = ev.currentTarget as HTMLElement;
      menuAt(anchor, list.map((x) => [x.label, () => { bound = x; void refresh(st); }] as [string, () => void]),
        tr("sftp.chooseSession"));
    });
  }

  /** 远端列表失败时的错误态(不要把失败画成"未连接"空态) */
  function renderError(st: PaneState, msg: string): void {
    st.crumbsEl.textContent = "";
    const pane = st.rowsEl.closest(".sftp-pane");
    const cols = pane?.querySelector(".sp-cols") as HTMLElement | null;
    if (cols) cols.style.display = "none";
    const body = st.rowsEl.parentElement!;
    body.innerHTML = `
      <div class="sftp-empty sftp-err">
        <div class="sp-empty-ico"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#e08a8a" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.2v.3"/></svg></div>
        <h3>${tr("sftp.errTitle")}</h3>
        <p></p>
        <button class="sp-select sp-retry">${tr("sftp.errRetry")}</button>
      </div>
      <div class="sp-rows"></div>`;
    st.rowsEl = body.querySelector(".sp-rows")! as HTMLElement;
    const p = body.querySelector("p")!;
    p.textContent = msg;
    body.querySelector(".sp-retry")?.addEventListener("click", () => { void refresh(st); });
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

  /** 过滤 + 排序后的可见条目(sortBy=null 时用"目录优先 + 名称"的自然顺序,与原版默认一致) */
  function visibleEntries(st: PaneState): SftpEntry[] {
    const arr = st.entries
      .filter((e) => (st.showHidden || !e.name.startsWith(".")))
      .filter((e) => !st.filter || e.name.toLowerCase().includes(st.filter));
    const base = (a: SftpEntry, b: SftpEntry): number => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1);
    if (!st.sortBy) return arr.sort((a, b) => base(a, b) || a.name.localeCompare(b.name));
    const key = st.sortBy;
    const cmp = (a: SftpEntry, b: SftpEntry): number => {
      let r = 0;
      if (key === "name") r = a.name.localeCompare(b.name);
      else if (key === "date") r = (a.mtime ?? 0) - (b.mtime ?? 0);
      else if (key === "size") r = (a.isDir ? -1 : a.size) - (b.isDir ? -1 : b.size);
      else r = (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1) || a.name.localeCompare(b.name);
      if (key !== "kind") r = r || a.name.localeCompare(b.name); // 同键值再按名称稳定排序
      return st.sortDir === "ASC" ? r : -r;
    };
    return arr.sort((a, b) => base(a, b) || cmp(a, b));
  }

  function render(st: PaneState): void {
    renderCrumbs(st);
    /* 从"空态/错误态"回到列表:列头要恢复显示,占位块要移除。
       (renderEmpty 会隐藏 .sp-cols,而此前没有任何地方把它恢复回来。) */
    const pane = st.rowsEl.closest(".sftp-pane");
    const cols = pane?.querySelector(".sp-cols") as HTMLElement | null;
    if (cols) cols.style.display = "";
    st.rowsEl.parentElement?.querySelectorAll(".sftp-empty").forEach((n) => n.remove());
    // 列头指示器:仅在当前排序列显示(ASC ▲ / DESC ▼)
    st.rowsEl.parentElement?.parentElement?.querySelectorAll<HTMLButtonElement>(".sp-col").forEach((b) => {
      const on = st.sortBy === b.dataset.sort;
      b.classList.toggle("on", on);
      b.dataset.dir = on ? st.sortDir : "";
    });
    st.rowsEl.textContent = "";
    const list = visibleEntries(st);

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
      row.className = `sp-row${st.selSet.has(e.name) ? " sel" : ""}`;
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
      kd.className = "sp-kind"; kd.textContent = e.isDir ? tr("sftp.kindFolder") : tr("sftp.kindFile");
      row.append(nm, dt, sz, kd);
      // T5:行可拖到对面栏
      row.draggable = true;
      row.addEventListener("dragstart", (ev) => {
        dragSrc = { which: st.which, entry: e };
        ev.dataTransfer?.setData("text/plain", e.name);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        dragSrc = null;
        document.querySelectorAll(".sp-row.dragging").forEach((n) => n.classList.remove("dragging"));
        document.querySelectorAll(".sp-body.drop-hot").forEach((n) => n.classList.remove("drop-hot"));
      });
      row.addEventListener("click", (ev) => {
        const multi = ev.metaKey || ev.ctrlKey;
        const range = ev.shiftKey;
        st.sel = e;
        if (range && st.anchor) {
          const names = list.map((x) => x.name);
          const i = names.indexOf(st.anchor), j = names.indexOf(e.name);
          if (i >= 0 && j >= 0) {
            st.selSet = new Set(names.slice(Math.min(i, j), Math.max(i, j) + 1));
          }
        } else if (multi) {
          if (st.selSet.has(e.name)) st.selSet.delete(e.name); else st.selSet.add(e.name);
          st.anchor = e.name;
        } else {
          st.selSet = new Set([e.name]);
          st.anchor = e.name;
        }
        render(st);
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
    const n = st.selSet.size;
    const items: Array<[string, () => void]> = [
      ["Go up", () => { st.dir = parentOf(st.dir); void refresh(st); }],
      ["New folder", () => void op(st, "mkdir")],
    ];
    if (n > 1) {
      // 多选态:动作作用于全部选中项
      items.push([`Delete ${n} items`, () => void opMany(st, "remove")]);
      items.push(["Clear selection", () => { st.selSet.clear(); st.sel = null; render(st); }]);
    } else {
      items.push(["Rename", () => void op(st, "rename")]);
      items.push(["Delete", () => void op(st, "remove")]);
    }
    items.push([st.showHidden ? "Hide hidden files" : "Show hidden files", () => { st.showHidden = !st.showHidden; render(st); }]);
    if (n > 1) items.push([st.which === "local" ? `Upload ${n} items →` : `← Download ${n} items`, () => void transferMany(st)]);
    else if (st.which === "local") items.push(["Upload →", () => void transfer("up")]);
    else items.push(["← Download", () => void transfer("down")]);
    menuAt(anchor, items);
  }

  /** 批量删除:复用单条逻辑,逐个执行 */
  async function opMany(st: PaneState, kind: "remove"): Promise<void> {
    const s = session();
    if (st.which === "remote" && !s) { banner(tr("sftp.notBound")); return; }
    const targets = st.entries.filter((e) => st.selSet.has(e.name));
    if (!targets.length) return;
    let done = 0;
    for (const t of targets) {
      st.sel = t;
      try {
        if (st.which === "local") await bridge.local.remove(joinPath(st.dir, t.name));
        else await bridge.sftp.remove(s!.sid, joinPath(st.dir, t.name));
        done++;
      } catch { /* 单个失败不打断其余 */ }
    }
    st.selSet.clear(); st.sel = null;
    banner(tr("sftp.deleted", { done, total: targets.length }));
    await refresh(st);
  }

  /** T5:把被拖条目放到本栏 —— 等价于"选中它再点传输",方向按拖拽源决定 */
  async function dropTransfer(target: PaneState, src: { which: "local" | "remote"; entry: SftpEntry }): Promise<void> {
    const from = src.which === "local" ? local : remote;
    from.sel = src.entry;
    from.selSet = new Set([src.entry.name]);
    await transfer(src.which === "local" ? "up" : "down");
    await refresh(target);
    await refresh(from);
  }

  /** 批量传输:逐个走原有的单文件传输 */
  async function transferMany(st: PaneState): Promise<void> {
    const targets = st.entries.filter((e) => st.selSet.has(e.name));
    for (const t of targets) {
      st.sel = t;
      await transfer(st.which === "local" ? "up" : "down");
    }
  }

  async function op(st: PaneState, kind: "mkdir" | "rename" | "remove"): Promise<void> {
    const s = session();
    if (st.which === "remote" && !s) { banner(tr("sftp.notBound")); return; }
    try {
      if (kind === "mkdir") {
        const name = await dialogs().prompt(tr("sftp.newDirTitle"));
        if (name) {
          if (st.which === "local") await bridge.local.mkdir(joinPath(st.dir, name));
          else await bridge.sftp.mkdir(s!.sid, joinPath(st.dir, name));
        }
      } else {
        const p = st.sel;
        if (!p) { banner(tr("sftp.selectItemFirst")); return; }
        const rel = joinPath(st.dir, p.name);
        if (kind === "remove") {
          if (!(await dialogs().confirm(tr("sftp.deleteTitle"), `${p.name}`))) return;
          if (st.which === "local") await bridge.local.remove(rel);
          else await bridge.sftp.remove(s!.sid, rel);
        } else {
          const next = await dialogs().prompt(tr("sftp.renameTitle"), p.name);
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
    if (!s) { banner(tr("sftp.notBound")); return; }
    const from = dir === "up" ? local : remote;
    const to = dir === "up" ? remote : local;
    const f = from.sel;
    if (!f || f.isDir) { banner(tr("sftp.pickFirst")); return; }
    const src = joinPath(from.dir, f.name);
    const dst = joinPath(to.dir, f.name);
    try {
      if (dir === "up") await bridge.sftp.upload(s.sid, src, dst);
      else await bridge.sftp.download(s.sid, src, dst);
      await refresh(to);
    } catch (err) { banner(pick(String((err as Error).message ?? err))); }
  }

  /* ---------- 传输进度 ---------- */


  /* ---- 应用内弹窗:Electron 渲染进程**不支持** window.prompt(返回 null),
          原生 confirm 在 Linux 上还会阻塞渲染进程 —— 统一换成 DOM 弹窗。 ---- */
  function dialogs(): {
    prompt: (title: string, initial?: string) => Promise<string | null>;
    confirm: (title: string, body: string) => Promise<boolean>;
  } {
    const mount = (html: string): HTMLElement => {
      document.querySelectorAll(".prompt-dlg").forEach((n) => n.remove());
      const wrap = document.createElement("div");
      wrap.className = "discard-dlg prompt-dlg";
      wrap.innerHTML = html;
      document.body.append(wrap);
      return wrap;
    };
    return {
      prompt(title, initial = "") {
        return new Promise((resolve) => {
          const wrap = mount(`
            <div class="dd-box" role="dialog" aria-modal="true">
              <div class="dd-head"><span></span><button class="dd-x" aria-label="close">✕</button></div>
              <div class="dd-body">
                <p></p>
                <input class="pd-input" type="text" />
                <div class="pd-actions">
                  <button class="dd-cancel"></button><button class="dd-ok"></button>
                </div>
              </div>
            </div>`);
          wrap.querySelector(".dd-head span")!.textContent = title;
          wrap.querySelector(".dd-body p")!.textContent = title;
          const input = wrap.querySelector(".pd-input") as HTMLInputElement;
          input.value = initial;
          (wrap.querySelector(".dd-cancel") as HTMLButtonElement).textContent = tr("form.cancel");
          (wrap.querySelector(".dd-ok") as HTMLButtonElement).textContent = "OK";
          const done = (v: string | null): void => { wrap.remove(); resolve(v); };
          wrap.querySelector(".dd-x")!.addEventListener("click", () => done(null));
          wrap.querySelector(".dd-cancel")!.addEventListener("click", () => done(null));
          wrap.addEventListener("click", (ev) => { if (ev.target === wrap) done(null); });
          wrap.querySelector(".dd-ok")!.addEventListener("click", () => done(input.value.trim() || null));
          input.addEventListener("keydown", (ev) => {
            if ((ev as KeyboardEvent).key === "Enter") done(input.value.trim() || null);
            if ((ev as KeyboardEvent).key === "Escape") done(null);
          });
          input.focus();
          input.select();
        });
      },
      confirm(title, body) {
        return new Promise((resolve) => {
          const wrap = mount(`
            <div class="dd-box" role="dialog" aria-modal="true">
              <div class="dd-head"><span></span><button class="dd-x" aria-label="close">✕</button></div>
              <div class="dd-body"><p></p>
                <div class="pd-actions"><button class="dd-cancel"></button><button class="dd-ok danger"></button></div>
              </div>
            </div>`);
          wrap.querySelector(".dd-head span")!.textContent = title;
          wrap.querySelector(".dd-body p")!.textContent = body;
          (wrap.querySelector(".dd-cancel") as HTMLButtonElement).textContent = tr("form.cancel");
          (wrap.querySelector(".dd-ok") as HTMLButtonElement).textContent = tr("dlg.delete");
          const done = (v: boolean): void => { wrap.remove(); resolve(v); };
          wrap.querySelector(".dd-x")!.addEventListener("click", () => done(false));
          wrap.querySelector(".dd-cancel")!.addEventListener("click", () => done(false));
          wrap.addEventListener("click", (ev) => { if (ev.target === wrap) done(false); });
          wrap.querySelector(".dd-ok")!.addEventListener("click", () => done(true));
        });
      },
    };
  }

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
    /* 切换语言:静态标记就地重译,再把两栏重画一遍(行内的 Up/Reload 提示与空态文案都在渲染时生成) */
    relabel: () => { applyDom(root); void refresh(local); void refresh(remote); },
  };
}
