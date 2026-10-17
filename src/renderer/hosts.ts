import type { HostInput, HostRecord } from "../shared/host";
import type { SftpEntry, TransferProgress } from "../shared/sftp";

interface SshkitBridge {
  createLocal(opts: { cols: number; rows: number }): Promise<{ id: number }>;
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  dispose(id: number): void;
  onData(id: number, callback: (data: string) => void): () => void;
  onExit(id: number, callback: (info: { exitCode: number; error?: string }) => void): () => void;
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
    const byGroup = new Map<string, HostRecord[]>();
    for (const h of hosts) {
      const g = h.group || "hosts";
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(h);
    }
    for (const [group, items] of Array.from(byGroup).sort((a, b) => a[0].localeCompare(b[0]))) {
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
