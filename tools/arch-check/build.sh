#!/usr/bin/env bash
# Builds the engine for the platforms the ratchet runs on and records the source
# hash that CI checks. Run from any directory; needs this folder's mise.toml tools.
set -euo pipefail
cd "$(dirname "$0")"

rustup target add aarch64-apple-darwin x86_64-unknown-linux-gnu
cargo test --locked --quiet
cargo build --locked --release --target aarch64-apple-darwin
cargo zigbuild --locked --release --target x86_64-unknown-linux-gnu.2.28

mkdir -p bin
cp target/aarch64-apple-darwin/release/arch-check bin/arch-check-darwin-arm64
cp target/x86_64-unknown-linux-gnu/release/arch-check bin/arch-check-linux-x64
./source-hash.sh > bin/source.sha256
ls -l bin
