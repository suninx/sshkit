#!/usr/bin/env bash
# bench/down.sh — 收台:只关"本仓 electron"与"本 payload 原版",绝不误杀别的应用
#
# 用路径锚定 + pgrep(pgrep 排除自身)。不发 Apple 事件(那要 Automation 授权),
# 直接对锚定到的 pid 发 TERM,超时再 KILL。
#
# 用法: bash bench/down.sh [--keep-termius] [--keep-sshkit]

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

KEEP_T=0; KEEP_K=0
for arg in "$@"; do
  case "$arg" in
    --keep-termius) KEEP_T=1 ;;
    --keep-sshkit) KEEP_K=1 ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) bad "未知参数: $arg"; exit 2 ;;
  esac
done

printf 'sshkit 对照台收台 — %s\n' "$(date '+%H:%M:%S')"
hr

reap() { # 显示名 取pid函数名
  local name="$1" fn="$2" pids
  pids="$($fn)"
  if [ -z "$pids" ]; then dim "$name 未在运行"; return 0; fi
  dim "$name pids: $(printf '%s' "$pids" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  for _ in $(seq 1 12); do sleep 0.5; [ -z "$($fn)" ] && break; done
  if [ -n "$($fn)" ]; then
    warn "$name 未响应 TERM → KILL"
    # shellcheck disable=SC2086
    kill -9 $($fn) 2>/dev/null
    sleep 0.5
  fi
  [ -z "$($fn)" ] && ok "$name 已收" || bad "$name 仍在"
}

if [ "$KEEP_K" = "1" ]; then dim "保留 sshkit"; else reap "sshkit" sshkit_pids; fi
if [ "$KEEP_T" = "1" ]; then dim "保留原版"; else reap "原版  " termius_pids; fi

# 清 pid/日志残留(只删本仓 .run 下的记录文件,不删证据)
if [ -d "$RUN_DIR" ]; then
  rm -f "$RUN_DIR"/termius.pid "$RUN_DIR"/sshkit.pid
  dim "已清 $RUN_DIR 下的 pid 记录(日志保留)"
fi
hr
