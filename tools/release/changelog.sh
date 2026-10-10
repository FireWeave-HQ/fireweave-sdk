#!/usr/bin/env bash
# Generate a conventional-commits changelog for one SDK component.
#
# Usage: tools/release/changelog.sh <component> <version> [<out-file>]
#   component: server | web | python | java | go | rust | swift | dart
#   version:   semver without leading v (e.g. 0.1.0)
#
# Range: commits since the previous release tag of this component's tag
# convention (server/v* | web/v* | python/v* | java/v* | rust/v* | swift/v* |
# dart/v* | sdks/go/v* — Go's tag must equal the module subdirectory path for
# `go get` resolution), scoped to the paths that ship in the component. The
# previous tag depends on the channel, read from <version>'s spelling (an rc,
# `X.Y.Z-rc.N` or python `X.Y.ZrcN`, is a staging run; anything else is
# production):
#   - production: the highest plain `X.Y.Z` tag;
#   - staging:    the higher of the highest plain tag and the highest rc tag
#                 (a release follows its own rc, so 3.0.0 beats 3.0.0-rc.4).
# Pre-rename staging tags (`-staging.N`, python `aN`) never count: staging.1
# sorts above every rc and above 3.0.0, so it would otherwise start every 3.0.0
# changelog. A version-sorted filter is used rather than `git describe`, because
# rust/dart/swift tags point at detached release commits that are not ancestors
# of main; `<tag>..HEAD` still works since a release commit's parent is on main.
# Commits are grouped by
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
  dart) TAG_PREFIX="dart/v"; PATHS=("sdks/dart" "examples/dart") ;;
  *) echo "changelog: unknown component '$COMPONENT' (server|web|python|java|go|rust|swift|dart)" >&2; exit 2 ;;
esac
# Shared surfaces always included: contract fixtures and spec affect every SDK.
PATHS+=("contracts" "spec")

# highest_plain_version: the numeric-safe "highest X.Y.Z" helper the version
# computation already uses for go/swift.
# shellcheck source=version.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/version.sh"

# The highest rc over a newline list of bare versions: `X.Y.Z-rc.N`, or python's
# `X.Y.ZrcN`. Prints nothing when there is none.
highest_rc_version() { # <component> <versions>
  local re='^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$'
  [ "$1" = python ] && re='^[0-9]+\.[0-9]+\.[0-9]+rc[0-9]+$'
  printf '%s\n' "$2" | { grep -E "$re" || true; } | awk '{
    match($0, /-?rc\.?[0-9]+$/)
    split(substr($0, 1, RSTART - 1), v, ".")
    n = substr($0, RSTART); sub(/^-?rc\.?/, "", n)
    printf "%05d%05d%05d%05d %s\n", v[1], v[2], v[3], n, $0
  }' | sort | tail -n1 | cut -d' ' -f2
}

case "$COMPONENT:$VERSION" in
  python:*rc[0-9]*|*:*-rc.*) CHANNEL=staging ;;
  *) CHANNEL=production ;;
esac

TAG_VERSIONS="$(git tag --list "${TAG_PREFIX}*" | while IFS= read -r t; do printf '%s\n' "${t#"$TAG_PREFIX"}"; done)"
PREVIOUS="$(highest_plain_version "$TAG_VERSIONS" || true)"
if [ "$CHANNEL" = staging ]; then
  RC="$(highest_rc_version "$COMPONENT" "$TAG_VERSIONS")"
  if [ -n "$RC" ]; then
    RC_BASE="$(printf '%s\n' "$RC" | sed -E 's/-?rc\.?[0-9]+$//')"
    # The rc wins only over an older plain release; a release beats its own rc.
    if [ -z "$PREVIOUS" ] || { [ "$RC_BASE" != "$PREVIOUS" ] \
      && [ "$(highest_plain_version "$(printf '%s\n%s\n' "$PREVIOUS" "$RC_BASE")")" = "$RC_BASE" ]; }; then
      PREVIOUS="$RC"
    fi
  fi
fi
LAST_TAG=""
[ -n "$PREVIOUS" ] && LAST_TAG="${TAG_PREFIX}${PREVIOUS}"
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
