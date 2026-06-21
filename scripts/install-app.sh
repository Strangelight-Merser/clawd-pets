#!/usr/bin/env bash
# 打包并把 Clawd Pets 安装到「应用程序」，然后打开——之后从 Launchpad / 聚焦搜索 / 访达 即可直接启动。
# 跑：npm run app
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ 打包（electron-builder）…"
npm run pack

APP="$(find dist -maxdepth 2 -name 'Clawd Pets.app' -type d 2>/dev/null | head -1)"
[ -n "$APP" ] || { echo "✗ 未找到构建产物 (dist/**/Clawd Pets.app)"; exit 1; }

DEST="/Applications"
if [ ! -w "$DEST" ]; then DEST="$HOME/Applications"; mkdir -p "$DEST"; echo "▸ /Applications 不可写，改装到 $DEST"; fi

rm -rf "$DEST/Clawd Pets.app"
cp -R "$APP" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/Clawd Pets.app" 2>/dev/null || true   # 本地构建清隔离属性，免首次 Gatekeeper 拦

echo "✓ 已安装到 $DEST/Clawd Pets.app"
echo "  现在可从 Launchpad / 聚焦搜索（⌘Space 搜 \"Clawd\"）/ 访达「应用程序」直接打开。"
open "$DEST/Clawd Pets.app"
