import { vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 主进程测试用的 electron 假件。
 * 目标不是"跑通",而是**忠实**:只提供 src/main 真正用到的 API,签名与语义对齐,
 * 未实现的方法调用会显式抛错(见 AGENTS.md 铁律 8)。
 */
export interface ElectronMock {
  module: Record<string, unknown>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  onHandlers: Map<string, (...args: unknown[]) => void>;
  webContents: { sent: Array<[string, ...unknown[]]> };
  dialog: { openResult: string[] | null; messages: string[] };
  menu: { built: unknown[]; applied: unknown[] };
  clipboard: { text: string };
  windows: Array<Record<string, unknown>>;
  userData: string;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  fire: (channel: string, ...args: unknown[]) => void;
  tmp: () => string;
}

export function createElectronMock(userDataDir?: string): ElectronMock {
  const userData = userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-ud-"));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const onHandlers = new Map<string, (...args: unknown[]) => void>();
  const sent: Array<[string, ...unknown[]]> = [];
  const dialogState = {
    openResult: null as string[] | null,
    saveResult: null as string | null,
    messages: [] as string[],
  };
  const clipboardState = { text: "" };
  const windows: Array<Record<string, unknown>> = [];
  const menuState = { built: [] as unknown[], applied: [] as unknown[] };

  const notStubbed = (name: string) => (): never => {
    throw new Error(`not stubbed in electron mock: ${name}`);
  };

  class FakeBrowserWindow extends EventEmitter {
    webContents = {
      send: (...args: unknown[]) => { sent.push(args as [string, ...unknown[]]); },
      once: () => undefined,
      on: () => undefined,
      /* 编辑菜单项点击会调这些(菜单挂 click 不挂 accelerator,快捷键留给渲染层) */
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      openDevTools: notStubbed("webContents.openDevTools"),
      setWindowOpenHandler: () => undefined,
    };
    constructor(public options: Record<string, unknown> = {}) {
      super();
      windows.push(this as unknown as Record<string, unknown>);
    }
    loadFile = async (): Promise<void> => undefined;
    loadURL = async (): Promise<void> => undefined;
    once = (ev: string, cb: (...a: unknown[]) => void): this => { super.once(ev, cb); return this; };
    on = (ev: string, cb: (...a: unknown[]) => void): this => { super.on(ev, cb); return this; };
    show = (): void => undefined;
    focus = (): void => undefined;
    /* 无边框窗口的自绘按钮走这些方法(window:* IPC 通道) */
    minimize = vi.fn();
    maximize = vi.fn();
    unmaximize = vi.fn();
    close = vi.fn();
    isMaximized = vi.fn((): boolean => false);
    isDestroyed = (): boolean => false;
    static getAllWindows = (): FakeBrowserWindow[] => windows as unknown as FakeBrowserWindow[];
    static fromWebContents = (): FakeBrowserWindow | null => null;
  }

  const module = {
    app: {
      getPath: (name: string) => (name === "userData" ? userData : path.join(os.tmpdir(), `sshkit-${name}`)),
      getName: () => "sshkit",
      getVersion: () => "0.1.0-test",
      getPreferredSystemLanguages: () => ["zh-CN"],
      whenReady: () => Promise.resolve(),
      on: (ev: string, cb: unknown) => { onHandlers.set(`app:${ev}`, cb as never); },
      /* 这些用 vi.fn:菜单/关于面板/关窗退出的断言要检查调用 */
      quit: vi.fn(),
      setName: vi.fn(),
      setAboutPanelOptions: vi.fn(),
      showAboutPanel: vi.fn(),
      dock: { setIcon: vi.fn() },
      isPackaged: false,
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn); },
      on: (ch: string, fn: (...a: unknown[]) => void) => { onHandlers.set(ch, fn); },
    },
    Menu: {
      buildFromTemplate: (t: unknown) => { menuState.built.push(t); return { template: t }; },
      setApplicationMenu: (m: unknown) => { menuState.applied.push(m); },
    },
    clipboard: {
      readText: () => clipboardState.text,
      writeText: (t: string) => { clipboardState.text = t; },
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: !dialogState.openResult, filePaths: dialogState.openResult ?? [] }),
      showSaveDialog: async () => ({ canceled: !dialogState.saveResult, filePath: dialogState.saveResult ?? undefined }),
      showMessageBox: async () => ({ response: 0 }),
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
    shell: { openExternal: vi.fn(async () => undefined) },
    nativeImage: {
      createFromPath: (filePath: string) => ({
        filePath,
        resize: (size: { width: number; height: number }) => ({ filePath, size }),
      }),
    },
  };

  return {
    module, handlers, onHandlers,
    webContents: { sent },
    dialog: dialogState,
    menu: menuState,
    clipboard: clipboardState,
    windows,
    userData,
    /** 走真实 IPC 注册表调用 handler(参数与渲染层一致:首参是 IpcMainInvokeEvent) */
    invoke: async (channel: string, ...args: unknown[]) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no ipc handler registered: ${channel}`);
      return await fn({ sender: { send: () => undefined, once: () => undefined } }, ...args);
    },
    fire: (channel: string, ...args: unknown[]) => {
      const fn = onHandlers.get(channel);
      if (!fn) throw new Error(`no ipc on-handler registered: ${channel}`);
      fn({ sender: { send: () => undefined } }, ...args);
    },
    tmp: () => fs.mkdtempSync(path.join(os.tmpdir(), "sshkit-t-")),
  };
}
