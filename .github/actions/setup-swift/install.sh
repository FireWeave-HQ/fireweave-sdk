#!/usr/bin/env bash
# Installs Swift $SWIFT_VERSION for Ubuntu 24.04 from download.swift.org, verified against the
# keys swift.org publishes, and adds it to $GITHUB_PATH. Used by .github/actions/setup-swift.
set -euo pipefail

version="${SWIFT_VERSION:?SWIFT_VERSION is required, for example 6.4.2}"
case "$(uname -m)" in
  x86_64) arch="" ;;
  aarch64) arch="-aarch64" ;;
  *) echo "setup-swift: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
name="swift-${version}-RELEASE-ubuntu24.04${arch}"
url="https://download.swift.org/swift-${version}-release/ubuntu2404${arch}/swift-${version}-RELEASE/${name}.tar.gz"
dest="${RUNNER_TOOL_CACHE:-$HOME/.cache}/swift/${version}${arch}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 -o "$work/swift.tar.gz" "$url"
curl -fsSL --retry 3 -o "$work/swift.tar.gz.sig" "$url.sig"

# A fresh keyring holding only swift.org's keys, fetched over HTTPS. There is no keyserver
# refresh (swift.org's install guide marks it optional); the signature must verify regardless.
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
curl -fsSL --retry 3 -o "$work/all-keys.asc" https://swift.org/keys/all-keys.asc
if gunzip --test "$work/all-keys.asc" 2>/dev/null; then
  zcat "$work/all-keys.asc" | gpg --batch --quiet --import
else
  gpg --batch --quiet --import "$work/all-keys.asc"
fi
gpg --batch --verify "$work/swift.tar.gz.sig" "$work/swift.tar.gz"

mkdir -p "$dest"
tar -xzf "$work/swift.tar.gz" -C "$dest" --strip-components=1
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$dest/usr/bin" >> "$GITHUB_PATH"
fi
"$dest/usr/bin/swift" --version
