#!/usr/bin/env bash
# bench/cdp.sh — 列/存双侧 CDP targets(对照台的证据入口)
#
# 用法:
#   bash bench/cdp.sh                    # 人读:双侧 target 清单
#   bash bench/cdp.sh --save             # 存进 bench/sessions/<时间戳>/targets-*.json
#   bash bench/cdp.sh --port 9222        # 只看一侧
#
# 交给 REA 的后续动作(target_id 从这里取):
#   capture_web_screenshot / inspect_web_page / capture_browser_scenario
#   → 再用 compare_web_screenshots / compare_web_captures 做量化对照

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SAVE=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --save) SAVE=1; shift ;;
    --port) ONLY="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) bad "未知参数: $1"; exit 2 ;;
  esac
done

show_port() { # 名称 端口
  local name="$1" port="$2"
  if ! cdp_alive "$port"; then
    warn "$name http://127.0.0.1:$port  —— 无 CDP 响应"
    return 1
  fi
  ok "$name http://127.0.0.1:$port"
  cdp_json "$port" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      let j; try{ j=JSON.parse(s);}catch(e){ console.log("  (JSON 解析失败)"); return; }
      if(!Array.isArray(j)||!j.length){ console.log("  (无 target)"); return; }
      const pick=(o,...ks)=>{for(const k of ks) if(o&&o[k]!=null&&o[k]!=="") return o[k]; return "-";};
      for(const t of j){
        console.log("  • " + pick(t,"type") + "  " + String(pick(t,"title")).slice(0,60));
        console.log("      id  : " + pick(t,"id"));
        console.log("      url : " + String(pick(t,"url")).slice(0,120));
      }
    });' 2>/dev/null
}

if [ -n "$ONLY" ]; then
  show_port "指定" "$ONLY"
else
  printf 'CDP targets — %s\n' "$(date '+%H:%M:%S')"
  hr
  show_port "原版  " "$TERMIUS_CDP_PORT"
  echo
  show_port "sshkit" "$SSHKIT_CDP_PORT"
fi

if [ "$SAVE" = "1" ]; then
  hr
  d="$(session_dir)"
  for spec in "termius $TERMIUS_CDP_PORT" "sshkit $SSHKIT_CDP_PORT"; do
    name="${spec%% *}"; port="${spec##* }"
    if cdp_alive "$port"; then
      cdp_json "$port" > "$d/targets-$name-$port.json" && dim "存 $d/targets-$name-$port.json"
    fi
  done
  printf '本次会话证据目录: %s\n' "$d"
fi
