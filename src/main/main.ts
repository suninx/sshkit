import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, nativeImage } from "electron";
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
import type { SFTPWrapper } from "ssh2";
import { randomBytes } from "node:crypto";
import { startMcpServer, type McpServerHandle } from "./mcp/server";
import { buildReadTools, type McpToolDeps } from "./mcp/tools";
import { RemotePool } from "./mcp/pool";
import { listRemote, readRemote, statRemote } from "./mcp/remote";
import { getMcpToken, setMcpToken } from "./keystore";
import { MCP_ACTIVITY_LIMIT, MCP_SSE_PING_MS, type McpActivity, type McpStatus } from "../shared/mcp";

/** macOS 专属窗口 chrome:原版没有原生标题栏,红绿灯浮在内容上。
 *  **纯函数**(平台由调用方传入),便于在任意平台覆盖两个分支。 */
export type WindowChrome = {
  titleBarStyle?: "hiddenInset";
  trafficLightPosition?: { x: number; y: number };
  /** 无边框窗口:原生标题栏与窗口按钮都不要,改由渲染层自绘(原版主窗口就是 frame:false) */
  frame?: boolean;
};

/* macOS 的交通灯位置:原版实测三个圆点中心 y≈25(顶栏高 53,即垂直居中),左侧约 14 起。
   Electron 的 hiddenInset 默认把它们放得更靠上(实测中心 y≈18),看上去"飘"在顶栏上方,
   所以显式给位置。trafficLightPosition 指的是整组按钮的**左上角**。 */
export function windowChrome(platform: NodeJS.Platform): WindowChrome {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 19 } };
  }
  /* 原版 Termius 的 app.asar 里,主窗口创建参数就是 `frame:!1`(三平台一致),窗口按钮由它
     自己的界面画。Windows 上返回 {} 会保留系统边框 —— 顶栏上方多出一整条原生标题栏,
     左侧 78px 的红绿灯让位(见 index.html 的 --tl-inset)也变成空白。改成无边框后,
     最小化/最大化/关闭由渲染层顶栏右端的按钮走 IPC(window:* 通道)完成。
     Linux 本轮不动(没有实测依据,保持现状)。 */
  if (platform === "win32") return { frame: false };
  return {};
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
        /* 用 click 调 showAboutPanel,而不是 role:"about" —— role 走的是系统默认面板,
       会忽略 setAboutPanelOptions(实测还是显示 Electron 44.8.0)。 */
        { label: `${tr("menu.about")} ${name}`, click: () => app.showAboutPanel() },
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
/** dev 模式 Dock 图标。setIcon 作为参数传入,成功/抛错两条路径都能单测。 */
export function setDockIcon(platform: NodeJS.Platform, setIcon: (file: string) => void,
                             warn: (msg: string, err: unknown) => void = console.warn): void {
  if (platform !== "darwin") return;
  try {
    setIcon(path.join(__dirname, "..", "..", "build", "icon-1024.png"));
  } catch (err) {
    warn("[app] 设置 Dock 图标失败:", err);
  }
}

export function installAboutPanel(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") return;
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    copyright: "MIT License · Local-first SSH client",
    iconPath: path.join(__dirname, "..", "..", "build", "icon-1024.png"),
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
  const win = new BrowserWindow({
    width: 1280,          // 与原版对照窗口同尺寸,便于逐像素比对
    height: 800,
    minWidth: 720,
    minHeight: 460,
    backgroundColor: "#1d2033",
    title: "sshkit",
    /* 原版没有原生标题栏:红绿灯直接浮在内容上,整条顶栏都是 tab 区。
       macOS 用 hiddenInset 保留红绿灯;Windows 用 frame:false,窗口按钮由渲染层自绘
       (见 index.html 的 --tl-inset 与 #wincontrols)。 */
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
  mainWindow = win;

  win.on("closed", () => { mainWindow = null; });
  /* 自绘的最大化按钮要在 □ / ❐ 之间切换:窗口状态变化时推给渲染层 */
  win.on("maximize", () => win.webContents.send("window:maximized", true));
  win.on("unmaximize", () => win.webContents.send("window:maximized", false));
  win.webContents.on("console-message", (...args: unknown[]) => {
    const ev = args[0] as { message?: string; lineNumber?: number; sourceId?: string } | undefined;
    const legacy = args.slice(1) as [number, string, number | undefined, string | undefined];
    const message = ev?.message ?? legacy[1] ?? "";
    const line = ev?.lineNumber ?? legacy[2];
    const sourceId = ev?.sourceId ?? legacy[3];
    console.log("[renderer]", String(message).replace(/\s+/g, " ").slice(0, 300), sourceId ? `${sourceId}:${line ?? ""}` : "");
  });
  void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
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

/* ---------- 无边框窗口的窗口按钮(Windows:渲染层自绘,见 index.html #wincontrols) ----------
   走 BrowserWindow.fromWebContents(发送方),不依赖全局 mainWindow —— 将来多窗口也不会点错。 */
ipcMain.on("window:minimize", (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize(); });
ipcMain.on("window:toggleMaximize", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});
ipcMain.on("window:close", (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); });

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
/* 树传输:递归目录 / 断点续传 / 可取消(见 SftpController.transferTree) */
ipcMain.handle("sftp:transfer", (_e, sid: number, dir: "up" | "down", localPath: string, remotePath: string,
  policy?: "overwrite" | "skip" | "rename") =>
  sftpController.transferTree(sid, dir, localPath, remotePath, { policy }));
ipcMain.handle("sftp:cancel", (_e, jobId: number) => sftpController.cancelJob(jobId));
/* 改权限:mode 用八进制数字位(0o644)。本地与远端走同一条通道,由 dir 决定 */
ipcMain.handle("sftp:chmod", (_e, sid: number, target: string, mode: number) => sftpController.chmodRemote(sid, target, mode));
ipcMain.handle("local:chmod", (_e, target: string, mode: number) => sftpController.chmodLocal(target, mode));
/* 拖到 Finder:原生拖拽需要一个图标(32px 即可) */
ipcMain.on("sftp:startDrag", (e, filePath: string) => {
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "..", "build", "icon-1024.png"));
  e.sender.startDrag({ file: filePath, icon: icon.resize({ width: 32, height: 32 }) });
});

ipcMain.handle("local:list", (_e, dir: string) => sftpController.listLocal(dir));
ipcMain.handle("local:mkdir", (_e, dir: string) => sftpController.mkdirLocal(dir));
ipcMain.handle("local:remove", (_e, target: string) => sftpController.removeLocal(target));
ipcMain.handle("local:rename", (_e, from: string, to: string) => sftpController.renameLocal(from, to));

/* ---------- 内置 MCP 服务器(阶段 1:只读工具 + 活动流) ----------
   AI 客户端(Claude Code / Codex / IDEA+Junie)通过本地 HTTP 调这些工具,
   sshkit 负责执行并把每次调用推给渲染层 —— 用户要"AI 能操作,但我看得见"。
   凭据不经过 MCP:工具只收 hostId/主机名,密码/私钥仍从这里查钥匙串。 */

let mcpHandle: McpServerHandle | null = null;
let mcpToken = "";
let mcpClients: string[] = [];
let mcpError: string | null = null;
const mcpActivity: McpActivity[] = [];

const mcpStatus = (): McpStatus => ({
  running: mcpHandle !== null,
  port: mcpHandle?.port ?? getSettings().mcp.port,
  token: mcpToken,
  clients: mcpClients,
  error: mcpError,
  activity: mcpActivity,
});

const pushMcpStatus = (): void => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mcp:status", mcpStatus());
};

const pushMcpActivity = (ev: McpActivity): void => {
  /* 同一次调用(running → ok/error)复用 id:原地更新,活动流里只留一行 */
  const idx = mcpActivity.findIndex((a) => a.id === ev.id);
  if (idx >= 0) mcpActivity[idx] = ev;
  else mcpActivity.unshift(ev);
  if (mcpActivity.length > MCP_ACTIVITY_LIMIT) mcpActivity.length = MCP_ACTIVITY_LIMIT;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mcp:activity", ev);
};

/* 主机 id → 独立 SFTP 连接(闲置 2 分钟自动关),与 SftpController 的 aux 连接同一思路 */
const mcpPool = new RemotePool(async (hostId: string) => {
  /* 工具层已经用 hostStore 校验过主机存在(resolveHost),这里直接取 */
  const host = hostStore.get(hostId)!;
  const secrets = host.authType === "password" || host.authType === "key" ? await getCreds(hostId) : {};
  const client = await sshService.openAux(host, secrets);
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, wrapper) => (err ? reject(err) : resolve(wrapper)));
  });
  return {
    sftp,
    close: () => { try { client.end(); } catch { /* 已断开 */ } },
  };
});

const mcpDeps: McpToolDeps = {
  listHosts: () => hostStore.list().map((h) => ({
    id: h.id, name: h.name, host: h.host, port: h.port, username: h.username, authType: h.authType,
  })),
  findHost: (q) => {
    const h = hostStore.list().find((x) => x.id === q || x.name === q);
    return h ? { id: h.id, name: h.name, host: h.host, port: h.port, username: h.username, authType: h.authType } : undefined;
  },
  remote: {
    list: async (hostId, dir) => listRemote((await mcpPool.get(hostId)).sftp, dir),
    read: async (hostId, file, maxBytes) => readRemote((await mcpPool.get(hostId)).sftp, file, maxBytes),
    stat: async (hostId, p) => statRemote((await mcpPool.get(hostId)).sftp, p),
  },
};

async function startMcp(): Promise<void> {
  mcpError = null;
  try {
    mcpHandle = await startMcpServer({
      port: getSettings().mcp.port,
      token: mcpToken,
      version: app.getVersion(),
      tools: buildReadTools(mcpDeps),
      pingMs: MCP_SSE_PING_MS,
      onActivity: pushMcpActivity,
      onClients: (clients) => { mcpClients = clients; pushMcpStatus(); },
    });
  } catch (err) {
    /* 端口被占/权限不足:如实记下原因,让 UI 显示"启动失败"而不是假装在跑 */
    mcpHandle = null;
    mcpError = String((err as Error).message);
  }
  pushMcpStatus();
}

async function stopMcp(): Promise<void> {
  const handle = mcpHandle;
  mcpHandle = null;
  mcpClients = [];
  mcpError = null;
  mcpPool.closeAll();
  await handle!.close();
  pushMcpStatus();
}

/** ready 后按设置决定是否启动 MCP(导出:两个分支都要被测到) */
export async function bootMcp(settings: { enabled: boolean }): Promise<void> {
  if (settings.enabled) await startMcp();
}

/** 令牌首次使用时生成(32 字节随机),之后一直从钥匙串读(导出便于单测"已存在"分支) */
export async function ensureMcpToken(): Promise<void> {
  mcpToken = (await getMcpToken()) ?? "";
  if (!mcpToken) {
    mcpToken = randomBytes(32).toString("hex");
    await setMcpToken(mcpToken);
  }
}

ipcMain.handle("mcp:status", () => mcpStatus());
ipcMain.handle("mcp:set", async (_e, patch: { enabled?: boolean; port?: number }) => {
  const cur = getSettings().mcp;
  const next = {
    enabled: patch.enabled ?? cur.enabled,
    port: typeof patch.port === "number" && patch.port > 0 && patch.port < 65_536 ? patch.port : cur.port,
  };
  setSetting("mcp", next);
  const wasRunning = mcpHandle !== null;
  if (next.enabled) {
    if (wasRunning) await stopMcp();
    await startMcp();
  } else if (wasRunning) {
    await stopMcp();
  }
  return mcpStatus();
});
ipcMain.handle("mcp:regenerateToken", async () => {
  mcpToken = randomBytes(32).toString("hex");
  await setMcpToken(mcpToken);
  if (mcpHandle) { await stopMcp(); await startMcp(); }
  return mcpStatus();
});
ipcMain.handle("mcp:clearActivity", () => { mcpActivity.length = 0; pushMcpStatus(); return mcpStatus(); });

/* dev 模式下进程名/图标都来自 Electron 自己的 bundle(菜单栏会显示 "Electron")。
   显式设置应用名与 Dock 图标,让开发时的表现接近打包后的样子。 */
app.setName("sshkit");

app.whenReady().then(async () => {
  setDockIcon(process.platform, (file) => app.dock?.setIcon(file));
  /* MCP:先确保令牌存在,再按用户设置决定是否启动(默认关闭) */
  await ensureMcpToken();
  await bootMcp(getSettings().mcp);
  installAboutPanel();   // 必须在 ready 之后,否则 setAboutPanelOptions 不生效
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

/** 关窗事件处理(抽出来是为了两个平台分支都能被单测覆盖)。 */
export function onAllWindowsClosed(platform: NodeJS.Platform = process.platform): void {
  if (shouldQuitOnAllClosed(platform)) app.quit();
}

app.on("window-all-closed", () => onAllWindowsClosed());
app.on("before-quit", () => {
  forwardService.stopAll();
  ptyService.disposeAll();
  sshService.disposeAll();
});
