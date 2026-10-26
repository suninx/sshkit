# sshkit

[中文](./README.md) | **English**

A **local-first** SSH client for macOS. Everything stays on your machine — no accounts, no cloud
sync, no telemetry. Electron + TypeScript + xterm, an **original implementation**.

> Behaviour informed by a local, read-only study of a commercial SSH terminal.
> **No code, binaries, or assets from that product are reused here.**

## Status

`0.1.0-rc.3` (pre-release) → [Releases](https://github.com/suninx/sshkit/releases)

## Screenshots

| Host book | Terminal |
|---|---|
| ![Host book](./docs/screenshots/hosts.png) | ![Terminal](./docs/screenshots/terminal.png) |

| Broadcast input (two hosts at once) | MCP (AI integration) |
|---|---|
| ![Broadcast input](./docs/screenshots/broadcast-input.png) | ![MCP section](./docs/screenshots/mcp.png) |

## Features

### Connections & terminal
- **SSH**: password / private key / ssh-agent; known-hosts verification (TOFU prompt, hashed
  entries, import from another `known_hosts`); automatic reconnect
- **Terminal**: xterm, 64 colour schemes, adjustable font & size (3 bundled Nerd Fonts),
  5000-line scrollback, search, horizontal split panes
- **Broadcast input**: right-click several session tabs → *Join broadcast input*; typing in any
  of them runs the same input on every host in the group. Dangerous commands
  (`rm -rf` / `mkfs` / `dd of=` / `shutdown` / fork bombs …) ask for confirmation before Enter
- **Multi-host command panel**: pick hosts, run one command in parallel or serially, compare
  results side by side (exit code / duration / output) — no terminal tabs required

### Files & network
- **SFTP**: dual-pane local ↔ remote browser with recursive transfer, resume, conflict policy
  (overwrite / skip / rename), drag-and-drop upload, queue + cancel, context menu
  (open / rename / delete / download / upload / chmod), reload
- **Port forwarding**: local / remote / dynamic (built-in SOCKS5), persistent rules, live status

### Organisation
- **Host book**: groups, tags, search, edit/delete; credentials in the system keychain
- **Encrypted backup**: export/import the whole host book from *Host book → More*. Export asks for a
  password and encrypts with **AES-256-GCM** (scrypt-derived key); stored passwords/passphrases and
  private key files are included. Import asks for the same password and dedupes by host
- **Snippets**, **logs**, **known-hosts** management
- **Right side panel (two-panel mode)**: appearance (font / size / themes), snippets, jump-to
- **Appearance**: dark/light UI, terminal themes, font and size; shared with the side panel
- **i18n**: 中文 / English, switchable at runtime (follows the system by default)

### MCP (AI integration)
sshkit can act as an **MCP server** so AI assistants can drive your servers:

- **Two transports**:
  - Streamable HTTP: `POST/GET/DELETE http://127.0.0.1:7788/stream` (`/mcp` kept as an alias)
  - Legacy HTTP+SSE: `GET http://127.0.0.1:7788/sse` + `POST /messages?sessionId=…`
  - Auth: `Authorization: Bearer <token>` (token in the system keychain); client configs can be
    **copied per protocol** from the UI
- **12 tools**: 4 read (`list_hosts` / `sftp_list` / `sftp_read_file` / `sftp_stat`),
  7 write (`sftp_mkdir` / `sftp_rename` / `sftp_remove` / `sftp_chmod` / `sftp_write_file` /
  `sftp_upload` / `sftp_download`), 1 exec (`ssh_exec`)
- **Visible**: live activity stream in the MCP section; `ssh_exec` opens an *AI exec* tab that
  replays output and can be **taken over** into a real interactive terminal
- **Three policies**: read-only / standard (approve writes & exec) / full auto
- **STOP**: abort every in-flight call
- **Audit**: one JSONL line per call in `userData/mcp-audit.jsonl` (arguments redacted)
- **Port**: default 7788; if taken, it falls forward to the next free port and persists the choice,
  showing “port X was occupied — using Y” in the UI
- **Credentials never pass through MCP**: tools take host ids/names only; secrets stay in the
  local keychain

## Install

### Prebuilt packages

| Platform | Installer | Portable (no install) |
|---|---|---|
| macOS (Apple Silicon) | `sshkit-*-arm64-mac.dmg` (open, drag into Applications) | `sshkit-*-arm64-mac.zip` (unzip and run) |
| Windows x64 | `sshkit Setup *.exe` (NSIS installer) | `sshkit *.exe` (single-file portable) or `sshkit-*-win.zip` |
| Linux x64 | — | `sshkit-*.AppImage` or `.tar.gz` |

> Pre-release builds are **unsigned**: on macOS right-click → Open the first time; Windows
> SmartScreen will warn.

### From source

Requirements: **Node ≥ 22.12**, **pnpm 11**.

```sh
pnpm install
pnpm run rebuild:pty     # rebuild node-pty for the Electron ABI
pnpm start               # build + launch
```

Packaging (output in `release/`):

```sh
pnpm dist                # current platform zip (unsigned)
pnpm run dist:dmg        # macOS dmg (built from release/mac-arm64/sshkit.app)
pnpm run dist:dir        # unpacked .app for debugging
```

CI also produces, per platform: macOS **dmg + zip**; Windows **NSIS Setup exe + portable exe + zip**;
Linux **AppImage + tar.gz**.

CI builds all three platforms on native runners (macOS arm64 / Windows x64 / Linux x64):
`test`, `e2e`, `package` × 3 platforms.

## Development

```sh
pnpm run typecheck       # tsc --noEmit
pnpm test                # unit / integration (vitest)
pnpm run test:e2e        # end-to-end (Playwright drives the real Electron app)
pnpm run test:coverage   # coverage (thresholds fixed at 100%)
pnpm run test:all        # typecheck + unit + build + e2e
```

Conventions and red lines: **[`AGENTS.md`](./AGENTS.md)** (tests lock *desired* behaviour,
coverage never discounted, every bug fix ships a regression test, bilingual i18n, commit style).
Project history / handover: **[`HANDOVER.md`](./HANDOVER.md)**.

## Known limitations

- **MFA / keyboard-interactive is not supported** yet — servers with 2FA cannot be reached
- Not planned: serial, `~/.ssh/config` import, key generation/import, certificates / Touch ID /
  FIDO2, ProxyJump, mosh
- Packages are unsigned

## License

[Apache License 2.0](./LICENSE) © 2026 suninx — see [NOTICE](./NOTICE).

Third-party components and bundled font licences: [`THIRD-PARTY.md`](./THIRD-PARTY.md).
