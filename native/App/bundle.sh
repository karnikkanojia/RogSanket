#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release
app="$PWD/dist/EpiCast.app"
mkdir -p "$app/Contents/MacOS"
cp .build/release/EpiCast "$app/Contents/MacOS/EpiCast"
cp Info.plist "$app/Contents/Info.plist"
codesign --force --sign - "$app"
echo "$app"
