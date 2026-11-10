#!/usr/bin/env bash
# The twin gate (ADR-0014): build each ESM SDK package and its CommonJS twin,
# then check that they match and that the twin works for the consumers it
# exists for. Run it before saying a change to sdks/node or sdks/web is done,
# and before every publish (release.yml runs it). See docs/module-formats.md.
#
# Usage: tools/typescript/twins/verify-twins.sh [node|web|all] [--publish]   (default: all)
#   --publish  only the checks that need no third-party tools (release.yml's
#              publish jobs, which hold an npm token, use it)

source "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/lib.sh"

TARGET="${1:-all}"
MODE="${2:-}"
case "$TARGET" in
  node|web|all) ;;
  *) fw_die "usage: tools/typescript/twins/verify-twins.sh [node|web|all] [--publish]" ;;
esac
case "$MODE" in
  ""|--publish) ;;
  *) fw_die "unknown option: $MODE" ;;
esac

fw_require node "install Node >= 20.20"
fw_require npm "install Node >= 20.20"

if [ "$TARGET" != "web" ]; then
  fw_node_deps
fi
if [ "$TARGET" != "node" ]; then
  fw_require bun "install Bun (sdks/web builds with it)"
  if [ ! -d "$FW_ROOT/sdks/web/node_modules" ]; then
    fw_section "web: installing workspace dependencies"
    (cd "$FW_ROOT/sdks/web" && bun install --frozen-lockfile)
  fi
fi
if [ -z "$MODE" ] && [ ! -d "$FW_ROOT/tools/typescript/twins/node_modules" ]; then
  fw_section "twin gate: installing its pinned tools"
  (cd "$FW_ROOT/tools/typescript/twins" && npm ci --no-audit --no-fund)
fi

fw_section "twin gate: $TARGET"
node "$FW_ROOT/tools/typescript/twins/verify.mjs" "$TARGET" ${MODE:+"$MODE"}
