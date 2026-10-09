#!/usr/bin/env bash
# Offline tests for tools/release/version.sh's pure logic, plus one
# end-to-end "compute" run with the registry seam (registry_versions)
# stubbed out — proving the seam is real and swappable, not just asserted.
#
# Zero network calls anywhere in this file. Run: bash tools/release/version.test.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source version.sh as a library: BASH_SOURCE[0] != $0 here, so main() does
# not run — only functions are defined.
# shellcheck source=/dev/null
source "$HERE/version.sh"

# Keep the real registry seam under another name: later sections replace
# registry_versions with fixed stubs, while the python and java counter cases
# below stub one layer lower (pypi_versions / remote_tag_versions) to prove the
# real seam reads the right source.
eval "$(declare -f registry_versions | sed '1s/^registry_versions/real_registry_versions/')"

PASS=0
FAIL=0
SKIP=0

assert_eq() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3" >&2
  fi
}

assert_fail() { # <label> <command...> — asserts the command exits non-zero
  # Run in a SUBSHELL: version.sh is sourced, so a guard that aborts with
  # `exit` (not `return`) would otherwise take this test script down with it,
  # reporting success by simply never reaching the summary.
  local label="$1"
  shift
  if ( "$@" ) >/dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s (expected non-zero exit, got 0)\n' "$label" >&2
  else
    PASS=$((PASS + 1))
  fi
}

# -------------------------------------------------------------- strip_prerelease
assert_eq "strip: plain version unchanged" "1.4.0" "$(semver_strip_prerelease "1.4.0")"
assert_eq "strip: drops -rc.N" "1.4.0" "$(semver_strip_prerelease "1.4.0-rc.3")"
assert_eq "strip: drops a legacy -staging.N" "1.4.0" "$(semver_strip_prerelease "1.4.0-staging.3")"
assert_eq "strip: drops -SNAPSHOT" "0.1.0" "$(semver_strip_prerelease "0.1.0-SNAPSHOT")"
assert_eq "strip: drops build metadata" "1.4.0" "$(semver_strip_prerelease "1.4.0+build5")"
assert_eq "strip: drops prerelease AND build metadata" "1.4.0" "$(semver_strip_prerelease "1.4.0-rc.1+build5")"
assert_eq "strip: drops PEP 440 alpha (python staging)" "1.4.0" "$(semver_strip_prerelease "1.4.0a3")"
assert_eq "strip: drops PEP 440 .devN" "1.4.0" "$(semver_strip_prerelease "1.4.0.dev7")"

# -------------------------------------------------------------------- semver_bump
assert_eq "bump patch" "1.4.1" "$(semver_bump "1.4.0" patch)"
assert_eq "bump minor resets patch" "1.5.0" "$(semver_bump "1.4.9" minor)"
assert_eq "bump major resets minor+patch" "2.0.0" "$(semver_bump "1.4.9" major)"
assert_eq "bump from 0.0.0" "0.1.0" "$(semver_bump "0.0.0" minor)"
assert_fail "bump: invalid bump kind rejected" semver_bump "1.4.0" bogus
assert_fail "bump: non-semver base rejected" semver_bump "1.4" patch

# ---------------------------------------------------- strip THEN bump (the mandate)
# "1.4.0-rc.3 + patch must give 1.4.1" — never 1.4.0-rc.4.
staged_base="$(semver_strip_prerelease "1.4.0-rc.3")"
assert_eq "mandate: strip(1.4.0-rc.3)=1.4.0" "1.4.0" "$staged_base"
assert_eq "mandate: strip-then-bump patch = 1.4.1" "1.4.1" "$(semver_bump "$staged_base" patch)"
snapshot_base="$(semver_strip_prerelease "0.1.0-SNAPSHOT")"
assert_eq "mandate: java -SNAPSHOT strips + bumps patch = 0.1.1" "0.1.1" "$(semver_bump "$snapshot_base" patch)"

# ------------------------------------------------------------------- extract_rc_n
assert_eq "extract: matching base+N" "3" "$(extract_rc_n "1.4.0-rc.3" "1.4.0")"
assert_eq "extract: double-digit N" "12" "$(extract_rc_n "1.4.0-rc.12" "1.4.0")"
assert_fail "extract: non-matching base" extract_rc_n "1.4.0-rc.3" "1.5.0"
assert_fail "extract: plain version (no rc suffix)" extract_rc_n "1.4.0" "1.4.0"
assert_fail "extract: non-numeric N" extract_rc_n "1.4.0-rc.x1" "1.4.0"
assert_fail "extract: a legacy -staging.N is not an rc" extract_rc_n "1.4.0-staging.3" "1.4.0"

# ----------------------------------------------------------------------- max_rc_n
existing="$(printf '1.4.0\n1.4.0-rc.1\n1.4.0-rc.3\n1.4.0-rc.2\n2.0.0-rc.9\n')"
assert_eq "max_rc_n: picks the highest N for the matching base" \
  "3" "$(printf '%s' "$existing" | max_rc_n "1.4.0")"
assert_eq "max_rc_n: 0 when nothing matches the base" \
  "0" "$(printf '%s' "$existing" | max_rc_n "9.9.9")"
assert_eq "max_rc_n: 0 on empty registry (first-ever staging release)" \
  "0" "$(printf '' | max_rc_n "1.4.0")"
assert_eq "max_rc_n: legacy -staging.N versions are ignored (N starts at 1)" \
  "0" "$(printf '1.4.0-staging.1\n1.4.0-staging.7\n' | max_rc_n "1.4.0")"

# --------------------------------------------------------- PEP 440 rc (python)
assert_eq "extract pep440 rc: matching base+N" "3" "$(extract_pep440_rc_n "1.4.0rc3" "1.4.0")"
assert_eq "extract pep440 rc: double-digit N" "12" "$(extract_pep440_rc_n "1.4.0rc12" "1.4.0")"
assert_fail "extract pep440 rc: non-matching base" extract_pep440_rc_n "1.4.0rc3" "1.5.0"
assert_fail "extract pep440 rc: plain version" extract_pep440_rc_n "1.4.0" "1.4.0"
assert_fail "extract pep440 rc: the -rc.N form is not PEP 440 rcN" extract_pep440_rc_n "1.4.0-rc.3" "1.4.0"
assert_fail "extract pep440 rc: a legacy alpha is not an rc" extract_pep440_rc_n "1.4.0a3" "1.4.0"
rcs="$(printf '1.4.0\n1.4.0rc1\n1.4.0rc3\n1.4.0rc2\n1.4.0a9\n2.0.0rc9\n')"
assert_eq "max_pep440_rc_n: picks the highest N for the matching base" \
  "3" "$(printf '%s' "$rcs" | max_pep440_rc_n "1.4.0")"
assert_eq "max_pep440_rc_n: 0 when nothing matches" \
  "0" "$(printf '%s' "$rcs" | max_pep440_rc_n "9.9.9")"
assert_eq "max_pep440_rc_n: 0 on empty registry" \
  "0" "$(printf '' | max_pep440_rc_n "1.4.0")"

# -------------------------------------------------------------- highest_plain_version
tags="$(printf '0.1.0\n0.2.0\n0.10.0\n0.2.0-staging.1\n0.2.0-rc.1\nnot-a-version\n')"
assert_eq "highest_plain_version: numeric-safe (0.10.0 beats 0.2.0)" \
  "0.10.0" "$(highest_plain_version "$tags")"
assert_fail "highest_plain_version: empty input fails (no prior tag)" highest_plain_version ""

# ------------------------------------------------------------ component tables
assert_eq "manifest: server" "sdks/node/package.json" "$(component_manifest server)"
assert_eq "manifest: go is tag-only (empty)" "" "$(component_manifest go)"
assert_eq "manifest: swift is tag-only (empty)" "" "$(component_manifest swift)"
assert_eq "tag prefix: go forced exception" "sdks/go" "$(component_tag_prefix go)"
assert_eq "tag prefix: server uses its own name (not node)" "server" "$(component_tag_prefix server)"
assert_eq "tag prefix: swift matches org convention" "swift" "$(component_tag_prefix swift)"
assert_eq "manifest: dart" "sdks/dart/pubspec.yaml" "$(component_manifest dart)"
assert_eq "tag prefix: dart matches org convention" "dart" "$(component_tag_prefix dart)"
assert_fail "unknown component is rejected" component_manifest bogus

# ------------------------------------------- python staging counter reads PyPI
# Python staging builds go to pypi.org as X.Y.ZrcN; no other Python index is
# read. Stub one layer below the seam: pypi_versions answers only for pypi.org
# and fails for any other index, so the real registry_versions must ask PyPI.
pypi_versions() {
  if [ "$1" != "https://pypi.org" ]; then
    echo "test stub: unexpected python index '$1'" >&2
    return 2
  fi
  printf '%s' "$PYPI_STUB"
}
scratch_pypi="$(mktemp -d)"
mkdir -p "$scratch_pypi/sdks/python"
cat > "$scratch_pypi/sdks/python/pyproject.toml" <<'EOF'
[project]
name = "fireweave"
version = "2.2.0"
EOF
PYPI_STUB="$(printf '2.1.0\n2.2.0\n')"
assert_eq "registry_versions python staging reads pypi.org" "$PYPI_STUB" "$(real_registry_versions python staging)"
out_pypi="$(cmd_compute python major staging --manifest-root "$scratch_pypi")"
assert_eq "python staging with pypi.org holding 2.2.0 -> 3.0.0rc1" \
  "3.0.0rc1" "$(printf '%s\n' "$out_pypi" | sed -n 's/^release_version=//p')"
PYPI_STUB="$(printf '2.2.0\n3.0.0a1\n3.0.0rc1\n')"
out_pypi="$(cmd_compute python major staging --manifest-root "$scratch_pypi")"
assert_eq "python staging with pypi.org holding 3.0.0rc1 -> 3.0.0rc2" \
  "3.0.0rc2" "$(printf '%s\n' "$out_pypi" | sed -n 's/^release_version=//p')"
assert_eq "python staging tag" "python/v3.0.0rc2" "$(printf '%s\n' "$out_pypi" | sed -n 's/^tag=//p')"
rm -rf "$scratch_pypi"
unset PYPI_STUB

# ------------------------------------------- java staging counter reads its tags
remote_tag_versions() { printf '2.2.0\n3.0.0-staging.1\n3.0.0-rc.1\n'; }
scratch_java="$(mktemp -d)"
mkdir -p "$scratch_java/sdks/java"
cat > "$scratch_java/sdks/java/pom.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>ai.fireweave</groupId>
  <artifactId>fireweave-java-parent</artifactId>
  <version>2.2.0</version>
</project>
EOF
out_java="$(cmd_compute java major staging --manifest-root "$scratch_java")"
assert_eq "java staging with tags 3.0.0-staging.1 and 3.0.0-rc.1 -> 3.0.0-rc.2" \
  "3.0.0-rc.2" "$(printf '%s\n' "$out_java" | sed -n 's/^release_version=//p')"
rm -rf "$scratch_java"

# ------------------------------------------- rust staging counter reads its tags
# crates.io never receives a staging upload, so it never holds an rc: a counter
# read from it restarts at 1 on every run and the second rc's tag push
# collides. The crates.io stub holds only releases; the tags hold rc.1.
crates_versions() { printf '2.2.0\n'; }
remote_tag_versions() { printf '2.2.0\n3.0.0-staging.1\n3.0.0-rc.1\n'; }
assert_eq "registry_versions rust staging reads the rust tags" \
  "$(printf '2.2.0\n3.0.0-staging.1\n3.0.0-rc.1')" "$(real_registry_versions rust staging)"
assert_eq "registry_versions rust production still reads crates.io" "2.2.0" "$(real_registry_versions rust production)"
scratch_rust="$(mktemp -d)"
mkdir -p "$scratch_rust/sdks/rust"
printf '[package]\nname = "fireweave"\nversion = "2.2.0"\n' > "$scratch_rust/sdks/rust/Cargo.toml"
out_rust="$(cmd_compute rust major staging --manifest-root "$scratch_rust")"
assert_eq "rust staging with tag rust/v3.0.0-rc.1 -> 3.0.0-rc.2" \
  "3.0.0-rc.2" "$(printf '%s\n' "$out_rust" | sed -n 's/^release_version=//p')"
assert_eq "rust staging tag" "rust/v3.0.0-rc.2" "$(printf '%s\n' "$out_rust" | sed -n 's/^tag=//p')"
rm -rf "$scratch_rust"

# ---------------------------------------------- end-to-end compute(), network stubbed
# Prove the registry query is a genuinely swappable seam: override it with a
# fixed, in-memory stub (no curl/npm/git ever invoked) and confirm cmd_compute
# wires the stub's answer through staging_n / release_version / tag correctly.
registry_versions() { printf '2.1.0\n2.1.1-rc.1\n2.1.1-rc.2\n'; }

scratch="$(mktemp -d)"
mkdir -p "$scratch/sdks/node"
printf '{"name":"@fireweaveai/server-sdk","version":"2.1.0"}\n' > "$scratch/sdks/node/package.json"

out="$(cmd_compute server patch staging --manifest-root "$scratch")"
get() { printf '%s\n' "$out" | sed -n "s/^$1=//p"; }

assert_eq "stubbed e2e: current_version read from scratch manifest" "2.1.0" "$(get current_version)"
assert_eq "stubbed e2e: bumped_version" "2.1.1" "$(get bumped_version)"
assert_eq "stubbed e2e: staging_n continues past the stub's existing .1/.2" "3" "$(get staging_n)"
assert_eq "stubbed e2e: release_version" "2.1.1-rc.3" "$(get release_version)"
assert_eq "stubbed e2e: tag" "server/v2.1.1-rc.3" "$(get tag)"
assert_eq "stubbed e2e: npm dist-tag stays 'next' for staging (never latest)" "next" "$(get dist_tag)"

# The legacy -staging.N spelling never feeds the rc counter (3.0.0 onwards).
scratch_major="$(mktemp -d)"
mkdir -p "$scratch_major/sdks/node"
printf '{"name":"@fireweaveai/server-sdk","version":"2.2.0"}\n' > "$scratch_major/sdks/node/package.json"
registry_versions() { printf '2.2.0\n3.0.0-staging.1\n3.0.0-rc.1\n'; }
assert_eq "registry with 3.0.0-staging.1 and 3.0.0-rc.1 -> 3.0.0-rc.2" "3.0.0-rc.2" \
  "$(cmd_compute server major staging --manifest-root "$scratch_major" | sed -n 's/^release_version=//p')"
registry_versions() { printf '2.2.0\n3.0.0-staging.1\n'; }
assert_eq "registry with only 3.0.0-staging.1 -> 3.0.0-rc.1" "3.0.0-rc.1" \
  "$(cmd_compute server major staging --manifest-root "$scratch_major" | sed -n 's/^release_version=//p')"
rm -rf "$scratch_major"

# The compute guard: a staging version must carry the rc spelling.
assert_fail "guard: staging refuses a version without -rc." assert_staging_spelling server "3.0.0-staging.1"
assert_fail "guard: staging refuses a plain version" assert_staging_spelling go "3.0.0"
assert_fail "guard: python staging refuses a legacy alpha" assert_staging_spelling python "3.0.0a1"
assert_fail "guard: python staging refuses the unnormalised -rc.N" assert_staging_spelling python "3.0.0-rc.1"
assert_eq "guard: staging accepts X.Y.Z-rc.N" "ok" "$(assert_staging_spelling server "3.0.0-rc.1" && echo ok)"
assert_eq "guard: python staging accepts X.Y.ZrcN" "ok" "$(assert_staging_spelling python "3.0.0rc1" && echo ok)"

# Python staging must emit PEP 440 `XrcN`, not `-rc.N`. Its counter reads
# pypi.org through the real seam (pypi_versions is still the stub above).
registry_versions() { real_registry_versions "$@"; }
PYPI_STUB="$(printf '0.1.0\n0.1.1rc1\n0.1.1rc2\n')"
scratch_py="$(mktemp -d)"
mkdir -p "$scratch_py/sdks/python"
cat > "$scratch_py/sdks/python/pyproject.toml" <<'EOF'
[project]
name = "fireweave"
version = "0.1.0"
EOF
out_py="$(cmd_compute python patch staging --manifest-root "$scratch_py")"
get_py() { printf '%s\n' "$out_py" | sed -n "s/^$1=//p"; }
assert_eq "stubbed e2e python: bumped_version" "0.1.1" "$(get_py bumped_version)"
assert_eq "stubbed e2e python: staging_n continues past rc1/rc2" "3" "$(get_py staging_n)"
assert_eq "stubbed e2e python: release_version is PEP 440 rc" "0.1.1rc3" "$(get_py release_version)"
assert_eq "stubbed e2e python: tag" "python/v0.1.1rc3" "$(get_py tag)"
rm -rf "$scratch_py"
unset PYPI_STUB

# Dart uses the shared `-rc.N` form (pub.dev accepts semver
# prereleases); its "registry" is pub.dev's own package listing, read
# through the same stubbed seam. The pubspec version line is read by sed,
# never a YAML parser.
registry_versions() { printf '2.2.0\n2.2.1-rc.1\n'; }
scratch_fl="$(mktemp -d)"
mkdir -p "$scratch_fl/sdks/dart"
cat > "$scratch_fl/sdks/dart/pubspec.yaml" <<'EOF'
name: fireweave
description: test
version: 2.2.0 # trailing comment must not leak into the version
environment:
  sdk: ^3.8.0
EOF
out_fl="$(cmd_compute dart patch staging --manifest-root "$scratch_fl")"
get_fl() { printf '%s\n' "$out_fl" | sed -n "s/^$1=//p"; }
assert_eq "stubbed e2e dart: current_version read from pubspec" "2.2.0" "$(get_fl current_version)"
assert_eq "stubbed e2e dart: bumped_version" "2.2.1" "$(get_fl bumped_version)"
assert_eq "stubbed e2e dart: staging_n continues past .1" "2" "$(get_fl staging_n)"
assert_eq "stubbed e2e dart: release_version" "2.2.1-rc.2" "$(get_fl release_version)"
assert_eq "stubbed e2e dart: tag" "dart/v2.2.1-rc.2" "$(get_fl tag)"
assert_eq "stubbed e2e dart: no npm dist-tag" "n/a" "$(get_fl dist_tag)"
rm -rf "$scratch_fl"
# Restore the server stub for any later assertions that might call compute.
registry_versions() { printf '2.1.0\n2.1.1-rc.1\n2.1.1-rc.2\n'; }

# The production path additionally consults the tag list; stub that too so the
# suite keeps its zero-network-calls promise (no `git ls-remote` from a test).
remote_tag_versions() { printf '2.1.0\n2.1.1-rc.1\n2.1.1-rc.2\n'; }

out_prod="$(cmd_compute server patch production --manifest-root "$scratch")"
assert_eq "stubbed e2e: production has no staging suffix" "2.1.1" "$(printf '%s\n' "$out_prod" | sed -n 's/^release_version=//p')"
assert_eq "stubbed e2e: production dist-tag is latest" "latest" "$(printf '%s\n' "$out_prod" | sed -n 's/^dist_tag=//p')"

# ---------------------------------------------- production collision guard
# `compute` bumps from the committed manifest and nothing writes the applied
# version back, so a repeat production run recomputes the same number. The
# guard has to catch that from EITHER source: an artifact on the registry, or
# a tag on origin whose publish never landed (the server/web v2.3.0 case).

# (a) already on the registry -> refuse.
registry_versions() { printf '2.1.0\n2.1.1\n'; }
remote_tag_versions() { printf '2.1.0\n'; }
assert_fail "production refuses a version already on the registry" \
  cmd_compute server patch production --manifest-root "$scratch"

# (b) registry clean, but the tag exists -> still refuse. This is the orphan
#     tag left behind when a publish job is skipped or fails.
registry_versions() { printf '2.1.0\n'; }
remote_tag_versions() { printf '2.1.0\n2.1.1\n'; }
assert_fail "production refuses a version already tagged on origin" \
  cmd_compute server patch production --manifest-root "$scratch"

# (c) free on both -> proceeds.
registry_versions() { printf '2.1.0\n2.1.1-rc.4\n'; }
remote_tag_versions() { printf '2.1.0\n2.1.1-rc.4\n'; }
out_free="$(cmd_compute server patch production --manifest-root "$scratch")"
assert_eq "production proceeds when the version is free on both sources" \
  "2.1.1" "$(printf '%s\n' "$out_free" | sed -n 's/^release_version=//p')"

# (d) the guard is production-only — staging iterates N past collisions by
#     design and must not be blocked by a base version already published.
registry_versions() { printf '2.1.0\n2.1.1\n'; }
remote_tag_versions() { printf '2.1.0\n2.1.1\n'; }
out_stg="$(cmd_compute server patch staging --manifest-root "$scratch")"
assert_eq "staging is unaffected by an already-published base version" \
  "2.1.1-rc.1" "$(printf '%s\n' "$out_stg" | sed -n 's/^release_version=//p')"

rm -rf "$scratch"

# ------------------------------------------------------------- apply() offline
# apply() never touches the network — exercise every manifest writer against
# scratch copies (never the real repo manifests).
scratch2="$(mktemp -d)"
mkdir -p "$scratch2/sdks/node" "$scratch2/sdks/web" "$scratch2/sdks/python" "$scratch2/sdks/rust"
printf '{"name":"@fireweaveai/server-sdk","version":"2.1.0"}\n' > "$scratch2/sdks/node/package.json"
printf '{"name":"@fireweaveai/web-sdk","version":"2.1.0"}\n' > "$scratch2/sdks/web/package.json"
cat > "$scratch2/sdks/python/pyproject.toml" <<'EOF'
[project]
name = "fireweave"
version = "0.1.0"
EOF
cat > "$scratch2/sdks/rust/Cargo.toml" <<'EOF'
[package]
name = "fireweave"
version = "0.1.0"
EOF

cmd_apply server "2.1.1-rc.3" --manifest-root "$scratch2"
assert_eq "apply: server package.json written" '"2.1.1-rc.3"' "$(node -e 'console.log(JSON.stringify(require(process.argv[1]).version))' "$scratch2/sdks/node/package.json")"
assert_eq "apply: server build-info version stamped" "export const SDK_VERSION = '2.1.1-rc.3';" "$(grep '^export const SDK_VERSION' "$scratch2/sdks/node/src/start/build-info.ts")"
assert_eq "apply: staging version stamps the staging channel" "export const SDK_CHANNEL: 'staging' | 'production' = 'staging';" "$(grep '^export const SDK_CHANNEL' "$scratch2/sdks/node/src/start/build-info.ts")"
cmd_apply server "2.1.1" --manifest-root "$scratch2"
assert_eq "apply: production version stamps the production channel" "export const SDK_CHANNEL: 'staging' | 'production' = 'production';" "$(grep '^export const SDK_CHANNEL' "$scratch2/sdks/node/src/start/build-info.ts")"
# No legacy alias from 3.0.0: -staging.N and a bare -rc stamp production.
cmd_apply server "3.0.0-staging.1" --manifest-root "$scratch2"
assert_eq "apply: a legacy -staging.N version stamps production" "export const SDK_CHANNEL: 'staging' | 'production' = 'production';" "$(grep '^export const SDK_CHANNEL' "$scratch2/sdks/node/src/start/build-info.ts")"
cmd_apply server "3.0.0-rc" --manifest-root "$scratch2"
assert_eq "apply: -rc without an iteration stamps production" "export const SDK_CHANNEL: 'staging' | 'production' = 'production';" "$(grep '^export const SDK_CHANNEL' "$scratch2/sdks/node/src/start/build-info.ts")"

cmd_apply web "2.1.1" --manifest-root "$scratch2"
assert_eq "apply: web package.json written" '"2.1.1"' "$(node -e 'console.log(JSON.stringify(require(process.argv[1]).version))' "$scratch2/sdks/web/package.json")"
assert_eq "apply: web build-info version stamped" "export const SDK_VERSION = '2.1.1';" "$(grep '^export const SDK_VERSION' "$scratch2/sdks/web/src/start/build-info.ts")"
assert_eq "apply: web production version stamps the production channel" "export const SDK_CHANNEL: 'staging' | 'production' = 'production';" "$(grep '^export const SDK_CHANNEL' "$scratch2/sdks/web/src/start/build-info.ts")"
cmd_apply web "2.1.1-rc.2" --manifest-root "$scratch2"
assert_eq "apply: web staging version stamps the staging channel" "export const SDK_CHANNEL: 'staging' | 'production' = 'staging';" "$(grep '^export const SDK_CHANNEL' "$scratch2/sdks/web/src/start/build-info.ts")"

cmd_apply python "0.1.2rc1" --manifest-root "$scratch2"
assert_eq "apply: pyproject.toml written (PEP 440 rc)" "0.1.2rc1" "$(sed -nE 's/^version = \"([^\"]+)\".*/\1/p' "$scratch2/sdks/python/pyproject.toml" | head -n1)"

cmd_apply rust "0.1.1" --manifest-root "$scratch2"
assert_eq "apply: Cargo.toml written" "0.1.1" "$(sed -nE 's/^version = \"([^\"]+)\".*/\1/p' "$scratch2/sdks/rust/Cargo.toml" | head -n1)"

mkdir -p "$scratch2/sdks/dart"
cat > "$scratch2/sdks/dart/pubspec.yaml" <<'EOF'
name: fireweave
version: 2.2.0
environment:
  sdk: ^3.8.0
EOF
cmd_apply dart "2.2.1-rc.2" --manifest-root "$scratch2"
assert_eq "apply: pubspec.yaml written" "2.2.1-rc.2" "$(sed -nE 's/^version:[[:space:]]*(.*)$/\1/p' "$scratch2/sdks/dart/pubspec.yaml" | head -n1)"
assert_eq "apply: pubspec.yaml keeps its other keys" "name: fireweave" "$(head -n1 "$scratch2/sdks/dart/pubspec.yaml")"
assert_eq "apply: dart build_info version stamped" "const String buildSdkVersion = '2.2.1-rc.2';" "$(grep '^const String buildSdkVersion' "$scratch2/sdks/dart/lib/src/start/build_info.dart")"
assert_eq "apply: dart staging version stamps the staging channel" "const String buildSdkChannel = 'staging';" "$(grep '^const String buildSdkChannel' "$scratch2/sdks/dart/lib/src/start/build_info.dart")"
cmd_apply swift "2.3.0-rc.4" --manifest-root "$scratch2"
assert_eq "apply: swift build info version stamped" '  static let sdkVersion = "2.3.0-rc.4"' "$(grep 'static let sdkVersion' "$scratch2/sdks/swift/Sources/FireweaveStart/BuildInfo.swift")"
assert_eq "apply: swift staging version stamps the staging channel" '  static let sdkChannel = "staging"' "$(grep 'static let sdkChannel' "$scratch2/sdks/swift/Sources/FireweaveStart/BuildInfo.swift")"

# java: write_manifest shells out to `mvn versions:set` (same command
# publish-maven now calls this way instead of repeating it inline — see
# release.yml). Needs a real `mvn` on PATH; SKIP (not pass, not fail) rather
# than silently no-op when it's absent, so an environment without Maven
# doesn't get a false-green "44 passed" that never actually exercised this
# path.
mkdir -p "$scratch2/sdks/java"
cat > "$scratch2/sdks/java/pom.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>ai.fireweave</groupId>
  <artifactId>fireweave-java-parent</artifactId>
  <version>0.1.0-SNAPSHOT</version>
  <packaging>pom</packaging>
</project>
EOF
if command -v mvn >/dev/null 2>&1; then
  cmd_apply java "0.1.1" --manifest-root "$scratch2"
  written="$(python3 -c '
import sys
import xml.etree.ElementTree as ET
ns = {"m": "http://maven.apache.org/POM/4.0.0"}
root = ET.parse(sys.argv[1]).getroot()
print(root.find("m:version", ns).text.strip())
' "$scratch2/sdks/java/pom.xml")"
  assert_eq "apply: pom.xml written via mvn versions:set" "0.1.1" "$written"
else
  SKIP=$((SKIP + 1))
  echo "SKIP: apply: java (no 'mvn' on PATH in this environment — exercised in CI, which sets up Maven)" >&2
fi

# go/swift: apply() is a documented no-op (no manifest exists) — must not error.
if cmd_apply go "0.1.0" --manifest-root "$scratch2" 2>/dev/null; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  printf 'FAIL: apply: go no-op should exit 0\n' >&2
fi

rm -rf "$scratch2"

# ---------------------------------------------------------------- check-stamp
# check-stamp reads the channel the stamped workspace will actually call and
# fails unless it equals the channel the release was dispatched on. Runs in
# release.yml after `apply` and before every publish.
scratch3="$(mktemp -d)"
mkdir -p "$scratch3/sdks/node" "$scratch3/sdks/python" "$scratch3/sdks/rust" "$scratch3/sdks/dart" "$scratch3/sdks/java"
printf '{"name":"@fireweaveai/server-sdk","version":"2.2.0"}\n' > "$scratch3/sdks/node/package.json"
printf '[project]\nname = "fireweave"\nversion = "2.2.0"\n' > "$scratch3/sdks/python/pyproject.toml"
printf '[package]\nname = "fireweave"\nversion = "2.2.0"\n' > "$scratch3/sdks/rust/Cargo.toml"
printf 'name: fireweave\nversion: 2.2.0\n' > "$scratch3/sdks/dart/pubspec.yaml"
write_test_pom() { # <version>: the parent pom, written directly so this needs no mvn
  cat > "$scratch3/sdks/java/pom.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>ai.fireweave</groupId>
  <artifactId>fireweave-java-parent</artifactId>
  <version>$1</version>
</project>
EOF
}
check_ok() { # <label> <component> <channel> [version]
  local label="$1"
  shift
  if ( cmd_check_stamp "$@" --manifest-root "$scratch3" ) >/dev/null 2>&1; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s (check-stamp %s should pass)\n' "$label" "$*" >&2
  fi
}
check_refused() { # <label> <component> <channel> [version]
  local label="$1"
  shift
  assert_fail "$label" cmd_check_stamp "$@" --manifest-root "$scratch3"
}

cmd_apply server "3.0.0-rc.1" --manifest-root "$scratch3" 2>/dev/null
check_ok "check-stamp server: 3.0.0-rc.1 is staging" server staging
check_refused "check-stamp server: 3.0.0-rc.1 is not production" server production
cmd_apply server "3.0.0-rc" --manifest-root "$scratch3" 2>/dev/null
check_refused "check-stamp server: 3.0.0-rc is not staging" server staging
check_ok "check-stamp server: 3.0.0-rc is production" server production

cmd_apply dart "3.0.0-rc.1" --manifest-root "$scratch3" 2>/dev/null
check_ok "check-stamp dart: 3.0.0-rc.1 is staging" dart staging
check_refused "check-stamp dart: 3.0.0-rc.1 is not production" dart production
cmd_apply dart "3.0.0-rc" --manifest-root "$scratch3" 2>/dev/null
check_refused "check-stamp dart: 3.0.0-rc is not staging" dart staging

cmd_apply swift "3.0.0-rc.1" --manifest-root "$scratch3" 2>/dev/null
check_ok "check-stamp swift: 3.0.0-rc.1 is staging" swift staging
check_refused "check-stamp swift: 3.0.0-rc.1 is not production" swift production

cmd_apply rust "3.0.0-rc.1" --manifest-root "$scratch3" 2>/dev/null
check_ok "check-stamp rust: 3.0.0-rc.1 is staging" rust staging
check_refused "check-stamp rust: 3.0.0-rc.1 is not production" rust production
cmd_apply rust "3.0.0-rc" --manifest-root "$scratch3" 2>/dev/null
check_refused "check-stamp rust: 3.0.0-rc is not staging" rust staging
cmd_apply rust "3.0.0-staging.1" --manifest-root "$scratch3" 2>/dev/null
check_refused "check-stamp rust: a legacy 3.0.0-staging.1 is not staging" rust staging

write_test_pom "3.0.0-rc.1"
check_ok "check-stamp java: 3.0.0-rc.1 is staging" java staging
check_refused "check-stamp java: 3.0.0-rc.1 is not production" java production
write_test_pom "3.0.0-rc"
check_refused "check-stamp java: 3.0.0-rc is not staging" java staging
write_test_pom "3.0.0"
check_ok "check-stamp java: 3.0.0 is production" java production

cmd_apply python "3.0.0rc1" --manifest-root "$scratch3" 2>/dev/null
check_ok "check-stamp python: 3.0.0rc1 is staging" python staging
check_refused "check-stamp python: 3.0.0rc1 is not production" python production
cmd_apply python "3.0.0" --manifest-root "$scratch3" 2>/dev/null
check_refused "check-stamp python: 3.0.0 is not staging" python staging
check_ok "check-stamp python: 3.0.0 is production" python production
cmd_apply python "3.0.0.dev1" --manifest-root "$scratch3" 2>/dev/null
check_ok "check-stamp python: a dev release is staging (PEP 440 rule)" python staging

# go has no manifest: the tag's version is passed in.
check_ok "check-stamp go: v3.0.0-rc.1 is staging" go staging "v3.0.0-rc.1"
check_refused "check-stamp go: v3.0.0-rc.1 is not production" go production "v3.0.0-rc.1"
check_refused "check-stamp go: v3.0.0-staging.1 is not staging" go staging "v3.0.0-staging.1"
check_refused "check-stamp go: needs the tag's version" go staging
check_refused "check-stamp: an unknown channel is refused" server beta
rm -rf "$scratch3"

# ---------------------------------------------------------------------- summary
echo "version.test.sh: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
[ "$FAIL" -eq 0 ]
