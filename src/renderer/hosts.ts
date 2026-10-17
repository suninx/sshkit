import type { HostInput, HostRecord } from "../shared/host";
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
  hosts: {
    list(): Promise<HostRecord[]>;
    create(input: HostInput): Promise<HostRecord>;
    update(id: string, patch: Partial<HostInput>): Promise<HostRecord>;
    remove(id: string): Promise<void>;
  };
  creds: {
    put(id: string, secrets: { password?: string; passphrase?: string }): Promise<void>;
  };
  ssh: {
    connect(hostId: string, opts: { cols: number; rows: number }): Promise<{ id: number }>;
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

export function initHostPanel(onConnect: (host: HostRecord | null) => void): void {
  const listEl = document.getElementById("host-list")!;
  const backdrop = document.getElementById("form-backdrop")!;

  const btnNew = document.getElementById("btn-new-host")! as HTMLButtonElement;
  btnNew.addEventListener("click", () => openForm(null));
  document.getElementById("btn-cancel")!.addEventListener("click", () => backdrop.classList.remove("visible"));
  document.getElementById("form-backdrop")!.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.classList.remove("visible");
  });

  /* T7:搜索与排序。排序项文案取自原版 Sort options 菜单(A-z / Z-a / Newest to oldest / Oldest to newest) */
  type SortMode = "az" | "za" | "newest" | "oldest";
  const SORT_LABEL: Record<SortMode, string> = {
    az: "A-z", za: "Z-a", newest: "Newest to oldest", oldest: "Oldest to newest",
  };
  let sortMode: SortMode = (localStorage.getItem("sshkit.hostSort") as SortMode) || "az";
  let query = "";
  /* T7:按标签过滤(原版工具栏 `Filter by tags`)+ 布局切换(原版 `Change layout` → List / Grid) */
  let tagFilter = new Set<string>();
  let layout: "list" | "grid" = (localStorage.getItem("sshkit.hostLayout") as "list" | "grid") || "list";
  const searchEl = document.getElementById("host-search")! as HTMLInputElement;
  const sortBtn = document.getElementById("host-sort")! as HTMLButtonElement;

  function comparer(): (a: HostRecord, b: HostRecord) => number {
    switch (sortMode) {
      case "za": return (a, b) => b.name.localeCompare(a.name);
      case "newest": return (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      case "oldest": return (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
      default: return (a, b) => a.name.localeCompare(b.name);
    }
  }

  function openSortMenu(): void {
    document.querySelectorAll(".sort-menu").forEach((e) => e.remove());
    const r = sortBtn.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "sort-menu";
    menu.style.left = `${Math.round(r.left - 130)}px`;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
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
  sortBtn.addEventListener("click", (ev) => { ev.stopPropagation(); openSortMenu(); });

  const authSel = document.getElementById("f-auth")! as HTMLSelectElement;
  authSel.addEventListener("change", syncAuthVisibility);
  document.getElementById("host-form")!.addEventListener("submit", onSubmit);

  async function refresh(): Promise<void> {
    const hosts = await bridge.hosts.list();
    listEl.textContent = "";
    listEl.appendChild(renderItem(null));
    if (hosts.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.innerHTML = "No SSH hosts yet.<br>Click ＋ to add one.";
      listEl.appendChild(hint);
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

  function renderItem(host: HostRecord | null): HTMLElement {
    const el = document.createElement("div");
    el.className = "host-item";
    el.dataset.id = host ? host.id : "local";
    const name = host ? host.name : "Local shell";
    const small = host ? `${host.username}@${host.host}` : "⌂ zsh";
    el.innerHTML = `
      <span class="name">${escapeHtml(name)}</span>
      <span class="small">${escapeHtml(small)}</span>
      ${host ? `<button class="btn" data-act="edit" title="edit">✎</button><button class="btn danger" data-act="del" title="delete">✕</button>` : ""}`;
    if (host?.tags?.length) {
      const chips = document.createElement("div");
      chips.className = "tag-chips";
      for (const tag of host.tags) {
        const c = document.createElement("span");
        c.className = "tag-chip";
        const label = document.createElement("span");
        label.textContent = tag;
        /* T7:行内 `Remove tag`(原版字符串)。点✕只去掉这一个标签,不触发整行的连接动作。 */
        const rm = document.createElement("button");
        rm.className = "tag-x";
        rm.textContent = "✕";
        rm.title = "Remove tag";
        rm.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const left = (host.tags ?? []).filter((x) => x !== tag);
          void bridge.hosts.update(host.id, { ...host, tags: left.length ? left : undefined }).then(() => refresh());
        });
        c.append(label, rm);
        chips.append(c);
      }
      el.append(chips);
    }
    el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const act = target.dataset?.act;
      if (act === "edit") { e.stopPropagation(); openForm(host); return; }
      if (act === "del") { e.stopPropagation(); void removeHost(host!); return; }
      onConnect(host);
    });
    return el;
  }

  async function removeHost(host: HostRecord): Promise<void> {
    if (!confirm(`Delete host "${host.name}"? Saved credentials will also be removed.`)) return;
    await bridge.hosts.remove(host.id);
    await refresh();
  }

  function openForm(host: HostRecord | null): void {
    editingHostId = host?.id ?? null;
    (document.getElementById("form-heading")! as HTMLElement).textContent = host ? `Edit ${host.name}` : "New host";
    setVal("f-name", host?.name ?? "");
    setVal("f-group", host?.group ?? "");
    setVal("f-tags", (host?.tags ?? []).join(", "));
    setVal("f-host", host?.host ?? "");
    setVal("f-port", String(host?.port ?? 22));
    setVal("f-username", host?.username ?? "");
    setVal("f-auth", host?.authType ?? "password");
    setVal("f-keypath", host?.keyPath ?? "");
    setVal("f-secret", "");
    document.getElementById("form-error")!.textContent = "";
    syncAuthVisibility();
    backdrop.classList.add("visible");
  }

  function syncAuthVisibility(): void {
    const v = getVal("f-auth");
    const isKey = v === "key", isAgent = v === "agent";
    document.getElementById("f-key-row")!.style.display = isKey ? "block" : "none";
    document.getElementById("f-secret-row")!.style.display = isAgent ? "none" : "block";
    (document.getElementById("f-secret-label")! as HTMLElement).textContent =
      isKey ? "Key passphrase (optional, Keychain)" : "Password (saved in Keychain)";
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
