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
    const shell = process.env.SHELL || "/bin/zsh";
    const pty = PTY.spawn(shell, [], {
      name: "xterm-256color",
      cols: Math.max(2, Math.min(opts.cols, 500)),
      rows: Math.max(2, Math.min(opts.rows, 200)),
      cwd: opts.cwd || process.env.HOME || "/",
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
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}
