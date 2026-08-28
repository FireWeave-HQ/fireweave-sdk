#!/usr/bin/env bash
# Generate a conventional-commits changelog for one SDK component.
#
# Usage: tools/release/changelog.sh <component> <version> [<out-file>]
#   component: server | web | python | java | go | rust | swift
#   version:   semver without leading v (e.g. 0.1.0)
#
# Range: commits since the last tag matching this component's tag convention
# (server/v* | web/v* | python/v* | java/v* | rust/v* | swift/v* | sdks/go/v* —
# Go's tag must equal the module subdirectory path for `go get` resolution),
# scoped to the paths that ship in the component. Commits are grouped by
# conventional-commit type; anything unparseable lands under "Other changes"
# rather than being dropped.
#
set -euo pipefail

COMPONENT="${1:?usage: changelog.sh <component> <version> [out-file]}"
VERSION="${2:?usage: changelog.sh <component> <version> [out-file]}"
OUT="${3:-/dev/stdout}"

case "$COMPONENT" in
  server) TAG_PREFIX="server/v";  PATHS=("sdks/node" "examples/node") ;;
  web)    TAG_PREFIX="web/v";     PATHS=("sdks/web" "examples/web") ;;
  python) TAG_PREFIX="python/v";  PATHS=("sdks/python" "examples/python") ;;
  go)     TAG_PREFIX="sdks/go/v"; PATHS=("sdks/go" "examples/go") ;;
  java)   TAG_PREFIX="java/v";    PATHS=("sdks/java" "examples/java") ;;
  rust)   TAG_PREFIX="rust/v";    PATHS=("sdks/rust" "examples/rust") ;;
  swift)  TAG_PREFIX="swift/v";   PATHS=("sdks/swift" "examples/swift") ;;
  *) echo "changelog: unknown component '$COMPONENT' (server|web|python|java|go|rust|swift)" >&2; exit 2 ;;
esac
# Shared surfaces always included: contract fixtures and spec affect every SDK.
PATHS+=("contracts" "spec")

LAST_TAG="$(git tag --list "${TAG_PREFIX}*" --sort=-v:refname | head -n1 || true)"
RANGE=""
[ -n "$LAST_TAG" ] && RANGE="${LAST_TAG}..HEAD"

# Unit separator (0x1f) between hash and subject; expanded via printf because
# BSD awk does not understand \x escapes in -F.
US="$(printf '\037')"
LOG="$(git log ${RANGE:+"$RANGE"} --no-merges --pretty=format:'%h%x1f%s' -- "${PATHS[@]}")"

section() { # section <title> <type-regex>
  local title="$1" re="$2" body
  # NB: regexes below avoid backslashes entirely — awk -v mangles them.
  body="$(printf '%s\n' "$LOG" | awk -F "$US" -v re="$re" '
    $2 ~ re {
      subj = $2
      sub(/^[a-z]+(\([^)]*\))?!?:[ ]*/, "", subj)
      bang = ($2 ~ /^[a-z]+(\([^)]*\))?!:/) ? " **BREAKING**" : ""
      printf "- %s%s (%s)\n", subj, bang, $1
    }')"
  if [ -n "$body" ]; then
    printf '### %s\n\n%s\n\n' "$title" "$body"
  fi
}

{
  printf '## %s v%s\n\n' "$COMPONENT" "$VERSION"
  if [ -n "$LAST_TAG" ]; then
    printf '_Changes since `%s`._\n\n' "$LAST_TAG"
  else
    printf '_Initial release (no previous `%s*` tag)._\n\n' "$TAG_PREFIX"
  fi
  section 'Breaking changes' '^[a-z]+([(][^)]*[)])?!:'
  section 'Features' '^feat([(][^)]*[)])?!?:'
  section 'Bug fixes' '^fix([(][^)]*[)])?!?:'
  section 'Performance' '^perf([(][^)]*[)])?!?:'
  section 'Documentation' '^docs([(][^)]*[)])?!?:'
  # Everything else (incl. non-conventional subjects) — never silently dropped.
  body="$(printf '%s\n' "$LOG" | awk -F "$US" '
    $2 !~ /^(feat|fix|perf|docs)(\([^)]*\))?!?:/ && $2 !~ /^[a-z]+(\([^)]*\))?!:/ && NF {
      printf "- %s (%s)\n", $2, $1
    }')"
  if [ -n "$body" ]; then
    printf '### Other changes\n\n%s\n\n' "$body"
  fi
} > "$OUT"
