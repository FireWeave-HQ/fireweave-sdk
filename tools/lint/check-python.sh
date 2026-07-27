#!/usr/bin/env bash
# Pyflakes-level Python lint gate (ruff --select F; the repo has no ruff/black
# config, so no style rules are enforced — F-rules only: undefined names,
# unused imports/variables, redefinitions, f-string bugs).
#
# Pre-existing findings in sdks/python are baselined in python-baseline.txt
# (reported to the orchestrator as Agent G hygiene defects). This gate fails
# only on findings NOT in the baseline, so new dead code / undefined names
# still break CI without CI fighting code it does not own.
#
# Usage: tools/lint/check-python.sh <python-interpreter>

set -euo pipefail
PY="${1:?usage: check-python.sh <python-interpreter>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BASELINE="$HERE/python-baseline.txt"

cd "$ROOT"
# Plain output regardless of the calling terminal (FORCE_COLOR etc. would
# break the literal baseline match).
raw="$(env -u FORCE_COLOR -u CLICOLOR_FORCE NO_COLOR=1 \
  "$PY" -m ruff check --select F --no-cache --output-format concise --exit-zero --quiet \
  sdks/python/src sdks/python/tests sdks/python/conformance)"

# Normalize: strip :line:col: so baseline entries survive unrelated edits.
normalized="$(printf '%s\n' "$raw" | sed -E 's/:[0-9]+:[0-9]+:/:/' | sed '/^$/d' || true)"

new_findings=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if ! grep -qxF "$line" "$BASELINE"; then
    new_findings="${new_findings}${line}\n"
  fi
done <<< "$normalized"

if [ -n "$new_findings" ]; then
  echo "New pyflakes-level findings (not in tools/lint/python-baseline.txt):" >&2
  printf '%b' "$new_findings" >&2
  exit 1
fi

count="$(printf '%s\n' "$normalized" | sed '/^$/d' | wc -l | tr -d ' ')"
echo "python lint: OK (${count} baselined pre-existing finding(s), 0 new)"
