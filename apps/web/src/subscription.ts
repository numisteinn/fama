import { Subscription } from "@effect/ui"
import { Duration, Effect, Option, Queue, Stream } from "effect"
import { AudioPlayer } from "~/core/audio"
import { SETTING_KEYS, storedSettings } from "~/core/flags"
import { AppMessage } from "~/message"
import { type AppModel, current, episodes, isWorking } from "~/model"
import { FamaConnection } from "~/core/services"
import { chapterStartMs, totalMs } from "~/core/timeline"
import { SKIP_BACK_MS, SKIP_FORWARD_MS } from "~/playback/model"
import { FADE_MS, SLEEP_FADE_TICK_MS, SLEEP_TICK_MS } from "~/playback/sleepTimer"

const POLL_MS = 2000

/** Focused controls keep their own keys. */
const INTERACTIVE =
  "input, textarea, select, [contenteditable], button, a, [role=button], [role=slider], [role^=menuitem], [role=menu]"

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false

/** What a drop holds, taken during the event: the browser empties `dataTransfer` after it. */
const droppedEntries = (event: DragEvent): ReadonlyArray<FileSystemEntry | File> =>
  Array.from(event.dataTransfer?.items ?? []).flatMap((item): Array<FileSystemEntry | File> => {
    if (item.kind !== "file") return []
    const entry = item.webkitGetAsEntry()
    if (entry) return [entry]
    const file = item.getAsFile()
    return file ? [file] : []
  })

const readEntries = (reader: FileSystemDirectoryReader) =>
  new Promise<Array<FileSystemEntry>>((resolve, reject) => reader.readEntries(resolve, reject))

/** The files of an entry. A folder gives its files and those of its folders, by name, without hidden files. */
const entryFiles = async (entry: FileSystemEntry): Promise<Array<File>> => {
  if (entry instanceof FileSystemFileEntry) {
    return [await new Promise<File>((resolve, reject) => entry.file(resolve, reject))]
  }
  if (!(entry instanceof FileSystemDirectoryEntry)) return []
  const reader = entry.createReader()
  const children: Array<FileSystemEntry> = []
  for (let part = await readEntries(reader); part.length > 0; part = await readEntries(reader)) children.push(...part)
  const visible = children.filter((child) => !child.name.startsWith(".")).toSorted((a, b) => a.name.localeCompare(b.name))
  return (await Promise.all(visible.map(entryFiles))).flat()
}

const droppedFiles = (entries: ReadonlyArray<FileSystemEntry | File>): Promise<Array<File>> =>
  Promise.all(entries.map((entry) => (entry instanceof File ? Promise.resolve([entry]) : entryFiles(entry).catch(() => [])))).then(
    (files) => files.flat(),
  )

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

const fromDomEvent = <A>(
  target: EventTarget,
  type: string,
  mapEvent: (event: Event) => Option.Option<A>,
): Stream.Stream<A> =>
  Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (raw: Event) => {
          const maybe = mapEvent(raw)
          if (Option.isSome(maybe)) Queue.offerUnsafe(queue, maybe.value)
        }
        target.addEventListener(type, listener)
        return listener
      }),
      (listener) => Effect.sync(() => target.removeEventListener(type, listener)),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )

const MEDIA_ACTIONS: ReadonlyArray<MediaSessionAction> = [
  "play",
  "pause",
  "seekbackward",
  "seekforward",
  "seekto",
  "previoustrack",
  "nexttrack",
]

const mediaActionMessage = (action: MediaSessionAction, details: MediaSessionActionDetails): Option.Option<AppMessage> => {
  switch (action) {
    case "play":
      return Option.some(AppMessage.PressedMediaPlay())
    case "pause":
      return Option.some(AppMessage.PressedMediaPause())
    case "seekbackward":
      return Option.some(AppMessage.PressedMediaSkip({ deltaMs: -(details.seekOffset ?? SKIP_BACK_MS / 1000) * 1000 }))
    case "seekforward":
      return Option.some(AppMessage.PressedMediaSkip({ deltaMs: (details.seekOffset ?? SKIP_FORWARD_MS / 1000) * 1000 }))
    case "seekto":
      return details.seekTime === undefined
        ? Option.none()
        : Option.some(AppMessage.PressedMediaSeekTo({ positionMs: details.seekTime * 1000 }))
    case "previoustrack":
      return Option.some(AppMessage.PressedMediaPreviousTrack())
    case "nexttrack":
      return Option.some(AppMessage.PressedMediaNextTrack())
    case "skipad":
    case "stop":
      return Option.none()
  }
}

const isLoaded = (model: AppModel) => Option.isSome(current(model))

/** The countdown ticks while it plays: every half second, faster through the fade. */
const sleepTickMs = (model: AppModel): number => {
  if (model.sleep._tag !== "Countdown" || model.playback._tag !== "Loaded" || !model.playback.isPlaying) return 0
  return model.sleep.endsAtMs - model.sleepAtMs <= FADE_MS ? SLEEP_FADE_TICK_MS : SLEEP_TICK_MS
}

/** The Message for a `storage` event with `key`. A `null` key is a clear. Other keys, such as positions, are ignored. */
export const storageEventMessage = (key: string | null): Option.Option<AppMessage> =>
  key === null || SETTING_KEYS.includes(key) ? Option.some(AppMessage.ChangedStoredSettings(storedSettings())) : Option.none()

export const appSubscriptions = ({
  model,
}: {
  readonly model: AppModel
}): ReadonlyArray<Subscription.Subscription<AppMessage, AudioPlayer | FamaConnection> | false> => {
  const sleepIntervalMs = sleepTickMs(model)
  const isPolling = episodes(model).some((episode) => isWorking(episode.job))
  const isAudioLoaded = model.playback._tag === "Loaded"
  const loaded = current(model)
  const mediaMetaDeps = Option.match(loaded, {
    onNone: () => [null, null, null, ""] as const,
    onSome: ({ playback, episode }) =>
      [
        episode.title,
        episode.chapters[playback.chapter]?.title ?? null,
        episode.author,
        episode.coverUrl ? model.connection.origin + episode.coverUrl : "",
      ] as const,
  })
  const playbackState: "none" | "playing" | "paused" =
    model.playback._tag !== "Loaded" || !isLoaded(model)
      ? "none"
      : model.playback.isPlaying
        ? "playing"
        : "paused"
  const mediaPositionDeps = Option.match(loaded, {
    onNone: () => [0, 0, model.rate] as const,
    onSome: ({ playback, episode }) =>
      [
        chapterStartMs(episode.chapters, playback.chapter) + playback.offsetMs,
        totalMs(episode.chapters),
        model.rate,
      ] as const,
  })

  return [
    /** Refetch every 2 s while a job is Queued or Running. */
    isPolling &&
      Subscription.make(
        "app/poll",
        Stream.tick(Duration.millis(POLL_MS)).pipe(
          Stream.drop(1),
          Stream.map(() => AppMessage.TickedPoll()),
        ),
      ),

    /** Refetch when the page comes back; save the position when it goes away. */
    typeof document !== "undefined" &&
      typeof window !== "undefined" &&
      Subscription.make(
        "app/pageVisibility",
        Stream.merge(
          fromDomEvent(document, "visibilitychange", () =>
            Option.some(document.visibilityState === "visible" ? AppMessage.BecameVisible() : AppMessage.HidPage()),
          ),
          fromDomEvent(window, "pagehide", () => Option.some(AppMessage.HidPage())),
        ),
      ),

    /** Settings saved in another tab. Updates `FamaConnection` before notifying `App` so queries never read a stale token. */
    typeof window !== "undefined" &&
      Subscription.make(
        "app/storedSettings",
        Stream.unwrap(
          Effect.gen(function* () {
            const connectionService = yield* FamaConnection
            return fromDomEvent(window, "storage", (event) => {
              if (!(event instanceof StorageEvent)) return Option.none()
              const maybe = storageEventMessage(event.key)
              if (Option.isSome(maybe) && maybe.value._tag === "ChangedStoredSettings") {
                connectionService.set(maybe.value.connection)
              }
              return maybe
            })
          }),
        ),
      ),

    /** A file dragged anywhere over the window shows the drop overlay. */
    typeof window !== "undefined" &&
      Subscription.make(
        "app/fileDrop",
        Stream.mergeAll(
          [
            fromDomEvent<AppMessage>(window, "dragenter", (event) =>
              event instanceof DragEvent && hasFiles(event) ? Option.some(AppMessage.EnteredFileDrag()) : Option.none(),
            ),
            fromDomEvent<AppMessage>(window, "dragleave", (event) =>
              event instanceof DragEvent && hasFiles(event) ? Option.some(AppMessage.LeftFileDrag()) : Option.none(),
            ),
            fromDomEvent<AppMessage>(window, "dragover", (event) => {
              if (event instanceof DragEvent && hasFiles(event)) event.preventDefault()
              return Option.none()
            }),
            fromDomEvent<ReadonlyArray<FileSystemEntry | File>>(window, "drop", (event) => {
              if (!(event instanceof DragEvent) || !hasFiles(event)) return Option.none()
              event.preventDefault()
              return Option.some(droppedEntries(event))
            }).pipe(
              Stream.mapEffect((entries) =>
                Effect.promise(() => droppedFiles(entries)).pipe(
                  Effect.map((files) => AppMessage.DroppedFiles({ files })),
                ),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        ),
      ),

    /** Events of the detached audio element, while an episode is loaded. */
    isAudioLoaded &&
      Subscription.make(
        "app/audioEvents",
        Stream.unwrap(
          Effect.gen(function* () {
            const audio = yield* AudioPlayer
            const events: ReadonlyArray<Stream.Stream<AppMessage>> = [
              fromDomEvent(audio, "timeupdate", () =>
                Option.some(AppMessage.UpdatedAudioTime({ offsetMs: audio.currentTime * 1000, atMs: Date.now() })),
              ),
              fromDomEvent(audio, "play", () => Option.some(AppMessage.StartedAudio())),
              fromDomEvent(audio, "pause", () => (!audio.ended ? Option.some(AppMessage.PausedAudio()) : Option.none())),
              fromDomEvent(audio, "ended", () => Option.some(AppMessage.EndedChapter())),
            ]
            return Stream.mergeAll(events, { concurrency: "unbounded" })
          }),
        ),
      ),

    /** The sleep countdown, while it plays. The key holds the interval, so the fade restarts it faster. */
    sleepIntervalMs > 0 &&
      Subscription.make(
        "app/sleepTick",
        sleepIntervalMs,
        (interval) =>
          Stream.tick(Duration.millis(interval)).pipe(
            Stream.map(() => AppMessage.TickedSleep({ nowMs: Date.now() })),
          ),
      ),

    /** Space toggles, arrows skip. Focused controls keep their own keys. */
    typeof window !== "undefined" &&
      isLoaded(model) &&
      Subscription.make(
        "app/playerKeys",
        fromDomEvent<AppMessage>(window, "keydown", (event) => {
          if (!(event instanceof KeyboardEvent)) return Option.none()
          if (event.metaKey || event.ctrlKey || event.altKey) return Option.none()
          const target = event.target instanceof Element ? event.target : null
          if (target?.closest(INTERACTIVE)) return Option.none()
          const shortcut =
            event.key === " "
              ? "Toggle"
              : event.key === "ArrowLeft"
                ? "Back"
                : event.key === "ArrowRight"
                  ? "Forward"
                  : null
          if (!shortcut) return Option.none()
          event.preventDefault()
          return Option.some(AppMessage.PressedPlayerShortcut({ shortcut }))
        }),
      ),

    /** Lock screen and OS media keys: title and artwork. */
    Subscription.make("app/mediaMetadata", mediaMetaDeps, ([title, chapterTitle, author, artworkUrl]) =>
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
    ),

    Subscription.make("app/mediaPlaybackState", playbackState, (state) =>
      scoped(
        () => {
          const session = mediaSession()
          if (session) session.playbackState = state
        },
        () => undefined,
      ),
    ),

    Subscription.make("app/mediaPosition", mediaPositionDeps, ([positionMs, durationMs, rate]) =>
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
    ),

    Subscription.make(
      "app/mediaActions",
      Stream.callback<AppMessage>((queue) =>
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
  ]
}
