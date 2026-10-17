#!/usr/bin/env bash
# bench/up.sh — 开台:双开 + 同尺寸并排 + 打通 CDP 证据通道
#
# 用法:
#   bash bench/up.sh                    # 构建 + 双开 + 按原版几何并排(sshkit 侧用真实档案)
#   bash bench/up.sh --no-build
#   bash bench/up.sh --termius-only | --sshkit-only
#   bash bench/up.sh --isolated-profile # sshkit 侧改用 bench/profile,不碰你的主机簿
#   SWAP=1 bash bench/up.sh             # 原版在右、sshkit 在左
#
# 收台: bash bench/down.sh

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DO_BUILD=1; WANT_TERMIUS=1; WANT_SSHKIT=1; USE_REAL=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --termius-only) WANT_SSHKIT=0 ;;
    --sshkit-only) WANT_TERMIUS=0 ;;
    --isolated-profile) USE_REAL=0 ;;
    --use-real-profile) USE_REAL=1 ;;   # 兼容旧写法(现已是默认)
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) bad "未知参数: $arg"; exit 2 ;;
  esac
done

mkdir -p "$RUN_DIR"
printf 'sshkit 对照台开台 — %s\n' "$(date '+%H:%M:%S')"
hr

# ---- 0. 环境排雷(实测踩过的坑) ----
if [ -n "${ELECTRON_RUN_AS_NODE:-}" ]; then
  warn "检测到 ELECTRON_RUN_AS_NODE=$ELECTRON_RUN_AS_NODE → 子进程已清除"
  dim "        不清的话所有 Electron 应用退化成纯 Node 跑 main.js:"
  dim "        原版静默 exit 0;我方 TypeError: Cannot read properties of undefined (reading 'getPath')"
fi

# ---- 1. 构建 ----
if [ "$DO_BUILD" = "1" ] && [ "$WANT_SSHKIT" = "1" ]; then
  printf '构建中 … '
  if (cd "$ROOT" && pnpm run build >"$RUN_DIR/build.log" 2>&1); then ok "构建完成"; else bad "构建失败 → $RUN_DIR/build.log"; exit 1; fi
fi

# ---- 2. sshkit 档案选择 ----
UD="$BENCH_PROFILE"
if [ "$USE_REAL" = "1" ]; then
  UD="$REAL_UD"
  if [ -n "$(sshkit_pids)" ]; then
    bad "你已有 sshkit 实例在跑,不能占用真实档案(hosts.json 会互相覆盖)"
    dim "        先 bash bench/down.sh,或去掉 --use-real-profile 用默认隔离档案"
    exit 1
  fi
fi
mkdir -p "$UD"

# ---- 3. 起原版(直启:便于拿 pid 与 stderr) ----
if [ "$WANT_TERMIUS" = "1" ]; then
  if [ -n "$(termius_pids)" ]; then
    warn "原版已在运行 → 沿用;CDP 开关需重启才生效"
  elif [ -d "$TERMIUS_APP" ]; then
    ( gui "$TERMIUS_APP/Contents/MacOS/Termius" --remote-debugging-port="$TERMIUS_CDP_PORT" >"$RUN_DIR/termius.log" 2>&1 & echo $! >"$RUN_DIR/termius.pid" )
    sleep 1
    ok "原版已启动(pid $(cat "$RUN_DIR/termius.pid" 2>/dev/null))端口 $TERMIUS_CDP_PORT"
  else
    bad "原版未找到: $TERMIUS_APP"
  fi
fi

# ---- 4. 读原版窗口几何(CDP 能读不能移:Electron 未实现 Browser.setWindowBounds) ----
OW=""; OH=""; OX=""; OY=""
if [ "$WANT_TERMIUS" = "1" ]; then
  for _ in $(seq 1 15); do cdp_alive "$TERMIUS_CDP_PORT" && break; sleep 1; done
  if cdp_alive "$TERMIUS_CDP_PORT"; then
    g="$(node "$ROOT/bench/grab.mjs" --port "$TERMIUS_CDP_PORT" --url-match primary --geom 2>/dev/null)"
    read -r OW OH OX OY <<< "$(printf '%s' "$g" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s).geom;console.log([j.ow,j.oh,j.sx,j.sy].join(" "))}catch(e){console.log("")}})')"
  fi
  if [ -n "${OW:-}" ]; then ok "原版窗口几何 ${OW}x${OH} @ (${OX},${OY})"; else warn "读不到原版几何 → sshkit 侧退回右半屏"; fi
fi

# ---- 5. 起 sshkit(默认与原版同尺寸并排;几何经 SSHKIT_BENCH_BOUNDS 注入,不依赖辅助功能) ----
read -r SW SH <<< "$(screen_geometry)"
PLACE_NOTE=""
if [ -n "${OW:-}" ]; then
  bw="$OW"; bh="$OH"; by="$OY"
  # 优选"与原版同尺寸 + 紧贴";两侧都放不下才贴屏缘并明确提示重叠
  right_ok=0; left_ok=0
  [ $((OX + OW + OW)) -le "$SW" ] && right_ok=1
  [ $((OX - OW)) -ge 0 ] && left_ok=1
  if [ "$SWAP" = "1" ]; then want=left; else want=right; fi
  if [ "$want" = "right" ] && [ "$right_ok" = "1" ]; then bx=$((OX + OW)); PLACE_NOTE="紧贴原版右侧"
  elif [ "$want" = "left" ] && [ "$left_ok" = "1" ]; then bx=$((OX - OW)); PLACE_NOTE="紧贴原版左侧"
  elif [ "$want" = "right" ] && [ "$left_ok" = "1" ]; then bx=$((OX - OW)); PLACE_NOTE="右侧放不下 → 改贴原版左侧"
  elif [ "$want" = "left" ] && [ "$right_ok" = "1" ]; then bx=$((OX + OW)); PLACE_NOTE="左侧放不下 → 改贴原版右侧"
  else
    bx=$((SW - OW)); [ "$bx" -lt 0 ] && bx=0
    PLACE_NOTE="贴屏幕右缘(与原版有重叠)"
    warn "原版停在屏幕中间,左右都塞不下同尺寸窗口 → sshkit 贴右缘,会与原版重叠"
    dim "        把原版窗口拖到左半屏即可完美并排(sshkit 已是同尺寸 ${bw}x${bh},不用再动)"
  fi
else
  bw=$((SW / 2)); bh=$((SH - MENUBAR_H)); by=$MENUBAR_H
  if [ "$SWAP" = "1" ]; then bx=0; else bx=$((SW / 2)); fi
  PLACE_NOTE="无原版几何 → 占半屏"
fi

if [ "$WANT_SSHKIT" = "1" ]; then
  if [ -n "$(sshkit_pids)" ]; then
    warn "sshkit 已在运行 → 沿用(该实例没有 CDP;要 CDP 需先收台)"
  else
    ( cd "$ROOT" && gui SSHKIT_BENCH_BOUNDS="$bx,$by,$bw,$bh" "$ELECTRON_BIN" . \
        --remote-debugging-port="$SSHKIT_CDP_PORT" --user-data-dir="$UD" >"$RUN_DIR/sshkit.log" 2>&1 & echo $! >"$RUN_DIR/sshkit.pid" )
    sleep 1
    ok "sshkit 已启动(pid $(cat "$RUN_DIR/sshkit.pid" 2>/dev/null))${bw}x${bh} @ (${bx},${by})·${PLACE_NOTE}"
    dim "        档案 $UD"
  fi
fi

# ---- 6. CDP 通道实测 ----
hr
printf 'CDP 证据通道\n'
for spec in "原版:$TERMIUS_CDP_PORT:$WANT_TERMIUS" "sshkit:$SSHKIT_CDP_PORT:$WANT_SSHKIT"; do
  IFS=: read -r name port want <<< "$spec"
  [ "$want" = "1" ] || continue
  alive=0
  for _ in $(seq 1 15); do cdp_alive "$port" && { alive=1; break; }; sleep 1; done
  if [ "$alive" = "1" ]; then
    n="$(cdp_json "$port" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).filter(t=>t.type==="page").length)}catch(e){console.log("?")}})')"
    ok "$name  http://127.0.0.1:$port  page targets=$n"
  else
    bad "$name  http://127.0.0.1:$port  未开放 → 看 $RUN_DIR/{termius,sshkit}.log"
  fi
done

hr
dim "抓证据: node bench/grab.mjs --port $TERMIUS_CDP_PORT --url-match primary --out /tmp/shot-termius.png"
dim "        node bench/grab.mjs --port $SSHKIT_CDP_PORT --out /tmp/shot-sshkit.png"
dim "协议: bench/PROTOCOL.md   ·   收台: bash bench/down.sh"
[ -n "${OW:-}" ] && dim "原版窗口位置由原版自己决定;要严格并排就把它拖到 sshkit 旁边(或授了辅助功能后由 AppleScript 摆)。"
