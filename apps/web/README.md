# @fama/web

The desktop way to add sources and listen. Vite + Foldkit 0.171 (The Elm Architecture on Effect), Tailwind v4, `@foldkit/ui` for the Settings dialog.

```sh
pnpm --filter @fama/web dev        # http://localhost:5173, proxies /api /feed /media to :8787
pnpm --filter @fama/web build      # apps/web/dist, served by the API Worker
pnpm --filter @fama/web typecheck
pnpm --filter @fama/web test       # Story tests for update, Scene tests for the main flows
```

`src/model.ts` holds the Model and Flags, `src/message.ts` the Messages, `src/update.ts` the update, `src/command.ts` and `src/audio.ts` the Commands, `src/subscription.ts` the Subscriptions, and `src/view/` the view.

The whole stack (API, this build in watch mode, the worker) runs with `pnpm dev` from the repo root.
