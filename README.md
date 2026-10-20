# sshkit

A lean, local-first SSH client for macOS — **original implementation**.
Electron + TypeScript + xterm.css, no cloud, no accounts, no telemetry.

> Design informed by a behavioral study of a commercial SSH terminal
> (read-only, local). **No code, binaries, or assets from that product are reused here.**

## Status

Feature-complete for daily SSH work:

- **SSH**: password / private-key / agent auth, known-hosts verification (TOFU with explicit prompt,
  hashed entries, import from another `known_hosts`), reconnect on drop.
- **Terminal**: xterm with canvas renderer, colour schemes, font & size, scrollback, search,
  split panes, workspace view, broadcast input to all panes.
- **SFTP**: dual-pane browser (local ↔ remote) with upload/download, mkdir/rename/delete.
  Remote side rides a dedicated connection so it also works on servers that refuse extra
  channels on the interactive session.
- **Port forwarding**: local / remote / dynamic (built-in SOCKS5), rule persistence, live status.
- **Host book**: groups, tags, search, edit/delete; credentials stored in the system Keychain.
- **Snippets**, **Logs**, **appearance settings** (dark/light UI, 12 terminal schemes).
- **i18n**: 中文 / English, switchable at runtime (Follow system / 中文 / English).

## Install / run

Prerequisites: **Node ≥ 22.12**, **pnpm 11**, macOS (Apple silicon for the packaged build).

```sh
pnpm install
pnpm run rebuild:pty     # build node-pty for the Electron ABI
pnpm start               # build + launch
```

> First `test:e2e` (or first `dist`) downloads the Electron binary (~290 MB) — Electron 44 no
> longer does that at install time. `pnpm run test:e2e` builds first automatically.

Packaging:

```sh
pnpm dist                # → release/*.zip (unsigned)
pnpm run dist:dmg        # → release/*.dmg (via system hdiutil)
pnpm run dist:dir        # unpacked .app, handy when debugging packaging
```

### Packaged artifacts

`pnpm dist` (local) and CI both produce per-platform packages:

| Platform | Runner | Artifacts |
|---|---|---|
| macOS (arm64) | `macos-latest` | `.zip`, `.dmg` |
| Windows (x64) | `windows-latest` | NSIS `.exe` installer, `.zip` |
| Linux (x64) | `ubuntu-latest` | `.AppImage`, `.tar.gz` |

Each package is built on its own native runner — cross-building native modules
(`node-pty`, `keytar`) is not reliable, so CI never cross-compiles.

## Development

```sh
pnpm run typecheck       # tsc --noEmit
pnpm test                # unit/integration (vitest)
pnpm run test:e2e        # end-to-end (Playwright drives the real Electron app)
pnpm run test:coverage   # coverage (thresholds are a ratchet)
pnpm run test:all        # typecheck + unit + build + e2e
```

Working with an AI agent? Read **[`AGENTS.md`](./AGENTS.md)** first — red lines, commands,
verification discipline, testing iron rules (tests lock *desired* behaviour, never current
behaviour), i18n and commit conventions. Human handover / project history:
**[`HANDOVER.md`](./HANDOVER.md)**.

## License

[MIT](./LICENSE) © 2026 suninx. Third-party components and bundled font licences:
[`THIRD-PARTY.md`](./THIRD-PARTY.md).
