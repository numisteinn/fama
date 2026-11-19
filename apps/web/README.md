# @fama/web

The desktop way to add sources and listen. Vite + React 19, Tailwind v4, Base UI.

```sh
pnpm --filter @fama/web dev        # http://localhost:5173, proxies /api /feed /media to :8787
pnpm --filter @fama/web build      # apps/web/dist, served by the API Worker
pnpm --filter @fama/web typecheck
```

The whole stack (API, this build in watch mode, the worker) runs with `pnpm dev` from the repo root.
