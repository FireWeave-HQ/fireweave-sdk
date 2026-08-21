#!/usr/bin/env bash
# Run all four language conformance runners against contracts/, collect the
# per-language compatibility reports, then ALWAYS run the cross-language
# differential comparator (tools/conformance/compare.mjs) on whatever reports
# were produced. This script's own exit code is the comparator's exit code —
# not whether any individual runner happened to exit non-zero.
#
# Why not fail-fast on a runner's own exit code: contracts/harness.md rule 5
# requires every runner to "exit non-zero on any fail" — that is the EXPECTED
# behavior whenever a real (documented or not) fixture divergence exists, not
# a signal that the runner crashed. Dying the moment any one of the four
# non-zero-exits would mean the comparator — the 65x7 artifact this whole
# pipeline exists to produce — never runs while ANY divergence exists
# anywhere, which defeats its purpose. So each runner below is invoked
# tolerantly (its exit code is captured for the diagnostic summary only), and
# the comparator always runs on whatever report files exist.
#
# Each runner is passed an explicit --out/-out straight into $OUT_DIR — node
# included (task-10 review round 2, finding 1): it used to have no such flag,
# always writing to its own git-committed default path, with this script
# copying that file into $OUT_DIR only when present. That let a stale,
# previously-committed report survive an actual node crash (build failure,
# uncaught exception, its own internal sanity assertion firing) and get
# silently aggregated as if it were this run's — the `[ -f ]` check passed
# either way. Now all four write only to the ephemeral $OUT_DIR path handed
# to them; a runner crashing hard enough to never write it is caught
# immediately below by fw_check_report (which names the language) and, as a
# backstop, by compare.mjs's own loud read failure on the missing file — not
# by this script silently skipping the aggregate or laundering a stale copy.
#
# The aggregate is 65 fixtures x 7 languages (contracts/harness.md ruling 3):
# node/python/go/java below each run a real conformance suite and produce a
# report file; web/rust/swift need no runner invocation here at all —
# compare.mjs synthesizes their columns itself (web: not-applicable-web, per
# ADR-0009's separate contracts/web/ suite; rust/swift: not-implemented,
# Phase 6 not landed yet).
#
# Outputs (gitignored via root build/ rule):
#   build/conformance/compatibility-report.<lang>.json  x4 (node/python/go/java)
#   build/conformance/compatibility-report.json         (merged, 65x7)
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

# A runner that ran but left no report file behind did not merely "fail on a
# real divergence" (that shape always writes a report, then exits non-zero) —
# it crashed or exited before reaching its write (build failure, uncaught
# exception, an internal sanity assertion firing, etc). compare.mjs's own
# readFileSync throws loudly on that missing file too (an acceptable
# backstop), but this check runs first so the language is named in the
# script's own output rather than relying solely on compare.mjs's stack trace.
fw_check_report() {
  local lang="$1"
  local report_path="$2"
  local exit_code="$3"
  if [ ! -f "$report_path" ]; then
    fw_warn "$lang: no report file at $report_path after the runner ran (exit=$exit_code)."
    fw_warn "$lang: this is NOT the normal shape of a real fixture divergence — treat $lang's own logs above as the primary diagnostic. The differential comparator below will also fail loudly on this missing file."
  fi
}

fw_require node "install Node >= 20"
fw_require npm "install Node >= 20"
fw_require python3 "install Python >= 3.10"
fw_require go "install Go >= 1.25"
fw_require mvn "install Maven (JDK 11+ toolchain)"

NODE_EXIT=0
PYTHON_EXIT=0
GO_EXIT=0
JAVA_EXIT=0

# ---------- Node ----------
fw_node_deps
fw_section "node: conformance runner"
# --out (task-10 review round 2, finding 1): writes straight into $OUT_DIR,
# same as python/go/java below — no more copying from node's own gitignored
# default report path, which removes the "stale committed file survives a
# crash and gets copied as if fresh" hazard entirely.
(cd "$FW_ROOT/sdks/node" && npm run --silent conformance -- --out "$OUT_DIR/compatibility-report.node.json") || NODE_EXIT=$?
fw_check_report node "$OUT_DIR/compatibility-report.node.json" "$NODE_EXIT"

# ---------- Python ----------
fw_python_venv
fw_section "python: conformance runner"
"$FW_PY" "$FW_ROOT/sdks/python/conformance/run_conformance.py" \
     --contracts "$FW_ROOT/contracts" \
     --out "$OUT_DIR/compatibility-report.python.json" || PYTHON_EXIT=$?
fw_check_report python "$OUT_DIR/compatibility-report.python.json" "$PYTHON_EXIT"

# ---------- Go ----------
fw_section "go: conformance runner"
(cd "$FW_ROOT/sdks/go" && go run ./cmd/conformance \
      -contracts "$FW_ROOT/contracts" \
      -out "$OUT_DIR/compatibility-report.go.json") || GO_EXIT=$?
fw_check_report go "$OUT_DIR/compatibility-report.go.json" "$GO_EXIT"

# ---------- Java ----------
fw_section "java: conformance runner (exec:java)"
# exec:java resolves sibling modules from the local repo; install (tests
# skipped here — test-all.sh runs them) before running the report writer.
( mvn -q -f "$FW_ROOT/sdks/java/pom.xml" -DskipTests install \
   && cd "$FW_ROOT/sdks/java" \
   && mvn -q -pl fireweave-testing exec:java \
        -Dexec.args="$FW_ROOT/contracts $OUT_DIR/compatibility-report.java.json" ) || JAVA_EXIT=$?
fw_check_report java "$OUT_DIR/compatibility-report.java.json" "$JAVA_EXIT"

fw_section "per-language runner exit codes (informational only)"
printf '  %-8s exit=%s\n' node "$NODE_EXIT"
printf '  %-8s exit=%s\n' python "$PYTHON_EXIT"
printf '  %-8s exit=%s\n' go "$GO_EXIT"
printf '  %-8s exit=%s\n' java "$JAVA_EXIT"
printf 'A non-zero exit above is expected whenever that language has a real fixture\n'
printf 'divergence (contracts/harness.md rule 5) — it does not stop the comparator below,\n'
printf 'which is the actual gate (see this script'"'"'s own exit code).\n'

# ---------- Cross-language differential comparison (ALWAYS runs) ----------
fw_section "differential: tools/conformance/compare.mjs"
COMPARE_EXIT=0
node "$FW_ROOT/tools/conformance/compare.mjs" \
  --contracts "$FW_ROOT/contracts" \
  --report node="$OUT_DIR/compatibility-report.node.json" \
  --report python="$OUT_DIR/compatibility-report.python.json" \
  --report go="$OUT_DIR/compatibility-report.go.json" \
  --report java="$OUT_DIR/compatibility-report.java.json" \
  --out "$OUT_DIR/compatibility-report.json" \
  --markdown "$OUT_DIR/summary.md" || COMPARE_EXIT=$?

fw_section "artifacts"
ls -1 "$OUT_DIR"

# This script's verdict IS the comparator's verdict — never masked by, and
# never fail-fast on, an individual runner's own (expected-on-divergence)
# non-zero exit above.
exit "$COMPARE_EXIT"
