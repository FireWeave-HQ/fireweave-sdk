#!/usr/bin/env bash
# Package build DRY RUNS for all four SDKs — never publishes anything.
#   - Node:   npm run build + npm pack (tarball)
#   - Python: python -m build (sdist + wheel)
#   - Go:     go build ./... + go mod verify (modules ship via VCS tags; the
#             module zip is produced by the Go proxy from the tag, so the
#             closest local dry run is a clean build + sum verification)
#   - Java:   mvn -DskipTests package (jars)
# Artifacts + SHA-256 checksums land in build/packages/ (gitignored).
#
# Usage: scripts/build-all.sh [--out-dir DIR]

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT_DIR="$FW_ROOT/build/packages"
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

# ---------- Node: npm pack ----------
fw_node_deps
fw_section "node: build + npm pack (dry-run packaging)"
(cd "$FW_ROOT/sdks/node" && npm run --silent build)
(cd "$FW_ROOT/sdks/node" && npm pack --pack-destination "$OUT_DIR")

# ---------- Python: python -m build ----------
fw_python_venv
fw_section "python: python -m build (sdist + wheel)"
if ! PYTHONSAFEPATH=1 "$FW_PY" -c 'import build.__main__' >/dev/null 2>&1; then
  "$FW_PY" -m pip install --quiet build || fw_die "cannot install 'build' (network required once)"
fi
# PYTHONSAFEPATH keeps cwd off sys.path so stray build/ directories cannot
# shadow the pypa 'build' module (ignored harmlessly on Python 3.10).
(cd "$FW_ROOT/sdks/python" && PYTHONSAFEPATH=1 "$FW_PY" -m build --outdir "$OUT_DIR")
# Setuptools regenerates src/fireweave.egg-info/ during the sdist build.
# That directory is (defectively) committed — reported to the orchestrator as
# an sdks/python hygiene issue; until it is gitignored, restore it so a
# packaging DRY RUN leaves the working tree clean.
if git -C "$FW_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$FW_ROOT" checkout --quiet -- sdks/python/src/fireweave.egg-info/ 2>/dev/null || true
fi

# ---------- Go: build + module verification ----------
fw_section "go: build + go mod verify"
# -o into a temp dir so main-package binaries never land in the source tree
# (examples/go would otherwise get an untracked/overwritten `go` binary).
GO_TMP="$(mktemp -d)"
trap 'rm -rf "$GO_TMP"' EXIT
(cd "$FW_ROOT/go" && go build -o "$GO_TMP/" ./... && go mod verify)
(cd "$FW_ROOT/examples/go" && go build -o "$GO_TMP/" ./... && go mod verify)

# ---------- Java: mvn package ----------
fw_section "java: mvn -DskipTests package"
mvn -q -f "$FW_ROOT/sdks/java/pom.xml" -DskipTests clean package
find "$FW_ROOT/sdks/java" -path '*/target/*.jar' -not -name '*sources*' \
  -exec cp {} "$OUT_DIR/" \;

# ---------- Checksums ----------
fw_section "checksums (SHA-256)"
(
  cd "$OUT_DIR"
  : > SHA256SUMS
  for f in *; do
    [ "$f" = "SHA256SUMS" ] && continue
    shasum -a 256 "$f" >> SHA256SUMS
  done
  cat SHA256SUMS
)

fw_section "artifacts in $OUT_DIR"
ls -1 "$OUT_DIR"
echo
echo "NOTE: dry run only — nothing was published (npm/PyPI/Maven publishing is"
echo "hard-disabled; see .github/RELEASE.md)."
