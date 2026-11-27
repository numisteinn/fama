# Fama

Read `CONTEXT.md` for domain terms and `docs/api.md` for the HTTP contract. Shapes live in `packages/contracts` (Effect v4 Schema).

## Layout
- `packages/contracts` shared Effect Schema contract.
- `apps/api` Cloudflare Worker: API, D1, R2, RSS feed. Serves the web build as static assets.
- `apps/web` Vite + Effect UI web app (The Elm Architecture on Effect).
- `apps/mobile` Expo iOS app.
- `worker/` Python (uv) worker: extraction + TTS. Runs on the Mac and on Modal.

## Rules
- Tools are pinned in `mise.toml` (Node, pnpm, uv). pnpm workspace. Effect v4 for TypeScript services.
- Never deploy, create Cloudflare resources, or publish without the user's approval. Local dev uses `wrangler dev` with local D1 and R2.
- Keep the contract in `packages/contracts` and `docs/api.md` in sync. Change both or neither.
- Run `pnpm lint` (oxlint), `pnpm check:arch` (tangles, boundaries, narrow interfaces), `pnpm typecheck` and `pnpm test`. Typecheck includes Effect errors and warnings.
- For editor diagnostics, run the TypeScript language server with `pnpm exec effect-tsgo tsc --lsp --stdio`. In VS Code with TypeScript 7, run `pnpm exec effect-tsgo patch --typescript` after install and select the workspace TypeScript version.
- Prove user-facing behavior with the `verify-fama` skill (`.claude/skills/verify-fama`). When a feature changes, update its file in `features/` in the same change.
