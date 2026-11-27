# @fama/web

The desktop way to add sources and listen. Vite + Effect UI (The Elm Architecture on Effect), Tailwind v4, `@effect/ui-kit` for menus, dialogs, and controls.

```sh
pnpm --filter @fama/web dev        # http://localhost:5173, proxies /api /feed /media to :8787
pnpm --filter @fama/web build      # apps/web/dist, served by the API Worker
pnpm --filter @fama/web typecheck
pnpm --filter @fama/web test       # Story, HtmlScene, and HtmlPlay tests
```

`src/App.ts` composes the app, `src/model.ts` holds the Model and Flags, `src/message.ts` the Messages, `src/update.ts` the update, `src/queries.ts` the Queries, `src/command.ts` and `src/audio.ts` the Commands, `src/subscription.ts` the Subscriptions, `src/components/` the shared Effect UI components, `src/review/` and `src/reader/` the sub-screens, and `src/view/` the Library, AddBar, and PlayerBar views.

The whole stack (API, this build in watch mode, the worker) runs with `pnpm dev` from the repo root.
