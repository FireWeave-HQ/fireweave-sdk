#!/usr/bin/env bash
# Run all four language conformance runners against contracts/, collect the
# per-language compatibility reports, then run the cross-language differential
# comparator (tools/conformance/compare.mjs). Fails on any fixture failure or
# undeclared divergence (contracts/README.md "CI: fail on silent divergence").
#
# Outputs (gitignored via root build/ rule):
#   build/conformance/compatibility-report.<lang>.json  x4
#   build/conformance/compatibility-report.json         (merged)
#   build/conformance/summary.md
#
# Usage: scripts/conformance-all.sh [--out-dir DIR]

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT_DIR="$FW_ROOT/build/conformance"
if [ "${1:-}" = "--out-dir" ]; then
  [ -n "${2:-}" ] || fw_die "--out-dir requires a path"
  OUT_DIR="$2"
fi
mkdir -p "$OUT_DIR"

fw_require node "install Node >= 20"
fw_require npm "install Node >= 20"
fw_require python3 "install Python >= 3.10"
fw_require go "install Go >= 1.25"
fw_require mvn "install Maven (JDK 11+ toolchain)"

FAILED=()

# ---------- Node ----------
fw_node_deps
fw_section "node: conformance runner"
if (cd "$FW_ROOT/sdks/node" && npm run --silent conformance); then
  cp "$FW_ROOT/sdks/node/test/conformance/compatibility-report.node.json" \
     "$OUT_DIR/compatibility-report.node.json"
else
  FAILED+=("node conformance")
fi

# ---------- Python ----------
fw_python_venv
fw_section "python: conformance runner"
if "$FW_PY" "$FW_ROOT/sdks/python/conformance/run_conformance.py" \
     --contracts "$FW_ROOT/contracts" \
     --out "$OUT_DIR/compatibility-report.python.json"; then :; else
  FAILED+=("python conformance")
fi

# ---------- Go ----------
fw_section "go: conformance runner"
if (cd "$FW_ROOT/sdks/go" && go run ./cmd/conformance \
      -contracts "$FW_ROOT/contracts" \
      -out "$OUT_DIR/compatibility-report.go.json"); then :; else
  FAILED+=("go conformance")
fi

# ---------- Java ----------
fw_section "java: conformance runner (exec:java)"
# exec:java resolves sibling modules from the local repo; install (tests
# skipped here — test-all.sh runs them) before running the report writer.
if mvn -q -f "$FW_ROOT/sdks/java/pom.xml" -DskipTests install \
   && (cd "$FW_ROOT/sdks/java" && mvn -q -pl fireweave-testing exec:java \
         -Dexec.args="$FW_ROOT/contracts $OUT_DIR/compatibility-report.java.json"); then :; else
  FAILED+=("java conformance")
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  for f in "${FAILED[@]}"; do printf '  FAIL  %s\n' "$f"; done
  fw_die "conformance runner(s) failed; comparator not run"
fi

# ---------- Cross-language differential comparison ----------
fw_section "differential: tools/conformance/compare.mjs"
node "$FW_ROOT/tools/conformance/compare.mjs" \
  --contracts "$FW_ROOT/contracts" \
  --report node="$OUT_DIR/compatibility-report.node.json" \
  --report python="$OUT_DIR/compatibility-report.python.json" \
  --report go="$OUT_DIR/compatibility-report.go.json" \
  --report java="$OUT_DIR/compatibility-report.java.json" \
  --out "$OUT_DIR/compatibility-report.json" \
  --markdown "$OUT_DIR/summary.md"

fw_section "artifacts"
ls -1 "$OUT_DIR"
