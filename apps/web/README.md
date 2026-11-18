# @fama/web

The desktop way to add sources and listen. Vite + React 19, Tailwind v4, Base UI.

```sh
corepack pnpm --filter @fama/web dev        # http://localhost:5173, proxies /api /feed /media to :8787
corepack pnpm --filter @fama/web build      # apps/web/dist, served by the API Worker
corepack pnpm --filter @fama/web typecheck
```

Without the API, run the mock (fixtures, a fake worker, real m4a files with Range support; token `dev`):

```sh
corepack pnpm --filter @fama/web mock
```

`PORT=8788 corepack pnpm --filter @fama/web mock` and `FAMA_API_URL=http://127.0.0.1:8788 corepack pnpm --filter @fama/web dev` move it off 8787 when `wrangler dev` holds that port.
