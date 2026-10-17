import { contextBridge, ipcRenderer } from "electron";

const api = {
  create: (opts: { cols: number; rows: number; cwd?: string }) => ipcRenderer.invoke("terminal:create", opts),
  write: (id: number, data: string) => ipcRenderer.send("terminal:write", id, data),
  resize: (id: number, cols: number, rows: number) => ipcRenderer.send("terminal:resize", id, cols, rows),
  dispose: (id: number) => ipcRenderer.send("terminal:dispose", id),
  info: () => ipcRenderer.invoke("app:info"),

  onData: (id: number, callback: (data: string) => void) => {
    const handler = (_event: unknown, terminalId: number, data: string) => {
      if (terminalId === id) callback(data);
    };
    ipcRenderer.on("terminal:data", handler);
    return () => { ipcRenderer.off("terminal:data", handler); };
  },

  onExit: (id: number, callback: (info: { exitCode: number }) => void) => {
    const handler = (_event: unknown, terminalId: number, info: { exitCode: number }) => {
      if (terminalId === id) callback(info);
    };
    ipcRenderer.on("terminal:exit", handler);
    return () => { ipcRenderer.off("terminal:exit", handler); };
  },
};

contextBridge.exposeInMainWorld("sshkit", api);
