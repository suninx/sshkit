import os from "node:os";
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
    /* 按平台选默认 shell:macOS/Linux 用登录 shell,Windows 没有 $SHELL 也没有 /bin/zsh,
       退回 COMSPEC(cmd.exe)/PowerShell —— 否则本地终端在 Windows 上直接起不来。 */
    /* 平台优先:SHELL 是 POSIX 语义,Windows 上若从 Git Bash 继承了 POSIX 的 $SHELL,
       会去 spawn 一个 Windows 上不存在的路径。Windows 一律用 COMSPEC(cmd.exe)。 */
    const shell =
      process.platform === "win32"
        ? process.env.COMSPEC || "powershell.exe"
        : process.env.SHELL || "/bin/zsh";
    const pty = PTY.spawn(shell, [], {
      name: "xterm-256color",
      cols: Math.max(2, Math.min(opts.cols, 500)),
      rows: Math.max(2, Math.min(opts.rows, 200)),
      /* Windows 一般没有 HOME,用 USERPROFILE;os.homedir() 兜底跨平台一致 */
      cwd: opts.cwd || process.env.HOME || process.env.USERPROFILE || os.homedir(),
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
