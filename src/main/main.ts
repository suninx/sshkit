import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { PtyService, type TerminalCreateOptions } from "./pty";
import { HostStore } from "./store";
import { SshService } from "./ssh";
import { SftpController } from "./sftp";
import { deleteCreds, getCreds, putCreds } from "./keystore";
import type { HostInput } from "../shared/host";

const hostStore = new HostStore(app.getPath("userData"));
const ptyService = new PtyService();
const sshService = new SshService();
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 720,
    minHeight: 460,
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

/* ---------- local terminal ---------- */

ipcMain.handle("terminal:create", (event, opts: TerminalCreateOptions) => ({ id: ptyService.create(event.sender, opts) }));
ipcMain.on("terminal:write", (_e, id: number, data: string) => { ptyService.write(id, data); sshService.write(id, data); });
ipcMain.on("terminal:resize", (_e, id: number, cols: number, rows: number) => {
  ptyService.resize(id, cols, rows);
  sshService.resize(id, cols, rows);
});
ipcMain.on("terminal:dispose", (_e, id: number) => { ptyService.dispose(id); sshService.dispose(id); });

/* ---------- host book ---------- */

ipcMain.handle("hosts:list", () => hostStore.list());
ipcMain.handle("hosts:create", (_e, input: HostInput) => hostStore.create(input));
ipcMain.handle("hosts:update", (_e, id: string, patch: Partial<HostInput>) => hostStore.update(id, patch));
ipcMain.handle("hosts:delete", (_e, id: string) => {
  hostStore.remove(id);
  return deleteCreds(id);
});

/* ---------- credentials (write-only from renderer) ---------- */

ipcMain.handle("creds:put", (_e, id: string, secrets: { password?: string; passphrase?: string }) => {
  if (!hostStore.get(id)) throw new Error(`unknown host id: ${id}`);
  return putCreds(id, secrets);
});

/* ---------- ssh connect ---------- */

ipcMain.handle("ssh:connect", async (event, hostId: string, opts: { cols: number; rows: number }) => {
  const host = hostStore.get(hostId);
  if (!host) throw new Error(`unknown host id: ${hostId}`);
  const secrets = host.authType === "password" || host.authType === "key" ? await getCreds(hostId) : {};
  const id = await sshService.connect(event.sender, host, secrets, opts);
  return { id };
});

ipcMain.handle("app:info", () => ({
  versions: { app: app.getVersion(), electron: process.versions.electron, node: process.versions.node },
}));

/* ---------- SFTP (remote side rides the active ssh session) + local fs ---------- */

const sftpController = new SftpController(
  (sid) => sshService.clientOf(sid),
  (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sftp:progress", progress);
  },
);

ipcMain.handle("sftp:list", (_e, sid: number, dir: string) => sftpController.listRemote(sid, dir));
ipcMain.handle("sftp:mkdir", (_e, sid: number, dir: string) => sftpController.mkdirRemote(sid, dir));
ipcMain.handle("sftp:remove", (_e, sid: number, target: string) => sftpController.removeRemote(sid, target));
ipcMain.handle("sftp:rename", (_e, sid: number, from: string, to: string) => sftpController.renameRemote(sid, from, to));
ipcMain.handle("sftp:upload", (_e, sid: number, localPath: string, remotePath: string) => sftpController.upload(sid, localPath, remotePath));
ipcMain.handle("sftp:download", (_e, sid: number, remotePath: string, localPath: string) => sftpController.download(sid, remotePath, localPath));

ipcMain.handle("local:list", (_e, dir: string) => sftpController.listLocal(dir));
ipcMain.handle("local:mkdir", (_e, dir: string) => sftpController.mkdirLocal(dir));
ipcMain.handle("local:remove", (_e, target: string) => sftpController.removeLocal(target));
ipcMain.handle("local:rename", (_e, from: string, to: string) => sftpController.renameLocal(from, to));

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  ptyService.disposeAll();
  sshService.disposeAll();
});
