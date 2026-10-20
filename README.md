# sshkit

Lean local-first SSH terminal client. Original implementation, informed by a
feature study of a commercial terminal (see sibling repo `termius-rea` for the
research archive); no code or assets from that study are reused here.

> Working with an AI agent? Read **[`AGENTS.md`](./AGENTS.md)** first (red lines,
> commands, verification discipline, i18n and commit conventions).
> Human handover / project history: **[`HANDOVER.md`](./HANDOVER.md)**.

## Status: M0 — local terminal shell

- Electron 44 thin shell, esbuild bundling, TypeScript.
- `@xterm/xterm` renderer × `node-pty` main-process host.
- Secure defaults: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `contextBridge` API allowlist (anti-pattern remediation of
  the studied app).

## Run

```sh
pnpm install
pnpm run build        # esbuild → dist/
pnpm run rebuild:pty  # compile node-pty against Electron ABI
pnpm start            # build + electron .
```

## Roadmap

- M1 SSH connection desk: host book (CRUD + groups), ssh2 sessions,
  key/password storage in Keychain (keytar).
- M2 SFTP dual-pane + port forwarding.
- M3 UX: themes / keybindings / snippets.
- M4 mosh bridge (system binary), serial (optional).
- M5 packaging (electron-builder, GH Releases update feed).
