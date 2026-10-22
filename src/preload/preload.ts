import { contextBridge, ipcRenderer } from "electron";
import type { HostInput, HostRecord } from "../shared/host";

const api = {
  /* 平台:Windows 的无边框窗口需要渲染层决定"红绿灯让位 / 自绘窗口按钮"这类平台差异
     (sandbox 下的 preload 仍然能拿到 process.platform) */
  platform: process.platform,
  /* terminal pipeline (local pty + ssh share ids, channels, and semantics) */
  createLocal: (opts: { cols: number; rows: number }) => ipcRenderer.invoke("terminal:create", opts),
  write: (id: number, data: string) => ipcRenderer.send("terminal:write", id, data),
  resize: (id: number, cols: number, rows: number) => ipcRenderer.send("terminal:resize", id, cols, rows),
  dispose: (id: number) => ipcRenderer.send("terminal:dispose", id),
  info: () => ipcRenderer.invoke("app:info"),
  settings: {
    getLocale: (): Promise<{ pref: "system" | "zh" | "en"; system: string; effective: "zh" | "en" }> => ipcRenderer.invoke("settings:getLocale"),
    setLocale: (pref: "system" | "zh" | "en"): Promise<{ pref: "system" | "zh" | "en"; system: string; effective: "zh" | "en" }> => ipcRenderer.invoke("settings:setLocale", pref),
  },
  disposeAllSessions: (): void => ipcRenderer.send("sessions:disposeAll"),
  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke("clipboard:read"),
    write: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:write", text),
  },

  /** 主进程菜单「偏好设置(⌘,)」触发:在渲染层打开外观/设置面板 */
  onOpenPrefs: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("prefs:open", handler);
    return () => { ipcRenderer.off("prefs:open", handler); };
  },
  onData: (id: number, callback: (data: string) => void) => {
    const handler = (_e: unknown, terminalId: number, data: string) => { if (terminalId === id) callback(data); };
    ipcRenderer.on("terminal:data", handler);
    return () => { ipcRenderer.off("terminal:data", handler); };
  },
  onExit: (id: number, callback: (info: { exitCode: number; error?: string }) => void) => {
    const handler = (_e: unknown, terminalId: number, info: { exitCode: number; error?: string }) => {
      if (terminalId === id) callback(info);
    };
    ipcRenderer.on("terminal:exit", handler);
    return () => { ipcRenderer.off("terminal:exit", handler); };
  },

  /* host book */
  hosts: {
    list: (): Promise<HostRecord[]> => ipcRenderer.invoke("hosts:list"),
    create: (input: HostInput): Promise<HostRecord> => ipcRenderer.invoke("hosts:create", input),
    update: (id: string, patch: Partial<HostInput>): Promise<HostRecord> => ipcRenderer.invoke("hosts:update", id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("hosts:delete", id),
  },

  /* secrets — write-only (read always throws by design) */
  creds: {
    has: (id: string) => ipcRenderer.invoke("creds:has", id) as Promise<boolean>,
    put: (id: string, secrets: { password?: string; passphrase?: string }): Promise<void> =>
      ipcRenderer.invoke("creds:put", id, secrets),
  },

  ssh: {
    connect: (hostId: string, opts: { cols: number; rows: number }) => ipcRenderer.invoke("ssh:connect", hostId, opts),
  },

  window: {
    create: () => ipcRenderer.invoke("window:new") as Promise<boolean>,
    /* 无边框窗口(frameless)的自绘窗口按钮 */
    minimize: (): void => ipcRenderer.send("window:minimize"),
    toggleMaximize: (): void => ipcRenderer.send("window:toggleMaximize"),
    close: (): void => ipcRenderer.send("window:close"),
    /** 主进程在 maximize/unmaximize 时推状态,用于切换 □ / ❐ 图标 */
    onMaximized: (callback: (maximized: boolean) => void): (() => void) => {
      const handler = (_e: unknown, maximized: boolean): void => callback(maximized);
      ipcRenderer.on("window:maximized", handler);
      return () => { ipcRenderer.off("window:maximized", handler); };
    },
  },
  snippets: {
    list: () => ipcRenderer.invoke("snippets:list") as Promise<Array<{ id: string; name: string; command: string }>>,
    save: (input: { id?: string; name: string; command: string }) => ipcRenderer.invoke("snippets:save", input),
    remove: (id: string) => ipcRenderer.invoke("snippets:remove", id),
  },
  knownhost: {
    list: () => ipcRenderer.invoke("knownhost:list"),
    import: (sourcePath?: string) => ipcRenderer.invoke("knownhost:import", sourcePath) as Promise<{ canceled: boolean; added: number; skipped: number; file?: string; rows?: unknown[] }>,
    remove: (host: string) => ipcRenderer.invoke("knownhost:remove", host),
    answer: (reqId: string, action: string) => ipcRenderer.send("knownhost:answer", reqId, action),
    onAskCancel: (callback: (reqId: string) => void) => {
      const handler = (_e: unknown, reqId: string) => callback(reqId);
      ipcRenderer.on("knownhost:ask-cancel", handler);
      return () => { ipcRenderer.off("knownhost:ask-cancel", handler); };
    },
    onAsk: (callback: (req: unknown) => void) => {
      const handler = (_e: unknown, req: unknown) => callback(req);
      ipcRenderer.on("knownhost:ask", handler);
      return () => { ipcRenderer.off("knownhost:ask", handler); };
    },
  },

  fwd: {
    rules: () => ipcRenderer.invoke("fwd:rules"),
    statuses: () => ipcRenderer.invoke("fwd:statuses"),
    save: (rule: unknown) => ipcRenderer.invoke("fwd:save", rule),
    remove: (id: string) => ipcRenderer.invoke("fwd:delete", id),
    start: (rule: unknown) => ipcRenderer.invoke("fwd:start", rule),
    stop: (id: string) => ipcRenderer.invoke("fwd:stop", id),
    onStatus: (callback: (s: unknown) => void) => {
      const handler = (_e: unknown, s: unknown) => callback(s);
      ipcRenderer.on("fwd:status", handler);
      return () => { ipcRenderer.off("fwd:status", handler); };
    },
  },

  sftp: {
    list: (sid: number, dir: string) => ipcRenderer.invoke("sftp:list", sid, dir),
    mkdir: (sid: number, dir: string) => ipcRenderer.invoke("sftp:mkdir", sid, dir),
    remove: (sid: number, target: string) => ipcRenderer.invoke("sftp:remove", sid, target),
    rename: (sid: number, from: string, to: string) => ipcRenderer.invoke("sftp:rename", sid, from, to),
    upload: (sid: number, localPath: string, remotePath: string) => ipcRenderer.invoke("sftp:upload", sid, localPath, remotePath),
    download: (sid: number, remotePath: string, localPath: string) => ipcRenderer.invoke("sftp:download", sid, remotePath, localPath),
    onProgress: (callback: (p: { sid: number; jobId: number; dir: string; file: string; bytes: number; total: number; state: string; error?: string }) => void) => {
      const handler = (_e: unknown, p: unknown) => callback(p as never);
      ipcRenderer.on("sftp:progress", handler);
      return () => { ipcRenderer.off("sftp:progress", handler); };
    },
  },

  local: {
    list: (dir: string) => ipcRenderer.invoke("local:list", dir),
    mkdir: (dir: string) => ipcRenderer.invoke("local:mkdir", dir),
    remove: (target: string) => ipcRenderer.invoke("local:remove", target),
    rename: (from: string, to: string) => ipcRenderer.invoke("local:rename", from, to),
  },
};

contextBridge.exposeInMainWorld("sshkit", api);
