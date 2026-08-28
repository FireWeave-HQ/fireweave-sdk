#!/usr/bin/env bash
# Read -> bump -> write the release version for one SDK component.
#
# Usage:
#   tools/release/version.sh compute <component> <bump> <channel> [--manifest-root DIR]
#   tools/release/version.sh apply   <component> <release-version> [--manifest-root DIR]
#
#   component : server | web | python | java | go | rust | swift
#   bump      : patch | minor | major        (compute only)
#   channel   : staging | production          (compute only)
#   --manifest-root DIR : resolve/write manifests under DIR instead of the
#                repo root (points `apply` — or `compute`'s reads — at a
#                scratch copy so nothing ever mutates the real manifest).
#
# `compute` reads the component's current manifest version (or, for go/swift
# — which carry no version field; the git tag IS the version record — the
# highest existing plain `<prefix>/vX.Y.Z` tag, defaulting to 0.0.0 when none
# exists), strips any prerelease/build metadata, applies <bump>, and — for
# channel=staging — appends a staging iteration whose N is the next unused
# for that base version:
#   - most ecosystems: `X.Y.Z-staging.N` (npm / Cargo / git-tag consumers)
#   - python only:     `X.Y.ZaN` (PEP 440; `-staging.N` is rejected by
#                      packaging/setuptools and cannot be uploaded to
#                      TestPyPI/PyPI)
# It prints `key=value` lines to stdout (GITHUB_OUTPUT-compatible; see the
# block below) and never writes anything.
#
# `apply` takes an ALREADY-COMPUTED release version (typically `compute`'s
# own `release_version` output, downloaded from wherever `compute` ran) and
# writes it into the component's manifest. It does no bump math and touches
# no registry — it is the pure, trivially-testable half of "read -> bump ->
# write". go/swift have no manifest to write; `apply` is a documented no-op
# for them (the tag already pushed by the caller IS the version record).
#
# Why two subcommands instead of one "read -> bump -> write" call: a release
# that fans out to multiple jobs (build computes the version; a LATER,
# separately-checked-out publish job needs the SAME value to build the
# artifact it actually ships) must not have the publish job recompute from
# scratch. For go/java/swift specifically (registry_versions() below reads
# git tags over the network via `git ls-remote`, there being no test
# registry for any of the three — see registry_versions()'s comment), a
# recompute AFTER the release's own tag has been pushed would see that very
# tag and double-count. Computing once and applying the same value downstream
# removes the race entirely, for every ecosystem, not just the ones where it
# would otherwise bite.
#
# Two mandated behaviors (IMPLEMENTATION-PLAN.md Phase 7 / task-14 brief):
#   - any existing prerelease is stripped BEFORE bumping (1.4.0-staging.3 +
#     patch = 1.4.1, never 1.4.0-staging.4) — strip_prerelease() + semver_bump().
#   - the staging iteration N is read from the ecosystem's registry, not a
#     local file, so two operators releasing from different branches both
#     see the true next N — registry_versions() + max_staging_n().
#
# Sibling script: tools/release/changelog.sh (style/conventions followed here).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

usage() {
  cat >&2 <<'EOF'
Usage:
  version.sh compute <component> <bump> <channel> [--manifest-root DIR]
  version.sh apply   <component> <release-version> [--manifest-root DIR]

  component : server | web | python | java | go | rust | swift
  bump      : patch | minor | major
  channel   : staging | production
EOF
}

# --------------------------------------------------------------------------
# Component tables
# --------------------------------------------------------------------------

# Relative manifest path for a component, or "" for go/swift (no version
# field exists in go.mod / Package.swift — the git tag is authoritative).
component_manifest() {
  case "$1" in
    server) printf 'sdks/node/package.json\n' ;;
    web)    printf 'sdks/web/package.json\n' ;;
    python) printf 'sdks/python/pyproject.toml\n' ;;
    java)   printf 'sdks/java/pom.xml\n' ;;
    rust)   printf 'sdks/rust/Cargo.toml\n' ;;
    go|swift) printf '\n' ;;
    *) return 1 ;;
  esac
}

# Tag prefix: org convention is <component>/v<semver>, with go's forced
# exception (module in subdirectory sdks/go must be tagged sdks/go/v<semver>
# for `go get` to resolve it — see RELEASE.md). server/web/python/java/rust
# have never published, so the rename/additions break no historical tag.
component_tag_prefix() {
  case "$1" in
    go) printf 'sdks/go\n' ;;
    server|web|python|java|rust|swift) printf '%s\n' "$1" ;;
    *) return 1 ;;
  esac
}

component_npm_package() {
  case "$1" in
    server) printf '@fireweaveai/server-sdk\n' ;;
    web)    printf '@fireweaveai/web-sdk\n' ;;
    *) return 1 ;;
  esac
}

require_known_component() {
  case "$1" in
    server|web|python|java|go|rust|swift) ;;
    *) echo "version.sh: unknown component '$1' (server|web|python|java|go|rust|swift)" >&2; exit 2 ;;
  esac
}

# --------------------------------------------------------------------------
# Pure semver helpers (no I/O — exercised directly by version.test.sh)
# --------------------------------------------------------------------------

# Strip any prerelease AND build-metadata segment:
#   "1.4.0-staging.3+x" -> "1.4.0"
#   "1.4.0a3" / "1.4.0b1" / "1.4.0rc2" -> "1.4.0"  (PEP 440; python staging)
#   "1.4.0.dev1" / "1.4.0.post1" -> "1.4.0"
semver_strip_prerelease() {
  local v="$1"
  v="${v%%+*}"
  v="${v%%-*}"
  # .devN / .postN sit after the X.Y.Z core with a literal dot.
  v="$(printf '%s' "$v" | sed -E 's/\.(dev|post)[0-9]+.*$//')"
  # aN / bN / rcN / cN / alphaN / betaN / previewN glued to the core.
  v="$(printf '%s' "$v" | sed -E 's/(a|b|c|rc|alpha|beta|preview)[0-9]+.*$//')"
  printf '%s\n' "$v"
}

# "1.4.0" "patch|minor|major" -> next base version. Dies on a malformed base
# (should never happen post strip_prerelease unless the manifest itself is
# not valid semver).
semver_bump() {
  local base="$1" kind="$2" major minor patch
  if ! printf '%s' "$base" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "version.sh: '$base' is not a bare major.minor.patch version" >&2
    return 2
  fi
  IFS='.' read -r major minor patch <<<"$base"
  case "$kind" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *) echo "version.sh: invalid bump '$kind' (patch|minor|major)" >&2; return 2 ;;
  esac
  printf '%s.%s.%s\n' "$major" "$minor" "$patch"
}

# "1.4.0-staging.3" "1.4.0" -> "3" (exit 1, no stdout, if $1 is not a
# "<base>-staging.<digits>" string — including a non-matching base).
extract_staging_n() {
  local v="$1" base="$2" rest
  case "$v" in
    "${base}-staging."*)
      rest="${v#"${base}"-staging.}"
      rest="${rest%%+*}"
      case "$rest" in
        ''|*[!0-9]*) return 1 ;;
      esac
      printf '%s\n' "$rest"
      ;;
    *) return 1 ;;
  esac
}

# <base-version> <newline-separated existing version strings via stdin> ->
# highest existing "-staging.N" iteration for that base, or 0 if none.
max_staging_n() {
  local base="$1" max=0 n line
  # `|| [ -n "$line" ]` so the last line is still processed when the input
  # (e.g. a plain `printf '%s'` with no trailing newline) has none — `read`
  # returns non-zero on that final, newline-less line but still populates it.
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    if n="$(extract_staging_n "$line" "$base" 2>/dev/null)"; then
      if [ "$n" -gt "$max" ]; then max="$n"; fi
    fi
  done
  printf '%s\n' "$max"
}

# "1.4.0a3" "1.4.0" -> "3" (PEP 440 alpha used for python staging).
# Exit 1 with no stdout when $1 is not "<base>a<digits>".
extract_pep440_alpha_n() {
  local v="$1" base="$2" rest
  case "$v" in
    "${base}a"*)
      rest="${v#"${base}"a}"
      rest="${rest%%+*}"
      case "$rest" in
        ''|*[!0-9]*) return 1 ;;
      esac
      printf '%s\n' "$rest"
      ;;
    *) return 1 ;;
  esac
}

# Same as max_staging_n but for PEP 440 "<base>aN" (python TestPyPI/PyPI).
max_pep440_alpha_n() {
  local base="$1" max=0 n line
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    if n="$(extract_pep440_alpha_n "$line" "$base" 2>/dev/null)"; then
      if [ "$n" -gt "$max" ]; then max="$n"; fi
    fi
  done
  printf '%s\n' "$max"
}

# Numeric-safe "highest X.Y.Z" over a newline list of bare semver strings
# (no prerelease). Prints nothing (exit 1) if the input is empty.
highest_plain_version() {
  local input="$1" filtered
  filtered="$(printf '%s\n' "$input" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true)"
  [ -z "$filtered" ] && return 1
  printf '%s\n' "$filtered" \
    | awk -F. '{printf "%05d%05d%05d %s\n", $1, $2, $3, $0}' \
    | sort \
    | tail -n1 \
    | cut -d' ' -f2
}

# --------------------------------------------------------------------------
# Registry access (the "mockable seam" — the only I/O in this file)
# --------------------------------------------------------------------------

# GET a URL; print the body on 200, print nothing on 404 (a clean "does not
# exist yet" — the correct signal for "zero existing versions"), and FAIL
# LOUDLY (non-zero exit) on anything else (including "no HTTP response at
# all", i.e. curl couldn't connect) — a network outage must never be
# silently read as "nothing published yet".
http_get_json() {
  local url="$1" tmp status
  tmp="$(mktemp)"
  status="$(curl -sS -m 20 -o "$tmp" -w '%{http_code}' "$url" 2>/dev/null)" || true
  status="${status:-000}"
  case "$status" in
    200) cat "$tmp"; rm -f "$tmp"; return 0 ;;
    404) rm -f "$tmp"; return 0 ;;
    *)
      echo "version.sh: GET $url -> HTTP ${status:-<no response>} — cannot compute staging iteration" >&2
      rm -f "$tmp"
      return 2
      ;;
  esac
}

# <npm package> -> newline list of every published version, "" if the
# package has never been published, non-zero (with a stderr message) on any
# other npm/network failure.
npm_versions() {
  local pkg="$1" out err_file
  err_file="$(mktemp)"
  if out="$(npm view "$pkg" versions --json 2>"$err_file")"; then
    rm -f "$err_file"
    printf '%s' "$out" | node -e '
      let s = "";
      process.stdin.on("data", (d) => { s += d; });
      process.stdin.on("end", () => {
        const v = JSON.parse(s || "[]");
        (Array.isArray(v) ? v : [v]).forEach((x) => console.log(x));
      });'
    return 0
  fi
  if grep -q 'E404' "$err_file"; then
    rm -f "$err_file"
    return 0
  fi
  echo "version.sh: npm view $pkg versions failed (not a 404 — likely network/auth):" >&2
  cat "$err_file" >&2
  rm -f "$err_file"
  return 2
}

# <pypi index base URL, e.g. https://test.pypi.org> <project name> -> newline
# list of every published version.
pypi_versions() {
  local index="$1" name="$2" body
  body="$(http_get_json "${index}/pypi/${name}/json")"
  [ -z "$body" ] && return 0
  printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for v in d.get("releases", {}):
    print(v)
'
}

# <crate name> -> newline list of every published version on crates.io.
# crates.io requires a descriptive User-Agent (their API policy) or every
# request 403s regardless of the crate's existence.
crates_versions() {
  local name="$1" body status json
  body="$(curl -sS -m 20 -H 'User-Agent: fireweave-sdk-release (release-eng@fireweave.ai)' \
    -w '\n%{http_code}' "https://crates.io/api/v1/crates/${name}" 2>/dev/null)" || true
  status="${body##*$'\n'}"
  json="${body%$'\n'"$status"}"
  [ -z "$status" ] && status=000
  case "$status" in
    200) : ;;
    404) return 0 ;;
    *)
      echo "version.sh: GET crates.io/api/v1/crates/${name} -> HTTP ${status:-<no response>} — cannot compute staging iteration" >&2
      return 2
      ;;
  esac
  printf '%s' "$json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for v in d.get("versions", []):
    print(v.get("num", ""))
'
}

# <tag prefix, e.g. "java" or "sdks/go"> -> newline list of every "X.Y.Z" (or
# "X.Y.Z-staging.N") segment following "<prefix>/v" among tags on the ORIGIN
# remote (a live network query, not the local tag cache — see the module
# header for why this matters).
remote_tag_versions() {
  local prefix="$1"
  git ls-remote --tags origin "${prefix}/v*" 2>/dev/null \
    | sed -E "s#.*refs/tags/${prefix}/v##" \
    | sed 's/\^{}$//'
}

# component channel -> newline list of every version string known to that
# component's registry (staging: wherever a staging publish would actually
# land; production: the real registry) — the sole input to max_staging_n().
#
# No staging registry exists for rust, and none exists at all for go/java/
# swift (Maven Central Portal shares one credential set across channels;
# go/swift have no package registry, only git tags — see RELEASE.md). For
# those four, the "registry" queried here is `git ls-remote` against origin:
# a live network round-trip against the shared remote, not a local file, and
# — for go specifically — MORE authoritative than proxy.golang.org (which is
# itself just a cache over these same tags and can lag).
registry_versions() {
  local component="$1" channel="$2"
  case "$component" in
    server|web)
      npm_versions "$(component_npm_package "$component")"
      ;;
    python)
      if [ "$channel" = staging ]; then
        pypi_versions "https://test.pypi.org" fireweave
      else
        pypi_versions "https://pypi.org" fireweave
      fi
      ;;
    rust)
      crates_versions fireweave
      ;;
    go|java|swift)
      remote_tag_versions "$(component_tag_prefix "$component")"
      ;;
  esac
}

# --------------------------------------------------------------------------
# Manifest read / write
# --------------------------------------------------------------------------

read_current_version() {
  local component="$1" manifest="$2"
  case "$component" in
    server|web)
      node -e 'console.log(require(process.argv[1]).version)' "$manifest"
      ;;
    python|rust)
      # tomllib is 3.11+; CI uses modern Python. Offline/macOS 3.9 falls back
      # to a single-line match so compute still works without a backport.
      if python3 -c 'import tomllib' 2>/dev/null; then
        if [ "$component" = python ]; then
          python3 -c 'import tomllib,sys; print(tomllib.load(open(sys.argv[1],"rb"))["project"]["version"])' "$manifest"
        else
          python3 -c 'import tomllib,sys; print(tomllib.load(open(sys.argv[1],"rb"))["package"]["version"])' "$manifest"
        fi
      else
        sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$manifest" | head -n1
      fi
      ;;
    java)
      python3 - "$manifest" <<'PY'
import sys
import xml.etree.ElementTree as ET
ns = {"m": "http://maven.apache.org/POM/4.0.0"}
root = ET.parse(sys.argv[1]).getroot()
el = root.find("m:version", ns)
print((el.text or "").strip() if el is not None else "")
PY
      ;;
  esac
}

write_toml_version() {
  local manifest="$1" version="$2"
  python3 - "$manifest" "$version" <<'PY'
import re, sys
path, version = sys.argv[1], sys.argv[2]
text = open(path, "r", encoding="utf-8").read()
new_text, n = re.subn(r'(?m)^version = "[^"]*"$', f'version = "{version}"', text, count=1)
if n != 1:
    sys.exit(f"version.sh: expected exactly one top-level `version = \"...\"` line in {path}, found {n}")
open(path, "w", encoding="utf-8").write(new_text)
PY
}

write_manifest() {
  local component="$1" manifest="$2" version="$3"
  case "$component" in
    server|web)
      npm --prefix "$(dirname "$manifest")" pkg set "version=$version" >/dev/null
      ;;
    python|rust)
      write_toml_version "$manifest" "$version"
      ;;
    java)
      mvn -q -f "$manifest" versions:set -DnewVersion="$version" -DgenerateBackupPoms=false
      ;;
  esac
}

# --------------------------------------------------------------------------
# Subcommands
# --------------------------------------------------------------------------

cmd_compute() {
  local component="${1:?usage: version.sh compute <component> <bump> <channel>}"
  local bump="${2:?usage: version.sh compute <component> <bump> <channel>}"
  local channel="${3:?usage: version.sh compute <component> <bump> <channel>}"
  shift 3
  local manifest_root="$ROOT"
  while [ $# -gt 0 ]; do
    case "$1" in
      --manifest-root) manifest_root="${2:?--manifest-root requires a path}"; shift 2 ;;
      *) echo "version.sh: unknown flag '$1'" >&2; usage; exit 2 ;;
    esac
  done

  require_known_component "$component"
  case "$bump" in
    patch|minor|major) ;;
    *) echo "version.sh: invalid bump '$bump' (patch|minor|major)" >&2; exit 2 ;;
  esac
  case "$channel" in
    staging|production) ;;
    *) echo "version.sh: invalid channel '$channel' (staging|production)" >&2; exit 2 ;;
  esac

  local rel_manifest manifest=""
  rel_manifest="$(component_manifest "$component")"
  [ -n "$rel_manifest" ] && manifest="$manifest_root/$rel_manifest"

  local current_version
  if [ -n "$manifest" ]; then
    current_version="$(read_current_version "$component" "$manifest")"
  else
    current_version="$(highest_plain_version "$(remote_tag_versions "$(component_tag_prefix "$component")")" || printf '0.0.0\n')"
  fi

  local base_version bumped_version
  base_version="$(semver_strip_prerelease "$current_version")"
  bumped_version="$(semver_bump "$base_version" "$bump")"

  local staging_n="" release_version dist_tag="n/a"
  if [ "$channel" = staging ]; then
    local existing
    existing="$(registry_versions "$component" "$channel")"
    # Python must use PEP 440 (`XaN`); `-staging.N` fails packaging and
    # cannot be uploaded to TestPyPI/PyPI. Other ecosystems keep the
    # shared `-staging.N` form.
    if [ "$component" = python ]; then
      staging_n=$(( $(printf '%s' "$existing" | max_pep440_alpha_n "$bumped_version") + 1 ))
      release_version="${bumped_version}a${staging_n}"
    else
      staging_n=$(( $(printf '%s' "$existing" | max_staging_n "$bumped_version") + 1 ))
      release_version="${bumped_version}-staging.${staging_n}"
    fi
  else
    release_version="$bumped_version"
  fi

  case "$component" in
    server|web)
      if [ "$channel" = staging ]; then dist_tag=next; else dist_tag=latest; fi
      ;;
  esac

  local tag_prefix tag
  tag_prefix="$(component_tag_prefix "$component")"
  tag="${tag_prefix}/v${release_version}"

  printf 'component=%s\n' "$component"
  printf 'bump=%s\n' "$bump"
  printf 'channel=%s\n' "$channel"
  printf 'manifest_path=%s\n' "$rel_manifest"
  printf 'current_version=%s\n' "$current_version"
  printf 'base_version=%s\n' "$base_version"
  printf 'bumped_version=%s\n' "$bumped_version"
  printf 'staging_n=%s\n' "$staging_n"
  printf 'release_version=%s\n' "$release_version"
  printf 'tag_prefix=%s\n' "$tag_prefix"
  printf 'tag=%s\n' "$tag"
  printf 'dist_tag=%s\n' "$dist_tag"
}

cmd_apply() {
  local component="${1:?usage: version.sh apply <component> <release-version>}"
  local release_version="${2:?usage: version.sh apply <component> <release-version>}"
  shift 2
  local manifest_root="$ROOT"
  while [ $# -gt 0 ]; do
    case "$1" in
      --manifest-root) manifest_root="${2:?--manifest-root requires a path}"; shift 2 ;;
      *) echo "version.sh: unknown flag '$1'" >&2; usage; exit 2 ;;
    esac
  done

  require_known_component "$component"

  local rel_manifest
  rel_manifest="$(component_manifest "$component")"
  if [ -z "$rel_manifest" ]; then
    echo "version.sh: $component has no version manifest — the git tag is the version record; nothing written" >&2
    return 0
  fi
  write_manifest "$component" "$manifest_root/$rel_manifest" "$release_version"
  echo "version.sh: wrote $release_version to $rel_manifest" >&2
}

main() {
  if [ $# -lt 1 ]; then usage; exit 2; fi
  local sub="$1"
  shift
  case "$sub" in
    compute) cmd_compute "$@" ;;
    apply) cmd_apply "$@" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "version.sh: unknown subcommand '$sub' (compute|apply)" >&2; usage; exit 2 ;;
  esac
}

# Sourced (by version.test.sh) vs executed: only run main() when invoked
# directly, so tests can `source` this file to exercise the functions above
# with zero network calls and zero process-argv plumbing.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
