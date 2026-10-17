import { contextBridge, ipcRenderer } from "electron";
import type { HostInput, HostRecord } from "../shared/host";

const api = {
  /* terminal pipeline (local pty + ssh share ids, channels, and semantics) */
  createLocal: (opts: { cols: number; rows: number }) => ipcRenderer.invoke("terminal:create", opts),
  write: (id: number, data: string) => ipcRenderer.send("terminal:write", id, data),
  resize: (id: number, cols: number, rows: number) => ipcRenderer.send("terminal:resize", id, cols, rows),
  dispose: (id: number) => ipcRenderer.send("terminal:dispose", id),
  info: () => ipcRenderer.invoke("app:info"),
  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke("clipboard:read"),
    write: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:write", text),
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
    put: (id: string, secrets: { password?: string; passphrase?: string }): Promise<void> =>
      ipcRenderer.invoke("creds:put", id, secrets),
  },

  ssh: {
    connect: (hostId: string, opts: { cols: number; rows: number }) => ipcRenderer.invoke("ssh:connect", hostId, opts),
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
