#!/usr/bin/env bash
# vendor.sh — refresh the vendored upstream hermes-agent checkout and rebuild
# dist-webapp. Upstream-sync flow: bump HERMES_REF and re-run. The vendored
# tree is never edited in place — all browser adaptation lives in src/.
set -euo pipefail
cd "$(dirname "$0")/.."

UPSTREAM="${UPSTREAM:-https://github.com/NousResearch/hermes-agent.git}"
# PR NousResearch/hermes-agent#93508 head (feat/webapp — the dist-webapp
# renderer). After that PR merges, point HERMES_REF at main.
HERMES_REF="${HERMES_REF:-78a91234aa50b7bcae354b1d7bac22ec6fa89c0f}"
DEST="vendor/hermes-agent"

if [ ! -d "$DEST/.git" ]; then
  mkdir -p vendor
  git clone --filter=blob:none --no-checkout "$UPSTREAM" "$DEST"
fi
git -C "$DEST" fetch --depth 1 origin "$HERMES_REF" || \
  git -C "$DEST" fetch --depth 1 origin "pull/93508/head"
git -C "$DEST" checkout --detach FETCH_HEAD

node "$DEST/apps/desktop/scripts/build-webapp.mjs"
echo "vendored $(git -C "$DEST" rev-parse HEAD) → $DEST/apps/desktop/dist-webapp"
