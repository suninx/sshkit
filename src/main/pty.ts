import os from "node:os";

/**
 * 按平台决定默认 shell。
 * **纯函数**:平台与 env 都由调用方传入 —— 这样"win32 分支"在任何 OS 上都能被测试覆盖,
 * 否则 CI 在 macOS/Linux 跑覆盖率时必然漏掉 win32 那半边,100% 阈值就不可能跨平台成立。
 */
export function resolveShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  return platform === "win32" ? env.COMSPEC || "powershell.exe" : env.SHELL || "/bin/zsh";
}

/** 终端工作目录:显式 cwd → HOME → USERPROFILE(Windows 没有 HOME) → 用户主目录 */
export function resolveCwd(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string {
  return explicit || env.HOME || env.USERPROFILE || homedir();
}
import * as PTY from "node-pty";
import type { WebContents } from "electron";

export interface TerminalCreateOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
}

interface LiveTerminal {
  pty: PTY.IPty;
  sender: WebContents;
}

export class PtyService {
  private nextId = 1;
  private readonly terminals = new Map<number, LiveTerminal>();

  create(sender: WebContents, opts: TerminalCreateOptions): number {
    const id = this.nextId++;
    const shell = resolveShell(process.platform, process.env);
    const pty = PTY.spawn(shell, [], {
      name: "xterm-256color",
      cols: Math.max(2, Math.min(opts.cols, 500)),
      rows: Math.max(2, Math.min(opts.rows, 200)),
      /* Windows 一般没有 HOME,用 USERPROFILE;os.homedir() 兜底跨平台一致 */
      cwd: resolveCwd(opts.cwd, process.env, os.homedir),
      env: {
        ...cleanEnv(),
        LANG: process.env.LANG || "en_US.UTF-8",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...(opts.env || {}),
      },
    });

    const dt = (fn: () => void) => { if (!sender.isDestroyed()) fn(); };
    pty.onData((data) => dt(() => sender.send("terminal:data", id, data)));
    pty.onExit(({ exitCode }) => {
      this.terminals.delete(id);
      dt(() => sender.send("terminal:exit", id, { exitCode }));
    });

    this.terminals.set(id, { pty, sender });
    return id;
  }

  write(id: number, data: string): void {
    const t = this.terminals.get(id);
    if (process.env.SSHKIT_BENCH) console.log("[bench] pty.write", id, t ? "ok" : "**找不到该 pty**", JSON.stringify(data.slice(0, 30)));
    if (t) t.pty.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    const t = this.terminals.get(id);
    if (t) t.pty.resize(Math.max(2, Math.min(cols, 500)), Math.max(2, Math.min(rows, 200)));
  }

  dispose(id: number): void {
    const t = this.terminals.get(id);
    if (!t) return;
    this.terminals.delete(id);
    try { t.pty.kill(); } catch { /* already dead */ }
  }

  disposeAll(): void {
    for (const id of Array.from(this.terminals.keys())) this.dispose(id);
  }
}

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  /* Node 保证 process.env 枚举出的值都是字符串(赋 undefined 会被转成 "undefined"),
     原来的 typeof 判断是不可达分支。 */
  for (const [k, v] of Object.entries(process.env)) out[k] = v as string;
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}
