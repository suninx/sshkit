import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import os from "node:os";
import path from "node:path";
import { PtyService, type TerminalCreateOptions } from "./pty";
import { HostStore } from "./store";
import { SshService } from "./ssh";
import { SftpController } from "./sftp";
import { getSettings, setSetting } from "./settings";
import { getLocale, resolveLocale, setLocale as setI18nLocale, tr, type LocalePref } from "../shared/i18n";
import { ForwardService, type ForwardRule } from "./forward";
import { importKnownHosts, listKnownHosts, removeKnownHost } from "./knownhosts";
import { deleteCreds, getCreds, putCreds } from "./keystore";
import { SnippetStore } from "./snippets";
import type { HostInput } from "../shared/host";

/** macOS 专属窗口 chrome:原版没有原生标题栏,红绿灯浮在内容上。
 *  **纯函数**(平台由调用方传入),便于在任意平台覆盖两个分支。 */
export type WindowChrome = {
  titleBarStyle?: "hiddenInset";
  trafficLightPosition?: { x: number; y: number };
};

/* macOS 的交通灯位置:原版实测三个圆点中心 y≈25(顶栏高 53,即垂直居中),左侧约 14 起。
   Electron 的 hiddenInset 默认把它们放得更靠上(实测中心 y≈18),看上去"飘"在顶栏上方,
   所以显式给位置。trafficLightPosition 指的是整组按钮的**左上角**。 */
export function windowChrome(platform: NodeJS.Platform): WindowChrome {
  return platform === "darwin"
    ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 19 } }
    : {};
}

/* 应用菜单。默认菜单里 Edit 的 copy/paste/selectAll 角色会**在 OS 层吃掉 Cmd+C/V/A**,
   渲染层就永远收不到这几个键 —— 而我们的终端是 canvas 渲染,系统级"复制"从画布上**复制不到任何文本**,
   必须由渲染层自己处理(读 xterm 的选区写剪贴板)。所以这里去掉这些角色,把按键让给渲染层。
   保留最小菜单:应用菜单(关于/退出)、窗口(最小化/缩放/关闭)、编辑里只留 undo/redo 之外的空壳。 */
/* platform 作为参数传入(默认取真实平台):非 darwin 分支才能在 macOS 上被测到。 */
export function installAppMenu(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") { Menu.setApplicationMenu(null); return; }
  const name = app.getName();
  const wc = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null);
  const sendPrefs = (): void => { wc()?.send("prefs:open"); };
  /* 编辑菜单里的复制/粘贴**不能**用 role:role 会在系统层吃掉 Cmd+C/V,渲染层就永远收不到
     (终端是 canvas 渲染,必须自己处理选区复制)。所以这里只放点击项、不挂 accelerator:
     菜单能点,快捷键仍归渲染层。 */
  const editItem = (label: string, run: (w: Electron.WebContents) => void): Electron.MenuItemConstructorOptions => ({
    label, click: () => { const w = wc(); if (w) run(w); },
  });
  const menu = Menu.buildFromTemplate([
    {
      label: name,
      submenu: [
        { role: "about", label: `${tr("menu.about")} ${name}` },
        { type: "separator" },
        { label: tr("menu.preferences"), accelerator: "Cmd+,", click: sendPrefs },
        { type: "separator" },
        { role: "services", label: tr("menu.services") },
        { type: "separator" },
        { role: "hide", label: tr("menu.hide") },
        { role: "hideOthers", label: tr("menu.hideOthers") },
        { role: "unhide", label: tr("menu.showAll") },
        { type: "separator" },
        { role: "quit", label: `${tr("menu.quit")} ${name}` },
      ],
    },
    {
      label: tr("menu.edit"),
      submenu: [
        { role: "undo", label: tr("menu.undo") },
        { role: "redo", label: tr("menu.redo") },
        { type: "separator" },
        editItem(tr("menu.cut"), (w) => w.cut()),
        editItem(tr("menu.copy"), (w) => w.copy()),
        editItem(tr("menu.paste"), (w) => w.paste()),
        editItem(tr("menu.selectAll"), (w) => w.selectAll()),
      ],
    },
    {
      label: tr("menu.view"),
      submenu: [
        { role: "resetZoom", label: tr("menu.zoomReset") },
        { role: "zoomIn", label: tr("menu.zoomIn") },
        { role: "zoomOut", label: tr("menu.zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: tr("menu.fullscreen") },
      ],
    },
    { role: "windowMenu", label: tr("menu.window") },
    {
      role: "help",
      label: tr("menu.help"),
      submenu: [
        { label: tr("menu.docs"), click: () => void shell.openExternal("https://github.com/suninx/sshkit") },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

/** macOS 的"关于"面板:原生面板 + 版本/Electron/Chromium/Node 信息(与原版一致的信息密度)。 */
export function installAboutPanel(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") return;
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    copyright: "MIT License · Local-first SSH client",
    credits: `Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
  });
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
    width: 1280,          // 与原版对照窗口同尺寸,便于逐像素比对
    height: 800,
    minWidth: 720,
    minHeight: 460,
    backgroundColor: "#1d2033",
    title: "sshkit",
    /* 原版没有原生标题栏:红绿灯直接浮在内容上,整条顶栏都是 tab 区。
       hiddenInset 保留红绿灯、去掉标题栏;顶栏左端预留出红绿灯的位置(见 index.html 的 --tl-inset)。 */
    ...windowChrome(process.platform),
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
ipcMain.on("terminal:write", (_e, id: number, data: string) => {
  benchLog("write →", id, JSON.stringify(data.slice(0, 40)));
  try { ptyService.write(id, data); } catch (e) { benchLog("pty.write 抛错:", String(e)); }
  try { sshService.write(id, data); } catch (e) { benchLog("ssh.write 抛错:", String(e)); }
});
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
ipcMain.handle("hosts:delete", async (_e, id: string) => {
  hostStore.remove(id);
  /* 凭据清理是**尽力而为**:钥匙串不可用时(无 keyring 守护进程、被锁、CI 环境)
     deleteCreds 会 reject,但主机记录已经删掉了 —— 此时让整个操作失败,用户看到的是
     "点了删除没反应"(列表不刷新)。记录日志即可。 */
  try { await deleteCreds(id); }
  catch (err) { console.error("[hosts:delete] 清理钥匙串凭据失败(主机记录已删除):", err); }
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
/* 片段文件放到 Electron 的 userData 下:跨平台正确(Windows 是 %APPDATA%\sshkit),
   也避免与用户手写的其它文件混在一起。 */
const snippetStore = new SnippetStore(path.join(app.getPath("userData"), "snippets.json"));
ipcMain.handle("creds:has", async (_e, id: string) => {
  try {
    const c = await getCreds(id);
    return Boolean(c && (c.password || c.passphrase));
  } catch { return false; }
});

ipcMain.handle("window:new", () => { createWindow(); return true; });

ipcMain.handle("snippets:list", () => snippetStore.list());
ipcMain.handle("snippets:save", (_e, input: { id?: string; name: string; command: string }) => snippetStore.saveSnippet(input));
ipcMain.handle("snippets:remove", (_e, id: string) => snippetStore.remove(id));

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
  if (!r.canceled && r.filePaths.length > 0) {
    const res = importKnownHosts(r.filePaths[0]);
    return { canceled: false, ...res, file: r.filePaths[0], rows: listKnownHosts() };
  }
  return { canceled: true, added: 0, skipped: 0 };
});

ipcMain.handle("knownhost:remove", (_e, host: string) => { removeKnownHost(host); return listKnownHosts(); });

/* T8:渲染层 reload/关闭时,把它开的会话一并收掉 —— 否则主进程会留下没有界面的孤儿会话 */
ipcMain.on("sessions:disposeAll", () => {
  forwardService.stopAll();
  sshService.disposeAll();
  ptyService.disposeAll();
});

/* 语言:启动时按 settings.json 决定主进程的文案语言,渲染进程再通过 IPC 取同一份 */
const systemLang = (): string => (app.getPreferredSystemLanguages?.() ?? [])[0] ?? "en";
setI18nLocale(resolveLocale(getSettings().locale, systemLang()));

ipcMain.handle("settings:getLocale", () => ({
  pref: getSettings().locale,
  system: systemLang(),
  effective: getLocale(),
}));
ipcMain.handle("settings:setLocale", (_e, pref: LocalePref) => {
  /* 来自渲染层的值要白名单校验:不合法的偏好一律落回"跟随系统",别写脏数据 */
  const safe: LocalePref = pref === "zh" || pref === "en" ? pref : "system";
  setSetting("locale", safe);
  pref = safe;
  setI18nLocale(resolveLocale(pref, systemLang()));
  installAppMenu();   // 菜单文案跟随语言
  return { pref: getSettings().locale, system: systemLang(), effective: getLocale() };
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
  /* 交互会话上开不出 sftp 子系统时,给 SFTP 单独开一条连接(主机与凭据只有这里知道) */
  async (sid: number) => {
    const hostId = sshService.hostIdOf(sid);
    if (!hostId) return null;
    const host = hostStore.get(hostId);
    if (!host) return null;
    const secrets = host.authType === "password" || host.authType === "key" ? await getCreds(hostId) : {};
    return await sshService.openAux(host, secrets);
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

/* macOS 约定:关掉窗口**不退出应用**,留在 Dock,点 Dock 图标(activate)能重开窗口。
   Windows/Linux 仍按各自惯例退出。之前的无条件 quit() 让用户"一关窗口应用就没了",
   再点 Dock 也回不来(用户反馈"没看到窗口呀")。 */
/** 关掉所有窗口时是否退出应用:macOS 不退出(留在 Dock),其余平台按惯例退出。 */
export function shouldQuitOnAllClosed(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "darwin";
}

app.on("window-all-closed", () => {
  if (shouldQuitOnAllClosed()) app.quit();
});
app.on("before-quit", () => {
  forwardService.stopAll();
  ptyService.disposeAll();
  sshService.disposeAll();
});
