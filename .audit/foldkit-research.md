# Foldkit 0.171 research for the Fama web rewrite

Sources, all checked on 2026-11-20:

- Foldkit repo at tag `foldkit@0.171.0` (commit `9154209`). It is a shallow clone in `scratchpad/foldkit-src`. Paths below are relative to that clone.
- `https://foldkit.dev/llms.txt` and `https://foldkit.dev/llms-full.txt`. A copy is in `scratchpad/web/`. Every docs page is also served as `<url>.md`.
- npm registry (`npm view`).
- Fama: `apps/web/src/**`, `.claude/skills/verify-fama/SKILL.md` and `features/*.md`, and `node_modules/.pnpm/effect@4.1.3`.

Short version: Foldkit can do everything Fama's web app does. The port is not one-to-one, though. Six things need care: the slider handle, the persistent hidden file input, the detached Audio element, a `pagehide` flush, the Menu item role, and the Effect version pins. Details are in §9.

---

## 0. What must be ported (Fama today)

| Area | Behavior | Foldkit owner |
|---|---|---|
| `library.ts` | First load, refetch when token or origin changes, poll every 2 s while any job is `Queued`/`Running`, refetch on `visibilitychange`, upsert, retry, delete, 401 opens Settings | Commands + 2 Subscriptions |
| `api.ts` | Bearer token, origin prefix, status → message (`401`, `404`, `413`, JSON `{message}`, body text), status 0 = "Can't reach the server", decode failure message, multipart upload | One Effect helper used by Commands |
| `settings.ts`/`storage.ts` | localStorage keys `fama.token`, `fama.origin`, `fama.voice`, `fama.speed`, `fama.rate`, `fama.position.<id>`. Cross-tab `storage` event | Flags at boot + write Commands (+ optional Subscription) |
| `player.tsx` | Detached `new Audio()`, chapter timeline, `timeupdate`/`play`/`pause`/`ended`, seek across chapters, rate, a "waiting for next chapter" state, stop when the episode is deleted, position save every 5 s, on pause and on `pagehide`, Media Session | Resource (audio handle) + Commands + Subscriptions |
| `AddBar.tsx` | Textarea (Enter submits, IME aware), Url/Text/File draft, hidden file input, window drag-and-drop overlay, voice menu grouped by language, speed menu, `role=alert` error | Model + view + Menu ×2 + Subscription |
| `LibraryList.tsx` | Keyed rows, `Play/Pause <title>`, job status, Retry, two-click Delete with 3 s disarm and autofocus | View + Commands |
| `PlayerBar.tsx` | Transport, `Position` slider (drag, then commit), playback-speed menu, chapters menu, Download link, Space/←/→ shortcuts that skip focused controls, `aria-live` waiting text | Slider + Menu ×2 + Subscription |
| `SettingsDialog.tsx` | Dialog `Settings`, `API token` (password, autofocus), `Server`, `Save`, feed URL row, `Copy feed URL` → `Copied` for 1.5 s, `Close` | Dialog + Commands |

Accessible names that must stay the same are in the verify-fama SKILL.md "Stable handles" table. Two of them depend on DOM structure and not only on names:

- "group `Position` with a slider whose value is the position in ms". base-ui renders `role=group` on the root and `<input type=range>` in the thumb.
- "hidden `input[type=file]` (selector)". `preview_act upload` targets it directly (`features/add-file.md:29,40`).

---

## 1. Setup

### Packages (versions checked with `npm view`)

| Package | Version | Peers |
|---|---|---|
| `foldkit` | 0.171.0 | `effect ~4.1.0`, `@effect/platform-browser ~4.1.0` |
| `@foldkit/ui` | 0.171.0 | `effect ~4.1.0`, `foldkit >=0.167.0`. Depends on `@floating-ui/dom` |
| `@foldkit/vite-plugin` | 0.29.1 | `vite ^8`, `effect ~4.1.0`, `foldkit >=0.167.0`. **Depends on `@effect/platform-node ~4.1.0` and `@effect/platform-node-shared ~4.1.0`** |
| `@foldkit/devtools` (overlay, dev only) | 0.171.0 | `@effect/platform-browser ~4.1.0`, `@foldkit/ui`, `foldkit` |
| `@foldkit/devtools-mcp` (optional) | 0.26.0 | `effect ~4.1.0`, `foldkit >=0.165.0` |
| `@effect/platform-browser` | **use 4.1.3** | 4.1.3 has peer `effect ^4.1.3`. The latest, 4.1.5, has peer `effect ^4.1.5`, which conflicts with the catalog pin |
| `happy-dom` (template uses it for vitest) | `^20.14.5` in examples, 21.0.4 latest | — |

Version trap: `@effect/platform-node@4.1.5` and `@effect/platform-node-shared@4.1.5` have peer `effect ^4.1.5`. `~4.1.0` would resolve to them through the vite plugin and pull a second `effect` copy into the dev server (Node side), or at least a peer warning. Pin them the way the Foldkit repo itself does (`foldkit-src/pnpm-workspace.yaml` → `overrides:` pins every `@effect/*` to `4.1.0`).

Proposed `pnpm-workspace.yaml` change:

```yaml
catalog:
  effect: 4.1.3
  "@effect/platform-browser": 4.1.3
  # existing entries…
overrides:
  "@effect/platform-browser": 4.1.3
  "@effect/platform-node": 4.1.3
  "@effect/platform-node-shared": 4.1.3
```

Proposed `apps/web/package.json`. Remove react, react-dom, @base-ui/react, cva, tailwind-merge (keep `clsx`-like joining by hand or keep tailwind-merge) and @vitejs/plugin-react.

```jsonc
"dependencies": {
  "@effect/platform-browser": "catalog:",
  "@fama/contracts": "workspace:*",
  "@fontsource-variable/dm-sans": "^5.3.0",
  "@foldkit/ui": "0.171.0",
  "effect": "catalog:",
  "foldkit": "0.171.0"
},
"devDependencies": {
  "@foldkit/devtools": "0.171.0",
  "@foldkit/devtools-mcp": "0.26.0",
  "@foldkit/vite-plugin": "0.29.1",
  "@tailwindcss/vite": "^4.3.5",
  "happy-dom": "^20.14.5",
  "tailwindcss": "^4.3.5",
  "typescript": "catalog:",
  "vite": "^8.3.8",
  "vitest": "catalog:"
}
```

Icons: `lucide-react` goes. Use `lucide` (framework-free SVG data) or inline SVG via `h.svg`/`h.path`. I did not check which of these Foldkit prefers. The examples use inline SVG.

### vite config

Scaffolder template: `packages/create-foldkit-app/templates/base/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  optimizeDeps: { entries: ['src/entry.ts'] },
})
```

Fama version (keeps the `~` alias, the proxy and the dist dir):

```ts
const api = process.env.FAMA_API_URL ?? "http://localhost:8787"
export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  resolve: { alias: { "~": new URL("./src", import.meta.url).pathname } },
  optimizeDeps: { entries: ["src/entry.ts"] },
  server: { port: Number(process.env.PORT ?? 5173), proxy: { "/api": api, "/feed": api, "/media": api } },
  build: { outDir: "dist", emptyOutDir: true },
})
```

The plugin README (`packages/vite-plugin-foldkit/README.md`) says the plugin:

- brands view functions for the differ in dev **and** production builds;
- adds state-preserving live reload;
- dedupes `foldkit`/`@foldkit/ui`/`@foldkit/devtools`;
- excludes `foldkit` from pre-bundling;
- mounts the DevTools overlay when `@foldkit/devtools` is installed.

Without the plugin, "builds … fall back to positional matching plus keys". **Always use it.**

### Entry

Template `src/entry.ts` (`examples/weather/src/entry.ts`):

```ts
import { Runtime } from 'foldkit'
import { Message, Model, init, update, view } from './main'

const application = Runtime.makeApplication({
  Model, init, update, view,
  container: document.getElementById('root'),
  devTools: { Message },
})
Runtime.run(application)
```

Fama adds `Flags`, `subscriptions` and `resources` (see §4 and §5). `index.html` keeps `<div id="root">` and points `<script type="module" src="/src/entry.ts">`. CSS: `import "./index.css"` in entry, or a `<link>` like the template. The current `index.css` (Tailwind 4 `@import "tailwindcss"` plus tokens) works unchanged. Tailwind scans `.ts` files by default, so `h.Class('…')` strings are picked up.

### tsconfig

The template uses `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `moduleResolution: bundler` and `lib: [ES2022, DOM]`. Fama extends `tsconfig.base.json`. Drop `jsx` and `types: vite/client` stays.

### Coexistence

Tailwind 4: no conflict, and the template ships with it. pnpm catalog: Foldkit packages are not in the catalog. Pin them exactly, because Foldkit minors have breaking changes (0.171 changed `createKeyedLazy` and `Command.define` messages). The serving path does not change: `fama-verify up` runs `vite build` in `apps/web` and wrangler serves `../web/dist` (`apps/api/wrangler.json` `assets.directory`).

---

## 2. HTTP

Foldkit's `Http` module has one export: `Http.layer`. It is Effect's Fetch `HttpClient` with trace-header propagation off, so requests stay CORS-simple (docs: https://foldkit.dev/core/http). Canonical shape (docs, Commands page):

```ts
const FetchCount = Command.define('FetchCount', {
  messages: [Message.SucceededFetchCount, Message.FailedFetchCount],
  execute: Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.get('/api/count'))
    if (response.status !== 200) return yield* Effect.fail('API request failed')
    const { count } = yield* Schema.decodeUnknownEffect(CountResponse)(yield* response.json)
    return Message.SucceededFetchCount({ count })
  }).pipe(
    Effect.catch(error => Effect.succeed(Message.FailedFetchCount({ error: String(error) }))),
    Effect.provide(Http.layer),
  ),
})
```

Rules from the docs:

- Per-dispatch inputs go in `args` (Schemas).
- Module constants stay in scope.
- `Http.layer` is provided per Command until many Commands share it. Then move it to `resources` ("the moment you find yourself writing a `withClient` helper", https://foldkit.dev/core/resources). Fama has about 7 HTTP Commands, so put `Http.layer` in `resources` and keep `HttpClient` in each Command's requirements, which also helps tests.
- Every failure must become a declared Message (`Effect.catch`). Commands never crash the app.

Token and origin live in the Model (they change at runtime), so they travel as Command args. DevTools records Command args and Models, and the MCP server can read them. The docs say to wrap the token as `Schema.Redacted(Schema.String, { disallowJsonEncode: true })` (https://foldkit.dev/core/devtools, "Handling Sensitive Values").

Effect 4.1.3 has what Fama needs (`effect/dist/http/HttpClientRequest.d.ts`): `get`, `post`, `delete` (exported as `del as delete`), `make(method)`, `prependUrl`, `bearerToken(token: string | Redacted)`, `bodyJson`, `bodyFormData`. Error reasons are `TransportError`, `StatusCodeError` and `DecodeError` (`HttpClientError.d.ts`).

Sketch of Fama's API helper:

```ts
// api.ts
import { Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

export const ApiToken = Schema.Redacted(Schema.String, { label: "API token", disallowJsonEncode: true })
export const Connection = Schema.Struct({ origin: Schema.String, token: ApiToken })
export type Connection = typeof Connection.Type

export const ApiFailure = Schema.Struct({ status: Schema.Number, message: Schema.String })
export type ApiFailure = typeof ApiFailure.Type

const messageFor = (status: number, body: string): string => /* same as today */

const send = Effect.fnUntraced(function* (connection: Connection, request: HttpClientRequest.HttpClientRequest) {
  const client = yield* HttpClient.HttpClient
  const withAuth = request.pipe(
    HttpClientRequest.prependUrl(connection.origin),
    Redacted.value(connection.token) === "" ? (r) => r : HttpClientRequest.bearerToken(connection.token),
  )
  const response = yield* client.execute(withAuth).pipe(
    Effect.mapError(() => ({ status: 0, message: "Can't reach the server" }) satisfies ApiFailure),
  )
  if (response.status >= 400) {
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    return yield* Effect.fail<ApiFailure>({ status: response.status, message: messageFor(response.status, text) })
  }
  return response
})

export const json = <S extends Schema.Top>(schema: S) =>
  (connection: Connection, request: HttpClientRequest.HttpClientRequest) =>
    send(connection, request).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.catchIf((e): e is Exclude<typeof e, ApiFailure> => !("status" in e), () =>
        Effect.fail<ApiFailure>({ status: 0, message: "The server sent a response this app does not understand" })),
    )
```

(Type-level details such as the `catchIf` guard need a compile pass. The shape is the point.)

A Command with Fama's contract Schemas from `@fama/contracts`:

```ts
const FetchEpisodes = Command.define("FetchEpisodes", {
  args: { connection: Connection },
  messages: [Message.SucceededFetchEpisodes, Message.FailedFetchEpisodes],
  execute: ({ connection }) =>
    json(EpisodeList)(connection, HttpClientRequest.get("/api/episodes")).pipe(
      Effect.map(({ episodes }) => Message.SucceededFetchEpisodes({ episodes })),
      Effect.catch((failure) => Effect.succeed(Message.FailedFetchEpisodes({ failure }))),
    ),
})
```

`Episode`, `Voice` and `JobState` are Effect v4 Schemas (`Schema.TaggedUnion`, branded `EpisodeId`), so they can be Message payloads and Model fields directly. Model and Messages must be Schemas (Foldkit rule).

Multipart upload. A `File` is a valid Schema value (`packages/foldkit/src/file/file.ts`: `export const File = Schema.instanceOf(globalThis.File)`):

```ts
const UploadEpisode = Command.define("UploadEpisode", {
  args: { connection: Connection, file: File.File, voice: Schema.NullOr(VoiceRef), speed: Schema.Number },
  messages: [Message.SucceededCreateEpisode, Message.FailedCreateEpisode],
  execute: ({ connection, file, voice, speed }) => {
    const form = new FormData()
    form.set("file", file)
    if (voice) form.set("voice", voice)
    form.set("speed", String(speed))
    return json(Episode)(connection, HttpClientRequest.post("/api/episodes/upload").pipe(HttpClientRequest.bodyFormData(form))).pipe(
      Effect.map((episode) => Message.SucceededCreateEpisode({ episode })),
      Effect.catch((failure) => Effect.succeed(Message.FailedCreateEpisode({ failure }))),
    )
  },
})
```

For JSON create: `HttpClientRequest.bodyJson(Schema.encodeSync(CreateEpisode)(input))`, which returns an Effect, or `bodyJsonUnsafe`.

Per-row error text (`actionError`) becomes `rowErrors: HashMap<EpisodeId, string>` in the Model. Retry and Delete Commands carry `episodeId` in their result Messages. Fama's "one Command per kind" maps to Foldkit naming: `RetryEpisode` → `SucceededRetryEpisode`/`FailedRetryEpisode`, `DeleteEpisode` → …

---

## 3. Polling: tick every 2 s only while a job is Queued or Running

Pattern from https://foldkit.dev/core/subscriptions (auto-counter example):

```ts
const isWorking = (job: JobState) => job._tag === "Queued" || job._tag === "Running"

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  poll: entry(
    { isWorking: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        isWorking: Option.exists(model.maybeEpisodes, Array.some((e) => isWorking(e.job))),
      }),
      dependenciesToStream: ({ isWorking }) =>
        Stream.when(
          Stream.tick(Duration.seconds(2)).pipe(Stream.drop(1), Stream.map(() => Message.TickedPoll())),
          Effect.sync(() => isWorking),
        ),
    },
  ),
  visibility: Subscription.persistentEntry(
    Dom.streamFromEventFilterMap({
      target: document,
      type: "visibilitychange",
      filterMapEvent: () =>
        document.visibilityState === "visible" ? Option.some(Message.BecameVisible()) : Option.none(),
    }),
  ),
}))
```

Dependencies are compared structurally, so the timer only restarts when `isWorking` flips. `TickedPoll` and `BecameVisible` both return `FetchEpisodes({ connection })`. The "refetch when token or origin changes" rule moves into update: `SubmittedSettings` returns `FetchEpisodes` (and `FetchFeed`). `useEffect` deps are not needed. `Stream.tick` emits once at start, which is why the docs add `Stream.drop(1)`.

Overlapping polls: Fama today can fire a second request while one is in flight. In Foldkit, keep `episodesRequest: Idle | Loading` in the Model and skip the tick while `Loading`. Or use `interrupt: true` on `FetchEpisodes` (docs: Commands, "Interrupting Commands").

---

## 4. Audio playback

The lifecycle table (Subscriptions page and Mount page):

- Subscription: ongoing event stream, lifetime from Model dependencies.
- Mount: work that needs a rendered element.
- ManagedResource: a handle whose lifetime follows a Model condition, used by Commands.
- `resources`: an app-lifetime service.

The verify skill says Fama uses a **detached** `new Audio()` and has no `<audio>` in the DOM (`features/playback.md:47`). So Mount is out, unless you render `h.audio`. `h.OnTimeUpdate` exists but carries only a fixed Message, not `currentTime` (`html/index.ts:747`). It would also put an `<audio>` in the DOM and change what the verify note says.

Recommended shape:

1. **`resources`: one app-lifetime `AudioPlayer` service** that holds the element. The player exists for the whole page (today it is a `useState(() => new Audio())`). The resources Layer is built once and shared with Commands **and Subscriptions** (`runtime/runtime.ts:114-119`: `subscriptions?: Subscriptions<Model, Message, Resources | ManagedResourceServices>`). A ManagedResource also works: requirement `Option.some(null)` while an episode is loaded, release = pause + clear `src`. That gives "stop when the episode is deleted" for free when the Model drops the playback. Either choice is defensible. The ManagedResource adds `onAcquired`/`onReleased` Messages and a `ResourceNotAvailable` path in every Command.

```ts
export class AudioPlayer extends Context.Service<AudioPlayer, HTMLAudioElement>()("fama/web/AudioPlayer") {
  static readonly layer = Layer.effect(
    AudioPlayer,
    Effect.acquireRelease(
      Effect.sync(() => { const audio = new Audio(); audio.preload = "auto"; return audio }),
      (audio) => Effect.sync(() => { audio.pause(); audio.removeAttribute("src"); audio.load() }),
    ),
  )
}
// entry.ts
Runtime.makeApplication({ …, resources: Layer.mergeAll(AudioPlayer.layer, Http.layer) })
```

2. **Commands for every imperative call.** Update decides the target chapter and offset (pure timeline math from `timeline.ts` stays as is):

```ts
const LoadChapter = Command.define("LoadChapter", {
  args: { src: Schema.String, offsetMs: Schema.Number, rate: Schema.Number, isAutoplay: Schema.Boolean },
  messages: [Message.CompletedLoadChapter, Message.FailedPlayAudio],
  execute: ({ src, offsetMs, rate, isAutoplay }) =>
    Effect.gen(function* () {
      const audio = yield* AudioPlayer
      audio.src = src
      audio.currentTime = offsetMs / 1000
      audio.defaultPlaybackRate = rate
      audio.playbackRate = rate
      if (isAutoplay) yield* Effect.tryPromise(() => audio.play())
      return Message.CompletedLoadChapter()
    }).pipe(Effect.catch(() => Effect.succeed(Message.FailedPlayAudio()))),
})
// PlayAudio, PauseAudio, SeekAudio({ offsetMs }), SetAudioRate({ rate }), StopAudio: same shape.
```

3. **A Subscription for element events**, gated on "an episode is loaded":

```ts
audioEvents: entry({ isLoaded: Schema.Boolean }, {
  modelToDependencies: (model) => ({ isLoaded: model.playback._tag !== "Idle" }),
  dependenciesToStream: ({ isLoaded }) =>
    Stream.when(
      Stream.unwrap(Effect.gen(function* () {
        const audio = yield* AudioPlayer
        return Stream.mergeAll([
          Dom.streamFromEvent({ target: audio, type: "timeupdate",
            mapEvent: () => Message.TimedUpdateAudio({ offsetMs: audio.currentTime * 1000 }) }),
          Dom.streamFromEvent({ target: audio, type: "play", mapEvent: () => Message.StartedAudio() }),
          Dom.streamFromEventFilterMap({ target: audio, type: "pause",
            filterMapEvent: () => audio.ended ? Option.none() : Option.some(Message.PausedAudio()) }),
          Dom.streamFromEvent({ target: audio, type: "ended", mapEvent: () => Message.EndedChapter() }),
        ], { concurrency: "unbounded" })
      })),
      Effect.sync(() => isLoaded),
    ),
}),
```

`Dom.streamFromEvent` resolves `HTMLMediaElement` event maps (`dom/streamFromEvent.ts`, `ElementEventMapOf`), so the event types check.

4. **Model** replaces refs and `useState`:

```ts
const Playback = defineTaggedUnion({
  Idle: {},
  Loaded: { episodeId: EpisodeId, chapter: Schema.Number, offsetMs: Schema.Number,
            state: Schema.Literals(["Playing", "Paused", "WaitingForChapter"]), lastSavedMs: Schema.Number },
})
```

- `EndedChapter`: the next chapter exists → `LoadChapter`. The job is still working → `WaitingForChapter`. Else → `Paused` + `SavePosition(0)`.
- `SucceededFetchEpisodes`: while `WaitingForChapter`, if `chapters[chapter+1]` now exists → `LoadChapter`. If the playing episode is gone → `Idle` + `StopAudio`.

Both rules were `useEffect`s before. Now they are plain branches in update, which is the main gain of the rewrite.

5. **Position saves.** Throttle by media time: `TimedUpdateAudio` returns `SavePosition` when `|offsetMs - lastSavedMs| ≥ 5000` (this keeps update pure, no `Date.now()`). Pause → `SavePosition`. `pagehide`: see §9.

6. **Media Session.** "A Subscription may also maintain scoped DOM state without emitting Messages" (Subscriptions page). Use:

- one entry with deps `{title, chapterTitle, author, cover}` that sets `navigator.mediaSession.metadata` in `acquireRelease` and clears it on release;
- one entry with deps `{playbackState}`;
- one entry with deps `{positionSec, durationSec, rate}` for `setPositionState`;
- one `persistentEntry`/gated entry that registers `setActionHandler` callbacks with `Stream.callback` and emits `PressedMediaPlay`, `PressedMediaSeekTo({seconds})`, and so on. Remove the handlers on release.

7. **DevTools noise.** `timeupdate` fires about 4×/s. Add `devTools: { excludeFromHistory: ["TimedUpdateAudio"] }`. The docs warn that this stores a full Model snapshot per entry when the list is not empty (https://foldkit.dev/core/devtools).

---

## 5. Persistence (localStorage)

Read at boot with Flags. The pattern is from https://foldkit.dev/core/init-and-flags:

```ts
import { KeyValueStore } from "effect/persistence"
import { BrowserKeyValueStore } from "@effect/platform-browser"

export const Flags = Schema.Struct({
  token: Schema.String, origin: Schema.String,
  maybeVoice: Schema.Option(VoiceRef), speed: Schema.Number, rate: Schema.Number,
})
export const flags: Effect.Effect<typeof Flags.Type> = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore
  const read = <S extends Schema.Top>(key: string, schema: S, fallback: S["Type"]) =>
    store.get(key).pipe(
      Effect.flatMap((raw) => raw === undefined ? Effect.succeed(fallback)
        : Schema.decodeEffect(Schema.fromJsonString(schema))(raw)),
      Effect.orElseSucceed(() => fallback),
    )
  return { token: yield* read("fama.token", Schema.String, ""), /* … */ }
}).pipe(Effect.provide(BrowserKeyValueStore.layerLocalStorage))

// entry.ts
Runtime.run(Runtime.makeApplication({ Model, Flags, init, update, view, … }), { flags })
```

Keep Fama's existing JSON encoding (`JSON.stringify` of the value), so stored values from the React app still decode. `init` receives Flags and wraps the token in `Redacted.make`.

Writes are Commands: `StoreSetting({ key, json })` → `CompletedStoreSetting`. Per the Resources page, `KeyValueStore` stays per Command (`Effect.provide(BrowserKeyValueStore.layerLocalStorage)`).

Per-episode position `fama.position.<id>` is read when the user presses Play. That is a Command (`ReadSavedPosition({ episodeId })` → `CompletedReadSavedPosition({ episodeId, savedMs })`), followed by `LoadChapter`. It adds one async step before audio starts. Note the gotcha in §9: user activation for `audio.play()`. Alternative: load all `fama.position.*` keys in Flags into a `HashMap` in the Model and write through. Then `Play` is synchronous in update. I recommend this. It also keeps the first `play()` within the click's activation window.

Cross-tab sync (`storage` event): optional `Subscription.persistentEntry(Dom.streamFromEvent({ target: window, type: "storage", … }))`.

---

## 6. UI: what @foldkit/ui gives and what it renders

Foldkit UI has two kinds of component (skills/foldkit/SKILL.md):

- **Stateful Submodels** (Menu, Listbox, Dialog, Popover, Slider, FileDrop, Tabs, Toast…). These are embedded with `h.submodel` and folded with `Update.foldChild`.
- **Stateless helpers** (Button, Input, Textarea, Select, Fieldset), called as `X.view(config, h)`.

Every component is headless. You pass Tailwind classes through `toView`/`*ClassName`.

### Dialog (Settings): `packages/ui/src/dialog/index.ts`

- Renders a native `<dialog>` with `aria-labelledby` set to the `-dialog-title` id and `aria-modal` while visible. It opens through `Dom.showDialog` (focus trap, background inert, scroll lock, Escape, return focus).
- `RenderInfo` gives the attribute groups `dialog`, `backdrop`, `panel`, `title`, `description`, `initialFocus` and `closeButton` (`type=button` + close handler), plus `isVisible`.
- OutMessages: `Opened`, `Closed`. Programmatic `Dialog.open(model)` / `Dialog.close(model)`. Use these for "401 opens Settings" and for "Save closes".

```ts
h.submodel({
  slotId: "settings", model: model.settingsDialog, view: Dialog.view,
  toParentMessage: (message) => Message.GotSettingsDialogMessage({ message }),
  viewInputs: { toView: ({ dialog, backdrop, panel, title, initialFocus, closeButton, isVisible }) =>
    h.dialog([...dialog], isVisible ? [
      h.div([...backdrop, h.Class("fixed inset-0 bg-black/60")], []),
      h.div([...panel, h.Class("fixed top-1/2 left-1/2 …")], [
        h.h2([...title, h.Class("text-base font-semibold")], ["Settings"]),
        h.button([...closeButton, h.AriaLabel("Close"), h.Class(iconButton)], [xIcon(h)]),
        h.form([h.OnSubmit(Message.SubmittedSettings())], [
          h.label([h.For("api-token")], ["API token"]),
          h.input([...initialFocus, h.Id("api-token"), h.Type("password"), h.Autocomplete("off"),
                   h.Value(model.settingsDraft.token), h.OnInput((value) => Message.UpdatedTokenDraft({ value }))]),
          h.label([h.For("server")], ["Server"]),
          h.input([h.Id("server"), h.Type("url"), h.InputMode("url"), h.Placeholder(location.origin), …]),
          h.button([h.Type("submit")], ["Save"]),
        ]),
        feedRow(model, h),
      ]),
    ] : []),
  },
})
```

The names that matter all survive: role `dialog` named `Settings` (native `<dialog>` plus labelledby), textbox `API token` and textbox `Server` (label `for`), button `Save`, button `Close` (`aria-label`). Pass `isAnimated: true` at init for data-attribute transitions (`data-enter`, `data-leave`, `data-closed`) in place of base-ui's `data-[starting-style]`.

### Menu (voice, voice speed, playback speed, chapters): `packages/ui/src/menu/index.ts`

- Trigger button: `id`, `type=button`, `aria-haspopup=menu`, `aria-expanded`, and `aria-controls` when open. **`ariaLabel` puts `aria-label` on the trigger** (lines 993-1012), so `Voice: <name>`, `Voice speed: <rate>`, `Playback speed: <rate>` and `Chapters` keep their names.
- Panel: `role=menu` labelled by the button. Items: **`role=menuitem`**, with `data-active`/`aria-disabled`. Keyboard: arrows, Home/End, typeahead. Anchored with Floating UI and portaled to the body by default.
- `Menu.create<Item extends string>()`. Items must be **strings**. Rates become `"0.75" | "1" | …` and chapter indexes become `"0" | "1" | …`. Parse them back in `foldOutMessage`.
- Grouping: `itemGroupKey` + `groupToHeading` gives `role=group` with a heading. This matches the voice list grouped by language.
- Anchor: `anchor: { placement: "top-end", gap: 6, padding: 8 }` replaces base-ui's `side`/`align`.
- One Menu Model per menu in the parent Model (`Menu.init({ id: "voice-menu" })`), four in total.

Differences from base-ui: base-ui used `Menu.RadioItem` (`role=menuitemradio` with `aria-checked`). Foldkit Menu has no radio-item mode. Show the check with your own icon in `itemToConfig`. To keep `aria-checked` semantics, the closer component is **Listbox** (single select: `role=listbox`/`option` with `aria-selected`). The verify features only click an item by visible text (`Chapters`, then `Evening`) and do not rely on the item role. Menu keeps the closest behavior: it closes on pick and the trigger is a plain button.

### Slider (Position): `packages/ui/src/slider/index.ts`

- Thumb: a `div` with `role=slider`, `tabindex=0`, `aria-valuemin`/`max`/`now`, `aria-valuetext` (via `formatValue`) and `aria-label` (via `ariaLabel`). The root gets only `data-*`.
- Values come from the parent (`viewInputs.value`). The Slider Model holds `{id, min, max, step, dragState}`.
- **The only OutMessage is `ChangedValue({ value })`**. It fires on every drag move and key press. There is no "committed" event.

How Fama's "drag shows the time, seek on release" maps:

- Keep `maybeScrubMs: Option<number>` in the Model.
- In `GotPositionSliderMessage`, after `Update.foldChild`, compare the slider's `dragState`.
  - `Dragging` → `Idle` means release: seek to `maybeScrubMs` and clear it.
  - `ChangedValue` while `dragState` is `Idle` (keyboard) means seek at once.
  - `ChangedValue` while `Dragging` means store the value only.
- `max` grows as chapters render. Call `Slider.reflectRange({ min: 0, max })` (exported, `slider/index.ts:285`) whenever `durationMs` changes.

Keep the verify handle "group `Position`" by spreading `h.Role("group"), h.AriaLabel("Position")` on `attributes.root` in `toView`, and also pass `ariaLabel: "Position"` (the thumb needs its own name). The slider value is read from `aria-valuenow`, not from an `<input type=range>`. I expect Playwright aria snapshots to show it the same way (`slider "Position" [value]`). Confirm this once with `preview_snapshot`.

### Button / Input / Textarea helpers

`Button.view({ toView, onClick, isDisabled, type })` sets `aria-disabled="true"` + `data-disabled`, **not** the native `disabled` (`ui/src/button/index.ts`). Fama's `Add` submit button and the row `Play` button are natively `disabled` today.

- With `aria-disabled`, Enter in the form still submits, so guard in update (`draft._tag === "Empty"` → ignore).
- The verify locators still see the button as disabled.
- Or just write `h.button([h.Disabled(true), …])` directly. Plain `h.*` builders are fine. The helpers are optional.

`Input`/`Textarea` give `label`/`input`/`description` attribute groups with ids wired.

### Hidden file input + "Attach file" button

`File.select` makes a **temporary** `<input type=file>` that is removed after the pick (`file/select.ts`). That breaks the verify selector `input[type=file]` (`preview_act upload`). So keep a **persistent** hidden input:

```ts
h.input([h.Id("file-input"), h.Type("file"), h.Accept(ACCEPT), h.Hidden(true),
         h.OnFileChange((files) => Message.ChangedFileInput({ files }))])
h.button([h.Type("button"), h.AriaLabel("Attach file"), h.OnClick(Message.ClickedAttachFile())], [paperclip(h)])
// update: ClickedAttachFile → [ClickFileInput()]  where
const ClickFileInput = Command.define("ClickFileInput", {
  messages: [Message.CompletedClickFileInput],
  execute: Dom.clickElement("#file-input").pipe(Effect.ignore, Effect.as(Message.CompletedClickFileInput())),
})
```

`OnFileChange` already resets `target.value = ''` (`html/index.ts:1896-1906`), the same as Fama's `event.target.value = ""`. `FileDrop` (Submodel) also renders a hidden input, but it is built around a `<label>` drop zone, not a window-wide overlay. Use it only if the design changes.

Window drag-and-drop overlay: use a `Subscription.persistentEntry`.

- Merge `dragenter`, `dragleave` and `drop` on `window` into Messages that carry `hasFiles` (and `file` for `drop`). Keep the depth counter in the Model.
- For `dragover`, use `Dom.streamFromEventFilterMap` whose mapper calls `event.preventDefault()` when files are present and returns `Option.none()`. Per the docs the mapper runs synchronously in the listener, so cancelling works and no Message is sent about 20×/s.
- For `drop`, use `Dom.streamFromEventFilterMapPreventDefault` (cancels and emits `DroppedFile({ file })`).

### Clipboard

Foldkit has no clipboard helper. (`h.OnCopyText` is for the copy *event*.) Use a Command:

```ts
const CopyFeedUrl = Command.define("CopyFeedUrl", {
  args: { url: Schema.String },
  messages: [Message.SucceededCopyFeedUrl, Message.FailedCopyFeedUrl],
  execute: ({ url }) => Effect.tryPromise(() => navigator.clipboard.writeText(url)).pipe(
    Effect.as(Message.SucceededCopyFeedUrl()), Effect.catch(() => Effect.succeed(Message.FailedCopyFeedUrl()))),
})
// SucceededCopyFeedUrl → isCopied = true + WaitBeforeResetCopied (Effect.sleep("1500 millis"))
```

The button name switches between `Copy feed URL` and `Copied` from the Model.

### Keyed lists and other builders

- `h.keyed("li")(episode.id, attrs, children)` (`html/index.ts:3251`). Keys go on every row. The Mount and identity docs stress this.
- `createKeyedLazy()` memoizes rows. In 0.171 it evicts keys missing from the latest render by default (CHANGELOG).
- Attributes Fama needs, all present in `html/index.ts`: `AriaLabel`, `AriaLive`, `AriaHidden`, `Role`, `Disabled`, `Autofocus`, `Download`, `Href`, `Title`, `Placeholder`, `InputMode`, `Accept`, `Hidden`, `Style`, `DataAttribute`.
- `OnKeyDownPreventDefault(key, modifiers) => Option<Message>` skips IME composition keydowns (`html/index.ts:174`, `imeComposition.ts`). Use it for Enter-to-submit, which replaces `isComposing`.

### Row Delete (two clicks, 3 s disarm, focus)

- Model: `armedDeletes: HashSet<EpisodeId>`. Fama allows several rows armed at once, so state is per row (AGENTS.md: "keep transient interaction state on each entity").
- `ClickedArmDelete({ episodeId })` → add to the set, plus `WaitBeforeDisarm({ episodeId })` (sleep 3 s) and `FocusDeleteConfirm({ episodeId })` (`Dom.focus("#delete-<id>")`).
- `h.Autofocus` only works on page load or in a dialog, so use the Command.

### Keyboard shortcuts (Space, ←, →)

`Dom.streamFromKeyBindings` ignores keys from inputs, textareas, selects and contenteditable, but **not** from buttons, links, sliders or menuitems. Fama also skips those (`INTERACTIVE` in `PlayerBar.tsx`). To keep the exact behavior, use `Dom.streamFromEventFilterMapPreventDefault({ target: window, type: "keydown", filterMapEvent })` with the same `closest(INTERACTIVE)` and modifier checks. Gate the entry on `playback._tag === "Loaded"`.

---

## 7. Testing (Story and Scene)

Docs: https://foldkit.dev/testing, `/testing/story`, `/testing/scene`.

- Story drives `update` with Messages and keeps Commands as data until the test resolves them.
- Scene renders the view after every step and drives it through accessible locators. It runs on VNodes with no DOM or browser.
- Neither one runs Effects.

Scene locators follow ARIA, so tests can use the same names as the verify skill.

Setup (template `vitest.config.ts` + `src/vitest-setup.ts`):

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    environment: "happy-dom",
    setupFiles: ["./src/vitest-setup.ts"],
    server: { deps: { inline: ["foldkit", "@foldkit/ui", "@foldkit/devtools"] } },
  },
})
// src/vitest-setup.ts
import { setup } from "foldkit/test/vitest"   // registers toExist, toHaveText, toBeDisabled, …
setup()
```

Script: `"test": "vitest run"`. Fama's catalog `vitest: 5.1.1` is compatible (examples use `^5.0.2`).

Story example (polling transition):

```ts
import { Command, given, message, model, story } from "foldkit/story"
test("a Queued episode keeps polling and the poll result replaces the list", () => {
  story(update, given(withEpisodes([queued])),
    message(Message.TickedPoll()),
    Command.expectExact(FetchEpisodes({ connection })),
    Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ episodes: [ready] })),
    model((m) => expect(Option.getOrThrow(m.maybeEpisodes)[0]!.job._tag).toBe("Ready")))
})
```

Scene example (the same handles as verify):

```ts
import { Command, Mount, Subscription, click, expect, given, role, scene, type, keydown, changeFiles, selector } from "foldkit/scene"
scene({ update, view }, given(initialModel),
  type(role("textbox", { name: "Link or text" }), "http://localhost:8790/article.html"),
  keydown(role("textbox", { name: "Link or text" }), "Enter"),
  Command.expectExact(CreateEpisode),
  Command.resolve(CreateEpisode, Message.SucceededCreateEpisode({ episode: queuedEpisode })),
  expect(role("button", { name: "Play localhost:8790/article.html" })).toBeDisabled(),
  Subscription.emit(Message.TickedPoll()),           // Subscription output has no element
  …)
```

Things Scene enforces:

- Every pending Command and every `OnMount` must be resolved. That includes the Mounts inside `@foldkit/ui`, such as `Menu`'s anchor Mount and `Dialog.AcquireResources`. Unmounts need `Mount.expectEnded`.
- An interaction whose handler returns `Option.none()` must be acknowledged with `expectIgnored()`.
- `changeFiles(selector("input[type=file]"), [file])` and `dropFiles` exist for file inputs.
- ManagedResource lifecycle steps exist if you use one.

Effects inside Commands (HTTP helper, audio) are tested separately with `@effect/vitest` by providing a mock `HttpClient` Layer. That is one more reason to put `Http.layer` in `resources` and not per Command.

---

## 8. DevTools and the MCP server

- DevTools are on by default in development. Recording and the MCP bridge live in `foldkit`. The overlay is `@foldkit/devtools`, which the vite plugin mounts automatically when it is installed as a devDependency. Production builds omit it with no app code (https://foldkit.dev/core/devtools).
- MCP (https://foldkit.dev/ai/mcp, `packages/devtools-mcp`):
  1. `pnpm add -D @foldkit/devtools-mcp` in `apps/web`.
  2. `npx @foldkit/devtools-mcp init` in the project root. It creates or updates only the `foldkit-devtools` entry of `.mcp.json`.
  3. No Vite config change is needed. The plugin starts a loopback relay and publishes its address and a random token in a user-private registry (`~/.cache` on macOS).
  4. Pass `devTools: { Message }` to `makeApplication` to allow `foldkit_dispatch_message`. Without it, inspection and replay still work.
  5. Restart the agent. Open the app in a browser tab with `pnpm --filter @fama/web dev`. Tools: `foldkit_list_runtimes`, `foldkit_get_model`, `foldkit_list_messages`, `foldkit_diff_models`, `foldkit_replay_to_keyframe`, `foldkit_dispatch_message(s)`, and more.
- A fixed port (`foldkit({ devToolsMcpPort: 9988 })` + `FOLDKIT_DEVTOOLS_MCP_PORT`) listens on every interface without a token. Do not use it outside a trusted network. `devToolsMcpPort: false` turns MCP off but keeps the overlay.
- **For Fama:** the MCP server can read the Model, Message payloads and Command args. The API token must be `Schema.Redacted(…, { disallowJsonEncode: true })` everywhere it travels (Model, settings draft, Command args). Otherwise the agent sees the token. Also, `fama-verify` builds the production bundle and serves it from wrangler on :8788, so DevTools/MCP are **not** present during verify runs. They only exist under `vite dev`.

---

## 9. Gotchas, and what Foldkit makes harder

1. **Effect version pins.** `@effect/platform-browser` must be 4.1.3, not latest. Override `@effect/platform-node(-shared)` to 4.1.3, because the vite plugin depends on `~4.1.0` and 4.1.5 needs `effect ^4.1.5` (§1). Foldkit's own repo pins every `@effect/*` with overrides. The docs say to upgrade all Effect packages together within the supported minor.
2. **Verify handle `input[type=file]`.** Do not use `File.select` (temporary input). Keep a persistent hidden input and click it with `Dom.clickElement` from a Command. The click then runs on a later tick than the user's click. Browsers allow `input.click()` inside the transient user-activation window (Chrome about 5 s, Safari is stricter). Test the Attach button by hand in Safari. Fallback: put the hidden input inside a `<label>` that acts as the button. The verify path uses `preview_act upload` on the input and is not affected.
3. **`audio.play()` and user activation.** Fama calls `play()` synchronously in the click handler today. In Foldkit, `play()` runs in a Command after update. Chrome and Safari accept it within the activation window. iOS Safari is the risky case, but the iPhone app is native, so this concerns iOS web only. Avoid extra async hops before `LoadChapter`, for example a separate "read saved position" Command (load positions in Flags, §5). Map `play()` rejection to `FailedPlayAudio` → `Paused`.
4. **`pagehide` flush.** Commands run asynchronously on the runtime's fiber. A `PageHidden` Message → `SavePosition` Command may not finish before the page unloads. Options:
   - accept the 5 s/pause cadence;
   - write synchronously inside the `pagehide` Subscription's listener with `Stream.callback`. This is a side effect outside update, but it sits in the Subscription seam;
   - save on `visibilitychange` → hidden, which fires earlier.

   I recommend the third plus the existing cadence.
5. **Slider.** It has no commit event (only `ChangedValue`), so detect drag end from the child `dragState` (§6). The thumb is a `div role=slider`, not `input type=range`, and the root has no role. Add `role=group` + `aria-label=Position` yourself. Call `Slider.reflectRange` whenever `durationMs` grows. The Slider has an Escape-to-cancel drag that restores `originValue`, which Fama does not have today. That is a small behavior gain.
6. **Menu items** are `role=menuitem`, not `menuitemradio`, and items must be strings. No verify step depends on this. If checked-state semantics matter, use Listbox.
7. **`aria-disabled` vs `disabled`.** The `Button` helper only sets `aria-disabled`. Guard submits in update, or use `h.Disabled(true)` directly.
8. **Scene strictness.** Every @foldkit/ui Mount (Menu anchor, Dialog `AcquireResources`) must be resolved in Scene tests, and every handler fall-through acknowledged. It is more test boilerplate than Testing Library, but it is explicit.
9. **High-frequency Messages.** `timeupdate` (about 4/s) and Slider drag. Put `TimedUpdateAudio` in `excludeFromHistory`. That switches DevTools to full snapshots per entry, which is fine at Fama's Model size.
10. **Model must be a Schema.** `File.File` in the Model (the attached file) is fine at runtime. The dev live-reload preserves the Model over Vite's WebSocket, and a `File` cannot be serialized. I did not test what happens on reload with a file attached. Expect the attached file to drop or the preserve to fail for that state. This is dev only.
11. **Token secrecy.** DevTools and MCP record Models and args. Use `Schema.Redacted` for the token end to end (§2, §8).
12. **Things that become simpler.** The "waiting for next chapter", "episode deleted → stop" and "401 → open Settings" rules were three `useEffect` reactions on derived state. They become explicit branches in `update`. Stale-closure refs (`episodeRef`, `playbackRef`) go away.
13. **Things that become more verbose.** Every imperative call (play, pause, seek, rate, focus, clipboard, storage write, file click) is a named Command with a result Message. The four menus and the dialog each need a Model field, a `Got*Message` variant and a `foldChild`. Expect the roughly 1,750 lines to grow, not shrink, though the logic becomes flat and testable. The AGENTS.md conventions are strict: past-tense Message names, `Completed*` result names, `maybe*` for Option, `is*` booleans, no `NoOp`, `modifyFields`. `@foldkit/oxlint-plugin` (0.15.4) enforces some of them.
14. **React-only bits to replace.**
    - `useId` → static ids.
    - `field-sizing: content` on the textarea: plain CSS, still works.
    - `lucide-react` → SVG via `h`.
    - `cva`/`tailwind-merge` → small class helpers.
    - `StrictMode`: none.
15. **Foldkit is pre-1.0** and ships breaking minors often (0.171 changed `Command.define` messages and `createKeyedLazy`). Pin exact versions. Following the Foldkit skill, vendor the repo as a git subtree at `repos/foldkit` pinned to the `foldkit@0.171.0` tag, so agents read source that matches the installed version. That is a repo layout decision for the operator.

### Suggested file layout (from https://foldkit.dev/patterns/project-organization and `packages/typing-game/client/src/`)

```
apps/web/src/
  entry.ts            Runtime.makeApplication + run (side effects only here)
  main.ts             Model, Message, init, update, view (split when large)
  flags.ts            Flags Schema + localStorage read
  api.ts              request/json helpers + ApiFailure
  command.ts          HTTP, storage, clipboard, focus Commands
  audio.ts            AudioPlayer service, audio Commands, timeline math
  subscription.ts     poll, visibility, audio events, media session, keys, window drop
  view/addBar.ts, view/library.ts, view/playerBar.ts, view/settings.ts
  story.test.ts, scene.test.ts
```
