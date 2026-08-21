#!/usr/bin/env bash
# Shared helpers for Fireweave SDK scripts (macOS + Linux, bash 3.2+).
# Sourced by test-all.sh / conformance-all.sh / build-all.sh — not executable.

set -euo pipefail

# Repo root = parent of the scripts/ directory containing this file.
FW_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export FW_ROOT

fw_section() {
  printf '\n\033[1;36m==> %s\033[0m\n' "$*"
}

fw_warn() {
  printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2
}

fw_die() {
  printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2
  exit 1
}

fw_require() {
  command -v "$1" >/dev/null 2>&1 || fw_die "required tool not found: $1 ($2)"
}

# Ensure sdks/node has node_modules (npm ci if lockfile present, else install)
# and dist/ is built (package exports resolve to dist/; dist/ is gitignored).
fw_node_deps() {
  if [ ! -d "$FW_ROOT/sdks/node/node_modules" ]; then
    fw_section "node: installing workspace dependencies"
    (cd "$FW_ROOT/sdks/node" && if [ -f package-lock.json ]; then npm ci; else npm install; fi)
  fi
  if [ ! -f "$FW_ROOT/sdks/node/dist/index.js" ]; then
    fw_section "node: building SDK dist/"
    (cd "$FW_ROOT/sdks/node" && npm run build)
  fi
}

# Ensure the Python venv at sdks/python/.venv exists with dev extras installed.
# Recreates it when the interpreter is broken (e.g. after a Python upgrade).
fw_python_venv() {
  local venv="$FW_ROOT/sdks/python/.venv"
  if [ ! -x "$venv/bin/python" ] || ! "$venv/bin/python" -c 'import sys' >/dev/null 2>&1; then
    fw_section "python: (re)creating venv at sdks/python/.venv"
    rm -rf "$venv"
    python3 -m venv "$venv"
    "$venv/bin/python" -m pip install --quiet --upgrade pip
    "$venv/bin/python" -m pip install --quiet -e "$FW_ROOT/sdks/python[dev]"
  elif ! "$venv/bin/python" -c 'import pytest, fireweave' >/dev/null 2>&1; then
    fw_section "python: installing dev extras into existing venv"
    "$venv/bin/python" -m pip install --quiet -e "$FW_ROOT/sdks/python[dev]"
  fi
  FW_PY="$venv/bin/python"
  export FW_PY
}
