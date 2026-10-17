#!/usr/bin/env bash
# bench/preflight.sh — 开台前体检(只读,不启动任何 GUI 应用)
#
# 用法: bash bench/preflight.sh
# 退出码恒为 0:这是"报告"不是"闸门"。看不看得起台由 up.sh 决定。

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

printf 'sshkit 对照台 preflight — %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
hr

fatal=0

# ---- 1. 原版参照物 ----
if [ -d "$TERMIUS_APP" ]; then
  v="$(termius_installed_version || echo '?')"
  arch="$(lipo -archs "$TERMIUS_APP/Contents/MacOS/Termius" 2>/dev/null || echo '?')"
  sig="$(codesign -dv "$TERMIUS_APP" 2>&1 | awk -F= '/^Identifier=/{print $2}')"
  ok "原版 Termius      $v  $arch  ${sig:-unsigned}"
else
  bad "原版 Termius      未找到: $TERMIUS_APP"
  dim "                  可用 TERMIUS_APP=/path/to/Termius.app 覆盖"
  fatal=1
fi

# ---- 2. sshkit 构建 ----
if [ -f "$ROOT/dist/main/main.js" ]; then
  head="$(git -C "$ROOT" log --oneline -1 2>/dev/null)"
  dirty="$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  ok "sshkit 构建        dist/main/main.js  ($head, 改动文件 $dirty)"
else
  bad "sshkit 构建        缺 dist/main/main.js → 先 pnpm run build"
  fatal=1
fi
[ -x "$ELECTRON_BIN" ] && ok "electron 二进制    $ELECTRON_BIN" || { bad "electron 二进制    缺 $ELECTRON_BIN"; fatal=1; }

# ---- 2.5 环境排雷:本机全局导出了 ELECTRON_RUN_AS_NODE ----
if [ -n "${ELECTRON_RUN_AS_NODE:-}" ]; then
  warn "ELECTRON_RUN_AS_NODE=$ELECTRON_RUN_AS_NODE(全局导出)"
  dim "                  后果:所有 Electron 应用的 main.js 会以纯 Node 执行 ——"
  dim "                  原版静默 exit 0(看起来像\"起不来\"),我方 app.getPath undefined 崩。"
  dim "                  up.sh/down.sh 已在子进程清除;手动起应用也要 env -u。"
else
  ok "ELECTRON_RUN_AS_NODE 未设置"
fi

# ---- 3. SSH 靶机(决定能对照到哪一层) ----
hosts_json="$HOME/Library/Application Support/sshkit/hosts.json"
targets=""
if [ -f "$hosts_json" ]; then
  targets="$(node -e '
    const fs=require("fs");
    try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const j=Array.isArray(d)?d:(d.hosts||[]);
    for(const h of j) if(h&&h.host) console.log(h.host+" "+(h.port||22));
    }catch(e){}' "$hosts_json" 2>/dev/null)"
fi

reachable=0; n=0
if [ -n "$targets" ]; then
  while read -r h p; do
    [ -n "$h" ] || continue
    n=$((n+1))
    if port_open "$h" "$p"; then reachable=$((reachable+1)); ok "SSH 靶机          $h:$p 可达"; else warn "SSH 靶机          $h:$p 不可达"; fi
  done <<< "$targets"
fi
port_open 127.0.0.1 22 && { ok "本机 sshd         127.0.0.1:22 可达"; reachable=$((reachable+1)); n=$((n+1)); }
if [ "$n" -eq 0 ]; then
  warn "SSH 靶机          未配置任何主机 → 只能做 LOCAL_SHELL 层对照"
fi
[ "$reachable" -gt 0 ] && mode="FULL(含 SSH/SFTP)" || mode="LOCAL_SHELL_ONLY"

# ---- 4. 证据通道 ----
if [ "${SKIP_CAPTURE_PROBE:-0}" = "1" ]; then
  dim "[–] 屏幕截图        跳过探针(SKIP_CAPTURE_PROBE=1)"
else
  probe="${TMPDIR:-/tmp}/sshkit-bench-capprobe.png"; rm -f "$probe"
  if screencapture -x "$probe" 2>/dev/null && [ -s "$probe" ]; then
    ok "屏幕截图          screencapture 可用(整屏/分区)"
  else
    warn "屏幕截图          screencapture 此刻失败(显示器睡眠/锁屏会导致)"
    dim "                  这是**瞬时**故障,不是授权问题:同机同参数几分钟后又能用。"
  fi
  rm -f "$probe"
fi

# 证据主通道是 CDP:逐窗口 PNG、无需任何系统授权、还能读窗口几何。screencapture 只作兜底。
if cdp_alive "$TERMIUS_CDP_PORT" || cdp_alive "$SSHKIT_CDP_PORT"; then
  ok "CDP 证据通道      已有端点在线"
else
  dim "[–] CDP 证据通道      当前无端点(开台后由 up.sh 实测)"
fi

# 辅助功能:只对"UI 元素"(窗口)访问有意义。本检查早期版本只问 frontmost 即算通过 ——
# 太弱:该调用并不需要辅助功能,于是误报"摆位可用",而真正的窗口操作被拒 -25211。
if osascript -e 'tell application "System Events" to return (count of windows of process "Finder")' >/dev/null 2>&1; then
  ok "辅助功能          可用 → AppleScript 可摆任意窗口"
else
  warn "辅助功能          未授权(-25211)→ 不能用 AppleScript 摆窗口"
  dim "                 影响已缩小:sshkit 侧靠 SSHKIT_BENCH_BOUNDS 自摆(已实现),"
  dim "                 原版侧用 CDP 读几何 + 你手动拖一次,不阻塞对照。"
  dim "                 要全自动:系统设置→隐私与安全性→辅助功能→勾选 DeepSeek Harness。"
fi

# ---- 5. CDP 端口 ----
if port_open 127.0.0.1 "$TERMIUS_CDP_PORT"; then
  if [ -n "$(termius_pids)" ] && cdp_alive "$TERMIUS_CDP_PORT"; then
    ok "端口 $TERMIUS_CDP_PORT(原版)  你自己的原版实例正开着 CDP → up.sh 会沿用"
  else
    used="$(cdp_alive "$TERMIUS_CDP_PORT" && echo '是 CDP' || echo '非 CDP 占用')"
    warn "端口 $TERMIUS_CDP_PORT(原版)  已被占用($used)→ 改 TERMIUS_CDP_PORT"
  fi
else
  ok "端口 $TERMIUS_CDP_PORT(原版)  空闲"
fi
if port_open 127.0.0.1 "$SSHKIT_CDP_PORT"; then
  used="$(cdp_alive "$SSHKIT_CDP_PORT" && echo '是 CDP' || echo '非 CDP 占用')"
  warn "端口 $SSHKIT_CDP_PORT(sshkit) 已被占用($used)→ 改 SSHKIT_CDP_PORT"
else
  ok "端口 $SSHKIT_CDP_PORT(sshkit) 空闲"
fi

# ---- 6. 摆位几何 ----
read -r SW SH <<< "$(screen_geometry)"
half=$((SW / 2)); wh=$((SH - MENUBAR_H))
if [ "$SW" -lt 1400 ]; then warn "屏幕宽度 $SW 偏窄 → 左右各 $half,内容会挤"; fi
hr
printf '屏幕 %sx%s(点) → 左 %s,%s,%s,%s | 右 %s,%s,%s,%s\n' \
  "$SW" "$SH" 0 "$MENUBAR_H" "$half" "$wh" "$half" "$MENUBAR_H" "$half" "$wh"
if [ "$SWAP" = "1" ]; then dim "SWAP=1 → 原版放右"; else dim "左=原版(参照) 右=sshkit(受验)"; fi
dim "摆位分工:sshkit 自摆(SSHKIT_BENCH_BOUNDS,自动与原版同尺寸);原版手动拖一次。"
printf '对照层级: %s\n' "$mode"
[ "$fatal" -eq 0 ] && ok "体检通过 → bash bench/up.sh" || bad "有致命项未过 → 先修上面标 ✗ 的"
