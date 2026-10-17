#!/usr/bin/env bash
# bench/shot.sh — 像素通道:按"我们自己设定的几何"分区截双侧,落进会话证据目录
#
# 为什么靠 -R 而不是窗口 ID:窗口位置是 up.sh 自己摆的,坐标已知;
# 不需要辅助功能去查窗口 ID(那条路还依赖 CGWindowID 工具)。
#
# 用法:
#   bash bench/shot.sh                 # 截左(原版)+ 右(sshkit)
#   bash bench/shot.sh --full          # 另存整屏
#   bash bench/shot.sh --side left     # 只截一侧
#   bash bench/shot.sh --tag t3-tabs   # 给本次截图加标签(便于写进 FINDINGS.md)
#
# 注意:瞬时失败是真实存在的(见 lib.sh 头部)。本脚本失败时明确报错,不产出空证据。

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

FULL=0; SIDE="both"; TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1; shift ;;
    --side) SIDE="${2:-both}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) bad "未知参数: $1"; exit 2 ;;
  esac
done

read -r SW SH <<< "$(screen_geometry)"
half=$((SW / 2)); wh=$((SH - MENUBAR_H))
if [ "$SWAP" = "1" ]; then TNAME="right"; KNAME="left"; TX=$half; KX=0; else TNAME="left"; KNAME="right"; TX=0; KX=$half; fi

d="$(session_dir)" || { bad "无法创建会话目录 $SESSIONS"; exit 1; }
stamp="$(date +%H%M%S)"
tagpart=""; [ -n "$TAG" ] && tagpart="-$TAG"
fail=0

grab() { # 名称 x y w h
  local name="$1" x="$2" y="$3" w="$4" h="$5" out
  out="$d/${stamp}-${name}${tagpart}.png"
  if screencapture -x -R "$x,$y,$w,$h" "$out" 2>/dev/null && [ -s "$out" ]; then
    ok "$(basename "$out")  ${w}x${h}  $(du -h "$out" | awk '{print $1}')"
  else
    bad "截图失败: $name(显示器睡眠/锁屏会导致此错;唤醒后重试)"
    rm -f "$out"; fail=1
  fi
}

printf '对照台截图 — %s\n' "$(date '+%H:%M:%S')"
hr
case "$SIDE" in
  both|left|-l)  grab "termius-$TNAME" "$TX" "$MENUBAR_H" "$half" "$wh" ;;
esac
case "$SIDE" in
  both|right|-r) grab "sshkit-$KNAME" "$KX" "$MENUBAR_H" "$half" "$wh" ;;
esac
if [ "$FULL" = "1" ]; then grab "fullscreen" 0 0 "$SW" "$SH"; fi
hr
printf '证据目录: %s\n' "$d"
[ "$fail" -eq 0 ] || exit 1
