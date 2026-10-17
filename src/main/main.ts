import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { PtyService, type TerminalCreateOptions } from "./pty";

const ptyService = new PtyService();
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 560,
    minHeight: 360,
    backgroundColor: "#101418",
    title: "sshkit",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.on("console-message", (...args: unknown[]) => {
    const ev = args[0] as { message?: string; lineNumber?: number; sourceId?: string } | undefined;
    const legacy = args.slice(1) as [number, string, number | undefined, string | undefined];
    const message = ev?.message ?? legacy[1] ?? "";
    const line = ev?.lineNumber ?? legacy[2];
    const sourceId = ev?.sourceId ?? legacy[3];
    console.log("[renderer]", String(message).replace(/\s+/g, " ").slice(0, 300), sourceId ? `${sourceId}:${line ?? ""}` : "");
  });
  void mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

ipcMain.handle("terminal:create", (event, opts: TerminalCreateOptions) => {
  const id = ptyService.create(event.sender, opts);
  return { id };
});

ipcMain.on("terminal:write", (_event, id: number, data: string) => ptyService.write(id, data));
ipcMain.on("terminal:resize", (_event, id: number, cols: number, rows: number) => ptyService.resize(id, cols, rows));
ipcMain.on("terminal:dispose", (_event, id: number) => ptyService.dispose(id));

ipcMain.handle("app:info", () => ({
  versions: { app: app.getVersion(), electron: process.versions.electron, node: process.versions.node },
}));

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => ptyService.disposeAll());
