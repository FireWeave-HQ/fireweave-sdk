#!/usr/bin/env bash
# Offline tests for tools/release/changelog.sh's previous-tag selection.
#
# Builds a throwaway git repo with server/ and python/ tags across the
# pre-rename staging spelling (-staging.N / aN), the rc spelling (-rc.N /
# rcN) and plain releases, one rc tag on a detached commit (the shape a
# release commit gives a tag), and asserts which tag each production and
# staging run starts from.
#
# Zero network calls. Run: bash tools/release/changelog.test.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHANGELOG="$HERE/changelog.sh"

# The scratch repo must not inherit the developer's git config (signing,
# hooks, default branch) and needs an identity for commits and tags.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

PASS=0
FAIL=0

assert_eq() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3" >&2
  fi
}

assert_contains() { # <label> <needle> <haystack>
  case "$3" in
    *"$2"*) PASS=$((PASS + 1)) ;;
    *) FAIL=$((FAIL + 1)); printf 'FAIL: %s\n  missing: %s\n' "$1" "$2" >&2 ;;
  esac
}

assert_not_contains() { # <label> <needle> <haystack>
  case "$3" in
    *"$2"*) FAIL=$((FAIL + 1)); printf 'FAIL: %s\n  unexpected: %s\n' "$1" "$2" >&2 ;;
    *) PASS=$((PASS + 1)) ;;
  esac
}

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
cd "$SCRATCH"
git init -q -b main .

commit() { # <path> <subject>
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >> "$1"
  git add "$1"
  git commit -q -m "$2"
}

tag() { git tag -a -m "$1" "$1"; }

# The tag a run would start from: the "_Changes since `<tag>`._" line, or
# "none" for an initial release.
previous_tag() { # <component> <version>
  local out
  out="$(bash "$CHANGELOG" "$1" "$2")"
  case "$out" in
    *'_Changes since `'*) printf '%s\n' "$out" | sed -n 's/^_Changes since `\(.*\)`\._$/\1/p' ;;
    *) printf 'none\n' ;;
  esac
}

# History on main: 2.2.0 releases, then the pre-rename staging builds.
commit sdks/node/a.txt 'feat: server before 2.2.0'
commit sdks/python/a.txt 'feat: python before 2.2.0'
tag server/v2.2.0
tag python/v2.2.0
commit sdks/node/a.txt 'feat: server after 2.2.0'
commit sdks/python/a.txt 'feat: python after 2.2.0'
tag server/v3.0.0-staging.1
tag python/v3.0.0a1
commit sdks/node/a.txt 'feat: server after staging.1'
commit sdks/python/a.txt 'feat: python after a1'

# server rc.1 on main; python rc1 on a detached release commit whose parent
# is on main (main never contains it).
tag server/v3.0.0-rc.1
git checkout -q --detach
commit sdks/python/version.txt 'release(python): 3.0.0rc1'
tag python/v3.0.0rc1
git checkout -q main
commit sdks/node/a.txt 'feat: server after rc.1'
commit sdks/python/a.txt 'feat: python after rc1'

# --- before 3.0.0 exists --------------------------------------------------
# A legacy staging tag never counts, although it sorts above every rc and
# above 3.0.0.
assert_eq "server production 3.0.0 starts at the last plain release" \
  "server/v2.2.0" "$(previous_tag server 3.0.0)"
assert_eq "server staging 3.0.0-rc.2 starts at rc.1, not staging.1" \
  "server/v3.0.0-rc.1" "$(previous_tag server 3.0.0-rc.2)"
assert_eq "python production 3.0.0 starts at the last plain release, not its rc" \
  "python/v2.2.0" "$(previous_tag python 3.0.0)"
assert_eq "python staging 3.0.0rc2 starts at rc1 (a detached tag), not a1" \
  "python/v3.0.0rc1" "$(previous_tag python 3.0.0rc2)"

# The range from a detached tag still works: commits on main after the
# release commit's parent are listed, commits before it are not.
py_rc2="$(bash "$CHANGELOG" python 3.0.0rc2)"
assert_contains "python rc2 changelog lists the commit after rc1" "python after rc1" "$py_rc2"
assert_not_contains "python rc2 changelog omits the commit before rc1" "python after a1" "$py_rc2"
server_prod="$(bash "$CHANGELOG" server 3.0.0)"
assert_contains "server 3.0.0 changelog covers everything since 2.2.0" "server after 2.2.0" "$server_prod"
assert_not_contains "server 3.0.0 changelog omits commits before 2.2.0" "server before 2.2.0" "$server_prod"

# --- after 3.0.0 ships ----------------------------------------------------
tag server/v3.0.0
tag python/v3.0.0
commit sdks/node/a.txt 'feat: server after 3.0.0'
commit sdks/python/a.txt 'feat: python after 3.0.0'

assert_eq "server production 3.0.1 starts at 3.0.0" \
  "server/v3.0.0" "$(previous_tag server 3.0.1)"
assert_eq "server staging 3.1.0-rc.1 starts at 3.0.0, which follows its own rc" \
  "server/v3.0.0" "$(previous_tag server 3.1.0-rc.1)"
assert_eq "python production 3.0.1 starts at 3.0.0" \
  "python/v3.0.0" "$(previous_tag python 3.0.1)"
assert_eq "python staging 3.1.0rc1 starts at 3.0.0" \
  "python/v3.0.0" "$(previous_tag python 3.1.0rc1)"

# An rc on the next line outranks the release before it on a staging run,
# and never on a production run.
tag server/v3.1.0-rc.1
assert_eq "server staging 3.1.0-rc.2 starts at 3.1.0-rc.1" \
  "server/v3.1.0-rc.1" "$(previous_tag server 3.1.0-rc.2)"
assert_eq "server production 3.1.0 starts at 3.0.0, not its rc" \
  "server/v3.0.0" "$(previous_tag server 3.1.0)"
# Numeric ordering: rc.10 above rc.9, and 3.0.10 above 3.0.9.
tag server/v3.1.0-rc.9
tag server/v3.1.0-rc.10
assert_eq "server staging picks rc.10 over rc.9" \
  "server/v3.1.0-rc.10" "$(previous_tag server 3.1.0-rc.11)"

# A component with no tags at all is an initial release.
assert_eq "a component with no tags is an initial release" \
  "none" "$(previous_tag dart 0.1.0)"
# A component with only a legacy staging tag is an initial release too.
tag dart/v3.0.0-staging.1
assert_eq "only a legacy staging tag means an initial release (production)" \
  "none" "$(previous_tag dart 3.0.0)"
assert_eq "only a legacy staging tag means an initial release (staging)" \
  "none" "$(previous_tag dart 3.0.0-rc.1)"

printf '\nchangelog.test.sh: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
