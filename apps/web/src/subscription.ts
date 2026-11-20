import { Duration, Effect, Option, Queue, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { AudioPlayer } from "~/audio"
import { Message } from "~/message"
import { type Model, POLL_MS, SKIP_BACK_MS, SKIP_FORWARD_MS, current, episodes, isWorking } from "~/model"
import { chapterStartMs, totalMs } from "~/timeline"

/** Focused controls keep their own keys. */
const INTERACTIVE = "input, textarea, select, [contenteditable], button, a, [role=slider], [role^=menuitem], [role=menu]"

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false

const mediaSession = (): MediaSession | undefined =>
  typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : undefined

/** Runs `acquire` while the entry is active and `release` when it stops. Emits nothing. */
const scoped = (acquire: () => void, release: () => void): Stream.Stream<never> =>
  Stream.callback<never>(() =>
    Effect.acquireRelease(Effect.sync(acquire), () => Effect.sync(release)).pipe(Effect.flatMap(() => Effect.never)),
  )

const ignoreUnsupported = (run: () => void) => {
  try {
    run()
  } catch {
    // Not supported in this browser, or rejected during a source change.
  }
}

const MEDIA_ACTIONS: ReadonlyArray<MediaSessionAction> = [
  "play",
  "pause",
  "seekbackward",
  "seekforward",
  "seekto",
  "previoustrack",
  "nexttrack",
]

const mediaActionMessage = (action: MediaSessionAction, details: MediaSessionActionDetails): Option.Option<Message> => {
  switch (action) {
    case "play":
      return Option.some(Message.PressedMediaPlay())
    case "pause":
      return Option.some(Message.PressedMediaPause())
    case "seekbackward":
      return Option.some(Message.PressedMediaSkip({ deltaMs: -(details.seekOffset ?? SKIP_BACK_MS / 1000) * 1000 }))
    case "seekforward":
      return Option.some(Message.PressedMediaSkip({ deltaMs: (details.seekOffset ?? SKIP_FORWARD_MS / 1000) * 1000 }))
    case "seekto":
      return details.seekTime === undefined
        ? Option.none()
        : Option.some(Message.PressedMediaSeekTo({ positionMs: details.seekTime * 1000 }))
    case "previoustrack":
      return Option.some(Message.PressedMediaPreviousTrack())
    case "nexttrack":
      return Option.some(Message.PressedMediaNextTrack())
    default:
      return Option.none()
  }
}

const isLoaded = (model: Model) => Option.isSome(current(model))

export const subscriptions = Subscription.make<Model, Message, AudioPlayer>()((entry) => ({
  /** Refetch every 2 s while a job is Queued or Running. */
  poll: entry(
    { isPolling: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isPolling: episodes(model).some((episode) => isWorking(episode.job)) }),
      dependenciesToStream: ({ isPolling }) =>
        Stream.when(
          Stream.tick(Duration.millis(POLL_MS)).pipe(
            Stream.drop(1),
            Stream.map(() => Message.TickedPoll()),
          ),
          Effect.sync(() => isPolling),
        ),
    },
  ),

  /** Refetch when the page comes back; save the position when it goes away. */
  pageVisibility: Subscription.persistentEntry(
    Stream.merge(
      Dom.streamFromEvent({
        target: document,
        type: "visibilitychange",
        mapEvent: () => (document.visibilityState === "visible" ? Message.BecameVisible() : Message.HidPage()),
      }),
      Dom.streamFromEvent({ target: window, type: "pagehide", mapEvent: () => Message.HidPage() }),
    ),
  ),

  /** A file dragged anywhere over the window shows the drop overlay. */
  fileDrop: Subscription.persistentEntry(
    Stream.mergeAll(
      [
        Dom.streamFromEventFilterMap({
          target: window,
          type: "dragenter",
          filterMapEvent: (event) => Option.liftPredicate(Message.EnteredFileDrag(), () => hasFiles(event)),
        }),
        Dom.streamFromEventFilterMap({
          target: window,
          type: "dragleave",
          filterMapEvent: (event) => Option.liftPredicate(Message.LeftFileDrag(), () => hasFiles(event)),
        }),
        Dom.streamFromEventFilterMap({
          target: window,
          type: "dragover",
          filterMapEvent: (event) => {
            if (hasFiles(event)) event.preventDefault()
            return Option.none()
          },
        }),
        Dom.streamFromEventFilterMap({
          target: window,
          type: "drop",
          filterMapEvent: (event) => {
            if (!hasFiles(event)) return Option.none()
            event.preventDefault()
            return Option.map(Option.fromNullishOr(event.dataTransfer?.files[0]), (file) =>
              Message.DroppedFile({ file }),
            )
          },
        }),
      ],
      { concurrency: "unbounded" },
    ),
  ),

  /** Events of the detached audio element, while an episode is loaded. */
  audioEvents: entry(
    { isLoaded: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isLoaded: model.playback._tag === "Loaded" }),
      dependenciesToStream: ({ isLoaded: isActive }) =>
        Stream.when(
          Stream.unwrap(
            Effect.gen(function* () {
              const audio = yield* AudioPlayer
              const events: ReadonlyArray<Stream.Stream<Message>> = [
                  Dom.streamFromEvent({
                    target: audio,
                    type: "timeupdate",
                    mapEvent: () => Message.UpdatedAudioTime({ offsetMs: audio.currentTime * 1000, atMs: Date.now() }),
                  }),
                  Dom.streamFromEvent({ target: audio, type: "play", mapEvent: () => Message.StartedAudio() }),
                  Dom.streamFromEventFilterMap({
                    target: audio,
                    type: "pause",
                    filterMapEvent: () => Option.liftPredicate(Message.PausedAudio(), () => !audio.ended),
                  }),
                  Dom.streamFromEvent({ target: audio, type: "ended", mapEvent: () => Message.EndedChapter() }),
                ]
              return Stream.mergeAll(events, { concurrency: "unbounded" })
            }),
          ),
          Effect.sync(() => isActive),
        ),
    },
  ),

  /** Space toggles, arrows skip. Focused controls keep their own keys. */
  playerKeys: entry(
    { isLoaded: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isLoaded: isLoaded(model) }),
      dependenciesToStream: ({ isLoaded: isActive }) =>
        Stream.when(
          Dom.streamFromEventFilterMap({
            target: window,
            type: "keydown",
            filterMapEvent: (event) => {
              if (event.metaKey || event.ctrlKey || event.altKey) return Option.none()
              const target = event.target instanceof Element ? event.target : null
              if (target?.closest(INTERACTIVE)) return Option.none()
              const shortcut =
                event.key === " " ? "Toggle" : event.key === "ArrowLeft" ? "Back" : event.key === "ArrowRight" ? "Forward" : null
              if (!shortcut) return Option.none()
              event.preventDefault()
              return Option.some(Message.PressedPlayerShortcut({ shortcut }))
            },
          }),
          Effect.sync(() => isActive),
        ),
    },
  ),

  /** Lock screen and OS media keys: title and artwork. */
  mediaMetadata: entry(
    {
      title: Schema.NullOr(Schema.String),
      chapterTitle: Schema.NullOr(Schema.String),
      author: Schema.NullOr(Schema.String),
      artworkUrl: Schema.String,
    },
    {
      modelToDependencies: (model) =>
        Option.match(current(model), {
          onNone: () => ({ title: null, chapterTitle: null, author: null, artworkUrl: "" }),
          onSome: ({ playback, episode }) => ({
            title: episode.title,
            chapterTitle: episode.chapters[playback.chapter]?.title ?? null,
            author: episode.author,
            artworkUrl: episode.coverUrl ? model.connection.origin + episode.coverUrl : "",
          }),
        }),
      dependenciesToStream: ({ title, chapterTitle, author, artworkUrl }) =>
        scoped(
          () => {
            const session = mediaSession()
            if (!session) return
            if (!title) {
              session.metadata = null
              return
            }
            const artwork = artworkUrl
              ? [{ src: new URL(artworkUrl, location.href).href }]
              : [{ src: new URL("/icon-512.png", location.href).href, sizes: "512x512", type: "image/png" }]
            session.metadata = new MediaMetadata({
              title,
              artist: author ?? chapterTitle ?? "",
              album: chapterTitle ?? "Fama",
              artwork,
            })
          },
          () => undefined,
        ),
    },
  ),

  mediaPlaybackState: entry(
    { state: Schema.Literals(["none", "playing", "paused"]) },
    {
      modelToDependencies: (model) => ({
        state:
          model.playback._tag !== "Loaded" || !isLoaded(model)
            ? ("none" as const)
            : model.playback.isPlaying
              ? ("playing" as const)
              : ("paused" as const),
      }),
      dependenciesToStream: ({ state }) =>
        scoped(
          () => {
            const session = mediaSession()
            if (session) session.playbackState = state
          },
          () => undefined,
        ),
    },
  ),

  mediaPosition: entry(
    { positionMs: Schema.Number, durationMs: Schema.Number, rate: Schema.Number },
    {
      modelToDependencies: (model) =>
        Option.match(current(model), {
          onNone: () => ({ positionMs: 0, durationMs: 0, rate: model.rate }),
          onSome: ({ playback, episode }) => ({
            positionMs: chapterStartMs(episode.chapters, playback.chapter) + playback.offsetMs,
            durationMs: totalMs(episode.chapters),
            rate: model.rate,
          }),
        }),
      dependenciesToStream: ({ positionMs, durationMs, rate }) =>
        scoped(
          () => {
            const session = mediaSession()
            if (!session || durationMs <= 0) return
            ignoreUnsupported(() =>
              session.setPositionState({
                duration: durationMs / 1000,
                position: Math.min(positionMs, durationMs) / 1000,
                playbackRate: rate,
              }),
            )
          },
          () => undefined,
        ),
    },
  ),

  mediaActions: Subscription.persistentEntry(
    Stream.callback<Message>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const session = mediaSession()
          if (!session) return
          for (const action of MEDIA_ACTIONS) {
            ignoreUnsupported(() =>
              session.setActionHandler(action, (details) =>
                Option.match(mediaActionMessage(action, details), {
                  onNone: () => undefined,
                  onSome: (message) => Queue.offerUnsafe(queue, message),
                }),
              ),
            )
          }
        }),
        () =>
          Effect.sync(() => {
            const session = mediaSession()
            if (!session) return
            for (const action of MEDIA_ACTIONS) ignoreUnsupported(() => session.setActionHandler(action, null))
          }),
      ).pipe(Effect.flatMap(() => Effect.never)),
    ),
  ),
}))
