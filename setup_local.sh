#!/usr/bin/env bash
# Native Apple Silicon runtime; model provisioning is explicit and separate.
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "Native ARM64 macOS is required." >&2
  exit 1
fi
command -v uv >/dev/null || { echo "Install uv first: https://docs.astral.sh/uv/" >&2; exit 1; }
uv venv --python 3.14 .venv-apple
uv pip sync --python .venv-apple/bin/python requirements-apple.lock
echo 'Runtime installed. Provision verified artifacts using docs/apple-silicon.md.'
echo 'Build the application server: bash native/Server/build.sh'
echo 'Start it: EPICAST_ARTIFACT=/absolute/model/path ./run_local.sh'
echo 'Build the native UI in another terminal: bash native/App/bundle.sh'
echo 'Open the app: open native/App/dist/EpiCast.app'
