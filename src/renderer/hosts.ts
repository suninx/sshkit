import type { HostInput, HostRecord } from "../shared/host";
import { applyDom, tr } from "../shared/i18n";
import type { ForwardRule, ForwardStatus } from "../shared/forward";
import type { HostKeyAsk, KnownHostRow } from "../shared/knownhost";
import type { SftpEntry, TransferProgress } from "../shared/sftp";

interface SshkitBridge {
  createLocal(opts: { cols: number; rows: number }): Promise<{ id: number }>;
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  dispose(id: number): void;
  onData(id: number, callback: (data: string) => void): () => void;
  onExit(id: number, callback: (info: { exitCode: number; error?: string; reason?: string }) => void): () => void;
  /** T8:收掉本次界面开的全部会话(reload/关窗时) */
  disposeAllSessions(): void;
  clipboard: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };
  /** 应用级设置(语言):与主进程 settings.json 共用一份 */
  onOpenPrefs?: (callback: () => void) => () => void;
  settings: {
    getLocale(): Promise<{ pref: "system" | "zh" | "en"; system: string; effective: "zh" | "en" }>;
    setLocale(pref: "system" | "zh" | "en"): Promise<{ pref: "system" | "zh" | "en"; system: string; effective: "zh" | "en" }>;
  };
  hosts: {
    list(): Promise<HostRecord[]>;
    create(input: HostInput): Promise<HostRecord>;
    update(id: string, patch: Partial<HostInput>): Promise<HostRecord>;
    remove(id: string): Promise<void>;
  };
  creds: {
    has(hostId: string): Promise<boolean>;
    put(id: string, secrets: { password?: string; passphrase?: string }): Promise<void>;
  };
  ssh: {
    connect(hostId: string, opts: { cols: number; rows: number }): Promise<{ id: number }>;
  };
  window: {
    /** 注意:这里不能叫 new() —— 对象类型里的 new() 是构造签名,会被 TS 当成构造函数。 */
    create(): Promise<boolean>;
  };
  snippets: {
    list(): Promise<Array<{ id: string; name: string; command: string }>>;
    save(input: { id?: string; name: string; command: string }): Promise<{ id: string; name: string; command: string }>;
    remove(id: string): Promise<Array<{ id: string; name: string; command: string }>>;
  };
  knownhost: {
    list(): Promise<KnownHostRow[]>;
    remove(host: string): Promise<KnownHostRow[]>;
    import(sourcePath?: string): Promise<{ canceled: boolean; added: number; skipped: number; file?: string; rows?: unknown[] }>;
    answer(reqId: string, action: "continue" | "add" | "replace" | "cancel"): void;
    onAsk(callback: (req: HostKeyAsk) => void): () => void;
    onAskCancel(callback: (reqId: string) => void): () => void;
  };
  fwd: {
    rules(): Promise<ForwardRule[]>;
    statuses(): Promise<ForwardStatus[]>;
    save(rule: ForwardRule): Promise<ForwardRule>;
    remove(id: string): Promise<ForwardRule[]>;
    start(rule: ForwardRule): Promise<ForwardStatus>;
    stop(id: string): Promise<ForwardStatus>;
    onStatus(callback: (s: ForwardStatus) => void): () => void;
  };
  sftp: {
    list(sid: number, dir: string): Promise<{ path: string; entries: SftpEntry[] }>;
    mkdir(sid: number, dir: string): Promise<void>;
    remove(sid: number, target: string): Promise<void>;
    rename(sid: number, from: string, to: string): Promise<void>;
    upload(sid: number, localPath: string, remotePath: string): Promise<number>;
    download(sid: number, remotePath: string, localPath: string): Promise<number>;
    onProgress(cb: (p: TransferProgress) => void): () => void;
  };
  local: {
    list(dir: string): Promise<{ path: string; entries: SftpEntry[] }>;
    mkdir(dir: string): Promise<void>;
    remove(target: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
  };
}

export const bridge = (window as unknown as { sshkit: SshkitBridge }).sshkit;

export type { SshkitBridge };

/* ---------- host book panel ---------- */

let editingHostId: string | null = null;

export function initHostPanel(onConnect: (host: HostRecord) => void): { refresh: () => Promise<void> } {
  const listEl = document.getElementById("host-list")!;
  const backdrop = document.getElementById("form-backdrop")!;

  const btnNew = document.getElementById("btn-new-host")! as HTMLButtonElement;
  btnNew.addEventListener("click", () => openForm(null));
  /* 原版在关闭"有改动但必填未填完"的表单时会弹确认框(标题/正文/按钮文案取自原版自身)。 */
  /* "有没有改动"必须对照**打开表单时的快照**:新建表单预填了端口 22 等默认值,
     若按"有内容就算脏",用户什么都没输入点取消也会被问"放弃修改"(实测踩到)。 */
  /* id 必须与 index.html 一致:f-username / f-secret / f-keypath —— 之前写成 f-user/f-pass/f-key,
     导致只改用户名/密码/私钥路径时快照不变,取消时静默丢弃输入。 */
  const FORM_FIELDS = ["f-name", "f-group", "f-tags", "f-host", "f-username", "f-port", "f-secret", "f-keypath"];
  let formBaseline = "";

  function formSnapshot(): string {
    return FORM_FIELDS
      .map((id) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "")
      .join("\u0000");
  }

  function formDirty(): boolean {
    return formSnapshot() !== formBaseline;
  }

  function closeForm(force = false): void {
    if (!force && formDirty()) { openDiscardDialog(() => closeForm(true)); return; }
    backdrop.classList.remove("visible");
  }

  document.getElementById("btn-cancel")!.addEventListener("click", () => closeForm());
  document.getElementById("form-backdrop")!.addEventListener("click", (e) => {
    if (e.target === backdrop) closeForm();
  });

  /* T7:搜索与排序。排序项文案取自原版 Sort options 菜单(A-z / Z-a / Newest to oldest / Oldest to newest) */
  type SortMode = "az" | "za" | "newest" | "oldest";
  /* T7:标签颜色与自动补全。
   **诚实标注**:原版里标签颜色的数据形态**取不到**(在 ui-process 的 JS/CSS 里用
   `tag.color`/`colorId`/`"color": <num>`/`ADD_TAG` 等 12 种模式检索均 0 命中),
   所以下面的调色板是**自设计**的,只保证行为合理:按标签名全局配色、可清除、随列表刷新。 */
const TAG_PALETTE = ["#e05252", "#e08b3a", "#d9b53c", "#4caf72", "#3f9fd9", "#7a6ad9", "#c05fa8", "#7f8c99"];

function tagColorMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem("sshkit.tagColors") ?? "{}") as Record<string, string>; }
  catch { return {}; }
}

function tagColor(name: string): string | null {
  return tagColorMap()[name] ?? null;
}

function setTagColor(name: string, color: string | null): void {
  const m = tagColorMap();
  if (color) m[name] = color; else delete m[name];
  localStorage.setItem("sshkit.tagColors", JSON.stringify(m));
}

/** 就地展开的小调色板:点色点后在其下方出现一行色块(避免浮层定位与外部点击那类问题)。 */
function openTagPalette(host: HostRecord, tag: string, after: HTMLElement, refresh: () => void): void {
  after.parentElement?.querySelectorAll(".tag-pal").forEach((e) => e.remove());
  const pal = document.createElement("div");
  pal.className = "tag-pal";
  for (const c of TAG_PALETTE) {
    const sw = document.createElement("button");
    sw.className = `tag-sw${tagColor(tag) === c ? " on" : ""}`;
    sw.style.background = c;
    sw.title = c;
    sw.addEventListener("click", (ev) => { ev.stopPropagation(); setTagColor(tag, c); refresh(); });
    pal.append(sw);
  }
  const clr = document.createElement("button");
  clr.className = "tag-sw clear";
  clr.textContent = "✕";
  clr.title = "No color";
  clr.addEventListener("click", (ev) => { ev.stopPropagation(); setTagColor(tag, null); refresh(); });
  pal.append(clr);
  after.append(pal);
}

const SORT_LABEL: Record<SortMode, string> = {
    az: "A-z", za: "Z-a", newest: "Newest to oldest", oldest: "Oldest to newest",
  };
  let sortMode: SortMode = (localStorage.getItem("sshkit.hostSort") as SortMode) || "az";
  let query = "";
  /* T7:按标签过滤(原版工具栏 `Filter by tags`)+ 布局切换(原版 `Change layout` → List / Grid) */
  let tagFilter = new Set<string>();
  let layout: "list" | "grid" = (localStorage.getItem("sshkit.hostLayout") as "list" | "grid") || "list";
  const searchEl = document.getElementById("host-search")! as HTMLInputElement;

  function comparer(): (a: HostRecord, b: HostRecord) => number {
    switch (sortMode) {
      case "za": return (a, b) => b.name.localeCompare(a.name);
      case "newest": return (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      case "oldest": return (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
      default: return (a, b) => a.name.localeCompare(b.name);
    }
  }

  const tagsBtn = document.getElementById("host-tags")! as HTMLButtonElement;
  const layoutBtn = document.getElementById("host-layout")! as HTMLButtonElement;

  async function openTagMenu(): Promise<void> {
    document.querySelectorAll(".sort-menu").forEach((e) => e.remove());
    const all = new Set<string>();
    for (const h of await bridge.hosts.list()) for (const tg of h.tags ?? []) all.add(tg);
    const r = tagsBtn.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "sort-menu";
    menu.style.left = `${Math.round(r.left - 130)}px`;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    if (!all.size) {
      const empty = document.createElement("div");
      empty.className = "sort-item";
      empty.textContent = "No tags yet";
      menu.append(empty);
    }
    for (const tag of [...all].sort()) {
      const label = document.createElement("label");
      label.className = "sort-item tag-menu-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = tagFilter.has(tag);
      cb.addEventListener("change", () => {
        if (cb.checked) tagFilter.add(tag); else tagFilter.delete(tag);
        tagsBtn.classList.toggle("on", tagFilter.size > 0);
        void refresh();
      });
      const sp = document.createElement("span");
      sp.textContent = tag;
      label.append(cb, sp);
      menu.append(label);
    }
    if (tagFilter.size) {
      const clear = document.createElement("button");
      clear.className = "sort-item";
      clear.textContent = "Clear filters";
      clear.addEventListener("click", () => {
        tagFilter.clear();
        tagsBtn.classList.remove("on");
        menu.remove();
        void refresh();
      });
      menu.append(clear);
    }
    /* 原版工具条右侧只有 3 个图标,所以把「排序」并进这个菜单(筛标签 + 排序同属列表筛选) */
    const sep = document.createElement("div");
    sep.className = "menu-sep";
    menu.append(sep);
    const cap = document.createElement("div");
    cap.className = "menu-cap";
    cap.textContent = "Sort by";
    menu.append(cap);
    for (const mode of Object.keys(SORT_LABEL) as SortMode[]) {
      const item = document.createElement("button");
      item.className = `sort-item${mode === sortMode ? " on" : ""}`;
      item.textContent = SORT_LABEL[mode];
      item.addEventListener("click", () => {
        sortMode = mode;
        localStorage.setItem("sshkit.hostSort", mode);
        menu.remove();
        void refresh();
      });
      menu.append(item);
    }
    document.body.append(menu);
    setTimeout(() => document.addEventListener("click", function once(ev) {
      if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("click", once); }
    }), 0);
  }
  tagsBtn.addEventListener("click", (ev) => { ev.stopPropagation(); void openTagMenu(); });
  layoutBtn.addEventListener("click", () => {
    layout = layout === "list" ? "grid" : "list";
    localStorage.setItem("sshkit.hostLayout", layout);
    applyLayout();
  });
  function applyLayout(): void {
    listEl.classList.toggle("grid", layout === "grid");
    layoutBtn.textContent = layout === "grid" ? "▦" : "▤";
  }
  applyLayout();

  searchEl.addEventListener("input", () => { query = searchEl.value.trim().toLowerCase(); void refresh(); });

  const authSel = document.getElementById("f-auth")! as HTMLSelectElement;
  authSel.addEventListener("change", syncAuthVisibility);
  document.getElementById("host-form")!.addEventListener("submit", onSubmit);

  /** 原版"放弃修改"确认框。几何来自实测:对话框 498 宽、垂直居中;头部 36px 深色;正文白底;
      按钮 `Discard changes` 在正文右下,底色为原版危险色。 */
  /** 通用确认弹窗(与"放弃修改"同一套样式)。
      **不用原生 confirm()**:它在 Linux 上会阻塞渲染进程且无法被自动化/键盘一致处理,
      原版也是自有弹窗 —— 换成 DOM 弹窗后行为跨平台一致,也便于测试走真实用户路径。 */
  function openConfirmDialog(opts: { title: string; body: string; ok: string }): Promise<boolean> {
    return new Promise((resolve) => {
      document.querySelectorAll(".discard-dlg").forEach((e) => e.remove());
      const wrap = document.createElement("div");
      wrap.className = "discard-dlg";
      wrap.innerHTML = `
        <div class="dd-box" role="dialog" aria-modal="true">
          <div class="dd-head"><span></span>
            <button class="dd-x" aria-label="${tr("menu.close")}">✕</button></div>
          <div class="dd-body"><p></p><button class="dd-ok danger"></button></div>
        </div>`;
      /* 用 textContent 写入文案:标题/正文里可能含用户输入(主机名),不能拼 HTML。 */
      wrap.querySelector(".dd-head span")!.textContent = opts.title;
      wrap.querySelector(".dd-body p")!.textContent = opts.body;
      wrap.querySelector(".dd-ok")!.textContent = opts.ok;
      const finish = (v: boolean): void => { wrap.remove(); resolve(v); };
      wrap.querySelector(".dd-x")!.addEventListener("click", () => finish(false));
      wrap.addEventListener("click", (ev) => { if (ev.target === wrap) finish(false); });
      wrap.querySelector(".dd-ok")!.addEventListener("click", () => finish(true));
      document.body.append(wrap);
      (wrap.querySelector(".dd-ok") as HTMLButtonElement | null)?.focus();
    });
  }

  function openDiscardDialog(onConfirm: () => void): void {
    document.querySelectorAll(".discard-dlg").forEach((e) => e.remove());
    const wrap = document.createElement("div");
    wrap.className = "discard-dlg";
    wrap.innerHTML = `
      <div class="dd-box" role="dialog" aria-modal="true">
        <div class="dd-head"><span>${tr("dlg.discardTitle")}</span>
          <button class="dd-x" aria-label="${tr("menu.close")}">✕</button></div>
        <div class="dd-body">
          <p>${tr("dlg.discardDesc")}</p>
          <button class="dd-ok">${tr("dlg.discard")}</button>
        </div>
      </div>`;
    const close = (): void => wrap.remove();
    wrap.querySelector(".dd-x")!.addEventListener("click", close);
    wrap.addEventListener("click", (ev) => { if (ev.target === wrap) close(); });
    wrap.querySelector(".dd-ok")!.addEventListener("click", () => { close(); onConfirm(); });
    document.body.append(wrap);
  }

  async function refresh(): Promise<void> {
    const hosts = await bridge.hosts.list();
    listEl.textContent = "";
    if (hosts.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      /* 与原版一致:空态是**居中的创建卡片**(图标 / 标题 / 说明 / 地址输入 / Continue 按钮),
         不是一行提示文字。输入框里的地址会带进新建表单的 Address。
         文案走 data-i18n + applyDom:这是已在用的翻译机制,首次渲染即翻译,切语言时也会重刷。 */
      const card = document.createElement("div");
      card.className = "hosts-empty";
      card.innerHTML = `
        <div class="he-inner">
          <span class="he-ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7.5" cy="7.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="7.5" cy="16.5" r="1.1" fill="currentColor" stroke="none"/></svg></span>
          <div class="he-title" data-i18n="hosts.emptyTitle"></div>
          <div class="he-sub" data-i18n="hosts.emptyHint"></div>
          <input class="he-addr" data-i18n-placeholder="hosts.emptyAddrPlaceholder" />
          <button class="he-cta" data-i18n="hosts.emptyCta"></button>
        </div>`;
      applyDom(card);
      const addrEl = card.querySelector(".he-addr") as HTMLInputElement;
      const goNew = (): void => {
        openForm(null);
        const addr = addrEl.value.trim();
        if (addr) setVal("f-host", addr);
      };
      card.querySelector(".he-cta")!.addEventListener("click", goNew);
      addrEl.addEventListener("keydown", (e) => { if (e.key === "Enter") goNew(); });
      listEl.appendChild(card);
      return;
    }
    // T7:先按搜索词过滤(名称 / 主机名 / 用户名),再按所选方式排序
    const shown0 = query
      ? hosts.filter((h) =>
          h.name.toLowerCase().includes(query) ||
          h.host.toLowerCase().includes(query) ||
          h.username.toLowerCase().includes(query))
      : hosts;
    const shown = tagFilter.size ? shown0.filter((h) => (h.tags ?? []).some((x) => tagFilter.has(x))) : shown0;
    if (!shown.length) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "No hosts match your search.";
      listEl.appendChild(hint);
      return;
    }
    const byGroup = new Map<string, HostRecord[]>();
    for (const h of shown) {
      const g = h.group || "hosts";
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(h);
    }
    for (const [group, raw] of Array.from(byGroup).sort((a, b) => a[0].localeCompare(b[0]))) {
      const items = [...raw].sort(comparer());
      const label = document.createElement("div");
      label.className = "group-label";
      label.textContent = group;
      listEl.appendChild(label);
      for (const host of items) listEl.appendChild(renderItem(host));
    }
  }

  /* 主机列表只渲染真实的 HostRecord(没有 "Local shell" 伪条目,本地终端从工具条打开),
     所以不带 null 分支。 */
  function renderItem(host: HostRecord): HTMLElement {
    const el = document.createElement("div");
    el.className = "host-item";
    el.dataset.id = host.id;
    const name = host.name;
    /* 原版副标题格式是「类型, 用户名」(如 `ssh, root`),不是 user@host */
    const small = `ssh, ${host.username}`;
    el.innerHTML = `
      <span class="hico"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7.5" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="7.5" cy="16.5" r="1" fill="currentColor" stroke="none"/></svg></span>
      <span class="hcol"><span class="name">${escapeHtml(name)}</span>
      <span class="small">${escapeHtml(small)}</span></span>
      <button class="btn" data-act="edit" title="edit">✎</button><button class="btn danger" data-act="del" title="delete">✕</button>`;
    const tags = host.tags ?? [];
    if (tags.length) {
      const chips = document.createElement("div");
      chips.className = "tag-chips";
      /* 只放第一枚,其余收进 `+N`(见下);单行不换行,永不出现半截芯片 */
      const MAX_VISIBLE = 1;
      for (const tag of tags.slice(0, MAX_VISIBLE)) {
        const c = document.createElement("span");
        c.className = "tag-chip";
        const col = tagColor(tag);
        if (col) { c.style.background = `${col}2e`; c.style.borderColor = `${col}88`; }
        const dot = document.createElement("button");
        dot.className = "tag-dot";
        dot.style.background = col ?? "transparent";
        dot.title = "Tag color";
        dot.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openTagPalette(host, tag, c, refresh);
        });
        const label = document.createElement("span");
        label.textContent = tag;
        /* T7:行内 `Remove tag`(原版字符串)。点✕只去掉这一个标签,不触发整行的连接动作。 */
        const rm = document.createElement("button");
        rm.className = "tag-x";
        rm.textContent = "✕";
        rm.title = "Remove tag";
        rm.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const left = tags.filter((x) => x !== tag);
          void bridge.hosts.update(host.id, { ...host, tags: left.length ? left : undefined }).then(() => refresh());
        });
        c.append(dot, label, rm);
        chips.append(c);
      }
      if (tags.length > MAX_VISIBLE) {
        /* 卡片右侧空间有限:多余的标签收进 `+N`(悬停 title 列出全部),避免出现被裁半截的芯片 */
        const more = document.createElement("span");
        more.className = "tag-chip tag-more";
        more.textContent = `+${tags.length - MAX_VISIBLE}`;
        more.title = tags.join(", ");
        chips.append(more);
      }
      el.append(chips);
    }
    el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const act = target.dataset?.act;
      if (act === "edit") { e.stopPropagation(); openForm(host); return; }
      if (act === "del") { e.stopPropagation(); void removeHost(host); return; }
      onConnect(host);
    });
    return el;
  }

  async function removeHost(host: HostRecord): Promise<void> {
    const ok = await openConfirmDialog({
      title: tr("dlg.deleteHostTitle"),
      body: tr("dlg.deleteHostDesc", { name: host.name }),
      ok: tr("dlg.delete"),
    });
    if (!ok) return;
    await bridge.hosts.remove(host.id);
    await refresh();
  }

  function openForm(host: HostRecord | null): void {
    editingHostId = host?.id ?? null;
    (document.getElementById("form-heading")! as HTMLElement).textContent = host ? tr("form.editHost", { name: host.name }) : tr("form.newHost");
    setVal("f-name", host?.name ?? "");
    setVal("f-group", host?.group ?? "");
    setVal("f-tags", (host?.tags ?? []).join(", "));
    /* T7 自动补全:把全部已用过的标签喂给 datalist(标准 <input list=…> 行为,无需自绘浮层) */
    void bridge.hosts.list().then((all) => {
      const dl = document.getElementById("tag-suggest") ?? (() => {
        const d = document.createElement("datalist");
        d.id = "tag-suggest";
        document.body.append(d);
        return d;
      })();
      const names = [...new Set(all.flatMap((h) => h.tags ?? []))].sort();
      dl.replaceChildren(...names.map((n) => {
        const o = document.createElement("option");
        o.value = n;
        return o;
      }));
      /* #f-tags 是 index.html 里固定存在的输入框(openForm 在更早的 setVal 里已假定它在) */
      document.getElementById("f-tags")!.setAttribute("list", "tag-suggest");
    });
    setVal("f-host", host?.host ?? "");
    setVal("f-port", String(host?.port ?? 22));
    setVal("f-username", host?.username ?? "");
    setVal("f-auth", host?.authType ?? "password");
    setVal("f-keypath", host?.keyPath ?? "");
    setVal("f-secret", "");
    document.getElementById("form-error")!.textContent = "";
    syncAuthVisibility();
    formBaseline = formSnapshot();   // 以"刚打开"的状态为基线,之后才谈得上改动
    backdrop.classList.add("visible");
  }

  function syncAuthVisibility(): void {
    const v = getVal("f-auth");
    const isKey = v === "key", isAgent = v === "agent";
    document.getElementById("f-key-row")!.style.display = isKey ? "block" : "none";
    document.getElementById("f-secret-row")!.style.display = isAgent ? "none" : "block";
    (document.getElementById("f-secret-label")! as HTMLElement).textContent =
      isKey ? tr("form.keyPassphrase") : tr("form.passwordSaved");
  }

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const errEl = document.getElementById("form-error")!;
    try {
      const input: HostInput = {
        name: getVal("f-name"),
        group: getVal("f-group") || undefined,
        tags: getVal("f-tags") ? getVal("f-tags").split(",").map((x) => x.trim()).filter(Boolean) : undefined,
        host: getVal("f-host"),
        port: Number(getVal("f-port") || 22),
        username: getVal("f-username"),
        authType: getVal("f-auth") as HostInput["authType"],
        keyPath: getVal("f-auth") === "key" ? getVal("f-keypath") : undefined,
      };
      const secret = getVal("f-secret");
      const saved = editingHostId
        ? await bridge.hosts.update(editingHostId, input)
        : await bridge.hosts.create(input);
      if (secret && input.authType !== "agent") {
        await bridge.creds.put(saved.id, input.authType === "key" ? { passphrase: secret } : { password: secret });
      }
      editingHostId = null;
      document.getElementById("form-backdrop")!.classList.remove("visible");
      await refresh();
    } catch (err) {
      errEl.textContent = String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+',\s*/, "");
    }
  }

  void refresh();

  /* 语言/主题变化后要能重建:面板里的空态文案是渲染时定死的,不重建会停在旧语言 */
  return { refresh };
}

export function markActiveHost(hostId: string | null): void {
  document.querySelectorAll(".host-item").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.id === hostId);
  });
}

function getVal(id: string): string {
  return (document.getElementById(id)! as HTMLInputElement).value;
}
function setVal(id: string, v: string): void {
  (document.getElementById(id)! as HTMLInputElement).value = v;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
