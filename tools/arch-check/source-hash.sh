#!/usr/bin/env bash
# Prints one hash over the engine's Rust inputs. build.sh writes it to
# bin/source.sha256. With --check, fails when the binaries were built from other
# source, so CI catches an edit without a rebuild. Needs no Rust.
set -euo pipefail
cd "$(dirname "$0")"
hash=$(git ls-files -co --exclude-standard -- Cargo.toml Cargo.lock rust-toolchain.toml mise.toml build.sh src |
    LC_ALL=C sort | while read -r file; do printf '%s\n' "$file"; cat "$file"; done |
    shasum -a 256 | cut -d' ' -f1)
if [ "${1:-}" = --check ]; then
    if [ "$hash" != "$(cat bin/source.sha256)" ]; then
        echo 'The arch-check binaries were built from older source. Run tools/arch-check/build.sh and commit bin/.' >&2
        exit 1
    fi
    exit 0
fi
echo "$hash"
