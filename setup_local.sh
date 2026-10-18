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
echo 'EPICAST_ARTIFACT=/absolute/model/path .venv-apple/bin/python -m src.api.app'
