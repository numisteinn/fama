# arch-check

A fast, standalone Rust architecture checker for the Fama repo. It parses the
TypeScript apps and packages plus the Python worker in parallel, builds a
file-level dependency graph, and evaluates the declarative rules in
[`arch.config.json`](../../arch.config.json).

Run it with zero Rust and zero extra npm dependencies:

```sh
pnpm check:arch            # human report, exits 1 on a violation
pnpm check:arch --json     # JSON report
pnpm check:arch --stats    # per-area depth summary
```

The check runs in tens of milliseconds.

## What it checks

- **`no-file-cycles`** — Tarjan SCC over the file graph (currently 0 cycles).
- **`no-folder-tangles`** — bidirectional folder-level import pairs within each
  package, with an `allow` list for the legacy tangles on `main`. A new tangle
  fails; an allow entry that no longer matches is reported as a stale warning so
  the list ratchets down.
- **`no-depend`** — explicit architectural boundaries (e.g. `packages/contracts`
  may not depend on `apps/*`; each app may not import another app).
- **`max-lines`** / **`max-exports`** — per-file size guards with an `allow` list
  for the known god-files and wide surfaces on `main`.

For TypeScript it parses with `oxc_parser` and resolves relative imports,
tsconfig `paths` aliases (`~/`, `@/`), and `@fama/*` workspace packages. Test
files (`*.test.ts`, `*.test.tsx`, `vitest-setup.ts`) are excluded. For Python it
scans `fama_worker.*` and relative imports, non-test LOC, and public top-level
`def`/`class`.

## Binaries

`bin/` holds prebuilt binaries for macOS arm64 and Linux x64, so neither
developers nor CI need Rust. `bin/source.sha256` is a hash of the Rust source the
binaries were built from; `tools/arch-check/source-hash.sh --check` verifies it.

## Changing the engine

`mise.toml` in this folder pins Rust, zig and cargo-zigbuild. It applies only
here, so the repository root does not install them.

```sh
cd tools/arch-check
./build.sh    # cargo test, both binaries, bin/source.sha256
```

Commit `bin/` with the source change.
