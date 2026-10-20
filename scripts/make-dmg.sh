#!/usr/bin/env bash
# 用系统 hdiutil 把已打包的 .app 做成 DMG(不依赖第三方工具)。
# 前置:先跑 `pnpm dist`(产物在 release/mac-arm64/sshkit.app)。
set -euo pipefail
cd "$(dirname "$0")/.."

APP="release/mac-arm64/sshkit.app"
VERSION="$(python3 -c "import json;print(json.load(open('package.json'))['version'])")"
OUT="release/sshkit-${VERSION}-arm64.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

[ -d "$APP" ] || { echo "未找到 $APP,请先执行 pnpm dist" >&2; exit 1; }

cp -R "$APP" "$STAGE/sshkit.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -quiet -volname "sshkit" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT"
echo "已生成: $OUT"
hdiutil verify -quiet "$OUT" && echo "校验通过"
