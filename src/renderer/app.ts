import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

interface SshkitBridge {
  create(opts: { cols: number; rows: number }): Promise<{ id: number }>;
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  dispose(id: number): void;
  onData(id: number, cb: (data: string) => void): () => void;
  onExit(id: number, cb: (info: { exitCode: number }) => void): () => void;
}

declare global {
  interface Window { sshkit: SshkitBridge; }
}

const term = new Terminal({
  fontFamily: "Menlo, DejaVu Sans Mono, monospace",
  fontSize: 13,
  theme: {
    background: "#101418",
    foreground: "#d8dee9",
    cursor: "#88c0d0",
  },
});

const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term")!);
fit.fit();

const bridge = window.sshkit;

void (async () => {
  const { id } = await bridge.create({ cols: term.cols, rows: term.rows });
  term.onData((data) => bridge.write(id, data));
  term.onResize(({ cols, rows }) => bridge.resize(id, cols, rows));
  bridge.onData(id, (data) => term.write(data));
  bridge.onExit(id, ({ exitCode }) => {
    term.write(`\r\n\x1b[90m[process exited with ${exitCode} — restart the app]\x1b[0m\r\n`);
  });

  const container = document.getElementById("term")!;
  new ResizeObserver(() => {
    try { fit.fit(); } catch { /* errored while hidden */ }
  }).observe(container);
  term.focus();
})();
