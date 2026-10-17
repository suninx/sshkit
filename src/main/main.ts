import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from "electron";
import os from "node:os";
import path from "node:path";
import { PtyService, type TerminalCreateOptions } from "./pty";
import { HostStore } from "./store";
import { SshService } from "./ssh";
import { SftpController } from "./sftp";
import { ForwardService, type ForwardRule } from "./forward";
import { importKnownHosts, listKnownHosts, removeKnownHost } from "./knownhosts";
import { deleteCreds, getCreds, putCreds } from "./keystore";
import type { HostInput } from "../shared/host";

/* 应用菜单。默认菜单里 Edit 的 copy/paste/selectAll 角色会**在 OS 层吃掉 Cmd+C/V/A**,
   渲染层就永远收不到这几个键 —— 而我们的终端是 canvas 渲染,系统级"复制"从画布上**复制不到任何文本**,
   必须由渲染层自己处理(读 xterm 的选区写剪贴板)。所以这里去掉这些角色,把按键让给渲染层。
   保留最小菜单:应用菜单(关于/退出)、窗口(最小化/缩放/关闭)、编辑里只留 undo/redo 之外的空壳。 */
function installAppMenu(): void {
  if (process.platform !== "darwin") { Menu.setApplicationMenu(null); return; }
  const menu = Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}

/* bench 专用:仅在 SSHKIT_BENCH=1 时输出,正常运行零噪音 */
const benchLog = (...a: unknown[]): void => { if (process.env.SSHKIT_BENCH) console.log("[bench]", ...a); };

const hostStore = new HostStore(app.getPath("userData"));
const ptyService = new PtyService();
const sshService = new SshService();
let mainWindow: BrowserWindow | null = null;

/* ---------- 对照台窗口定位(bench/up.sh 用;不设此环境变量则完全无副作用) ---------- */

function benchBounds(): { x?: number; y?: number; width?: number; height?: number } {
  const raw = process.env.SSHKIT_BENCH_BOUNDS;
  if (!raw) return {};
  const p = raw.split(",").map((s) => Number(s.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
    console.warn(`[bench] SSHKIT_BENCH_BOUNDS 无效:"${raw}"(需要 x,y,w,h)`);
    return {};
  }
  return { x: p[0], y: p[1], width: p[2], height: p[3] };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 720,
    minHeight: 460,
    backgroundColor: "#101418",
    title: "sshkit",
    ...benchBounds(),
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
  benchLog("resize", id, cols, rows);
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

/* ---------- clipboard(T4:复制/粘贴终端选区走主进程,沙箱下最可靠) ---------- */

ipcMain.handle("clipboard:read", () => clipboard.readText());
ipcMain.handle("clipboard:write", (_e, text: string) => { clipboard.writeText(text ?? ""); });

/* ---------- T3 端口转发 ---------- */

const forwardService = new ForwardService(
  app.getPath("userData"),
  (hostId) => sshService.clientOfHost(hostId),
  (status) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("fwd:status", status); },
);

ipcMain.handle("fwd:rules", () => forwardService.listRules());
ipcMain.handle("fwd:statuses", () => forwardService.listStatuses());
ipcMain.handle("fwd:save", (_e, rule: ForwardRule) => forwardService.saveRule(rule));
ipcMain.handle("fwd:delete", (_e, id: string) => { forwardService.deleteRule(id); return forwardService.listRules(); });
ipcMain.handle("fwd:start", (_e, rule: ForwardRule) => forwardService.start(rule));
ipcMain.handle("fwd:stop", (_e, id: string) => { forwardService.stop(id); return forwardService.statusOf(id); });

/* ---------- T6 known_hosts ---------- */

ipcMain.on("knownhost:answer", (_e, reqId: string, action: "continue" | "add" | "replace" | "cancel") => {
  sshService.answerHostKey(reqId, action);
});
ipcMain.handle("knownhost:list", () => listKnownHosts());
ipcMain.handle("knownhost:import", async (e, sourcePath?: string) => {
  // 显式传入路径时跳过文件选择器 —— 便于自动化复验,正常使用仍走原生对话框
  if (sourcePath) {
    const res = importKnownHosts(sourcePath);
    return { canceled: false, ...res, file: sourcePath, rows: listKnownHosts() };
  }
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const r = win
    ? await dialog.showOpenDialog(win, { title: "Import Known Hosts", properties: ["openFile"], defaultPath: path.join(os.homedir(), ".ssh") })
    : await dialog.showOpenDialog({ title: "Import Known Hosts", properties: ["openFile"] });
  if (r.canceled || !r.filePaths.length) return { canceled: true, added: 0, skipped: 0 };
  const res = importKnownHosts(r.filePaths[0]);
  return { canceled: false, ...res, file: r.filePaths[0], rows: listKnownHosts() };
});

ipcMain.handle("knownhost:remove", (_e, host: string) => { removeKnownHost(host); return listKnownHosts(); });

/* T8:渲染层 reload/关闭时,把它开的会话一并收掉 —— 否则主进程会留下没有界面的孤儿会话 */
ipcMain.on("sessions:disposeAll", () => {
  forwardService.stopAll();
  sshService.disposeAll();
  ptyService.disposeAll();
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
  installAppMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  forwardService.stopAll();
  ptyService.disposeAll();
  sshService.disposeAll();
});
