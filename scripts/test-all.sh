#!/usr/bin/env bash
# Run everything CI's per-language test jobs run, locally (macOS + Linux):
#   - Node:   typecheck (tsc; no eslint/prettier configs exist -> tsc-only lint),
#             unit + integration tests
#   - Python: pyflakes-level lint (ruff --select F if available; no ruff/black
#             config exists so no style enforcement), pytest
#   - Go:     gofmt check, go vet, go build, go test -race
#   - Java:   mvn clean install (unit tests + conformance JUnit gate)
#   - Examples: run all four offline (in-memory adapter; no network backend)
#
# Usage: scripts/test-all.sh [--skip-examples]

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SKIP_EXAMPLES=0
[ "${1:-}" = "--skip-examples" ] && SKIP_EXAMPLES=1

fw_require node "install Node >= 20"
fw_require npm "install Node >= 20"
fw_require python3 "install Python >= 3.10"
fw_require go "install Go >= 1.25"
fw_require mvn "install Maven (JDK 11+ toolchain)"

FAILED=()
run_step() { # run_step <label> <command...>
  local label="$1"; shift
  fw_section "$label"
  if "$@"; then :; else
    FAILED+=("$label")
    fw_warn "$label FAILED"
  fi
}

# ---------- Node ----------
fw_node_deps
run_step "node: typecheck (tsc)" env -C "$FW_ROOT/sdks/node" npm run --silent typecheck
run_step "node: unit + integration tests" env -C "$FW_ROOT/sdks/node" npm run --silent test

# ---------- Python ----------
fw_python_venv
# pyflakes-level lint: ruff --select F only (no project ruff/black config; do
# not enforce style the code was not written against). Best-effort install.
if ! "$FW_PY" -m ruff --version >/dev/null 2>&1; then
  "$FW_PY" -m pip install --quiet ruff >/dev/null 2>&1 || true
fi
if "$FW_PY" -m ruff --version >/dev/null 2>&1; then
  # Baseline-gated: pre-existing sdks/python findings are recorded in
  # tools/lint/python-baseline.txt (reported as Agent G defects); only NEW
  # findings fail.
  run_step "python: pyflakes-level lint (ruff --select F, baselined)" \
    bash "$FW_ROOT/tools/lint/check-python.sh" "$FW_PY"
else
  fw_warn "python: ruff unavailable (offline?) — skipping pyflakes-level lint (CI runs it)"
fi
run_step "python: pytest" env -C "$FW_ROOT/sdks/python" "$FW_PY" -m pytest

# ---------- Go ----------
fw_section "go: gofmt check"
UNFORMATTED="$(cd "$FW_ROOT/sdks/go" && gofmt -l .)"
if [ -n "$UNFORMATTED" ]; then
  FAILED+=("go: gofmt")
  fw_warn "gofmt: files need formatting:"
  printf '%s\n' "$UNFORMATTED"
fi
run_step "go: vet" env -C "$FW_ROOT/sdks/go" go vet ./...
run_step "go: build" env -C "$FW_ROOT/sdks/go" go build ./...
run_step "go: test -race" env -C "$FW_ROOT/sdks/go" go test -race ./...

# ---------- Java ----------
run_step "java: mvn clean install (tests + conformance gate)" \
  mvn -q -f "$FW_ROOT/sdks/java/pom.xml" clean install

# ---------- Examples (offline by default) ----------
if [ "$SKIP_EXAMPLES" -eq 0 ]; then
  # Node example depends on the built SDK via file: — build dist first.
  run_step "examples: build node sdk dist" env -C "$FW_ROOT/sdks/node" npm run --silent build
  if [ ! -d "$FW_ROOT/examples/node/node_modules" ]; then
    (cd "$FW_ROOT/examples/node" && npm install --no-audit --no-fund)
  fi
  run_step "examples: node (offline)" env -C "$FW_ROOT/examples/node" npm start --silent
  run_step "examples: python (offline)" env -C "$FW_ROOT/examples/python" "$FW_PY" service.py
  run_step "examples: go (offline)" env -C "$FW_ROOT/examples/go" go run .
  run_step "examples: java (offline)" \
    mvn -q -f "$FW_ROOT/examples/java/pom.xml" compile exec:java
fi

# ---------- Summary ----------
fw_section "summary"
if [ "${#FAILED[@]}" -gt 0 ]; then
  for f in "${FAILED[@]}"; do printf '  FAIL  %s\n' "$f"; done
  fw_die "${#FAILED[@]} step(s) failed"
fi
echo "All test steps passed."
