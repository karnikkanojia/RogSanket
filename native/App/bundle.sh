#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
build_dir="${EPICAST_SWIFT_BUILD_DIR:-$PWD/.build}"
swift build -c release --scratch-path "$build_dir" -j "${EPICAST_SWIFT_BUILD_JOBS:-2}"
bin_dir="$(swift build -c release --scratch-path "$build_dir" --show-bin-path)"
app="$PWD/dist/EpiCast.app"
mkdir -p "$app/Contents/MacOS"
cp "$bin_dir/EpiCast" "$app/Contents/MacOS/EpiCast"
cp Info.plist "$app/Contents/Info.plist"
codesign --force --sign - "$app"
echo "$app"
