import fs from "node:fs";
import path from "node:path";

/**
 * 渲染层 jsdom 挂载器:
 *  - 把 src/renderer/index.html 的 body 结构与样式装进 document(去掉 <script>);
 *  - 装一个**忠实**的 window.sshkit 假桥(方法名与 preload 一致,未知方法显式抛错);
 *  - 所有桥调用记录在 calls 里,便于断言"界面到底请求了什么"。
 */
export interface BridgeCalls { [method: string]: unknown[][] }

export function loadRendererDom(): void {
  const html = fs.readFileSync(path.join(__dirname, "../../src/renderer/index.html"), "utf8");
  const body = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"));
  document.documentElement.innerHTML = `<head></head><body>${body.replace(/<script[\s\S]*?<\/script>/g, "")}</body>`;
}

type Behavior = (...args: unknown[]) => unknown;

export function installBridge(overrides: Record<string, Behavior> = {}, opts: { platform?: string } = {}): { calls: BridgeCalls } {
  const calls: BridgeCalls = {};
  const record = (name: string, impl: Behavior) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return impl(...args);
  };
  const noop = (): void => undefined;
  const notStubbed = (name: string) => (): never => {
    throw new Error(`not stubbed in bridge mock: ${name}`);
  };
  const base: Record<string, unknown> = {
    /* preload 暴露的 platform。测试里固定成 win32(覆盖自绘窗口按钮的那条路径);
       需要 darwin 行为的用例用 installBridge({}, { platform: "darwin" })。 */
    platform: opts.platform ?? "win32",
    terminal: {
      createLocal: record("terminal.createLocal", overrides["terminal.createLocal"] ?? (async () => 1)),
      write: record("terminal.write", overrides["terminal.write"] ?? noop),
      resize: record("terminal.resize", overrides["terminal.resize"] ?? noop),
      dispose: record("terminal.dispose", overrides["terminal.dispose"] ?? noop),
    },
    info: record("info", overrides.info ?? (async () => ({ version: "0.1.0", platform: "darwin", name: "sshkit" }))),
    settings: {
      getLocale: record("settings.getLocale", overrides["settings.getLocale"] ?? (async () => "system")),
      setLocale: record("settings.setLocale", overrides["settings.setLocale"] ?? (async () => undefined)),
    },
    disposeAllSessions: record("disposeAllSessions", overrides.disposeAllSessions ?? noop),
    clipboard: {
      read: record("clipboard.read", overrides["clipboard.read"] ?? (async () => "")),
      write: record("clipboard.write", overrides["clipboard.write"] ?? (async () => undefined)),
    },
    onOpenPrefs: record("onOpenPrefs", overrides.onOpenPrefs ?? (() => () => undefined)),
    onData: record("onData", overrides.onData ?? (() => () => undefined)),
    onExit: record("onExit", overrides.onExit ?? (() => () => undefined)),
    hosts: {
      list: record("hosts.list", overrides["hosts.list"] ?? (async () => [])),
      create: record("hosts.create", overrides["hosts.create"] ?? (async (h) => ({ ...(h as object), id: "h_1" }))),
      update: record("hosts.update", overrides["hosts.update"] ?? (async (id, p) => ({ id, ...(p as object) }))),
      remove: record("hosts.remove", overrides["hosts.remove"] ?? overrides["hosts.delete"] ?? (async () => undefined)),
    },
    creds: {
      put: record("creds.put", overrides["creds.put"] ?? (async () => undefined)),
      has: record("creds.has", overrides["creds.has"] ?? (async () => false)),
    },
    ssh: { connect: record("ssh.connect", overrides["ssh.connect"] ?? (async () => ({ ok: true }))) },
    window: {
      new: record("window.new", overrides["window.new"] ?? (async () => undefined)),
      /* 无边框窗口的自绘按钮(preload 同名 API) */
      minimize: record("window.minimize", overrides["window.minimize"] ?? noop),
      toggleMaximize: record("window.toggleMaximize", overrides["window.toggleMaximize"] ?? noop),
      close: record("window.close", overrides["window.close"] ?? noop),
      onMaximized: record("window.onMaximized", overrides["window.onMaximized"] ?? (() => () => undefined)),
    },
    snippets: {
      list: record("snippets.list", overrides["snippets.list"] ?? (async () => [])),
      save: record("snippets.save", overrides["snippets.save"] ?? (async (s) => s)),
      remove: record("snippets.remove", overrides["snippets.remove"] ?? (async () => undefined)),
    },
    knownhost: {
      list: record("knownhost.list", overrides["knownhost.list"] ?? (async () => [])),
      remove: record("knownhost.remove", overrides["knownhost.remove"] ?? (async () => 1)),
      import: record("knownhost.import", overrides["knownhost.import"] ?? (async () => ({ added: 0, skipped: 0 }))),
      onAsk: record("knownhost.onAsk", overrides["knownhost.onAsk"] ?? (() => () => undefined)),
      onAskCancel: record("knownhost.onAskCancel", overrides["knownhost.onAskCancel"] ?? (() => () => undefined)),
      answer: record("knownhost.answer", overrides["knownhost.answer"] ?? (() => undefined)),
    },
    fwd: {
      rules: record("fwd.rules", overrides["fwd.rules"] ?? (async () => [])),
      save: record("fwd.save", overrides["fwd.save"] ?? (async (r) => r)),
      remove: record("fwd.remove", overrides["fwd.remove"] ?? overrides["fwd.delete"] ?? (async () => undefined)),
      start: record("fwd.start", overrides["fwd.start"] ?? (async (r) => ({ id: (r as { id: string }).id, state: "running" }))),
      stop: record("fwd.stop", overrides["fwd.stop"] ?? (async () => undefined)),
      statuses: record("fwd.statuses", overrides["fwd.statuses"] ?? (async () => [])),
      onStatus: record("fwd.onStatus", overrides["fwd.onStatus"] ?? (() => () => undefined)),
    },
    sftp: {
      list: record("sftp.list", overrides["sftp.list"] ?? (async () => ({ path: "/", entries: [] }))),
      mkdir: record("sftp.mkdir", overrides["sftp.mkdir"] ?? (async () => undefined)),
      remove: record("sftp.remove", overrides["sftp.remove"] ?? (async () => undefined)),
      rename: record("sftp.rename", overrides["sftp.rename"] ?? (async () => undefined)),
      upload: record("sftp.upload", overrides["sftp.upload"] ?? (async () => ({ jobId: 1 }))),
      download: record("sftp.download", overrides["sftp.download"] ?? (async () => ({ jobId: 2 }))),
      onProgress: record("sftp.onProgress", overrides["sftp.onProgress"] ?? (() => () => undefined)),
    },
    /* 内置 MCP 服务器:状态/开关/活动流 */
    mcp: {
      status: record("mcp.status", overrides["mcp.status"] ?? (async () => ({
        running: false, port: 7788, token: "tok", clients: [], error: null, activity: [], policy: "full",
      }))),
      set: record("mcp.set", overrides["mcp.set"] ?? (async () => ({
        running: false, port: 7788, token: "tok", clients: [], error: null, activity: [], policy: "full",
      }))),
      regenerateToken: record("mcp.regenerateToken", overrides["mcp.regenerateToken"] ?? (async () => ({
        running: false, port: 7788, token: "tok2", clients: [], error: null, activity: [],
      }))),
      clearActivity: record("mcp.clearActivity", overrides["mcp.clearActivity"] ?? (async () => ({
        running: false, port: 7788, token: "tok", clients: [], error: null, activity: [], policy: "full",
      }))),
      abort: record("mcp.abort", overrides["mcp.abort"] ?? (async () => ({ running: true, port: 7788, token: "tok", clients: [], error: null, activity: [], policy: "full" }))),
      answerApproval: record("mcp.answerApproval", overrides["mcp.answerApproval"] ?? (async () => true)),
      onApproval: record("mcp.onApproval", overrides["mcp.onApproval"] ?? (() => () => undefined)),
      onExec: record("mcp.onExec", overrides["mcp.onExec"] ?? (() => () => undefined)),
      onActivity: record("mcp.onActivity", overrides["mcp.onActivity"] ?? (() => () => undefined)),
      onStatus: record("mcp.onStatus", overrides["mcp.onStatus"] ?? (() => () => undefined)),
    },
    local: {
      list: record("local.list", overrides["local.list"] ?? (async () => ({ path: "/home/u", entries: [] }))),
      mkdir: record("local.mkdir", overrides["local.mkdir"] ?? (async () => undefined)),
      remove: record("local.remove", overrides["local.remove"] ?? (async () => undefined)),
      rename: record("local.rename", overrides["local.rename"] ?? (async () => undefined)),
    },
  };
  // 未在 preload 中暴露、但被误用的属性要显式失败(而不是静默 undefined)
  const proxy = new Proxy(base, {
    get(t, p: string) {
      if (p in t) return t[p];
      if (p === "then") return undefined;
      return notStubbed(p);
    },
  });
  (window as unknown as { sshkit: unknown }).sshkit = proxy;
  return { calls };
}

/** 让挂起的 promise 与 jsdom 事件跑完(渲染函数普遍是 async) */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

export const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`element not found: ${sel}`);
  return el as T;
};
