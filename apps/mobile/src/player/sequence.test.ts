// The sequence check of progress sync, on the phone. The model, the steps and the invariants are
// `@fama/contracts/sequences`. This file gives it a phone: the real `step` of `core.ts`, and a native player that
// does what the native calls say (`Native`, the queue of `EpisodePlayer.swift`).
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
import { type Core, type NativeCall, type PlayerEvent, initialCore, step } from "./core"
import type { NativeStatus } from "./native"

const id = "harbour-days"

const episodeOf = (listing: Listing): Episode =>
  ({
    id,
    createdAt: stampAt(-600_000),
    source: { _tag: "Text", title: null, text: "Harbour Days" },
    title: "Harbour Days",
    author: null,
    language: "en",
    voice: null,
    speed: 1,
    durationMs: listing.job === "Ready" ? CHAPTER_MS.slice(0, listing.chapters).reduce((sum, ms) => sum + ms, 0) : null,
    chapters: CHAPTER_MS.slice(0, listing.chapters).map((durationMs, index) => ({
      index,
      title: `Chapter ${index + 1}`,
      durationMs,
      url: `/media/t/episodes/${id}/chapters/00${index}.m4a`,
    })),
    bookUrl: null,
    coverUrl: null,
    job:
      listing.job === "Ready"
        ? { _tag: "Ready", finishedAt: stampAt(0) }
        : listing.job === "Failed"
          ? { _tag: "Failed", reason: "The worker stopped", failedAt: stampAt(0) }
          : { _tag: "Running", workerId: "w", stage: "synthesizing", done: 1, total: 2, heartbeatAt: stampAt(0) },
    progress: listing.progress,
  }) as unknown as Episode

/**
 * The native player, as `EpisodePlayer.swift` has it: the queue, `wantsPlay`, `expectsMore` and `playAsked`. Keep
 * the two in step: `load`, `updateTracks`, `play`, `pause`, `seek` and the end of the queue in `listen` here say
 * what the Swift methods and `endIfOver` do.
 */
class Native {
  episodeId: string | null = null
  tracks: ReadonlyArray<number> = []
  expectsMore = false
  wantsPlay = false
  /** The listener pressed Play at the end of the queue while the job still made chapters. */
  playAsked = false
  /** The current queue item. `null`: the queue is empty. */
  item: number | null = null
  offsetMs = 0

  clone(): Native {
    return Object.assign(new Native(), this)
  }
  private startOf(index: number) {
    return this.tracks.slice(0, index).reduce((sum, ms) => sum + ms, 0)
  }
  get totalMs() {
    return this.startOf(this.tracks.length)
  }
  get isAtEnd() {
    return this.item === null && this.tracks.length > 0
  }
  get positionMs() {
    return this.isAtEnd ? this.totalMs : this.item === null ? 0 : this.startOf(this.item) + this.offsetMs
  }
  /** A listener hears audio. */
  get isAudible() {
    return this.wantsPlay && this.item !== null
  }
  /** `locate`: past the end of a chapter, it parks 250 ms before that end. */
  private locate(positionMs: number) {
    for (let index = this.tracks.length - 1; index >= 0; index--) {
      if (positionMs >= this.startOf(index)) {
        return { index, offsetMs: Math.min(positionMs - this.startOf(index), Math.max(0, this.tracks[index]! - 250)) }
      }
    }
    return { index: 0, offsetMs: 0 }
  }
  private rebuild(index: number, offsetMs: number) {
    if (index < this.tracks.length) {
      this.item = index
      this.offsetMs = offsetMs
    } else this.item = null
  }
  load(tracks: ReadonlyArray<number>, expectsMore: boolean, positionMs: number, autoplay: boolean) {
    this.episodeId = id
    this.expectsMore = expectsMore
    this.tracks = tracks
    const target = this.locate(positionMs)
    this.rebuild(target.index, target.offsetMs)
    if (autoplay) this.play()
    else {
      this.wantsPlay = false
      this.playAsked = false
    }
  }
  updateTracks(tracks: ReadonlyArray<number>, expectsMore: boolean) {
    if (this.episodeId === null) return
    const jobEnded = this.expectsMore && !expectsMore
    this.expectsMore = expectsMore
    if (tracks.length < this.tracks.length) return
    const oldCount = this.tracks.length
    const playPending = this.wantsPlay && this.item === null
    this.tracks = tracks
    if (tracks.length > oldCount) {
      if (this.item === null) {
        this.rebuild(oldCount, 0)
        if (playPending) this.play()
      }
    } else if (playPending && jobEnded) {
      if (this.playAsked) this.play()
      else this.wantsPlay = false
    }
  }
  play() {
    if (this.episodeId === null) return
    this.wantsPlay = true
    if (this.item === null && this.tracks.length > 0 && !this.expectsMore) this.rebuild(0, 0)
    this.playAsked = this.item === null
  }
  pause() {
    this.wantsPlay = false
    this.playAsked = false
  }
  seek(positionMs: number) {
    if (this.tracks.length === 0) return
    const target = this.locate(positionMs)
    const current = this.item ?? Math.max(0, this.tracks.length - 1)
    if (target.index === current && this.item !== null) this.offsetMs = target.offsetMs
    else this.rebuild(target.index, target.offsetMs)
  }
  skip(deltaMs: number) {
    this.seek(Math.max(0, Math.min(this.totalMs, this.positionMs + deltaMs)))
  }
  unload() {
    Object.assign(this, new Native())
  }
  /** `ms` of time pass: audio moves on, into the next chapter or off the end of the queue. */
  listen(ms: number) {
    if (!this.isAudible || this.item === null) return
    if (this.offsetMs + ms < this.tracks[this.item]!) this.offsetMs += ms
    else this.rebuild(this.item + 1, 0)
    // `endIfOver`: the queue ran out and the job makes no more chapters.
    if (this.isAtEnd && !this.expectsMore) this.wantsPlay = false
  }
  status(): NativeStatus {
    return {
      episodeId: this.episodeId,
      index: this.item ?? Math.max(0, this.tracks.length - 1),
      position: this.positionMs / 1000,
      duration: this.totalMs / 1000,
      playing: this.wantsPlay && !this.isAtEnd,
      wantsPlay: this.wantsPlay,
      buffering: false,
      rate: 1,
      ended: this.isAtEnd,
      error: null,
    }
  }
}

/**
 * A phone: the real `step`, and a native player that runs its calls in order. Each native call says its status
 * after the events of the same turn, as on the device.
 */
class Phone implements Device {
  readonly pausesHeldPlay = false
  private core: Core
  private native: Native
  /** The episode as the library row shows it: the newest list. */
  private listed: Listing
  /** The library requests that are out: the check's number, and the phone's own. */
  private requests: ReadonlyArray<readonly [number, number]> = []
  private queue: Array<{ readonly event: PlayerEvent; readonly before?: () => void }> = []
  private pauses = 0
  private faults: Array<string> = []
  private context: Context = { now: stampAt(0), put: (progress) => progress, answered() {}, started() {}, stamped() {} }

  constructor(from: Phone | { readonly listing: Listing; readonly local: EpisodeProgress | null }) {
    if (from instanceof Phone) {
      this.core = from.core
      this.native = from.native.clone()
      this.listed = from.listed
      this.requests = from.requests
      return
    }
    this.core = initialCore(from.local ? { [id]: from.local } : {})
    this.native = new Native()
    this.listed = from.listing
    // The library of an account: its first request, and the list it brings.
    this.send({ _tag: "RefreshStarted" })
    this.send({ _tag: "RefreshAnswered", request: this.core.requests, episodes: [episodeOf(from.listing)] })
  }

  fork(): Device {
    return new Phone(this)
  }

  get audio(): Audio {
    return { isPlaying: this.native.isAudible, positionMs: this.native.episodeId === null ? null : this.native.positionMs }
  }

  /** `EpisodeRow`: a row plays only when `isPlayable`. */
  startsFromRow(listing: Listing): boolean {
    return listing.chapters > 0 && listing.job !== "Failed"
  }

  refresh(_kind: "Foreground" | "Poll", request: number, context: Context): Observed {
    return this.turn(context, () => {
      this.send({ _tag: "RefreshStarted" })
      this.requests = [...this.requests, [request, this.core.requests]]
    })
  }

  answer(request: number, listing: Listing | null, context: Context): Observed {
    return this.turn(context, () => {
      const own = this.requests.find(([sent]) => sent === request)?.[1]
      if (own === undefined) throw new Error(`the phone has no request ${request}`)
      this.requests = this.requests.filter(([sent]) => sent !== request)
      if (listing !== null) this.listed = listing
      this.send({ _tag: "RefreshAnswered", request: own, episodes: listing === null ? null : [episodeOf(listing)] })
    })
  }

  /** The Play button when the episode is loaded, else its row. */
  play(context: Context): Observed {
    return this.turn(context, () =>
      this.send(this.native.episodeId === id ? { _tag: "Toggle" } : { _tag: "PlayEpisode", episode: episodeOf(this.listed) }),
    )
  }

  pause(_isHeld: boolean, context: Context): Observed {
    return this.turn(context, () => this.send({ _tag: "Toggle" }))
  }

  seek(positionMs: number, context: Context): Observed {
    return this.turn(context, () => this.send({ _tag: "Seek", positionMs }))
  }

  listen(ms: number, context: Context): Observed {
    return this.turn(context, () => {
      this.native.listen(ms)
      this.send({ _tag: "Status", status: this.native.status() })
    })
  }

  private turn(context: Context, act: () => void): Observed {
    this.context = context
    this.pauses = 0
    this.faults = []
    act()
    return { pauses: this.pauses, faults: this.faults }
  }

  /** Runs `step` for `event` and for every event its effects answer with, oldest first. */
  private send(event: PlayerEvent, before?: () => void) {
    this.queue.push(before ? { event, before } : { event })
    if (this.queue.length > 1) return
    for (let next = this.queue[0]; next !== undefined; next = this.queue[0]) {
      next.before?.()
      const result = step(this.core, next.event, this.context.now)
      this.core = result.core
      for (const effect of result.effects) {
        if (effect._tag !== "Push") this.call(effect)
        else {
          // A `PUT` with the stamp of this turn is a stamp the phone made now.
          if (effect.entry.updatedAt === this.context.now) this.context.stamped(effect.entry.positionMs)
          const stored = this.context.put(effect.entry)
          this.send({ _tag: "PushAnswered", episodeId: effect.episodeId, sent: effect.entry, stored }, () => this.context.answered(stored))
        }
      }
      this.queue.shift()
    }
  }

  /** One native call, and what a listener hears of it. Its status reaches the phone after this turn's events. */
  private call(call: NativeCall) {
    const { native } = this
    const wasAudible = native.isAudible
    const wasAt = native.positionMs
    const tracks = (episode: Episode) => episode.chapters.map((chapter) => chapter.durationMs)
    const expectsMore = (episode: Episode) => episode.job._tag === "Queued" || episode.job._tag === "Running"
    switch (call._tag) {
      case "Load":
        native.load(tracks(call.episode), expectsMore(call.episode), call.positionMs, call.autoplay)
        break
      case "UpdateTracks":
        native.updateTracks(tracks(call.episode), expectsMore(call.episode))
        break
      case "Seek":
        native.seek(call.positionMs)
        break
      case "Skip":
        native.skip(call.deltaMs)
        break
      case "Play":
        native.play()
        break
      case "Pause":
        native.pause()
        break
      case "Unload":
        native.unload()
        break
    }
    // I5: a Play acts on the track list and the job of the newest list.
    if (call._tag === "Play" || (call._tag === "Load" && call.autoplay)) {
      const isNewest = native.tracks.length >= this.listed.chapters && native.expectsMore === (this.listed.job === "Running")
      if (!isNewest) {
        this.faults.push(
          `native ${call._tag} before the newest track list: it has ${native.tracks.length} chapters, expectsMore ${native.expectsMore}`,
        )
      }
    }
    if (native.isAudible && (!wasAudible || native.positionMs !== wasAt)) this.context.started(native.positionMs)
    if (wasAudible && !native.isAudible) this.pauses += 1
    this.send({ _tag: "Status", status: native.status() })
  }
}

/** The entry the phone and the server start with. */
const old: EpisodeProgress = { positionMs: 10_000, updatedAt: stampAt(-60_000) }

const steps = {
  play: { _tag: "Play" },
  pause: { _tag: "Pause" },
  listen: { _tag: "Listen" },
} as const satisfies Record<string, Step>

/** A world after `prefix`: the phone holds `old`, and its library loaded once. */
const seed = (server: Omit<Listing, "progress">, prefix: ReadonlyArray<Step>): World => {
  const listing = { ...server, progress: old }
  const started = run(startWorld(new Phone({ listing, local: old }), listing), prefix)
  if (started.broken.length > 0) throw new Error(`The seed breaks an invariant: ${started.broken.join("; ")}`)
  return started.world
}

/**
 * The other device is at 40 s, in chapter 2. The phone took that entry with a list from before chapter 2: its
 * player rests at the end of chapter 1.
 */
const seedAhead = (prefix: ReadonlyArray<Step>): World => {
  const ahead = { positionMs: 40_000, updatedAt: stampAt(-30_000) }
  const listed: Listing = { chapters: 1, job: "Running", progress: ahead }
  const started = run(startWorld(new Phone({ listing: listed, local: old }), { ...listed, chapters: 2 }, listed), prefix)
  if (started.broken.length > 0) throw new Error(`The seed breaks an invariant: ${started.broken.join("; ")}`)
  return started.world
}

const waiting = [steps.play, steps.listen, steps.listen, steps.listen, steps.listen]

const SEEDS: ReadonlyArray<readonly [string, () => World]> = [
  ["ready, in the library", () => seed({ chapters: 2, job: "Ready" }, [])],
  ["ready, paused at 10 s", () => seed({ chapters: 2, job: "Ready" }, [steps.play, steps.pause])],
  ["growing, in the library", () => seed({ chapters: 1, job: "Running" }, [])],
  ["growing, paused at 10 s", () => seed({ chapters: 1, job: "Running" }, [steps.play, steps.pause])],
  ["growing, waiting at the end of chapter 1", () => seed({ chapters: 1, job: "Running" }, waiting)],
  ["growing, a wait the listener paused", () => seed({ chapters: 1, job: "Running" }, [...waiting, steps.pause])],
  ["encoding, playing at 10 s", () => seed({ chapters: 2, job: "Running" }, [steps.play])],
  ["growing, the entry is ahead of the list", () => seedAhead([steps.play, steps.pause])],
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
  test("2: a Play held at the end of the queue is released when the job is Ready", () => {
    // The base gave the native player `play`, then `updateTracks`: the queue stayed empty, and the Play was silent.
    const paused = seed({ chapters: 1, job: "Running" }, [...waiting, steps.pause])
    expect(paused.audio).toEqual({ isPlaying: false, positionMs: 26_825 })
    const result = run(paused, [
      { _tag: "Foreground" },
      steps.play,
      { _tag: "JobReady" },
      { _tag: "Answer", request: 1, brings: "ListNow" },
    ])
    process.stdout.write(`finding 2: ${result.broken.join("; ") || "holds"}\n`)
    expect(result.broken).toEqual([])
    // The episode is finished now, so the Play starts at the top.
    expect(result.world.audio).toEqual({ isPlaying: true, positionMs: 0 })
  })
})
