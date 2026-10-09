#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! grep -q 'cluster = "localnet"' Anchor.toml; then
  echo 'Localnet Anchor.toml is required. Devnet deployment is not part of this test.' >&2
  exit 1
fi
restore_production_build() {
  echo 'Restoring the normal 3600-second dispute-window build...'
  anchor build
}
trap restore_production_build EXIT
anchor build -- --features local-short-dispute
SENTINEL_FAST_TEST=1 anchor test --skip-build --validator legacy
