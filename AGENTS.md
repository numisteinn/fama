# Fama

Read `CONTEXT.md` for domain terms and `docs/api.md` for the HTTP contract. Shapes live in `packages/contracts` (Effect v4 Schema).

## Layout
- `packages/contracts` shared Effect Schema contract.
- `apps/api` Cloudflare Worker: API, D1, R2, RSS feed. Serves the web build as static assets.
- `apps/web` Vite + React web app.
- `apps/mobile` Expo iOS app.
- `worker/` Python (uv) worker: extraction + TTS. Runs on the Mac and on Modal.

## Rules
- Tools are pinned in `mise.toml` (Node, pnpm, uv). pnpm workspace. Effect v4 for TypeScript services.
- Never deploy, create Cloudflare resources, or publish without the user's approval. Local dev uses `wrangler dev` with local D1 and R2.
- Keep the contract in `packages/contracts` and `docs/api.md` in sync. Change both or neither.
