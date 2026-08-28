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
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s (expected non-zero exit, got 0)\n' "$label" >&2
  else
    PASS=$((PASS + 1))
  fi
}

# -------------------------------------------------------------- strip_prerelease
assert_eq "strip: plain version unchanged" "1.4.0" "$(semver_strip_prerelease "1.4.0")"
assert_eq "strip: drops -staging.N" "1.4.0" "$(semver_strip_prerelease "1.4.0-staging.3")"
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
# "1.4.0-staging.3 + patch must give 1.4.1" — never 1.4.0-staging.4.
staged_base="$(semver_strip_prerelease "1.4.0-staging.3")"
assert_eq "mandate: strip(1.4.0-staging.3)=1.4.0" "1.4.0" "$staged_base"
assert_eq "mandate: strip-then-bump patch = 1.4.1" "1.4.1" "$(semver_bump "$staged_base" patch)"
snapshot_base="$(semver_strip_prerelease "0.1.0-SNAPSHOT")"
assert_eq "mandate: java -SNAPSHOT strips + bumps patch = 0.1.1" "0.1.1" "$(semver_bump "$snapshot_base" patch)"

# -------------------------------------------------------------- extract_staging_n
assert_eq "extract: matching base+N" "3" "$(extract_staging_n "1.4.0-staging.3" "1.4.0")"
assert_eq "extract: double-digit N" "12" "$(extract_staging_n "1.4.0-staging.12" "1.4.0")"
assert_fail "extract: non-matching base" extract_staging_n "1.4.0-staging.3" "1.5.0"
assert_fail "extract: plain version (no staging suffix)" extract_staging_n "1.4.0" "1.4.0"
assert_fail "extract: non-numeric N" extract_staging_n "1.4.0-staging.rc1" "1.4.0"

# ------------------------------------------------------------------ max_staging_n
existing="$(printf '1.4.0\n1.4.0-staging.1\n1.4.0-staging.3\n1.4.0-staging.2\n2.0.0-staging.9\n')"
assert_eq "max_staging_n: picks the highest N for the matching base" \
  "3" "$(printf '%s' "$existing" | max_staging_n "1.4.0")"
assert_eq "max_staging_n: 0 when nothing matches the base" \
  "0" "$(printf '%s' "$existing" | max_staging_n "9.9.9")"
assert_eq "max_staging_n: 0 on empty registry (first-ever staging release)" \
  "0" "$(printf '' | max_staging_n "1.4.0")"

# ------------------------------------------------------ PEP 440 alpha (python)
assert_eq "extract pep440 alpha: matching base+N" "3" "$(extract_pep440_alpha_n "1.4.0a3" "1.4.0")"
assert_eq "extract pep440 alpha: double-digit N" "12" "$(extract_pep440_alpha_n "1.4.0a12" "1.4.0")"
assert_fail "extract pep440 alpha: non-matching base" extract_pep440_alpha_n "1.4.0a3" "1.5.0"
assert_fail "extract pep440 alpha: plain version" extract_pep440_alpha_n "1.4.0" "1.4.0"
assert_fail "extract pep440 alpha: -staging form is not alpha" extract_pep440_alpha_n "1.4.0-staging.3" "1.4.0"
alphas="$(printf '1.4.0\n1.4.0a1\n1.4.0a3\n1.4.0a2\n2.0.0a9\n')"
assert_eq "max_pep440_alpha_n: picks the highest N for the matching base" \
  "3" "$(printf '%s' "$alphas" | max_pep440_alpha_n "1.4.0")"
assert_eq "max_pep440_alpha_n: 0 when nothing matches" \
  "0" "$(printf '%s' "$alphas" | max_pep440_alpha_n "9.9.9")"
assert_eq "max_pep440_alpha_n: 0 on empty registry" \
  "0" "$(printf '' | max_pep440_alpha_n "1.4.0")"

# -------------------------------------------------------------- highest_plain_version
tags="$(printf '0.1.0\n0.2.0\n0.10.0\n0.2.0-staging.1\nnot-a-version\n')"
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
assert_fail "unknown component is rejected" component_manifest bogus

# ---------------------------------------------- end-to-end compute(), network stubbed
# Prove the registry query is a genuinely swappable seam: override it with a
# fixed, in-memory stub (no curl/npm/git ever invoked) and confirm cmd_compute
# wires the stub's answer through staging_n / release_version / tag correctly.
registry_versions() { printf '2.1.0\n2.1.1-staging.1\n2.1.1-staging.2\n'; }

scratch="$(mktemp -d)"
mkdir -p "$scratch/sdks/node"
printf '{"name":"@fireweaveai/server-sdk","version":"2.1.0"}\n' > "$scratch/sdks/node/package.json"

out="$(cmd_compute server patch staging --manifest-root "$scratch")"
get() { printf '%s\n' "$out" | sed -n "s/^$1=//p"; }

assert_eq "stubbed e2e: current_version read from scratch manifest" "2.1.0" "$(get current_version)"
assert_eq "stubbed e2e: bumped_version" "2.1.1" "$(get bumped_version)"
assert_eq "stubbed e2e: staging_n continues past the stub's existing .1/.2" "3" "$(get staging_n)"
assert_eq "stubbed e2e: release_version" "2.1.1-staging.3" "$(get release_version)"
assert_eq "stubbed e2e: tag" "server/v2.1.1-staging.3" "$(get tag)"
assert_eq "stubbed e2e: npm dist-tag stays 'next' for staging (never latest)" "next" "$(get dist_tag)"

# Python staging must emit PEP 440 `XaN`, not `-staging.N`.
registry_versions() { printf '0.1.0\n0.1.1a1\n0.1.1a2\n'; }
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
assert_eq "stubbed e2e python: staging_n continues past a1/a2" "3" "$(get_py staging_n)"
assert_eq "stubbed e2e python: release_version is PEP 440 alpha" "0.1.1a3" "$(get_py release_version)"
assert_eq "stubbed e2e python: tag" "python/v0.1.1a3" "$(get_py tag)"
rm -rf "$scratch_py"
# Restore the server stub for any later assertions that might call compute.
registry_versions() { printf '2.1.0\n2.1.1-staging.1\n2.1.1-staging.2\n'; }

out_prod="$(cmd_compute server patch production --manifest-root "$scratch")"
assert_eq "stubbed e2e: production has no staging suffix" "2.1.1" "$(printf '%s\n' "$out_prod" | sed -n 's/^release_version=//p')"
assert_eq "stubbed e2e: production dist-tag is latest" "latest" "$(printf '%s\n' "$out_prod" | sed -n 's/^dist_tag=//p')"

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

cmd_apply server "2.1.1-staging.3" --manifest-root "$scratch2"
assert_eq "apply: server package.json written" '"2.1.1-staging.3"' "$(node -e 'console.log(JSON.stringify(require(process.argv[1]).version))' "$scratch2/sdks/node/package.json")"

cmd_apply web "2.1.1" --manifest-root "$scratch2"
assert_eq "apply: web package.json written" '"2.1.1"' "$(node -e 'console.log(JSON.stringify(require(process.argv[1]).version))' "$scratch2/sdks/web/package.json")"

cmd_apply python "0.1.2a1" --manifest-root "$scratch2"
assert_eq "apply: pyproject.toml written (PEP 440 alpha)" "0.1.2a1" "$(sed -nE 's/^version = \"([^\"]+)\".*/\1/p' "$scratch2/sdks/python/pyproject.toml" | head -n1)"

cmd_apply rust "0.1.1" --manifest-root "$scratch2"
assert_eq "apply: Cargo.toml written" "0.1.1" "$(sed -nE 's/^version = \"([^\"]+)\".*/\1/p' "$scratch2/sdks/rust/Cargo.toml" | head -n1)"

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

# ---------------------------------------------------------------------- summary
echo "version.test.sh: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
[ "$FAIL" -eq 0 ]
