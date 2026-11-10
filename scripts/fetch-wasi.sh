#!/usr/bin/env bash
# Fetch the WASI userspace bundles at build time — pinned upstream release
# with sha256 verification (replaces the .webc blobs that used to live in
# this repo; compiled artifacts must not be vendored).
set -euo pipefail
BASE="https://github.com/TerexitariusStomp/hermes-browser/releases/download/wasi-v1"
cd "$(dirname "$0")/../assets/wasi"
declare -A S=(
  [bash.webc]=059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1
  [coreutils.webc]=35028c4e6b9fa8cccdffdcab2007d1df3af31b3f2b22fb890d022d7ae723bbd3
  [findutils.webc]=4d775bd4d37f26e043a2c54e220c554a67bbe349000930f87c6bc81e4a91c1fb
  [grep.webc]=42a2dd5452990c94a51036cfb5eb9574899beccb5ce8f83f75995f7ac5e0e1ca
  [tar.webc]=8e53221cd089dfd90e95ed96d2604db01d8d5fba9a9bda1752db27a4b65f5cc7
  [sed.webc]=3fc12256be87f6b8b7810d68d642359a6220f63b39a2ea6ef7a2bb6d79ec1393
)
for f in "${!S[@]}"; do
  if [ -f "$f" ] && echo "${S[$f]}  $f" | sha256sum -c - >/dev/null 2>&1; then
    echo "ok (cached): $f"; continue
  fi
  curl -fsSL "$BASE/$f" -o "$f"
  echo "${S[$f]}  $f" | sha256sum -c -
done
