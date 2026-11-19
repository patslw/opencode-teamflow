#!/usr/bin/env bash
# Package a committed release snapshot, never the developer's working directory.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
ref=${1:-HEAD}
version=$(git show "$ref:package.json" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version')
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$ ]] || { echo 'Expected an alpha package version' >&2; exit 1; }
prefix="opencode-teamflow-$version"
out=${2:-.runtime/releases}
mkdir -p "$out"
tmp=$(mktemp "$out/.alpha-source.XXXXXX")
trap 'rm -f "$tmp"' EXIT
git archive --format=tar --prefix="$prefix/" "$ref" -- \
  README.md .gitignore package.json package-lock.json tsconfig.json \
  apps/web apps/web-host/src apps/web-host/package.json config \
  packages/protocol plugin resources scripts docs/guide | gzip -n > "$tmp"
mv "$tmp" "$out/$prefix.tar.gz"
(cd "$out"; sha256sum "$prefix.tar.gz" > "$prefix.tar.gz.sha256")
echo "$out/$prefix.tar.gz"
