// The sequence check of progress sync, on the web tab. The model, the steps and the invariants are
// `@fama/contracts/sequences`. This file gives it a tab: the real `update`, and an audio element, a storage and a
// server that do what the Commands say.
import type { Episode, EpisodeProgress } from "@fama/contracts"
import {
  CHAPTER_MS,
  type Audio,
  type Context,
  type Device,
  type Listing,
  type Observed,
  type Report,
  type Step,
  type World,
  describeCounterexample,
  explore,
  mergeReports,
  run,
  stampAt,
  startWorld,
} from "@fama/contracts/sequences"
import { describe, expect, test } from "vitest"
import { apiToken } from "~/api"
import { harbourDays, runningHarbourDays } from "~/fixture"
import { Message } from "~/message"
import { type Model, StoredProgress } from "~/model"
import { init, update } from "~/update"

const { id } = harbourDays

const episodeOf = (listing: Listing): Episode => ({
  ...harbourDays,
  durationMs: listing.job === "Ready" ? CHAPTER_MS.slice(0, listing.chapters).reduce((sum, ms) => sum + ms, 0) : null,
  bookUrl: listing.job === "Ready" ? harbourDays.bookUrl : null,
  chapters: harbourDays.chapters.slice(0, listing.chapters),
  job:
    listing.job === "Ready"
      ? harbourDays.job
      : listing.job === "Failed"
        ? { _tag: "Failed", reason: "The worker stopped", failedAt: harbourDays.createdAt }
        : runningHarbourDays.job,
  progress: listing.progress,
})

type Command = NonNullable<ReturnType<typeof update>["commands"]>[number]

/** The audio element, as the Commands leave it. */
interface Element {
  readonly chapter: number | null
  readonly offsetMs: number
  readonly isPlaying: boolean
}

/**
 * A web tab: the real `update`, an audio element that does what the audio Commands say, the tab's storage, and the
 * server behind `Context.put`. Each Command answers at once, in the order `update` returned them.
 */
class Tab implements Device {
  private model: Model
  private element: Element = { chapter: null, offsetMs: 0, isPlaying: false }
  private stored: EpisodeProgress | null
  /** The library requests that are out: the check's number, and the tab's own. */
  private fetches: ReadonlyArray<{ readonly request: number; readonly generation: number; readonly own: number }> = []
  private lastFetch: { readonly generation: number; readonly own: number } | null = null
  /** Messages to send, oldest first. `before` runs when its Message reaches `update`. */
  private queue: Array<{ readonly message: Message; readonly before?: () => void }> = []
  private pauses = 0
  private context: Context = { now: stampAt(0), put: (progress) => progress, answered() {}, started() {}, stamped() {} }

  constructor(from: Tab | { readonly listing: Listing; readonly local: EpisodeProgress | null }) {
    if (from instanceof Tab) {
      this.model = from.model
      this.element = from.element
      this.stored = from.stored
      this.fetches = from.fetches
      return
    }
    this.stored = from.local
    const booted = init({
      token: apiToken("dev-api-token"),
      origin: "",
      voice: null,
      speed: 1,
      rate: 1,
      localProgress: from.local ? { [id]: from.local } : {},
    })
    this.model = booted.model
    for (const command of booted.commands ?? []) this.execute(command)
    const first = this.lastFetch
    if (!first) throw new Error("init sent no library request")
    this.send(Message.SucceededFetchEpisodes({ generation: first.generation, request: first.own, episodes: [episodeOf(from.listing)] }))
  }

  fork(): Device {
    return new Tab(this)
  }

  get audio(): Audio {
    const { chapter, offsetMs, isPlaying } = this.element
    return { isPlaying, positionMs: chapter === null ? null : this.startOf(chapter) + offsetMs }
  }

  readonly pausesHeldPlay = true

  startsFromRow(listing: Listing): boolean {
    return listing.chapters > 0
  }

  refresh(kind: "Foreground" | "Poll", request: number, context: Context): Observed {
    return this.step(context, () => {
      this.send(kind === "Foreground" ? Message.BecameVisible() : Message.TickedPoll())
      if (!this.lastFetch) throw new Error("the tab sent no library request")
      this.fetches = [...this.fetches, { request, ...this.lastFetch }]
    })
  }

  answer(request: number, listing: Listing | null, context: Context): Observed {
    return this.step(context, () => {
      const fetch = this.fetches.find((item) => item.request === request)
      if (!fetch) throw new Error(`the tab has no request ${request}`)
      this.fetches = this.fetches.filter((item) => item.request !== request)
      this.send(
        listing === null
          ? Message.FailedFetchEpisodes({
              generation: fetch.generation,
              request: fetch.own,
              failure: { status: 503, message: "Server unavailable" },
            })
          : Message.SucceededFetchEpisodes({ generation: fetch.generation, request: fetch.own, episodes: [episodeOf(listing)] }),
      )
    })
  }

  /** The bar's button when an episode is loaded, else the row. */
  play(context: Context): Observed {
    return this.step(context, () =>
      this.send(this.element.chapter === null ? Message.ClickedPlayEpisode({ episodeId: id }) : Message.ClickedPlayPause()),
    )
  }

  /** The bar's button. A held Play shows no Pause there: the listener takes it back with the Pause key. */
  pause(isHeld: boolean, context: Context): Observed {
    return this.step(context, () => this.send(isHeld ? Message.PressedMediaPause() : Message.ClickedPlayPause()))
  }

  seek(positionMs: number, context: Context): Observed {
    return this.step(context, () => this.send(Message.PressedMediaSeekTo({ positionMs })))
  }

  listen(ms: number, context: Context): Observed {
    return this.step(context, () => {
      const { chapter, offsetMs, isPlaying } = this.element
      if (chapter === null || !isPlaying) return
      const atMs = Date.parse(context.now)
      const endMs = CHAPTER_MS[chapter] ?? 0
      if (offsetMs + ms < endMs) {
        this.element = { chapter, offsetMs: offsetMs + ms, isPlaying }
        this.send(Message.UpdatedAudioTime({ offsetMs: offsetMs + ms, atMs }))
        return
      }
      // The file ended. The browser fires `timeupdate`, then `ended`; its `pause` at the end is not sent.
      this.element = { chapter, offsetMs: endMs, isPlaying: false }
      this.send(Message.UpdatedAudioTime({ offsetMs: endMs, atMs }))
      this.send(Message.EndedChapter())
    })
  }

  private step(context: Context, act: () => void): Observed {
    this.context = context
    this.pauses = 0
    act()
    return { pauses: this.pauses, faults: [] }
  }

  private startOf(chapter: number): number {
    return CHAPTER_MS.slice(0, chapter).reduce((sum, ms) => sum + ms, 0)
  }

  /** Runs `update` for `message` and for every Message its Commands answer with, oldest first. */
  private send(message: Message, before?: () => void) {
    this.queue.push(before ? { message, before } : { message })
    if (this.queue.length > 1) return
    for (let next = this.queue[0]; next !== undefined; next = this.queue[0]) {
      next.before?.()
      const result = update(this.model, next.message)
      this.model = result.model
      for (const command of result.commands ?? []) this.execute(command)
      this.queue.shift()
    }
  }

  private started() {
    const { chapter, offsetMs } = this.element
    if (chapter === null) return
    this.context.started(this.startOf(chapter) + offsetMs)
    this.send(Message.StartedAudio())
    // Audio told to play at the end of its file ends at once.
    if (offsetMs >= (CHAPTER_MS[chapter] ?? 0)) {
      this.element = { chapter, offsetMs, isPlaying: false }
      this.send(Message.EndedChapter())
    }
  }

  private execute(command: Command) {
    /** The args of a Command, as its definition declares them. */
    const args = <Args>() => command.args as Args
    switch (command.name) {
      case "FetchEpisodes": {
        const { generation, request } = args<{ generation: number; request: number }>()
        this.lastFetch = { generation, own: request }
        return
      }
      case "LoadChapter": {
        const { src, offsetMs, isAutoplay } = args<{ src: string; offsetMs: number; isAutoplay: boolean }>()
        const chapter = harbourDays.chapters.findIndex((item) => item.url === src)
        if (chapter < 0) throw new Error(`LoadChapter of an unknown file: ${src}`)
        if (this.element.isPlaying && !isAutoplay) this.pauses += 1
        this.element = { chapter, offsetMs, isPlaying: isAutoplay }
        if (isAutoplay) this.started()
        this.send(Message.CompletedLoadChapter())
        return
      }
      case "PlayAudio": {
        if (this.element.chapter === null) throw new Error("PlayAudio with no file loaded")
        if (!this.element.isPlaying) {
          this.element = { ...this.element, isPlaying: true }
          this.started()
        }
        this.send(Message.CompletedPlayAudio())
        return
      }
      case "PauseAudio": {
        if (this.element.isPlaying) {
          this.element = { ...this.element, isPlaying: false }
          this.pauses += 1
          this.send(Message.PausedAudio())
        }
        this.send(Message.CompletedPauseAudio())
        return
      }
      case "SeekAudio": {
        const { offsetMs } = args<{ offsetMs: number }>()
        const { chapter, isPlaying } = this.element
        this.element = { chapter, offsetMs, isPlaying }
        // Audio that plays and lands on the end of its file ends at once.
        if (chapter !== null && isPlaying && offsetMs >= (CHAPTER_MS[chapter] ?? 0)) {
          this.element = { chapter, offsetMs, isPlaying: false }
          this.send(Message.EndedChapter())
        }
        this.send(Message.CompletedSeekAudio())
        return
      }
      case "StopAudio":
        if (this.element.isPlaying) this.pauses += 1
        this.element = { chapter: null, offsetMs: 0, isPlaying: false }
        this.send(Message.CompletedStopAudio())
        return
      case "SaveProgress": {
        const { positionMs } = args<{ positionMs: number }>()
        const progress = { positionMs: Math.max(0, Math.round(positionMs)), updatedAt: this.context.now }
        this.stored = progress
        this.context.stamped(progress.positionMs)
        this.send(Message.SavedProgress({ episodeId: id, progress }))
        return
      }
      case "StoreProgress":
        this.stored = args<{ progress: EpisodeProgress }>().progress
        this.send(Message.CompletedStoreProgress())
        return
      case "ReadStoredProgress":
        this.send(
          Message.GotStoredProgress({
            episodeId: id,
            intent: args<{ intent: number }>().intent,
            stored: this.stored ? StoredProgress.Saved({ progress: this.stored }) : StoredProgress.NotSaved(),
          }),
        )
        return
      case "PushProgress": {
        const sent = args<{ progress: EpisodeProgress }>().progress
        const stored = this.context.put(sent)
        this.send(Message.SucceededPushProgress({ episodeId: id, sent, stored }), () => this.context.answered(stored))
        return
      }
      default:
        // Voices, focus and timers do not touch playback or progress.
        return
    }
  }
}

/** The entry the tab and the server start with. */
const old: EpisodeProgress = { positionMs: 10_000, updatedAt: stampAt(-60_000) }

const steps = {
  play: { _tag: "Play" },
  pause: { _tag: "Pause" },
  listen: { _tag: "Listen" },
} as const satisfies Record<string, Step>

/** A world after `prefix`: the tab booted with `old`, the library loaded once. */
const seed = (server: Omit<Listing, "progress">, prefix: ReadonlyArray<Step>): World => {
  const listing = { ...server, progress: old }
  const started = run(startWorld(new Tab({ listing, local: old }), listing), prefix)
  if (started.broken.length > 0) throw new Error(`The seed breaks an invariant: ${started.broken.join("; ")}`)
  return started.world
}

const SEEDS: ReadonlyArray<readonly [string, () => World]> = [
  ["ready, in the library", () => seed({ chapters: 2, job: "Ready" }, [])],
  ["ready, paused at 10 s", () => seed({ chapters: 2, job: "Ready" }, [steps.play, steps.pause])],
  ["growing, in the library", () => seed({ chapters: 1, job: "Running" }, [])],
  ["growing, paused at 10 s", () => seed({ chapters: 1, job: "Running" }, [steps.play, steps.pause])],
  [
    "growing, waiting at the end of chapter 1",
    () => seed({ chapters: 1, job: "Running" }, [steps.play, steps.listen, steps.listen, steps.listen, steps.listen]),
  ],
  ["encoding, playing at 10 s", () => seed({ chapters: 2, job: "Running" }, [steps.play])],
]

/** Steps after each seed. `FAMA_SEQUENCE_DEPTH=7` walks about ten times as many sequences. */
const DEPTH = Number(process.env.FAMA_SEQUENCE_DEPTH ?? 6)

const print = (report: Report) => {
  const lines = [
    `sequences ${report.sequences}, steps ${report.steps}, broken ${JSON.stringify(report.counts)}`,
    ...Object.values(report.shortest).map(describeCounterexample),
  ]
  process.stdout.write(lines.join("\n") + "\n")
}

describe("progress sync, every sequence", () => {
  test(`no sequence of ${DEPTH} steps breaks an invariant`, () => {
    const report = mergeReports(SEEDS.map(([name, world]) => explore(name, world(), DEPTH)))
    print(report)
    expect(report.counts).toEqual({})
  }, 1_800_000)
})

describe("the findings of review round 4", () => {
  const answer = (request: number, brings: "ListNow" | "ListAtSend" | "Failure" = "ListNow"): Step => ({
    _tag: "Answer",
    request,
    brings,
  })

  test("1: the other device saves the same position with a newer stamp while the Play waits", () => {
    const result = run(seed({ chapters: 2, job: "Ready" }, [steps.play, steps.pause]), [
      { _tag: "OtherDeviceSaves", positionMs: 10_000 },
      { _tag: "Foreground" },
      steps.play,
      answer(1),
    ])
    process.stdout.write(`finding 1: ${result.broken.join("; ") || "holds"}\n`)
    expect(result.broken).toEqual([])
    expect(result.world.audio.isPlaying).toBe(true)
  })

  test("3: one answer brings the next chapter and the other device's newer position to a Play that waits", () => {
    const waiting = seed({ chapters: 1, job: "Running" }, [steps.play, steps.listen, steps.listen, steps.listen, steps.listen])
    expect(waiting.audio).toEqual({ isPlaying: false, positionMs: 26_825 })
    const result = run(waiting, [
      { _tag: "ChapterMade" },
      { _tag: "OtherDeviceSaves", positionMs: 40_000 },
      { _tag: "Poll" },
      answer(1),
      steps.listen,
    ])
    process.stdout.write(`finding 3: ${result.broken.join("; ") || "holds"}\n`)
    expect(result.broken).toEqual([])
    expect(result.world.server.progress?.positionMs).toBe(45_000)
  })
})
