#!/usr/bin/env bash
# Swift application server; model processes remain independently supervised.
set -euo pipefail
cd "$(dirname "$0")"
export EPICAST_ROOT="$PWD"
server="${EPICAST_SERVER_BIN:-$PWD/native/Server/dist/EpiCastServer}"
if [[ ! -x "$server" ]]; then
    echo 'Build the native server first: bash native/Server/build.sh' >&2
    exit 1
fi
exec "$server" "$@"
