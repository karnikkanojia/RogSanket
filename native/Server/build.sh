#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
build_dir="${EPICAST_SERVER_BUILD_DIR:-$PWD/.build}"
swift build -c release --scratch-path "$build_dir" -j "${EPICAST_SWIFT_BUILD_JOBS:-2}"
bin_dir="$(swift build -c release --scratch-path "$build_dir" --show-bin-path)"
mkdir -p dist
cp "$bin_dir/EpiCastServer" dist/EpiCastServer
# A previous test build can leave this resource beside production bundles.
rm -rf dist/EpiCastServer_ServerCoreTests.bundle
for resource in "$bin_dir"/*.bundle; do
    [[ "$resource" == *Tests.bundle ]] && continue
    if [[ -d "$resource" ]]; then
        ditto "$resource" "dist/$(basename "$resource")"
    fi
done
codesign --force --sign - dist/EpiCastServer
echo "$PWD/dist/EpiCastServer"
