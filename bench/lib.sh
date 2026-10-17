#!/usr/bin/env bash
# bench/lib.sh — 对照台共用库(source 用,不要直接跑)
#
# 设计约束(实测得来,别改成想当然):
#   * screencapture 可用,但**会瞬时失败**:2026-10-17 12:22 曾报
#     "could not create image from display"(显示器睡眠/锁屏态),12:27 同机同参数又正常。
#     → preflight 每次实探;任何脚本都不得把"截屏一定成功"写死。
#     区域截图 -R 实测精确:screencapture -x -R 0,25,1720,1415 → 1720x1415。
#   * osascript/System Events 可用 → 窗口摆位可靠。
#   * 原版 Electron fuse: EnableNodeCliInspectArguments=disabled(故 --inspect 无效),
#     ASAR 完整性=enforced(故不可改原版 app.asar);--remote-debugging-port 是另一回事,
#     由 preflight/up 实测判定,不预设结论。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- 可覆盖配置 ----
TERMIUS_APP="${TERMIUS_APP:-$HOME/workspace/termius-rea/payload/Termius.app}"
TERMIUS_CDP_PORT="${TERMIUS_CDP_PORT:-9222}"
SSHKIT_CDP_PORT="${SSHKIT_CDP_PORT:-9223}"
TERMIUS_PROC="${TERMIUS_PROC:-Termius}"      # System Events 里的进程名
SSHKIT_PROC="${SSHKIT_PROC:-Electron}"       # 未设 productName,故为 Electron
MENUBAR_H="${MENUBAR_H:-25}"                 # 菜单栏高度(点)
SWAP="${SWAP:-0}"                            # 1 = 原版放右、sshkit 放左
SSHKIT_LOG="${SSHKIT_LOG:-${TMPDIR:-/tmp}/sshkit-bench-sshkit.log}"
SESSIONS="$ROOT/bench/sessions"
RUN_DIR="$ROOT/bench/.run"                              # pid/日志(不入库)
REAL_UD="$HOME/Library/Application Support/sshkit"      # 你日常那份档案
BENCH_PROFILE="${SSHKIT_UD:-$ROOT/bench/profile}"       # 对照台默认隔离档案:不碰你的实例
ELECTRON_BIN="$ROOT/node_modules/.bin/electron"

# 本机实测:ELECTRON_RUN_AS_NODE=1 是全局导出的。不清掉的话,所有 Electron 应用的
# main.js 都会以纯 Node 执行 —— 原版静默 exit 0,我方 app.getPath 直接 undefined 崩。
# 凡启动 GUI 应用一律走 gui;可顺手传 VAR=VAL(env 直接支持该形式,不必套两层 env)。
gui() { nohup env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS "$@"; }

# ---- 输出 ----
if [ -t 1 ]; then C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_BAD=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'; else C_OK=; C_WARN=; C_BAD=; C_DIM=; C_OFF=; fi
ok()   { printf '%s[✓]%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%s[!]%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
bad()  { printf '%s[✗]%s %s\n' "$C_BAD" "$C_OFF" "$*"; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
hr()   { printf '%s\n' "────────────────────────────────────────────────────────────"; }

# ---- 屏幕几何(点,非像素) ----
# 优先 "UI Looks like"(Retina 下的逻辑点空间),回退 "Resolution"。
screen_geometry() {
  local out res w h
  out="$(system_profiler SPDisplaysDataType 2>/dev/null)"
  res="$(printf '%s\n' "$out" | grep -m1 -oE 'UI Looks like: [0-9]+ x [0-9]+' | grep -oE '[0-9]+ x [0-9]+')"
  [ -n "$res" ] || res="$(printf '%s\n' "$out" | grep -m1 -oE 'Resolution: [0-9]+ x [0-9]+' | grep -oE '[0-9]+ x [0-9]+')"
  if [ -z "$res" ]; then printf '1920 1080\n'; return; fi
  w="${res%% x *}"; h="${res##* x }"
  case "$w$h" in ''|*[!0-9]*) w=1920; h=1080 ;; esac
  printf '%s %s\n' "$w" "$h"
}

# ---- 网络/端口 ----
port_open() { nc -z -G 2 "$1" "$2" >/dev/null 2>&1; }

# CDP target 列表;失败返回非 0
cdp_json() { curl -fsS --max-time 3 "http://127.0.0.1:$1/json/list" 2>/dev/null; }
cdp_alive() { cdp_json "$1" >/dev/null 2>&1; }

# ---- 窗口 ----
app_running() { pgrep -x "$1" >/dev/null 2>&1 || pgrep -f "MacOS/$1" >/dev/null 2>&1; }

window_exists() {
  osascript -e "tell application \"System Events\" to return (count of windows of process \"$1\")" 2>/dev/null | grep -qE '^[1-9]'
}

wait_window() { # PROC 超时秒
  local proc="$1" limit="${2:-20}" i=0
  while [ "$i" -lt "$((limit * 2))" ]; do
    window_exists "$proc" && return 0
    sleep 0.5; i=$((i + 1))
  done
  return 1
}

place_window() { # PROC x y w h
  local proc="$1" x="$2" y="$3" w="$4" h="$5"
  osascript >/dev/null 2>&1 <<APPLESCRIPT || return 1
tell application "System Events"
  tell process "$proc"
    set frontmost to true
    set position of window 1 to {$x, $y}
    set size of window 1 to {$w, $h}
  end tell
end tell
APPLESCRIPT
}

# 原版只退出"我们这份 payload"起的实例,绝不误杀用户另装的 Termius
# ⚠️ 必须用 pgrep(pgrep 会排除自身);曾用 ps|awk 匹配,awk 自己的 argv 含该路径 → 自我命中,
#    导致 up.sh 误判"已在运行"而根本不起应用(2026-10-17 实测踩过)。
termius_pids() {
  pgrep -f "$TERMIUS_APP/Contents/MacOS/Termius" 2>/dev/null
}

termius_installed_version() {
  [ -f "$TERMIUS_APP/Contents/Info.plist" ] || return 1
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$TERMIUS_APP/Contents/Info.plist" 2>/dev/null
}

# 我方仓库内的 electron 进程(路径锚定,避免误杀其它 Electron 应用)
# ⚠️ 同样必须用 pgrep:旧 ps|awk 版自身 argv 同时含 node_modules 与 "electron" 两个匹配条件
#    → 自我命中,up.sh 因此误判并把"未启动"当"已启动"(2026-10-17 实测踩过)。
sshkit_pids() {
  pgrep -f "$ROOT/node_modules/.pnpm/electron" 2>/dev/null
}

session_dir() { # 新建并回显本次会话证据目录
  local d="$SESSIONS/$(date +%Y-%m-%d_%H%M%S)"
  mkdir -p "$d" && printf '%s\n' "$d"
}
