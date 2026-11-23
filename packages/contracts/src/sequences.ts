/**
 * The sequence check of progress sync. It is test support: the web app and the phone app run it in their tests.
 *
 * The model is one episode, the server, another device, and the device under test (a web tab or a phone). A sequence
 * is a list of `Step`s: library requests go out and answer in any order, the other device saves, the job makes a
 * chapter or ends, and the listener plays, pauses, seeks and listens. `explore` walks every sequence up to a depth
 * and checks the invariants after each step. It knows nothing of how a device decides: it sees only what a listener
 * and the server see (`Observed`).
 *
 * - I1 A stamp is never older in position than a newer server entry the device had when that listening started,
 *      unless the listener sought. An entry that arrives while the audio plays does not move the audio.
 * - I2 The audio plays exactly when the listener asked for it: Play last, and the Play is not held and does not wait
 *      for a chapter. Only a Pause stops audio that plays, or a seek to the end of the audio.
 * - I3 A held Play starts when the `awaitedAfter` rule says so, and not before.
 * - I4 Audio starts at 0 only when `playStart` says so for the newest entry the device has, or when it has none.
 * - I5 The device reports its own faults: the phone reports a native play before the newest track list.
 */
import { type EpisodeProgress, type JobState, awaitedAfter, isNewerProgress, playStart } from "./index.ts"

/** The chapters the job makes, in order. */
export const CHAPTER_MS: ReadonlyArray<number> = [26_825, 19_700]

/** How much audio one `Listen` step plays. It is also how often a device saves while it plays. */
export const LISTEN_MS = 5_000

export type Job = "Running" | "Ready" | "Failed"

/** The episode as the server holds it, and as one library answer lists it. */
export interface Listing {
  /** How many of `CHAPTER_MS` are made. */
  readonly chapters: number
  readonly job: Job
  readonly progress: EpisodeProgress | null
}

export const chaptersOf = (listing: Listing): ReadonlyArray<{ readonly durationMs: number }> =>
  CHAPTER_MS.slice(0, listing.chapters).map((durationMs) => ({ durationMs }))

export const totalMs = (listing: Listing): number => chaptersOf(listing).reduce((sum, chapter) => sum + chapter.durationMs, 0)

const jobOf = (listing: Listing): { readonly _tag: JobState["_tag"] } => ({ _tag: listing.job })

export type Step =
  | { readonly _tag: "Foreground" }
  | { readonly _tag: "Poll" }
  | { readonly _tag: "Answer"; readonly request: number; readonly brings: "ListAtSend" | "ListNow" | "Failure" }
  | { readonly _tag: "OtherDeviceSaves"; readonly positionMs: number }
  | { readonly _tag: "ChapterMade" }
  | { readonly _tag: "JobReady" }
  | { readonly _tag: "JobFailed" }
  | { readonly _tag: "Play" }
  | { readonly _tag: "Pause" }
  | { readonly _tag: "Seek"; readonly positionMs: number }
  | { readonly _tag: "Listen" }

export const describeStep = (step: Step): string => {
  switch (step._tag) {
    case "Answer":
      return `Answer(${step.request}, ${step.brings})`
    case "OtherDeviceSaves":
    case "Seek":
      return `${step._tag}(${step.positionMs})`
    default:
      return step._tag
  }
}

/**
 * What a device gets with each step: the time, the server for its `PUT`s, and where it tells the check what a
 * listener and the server see of it, at the moment it happens.
 */
export interface Context {
  /** The device clock, ISO 8601. */
  readonly now: string
  /** `PUT /api/episodes/:id/progress`: the server keeps the newer entry and answers with what it stores. */
  put(progress: EpisodeProgress): EpisodeProgress
  /** The answer of a `PUT` reaches the device now. */
  answered(stored: EpisodeProgress): void
  /** Audio starts now, at `positionMs` of the episode. */
  started(positionMs: number): void
  /** The device stamps `positionMs` now, with a new `updatedAt` of its own. */
  stamped(positionMs: number): void
}

/** What the audio of a device does, as a listener hears it. */
export interface Audio {
  readonly isPlaying: boolean
  /** On the whole episode timeline. `null`: no episode is loaded. */
  readonly positionMs: number | null
}

/** What one step did on a device, beside what it told the `Context`. */
export interface Observed {
  /** How often audio that played was stopped, and not because its file ended. */
  readonly pauses: number
  /** Faults the device sees in its own calls. */
  readonly faults: ReadonlyArray<string>
}

/** A device under test: a web tab or a phone, with the episode in its library. */
export interface Device {
  /** A copy that shares no state, so the search can branch. */
  fork(): Device
  readonly audio: Audio
  /** Whether a Play from the library row starts this episode. */
  startsFromRow(listing: Listing): boolean
  /** Whether the listener can take a held Play back with a Pause. The web has the Pause key; the phone has none. */
  readonly pausesHeldPlay: boolean
  /** A library request goes out. `request` names it for `answer`. */
  refresh(kind: "Foreground" | "Poll", request: number, context: Context): Observed
  /** Library request `request` answers: with a list, or `null` for a failure. */
  answer(request: number, listing: Listing | null, context: Context): Observed
  play(context: Context): Observed
  /** `isHeld`: the Play waits for the library, so the listener takes it back with the Pause key. */
  pause(isHeld: boolean, context: Context): Observed
  seek(positionMs: number, context: Context): Observed
  /** `ms` of time pass. Audio that plays moves on. */
  listen(ms: number, context: Context): Observed
}

/** The model at one point of a sequence: the server, the device, and what the check remembers. */
export interface World {
  readonly clock: number
  readonly server: Listing
  readonly outstanding: ReadonlyArray<{ readonly request: number; readonly atSend: Listing }>
  readonly requests: number
  /** The episode as the last list the device took has it. */
  readonly listed: Listing
  readonly device: Device
  readonly audio: Audio
  /** The newest entry the device has: its own stamps, and what the server sent it. */
  readonly known: EpisodeProgress | null
  /**
   * A server entry the device got while its audio did not play: the next listening starts there, at `startMs` once
   * audio started. `null` after a stamp that respects it, and after a seek.
   */
  readonly owed: { readonly entry: EpisodeProgress; readonly startMs: number | null } | null
  /** Play was the listener's last ask. */
  readonly wantsPlay: boolean
  /** The requests a held Play waits for. */
  readonly hold: ReadonlyArray<number> | null
  /** The Play acted in an earlier step. */
  readonly isOn: boolean
  readonly otherSaves: number
  readonly seeks: number
}

const EPOCH = Date.parse("2026-11-23T10:00:00.000Z")

/** The stamp of the model's clock. Every step moves the clock, so two stamps never tie. */
export const stampAt = (clock: number): string => new Date(EPOCH + clock).toISOString()

/** A world before any step: the device has the server's list. */
export const startWorld = (device: Device, server: Listing): World => ({
  clock: 0,
  server,
  outstanding: [],
  requests: 0,
  listed: server,
  device,
  audio: device.audio,
  known: server.progress,
  owed: null,
  wantsPlay: false,
  hold: null,
  isOn: false,
  otherSaves: 0,
  seeks: 0,
})

/** How far a search goes beside its depth. */
export interface Limits {
  /** Library requests out at once. */
  readonly requests: number
  /** Saves of the other device in one sequence. */
  readonly otherSaves: number
  /** Seeks of the listener in one sequence. */
  readonly seeks: number
}

export const LIMITS: Limits = { requests: 2, otherSaves: 1, seeks: 1 }

/** Where the other device saves: the start of the seeds, the chapter boundary, inside chapter 2, the end. */
const OTHER_DEVICE_MS: ReadonlyArray<number> = [10_000, 26_825, 40_000, 46_525]
const SEEK_MS: ReadonlyArray<number> = [15_000, 30_000]

const isSameListing = (a: Listing, b: Listing): boolean =>
  a.chapters === b.chapters &&
  a.job === b.job &&
  a.progress?.positionMs === b.progress?.positionMs &&
  a.progress?.updatedAt === b.progress?.updatedAt

/** The steps that can come next. */
export const enabled = (world: World, limits: Limits = LIMITS): ReadonlyArray<Step> => {
  const steps: Array<Step> = []
  // A device sends the same request for both. So the first request out is the foreground one, and a poll joins it.
  if (world.outstanding.length < limits.requests) steps.push({ _tag: world.outstanding.length === 0 ? "Foreground" : "Poll" })
  for (const { request, atSend } of world.outstanding) {
    steps.push({ _tag: "Answer", request, brings: "ListAtSend" })
    if (!isSameListing(atSend, world.server)) steps.push({ _tag: "Answer", request, brings: "ListNow" })
    steps.push({ _tag: "Answer", request, brings: "Failure" })
  }
  if (world.otherSaves < limits.otherSaves) {
    for (const positionMs of OTHER_DEVICE_MS) {
      if (positionMs <= totalMs(world.server)) steps.push({ _tag: "OtherDeviceSaves", positionMs })
    }
  }
  if (world.server.job === "Running") {
    if (world.server.chapters < CHAPTER_MS.length) steps.push({ _tag: "ChapterMade" })
    steps.push({ _tag: "JobReady" }, { _tag: "JobFailed" })
  }
  const isLoaded = world.audio.positionMs !== null
  if ((!world.wantsPlay || world.hold !== null) && (isLoaded || world.hold !== null || world.device.startsFromRow(world.listed))) {
    steps.push({ _tag: "Play" })
  }
  if (world.wantsPlay && (world.hold === null || world.device.pausesHeldPlay)) steps.push({ _tag: "Pause" })
  if (isLoaded && world.seeks < limits.seeks) for (const positionMs of SEEK_MS) steps.push({ _tag: "Seek", positionMs })
  if (world.audio.isPlaying) steps.push({ _tag: "Listen" })
  return steps
}

const NOTHING: Observed = { pauses: 0, faults: [] }

/** One step: the next world, and each invariant the step broke. */
export const apply = (world: World, step: Step): { readonly world: World; readonly broken: ReadonlyArray<string> } => {
  const before = world.audio
  const wasOn = world.isOn
  const clock = world.clock + (step._tag === "Listen" ? LISTEN_MS : 1_000)
  const device = world.device.fork()
  let { server, outstanding, requests, listed, known, owed, wantsPlay, hold, otherSaves, seeks } = world
  let isActing = false
  const broken: Array<string> = []
  const canEnd = step._tag === "Listen" || step._tag === "Answer" || step._tag === "Seek"

  const isAtEnd = (audio: Audio) => audio.positionMs !== null && audio.positionMs >= totalMs(listed) - 1
  /**
   * A Play that was on is over when its audio rests at the end and the job ended: the episode played to its end, or
   * the job ended with no audio after the place the Play waited at.
   */
  const endPlay = (audio: Audio) => {
    if (wantsPlay && hold === null && wasOn && canEnd && !audio.isPlaying && isAtEnd(audio) && listed.job !== "Running") {
      wantsPlay = false
    }
  }
  /** The device gets a server entry. A newer one is where its next listening starts, unless its audio plays now. */
  const receive = (entry: EpisodeProgress | null, isPlaying: boolean) => {
    if (entry === null || (known !== null && !isNewerProgress(entry, known))) return
    known = entry
    if (!isPlaying) owed = { entry, startMs: null }
  }
  const context: Context = {
    now: stampAt(clock),
    put: (progress) => {
      if (known === null || isNewerProgress(progress, known)) known = progress
      if (server.progress === null || isNewerProgress(progress, server.progress)) server = { ...server, progress }
      return server.progress ?? progress
    },
    answered: (stored) => {
      // A Play that ended before this answer is over: the entry then moves a player that rests.
      endPlay(device.audio)
      receive(stored, device.audio.isPlaying)
    },
    started: (startMs) => {
      // I4
      const isRuled = known === null || playStart(known.positionMs, chaptersOf(listed), jobOf(listed)).positionMs < 1
      const wasThere = before.positionMs !== null && before.positionMs < 1
      if (startMs < 1 && !isRuled && !wasThere && step._tag !== "Seek") {
        broken.push(`I4 audio started at 0 with an entry at ${known?.positionMs}`)
      }
      if (owed !== null && owed.startMs === null) {
        owed = { ...owed, startMs: playStart(owed.entry.positionMs, chaptersOf(listed), jobOf(listed)).positionMs }
      }
    },
    stamped: (positionMs) => {
      // I1
      if (owed !== null) {
        const floorMs = owed.startMs ?? owed.entry.positionMs
        if (positionMs < floorMs - 1) {
          broken.push(`I1 stamped ${positionMs} over the newer entry at ${owed.entry.positionMs}, which starts at ${floorMs}`)
        }
        owed = null
      }
      known = { positionMs, updatedAt: stampAt(clock) }
    },
  }

  let observed = NOTHING
  switch (step._tag) {
    case "Foreground":
    case "Poll": {
      requests += 1
      outstanding = [...outstanding, { request: requests, atSend: server }]
      observed = device.refresh(step._tag, requests, context)
      break
    }
    case "Answer": {
      const sent = outstanding.find((item) => item.request === step.request)
      if (!sent) throw new Error(`No request ${step.request} is out`)
      outstanding = outstanding.filter((item) => item.request !== step.request)
      const listing = step.brings === "Failure" ? null : step.brings === "ListAtSend" ? sent.atSend : server
      if (listing !== null) {
        listed = listing
        receive(listing.progress, before.isPlaying)
      }
      if (hold !== null) {
        const still = awaitedAfter(hold, step.request, listing !== null)
        hold = still.length > 0 ? still : null
        isActing = hold === null
      }
      observed = device.answer(step.request, listing, context)
      break
    }
    case "OtherDeviceSaves":
      server = { ...server, progress: { positionMs: step.positionMs, updatedAt: context.now } }
      otherSaves += 1
      break
    case "ChapterMade":
      server = { ...server, chapters: server.chapters + 1 }
      break
    case "JobReady":
      server = { ...server, job: "Ready" }
      break
    case "JobFailed":
      server = { ...server, job: "Failed" }
      break
    case "Play": {
      // A second Play does not wait again. A first one waits for the requests that are out.
      if (hold === null && outstanding.length > 0) hold = outstanding.map((item) => item.request)
      else {
        hold = null
        isActing = true
      }
      wantsPlay = true
      observed = device.play(context)
      break
    }
    case "Pause": {
      const isHeld = hold !== null
      hold = null
      wantsPlay = false
      observed = device.pause(isHeld, context)
      break
    }
    case "Seek": {
      // A seek takes a held Play back. The listener chose the place, so no entry is owed.
      if (hold !== null) {
        hold = null
        wantsPlay = false
      }
      owed = null
      seeks += 1
      observed = device.seek(step.positionMs, context)
      break
    }
    case "Listen":
      observed = device.listen(LISTEN_MS, context)
      break
  }

  const audio = device.audio
  for (const fault of observed.faults) broken.push(`I5 ${fault}`)

  // I2 and I3
  // A seek to the end of the audio stops it too: the check below says whether it may rest there.
  if (observed.pauses > 0 && step._tag !== "Pause" && step._tag !== "Seek") broken.push(`I2 audio that played stopped without a Pause`)
  endPlay(audio)
  let isOn = false
  if (!wantsPlay || hold !== null) {
    if (audio.isPlaying) broken.push(hold !== null ? `I3 the held Play started before its requests answered` : `I2 audio plays after a Pause`)
  } else if (audio.isPlaying || (isAtEnd(audio) && listed.job === "Running")) {
    // The audio plays, or the Play waits for the next chapter.
    isOn = true
  } else {
    const where = audio.positionMs === null ? "nothing loaded" : `paused at ${Math.round(audio.positionMs)}`
    broken.push(
      isActing && step._tag === "Answer"
        ? `I3 the held Play did not start when its requests answered: ${where}`
        : `I2 Play was the last ask, and no audio plays: ${where}`,
    )
  }

  return {
    world: { clock, server, outstanding, requests, listed, device, audio, known, owed, wantsPlay, hold, isOn, otherSaves, seeks },
    broken,
  }
}

/** Applies `steps` in order. Stops at the first step that breaks an invariant. */
export const run = (
  world: World,
  steps: ReadonlyArray<Step>,
): { readonly world: World; readonly broken: ReadonlyArray<string>; readonly path: ReadonlyArray<Step> } => {
  let current = world
  const path: Array<Step> = []
  for (const step of steps) {
    const next = apply(current, step)
    path.push(step)
    if (next.broken.length > 0) return { world: next.world, broken: next.broken, path }
    current = next.world
  }
  return { world: current, broken: [], path }
}

/** A sequence that breaks an invariant, with the steps from the seed on. */
export interface Counterexample {
  readonly seed: string
  readonly path: ReadonlyArray<Step>
  readonly broken: ReadonlyArray<string>
}

export interface Report {
  /** Sequences walked to the depth, or to the step that broke an invariant. */
  readonly sequences: number
  /** Steps applied. */
  readonly steps: number
  /** How many sequences broke each invariant (`I1` to `I5`). */
  readonly counts: Readonly<Record<string, number>>
  /** The shortest sequence found for each invariant. */
  readonly shortest: Readonly<Record<string, Counterexample>>
}

/**
 * Walks every sequence of at most `depth` steps from `world`. A sequence that breaks an invariant ends there: what
 * follows a broken state proves nothing.
 */
export const explore = (seed: string, world: World, depth: number, limits: Limits = LIMITS): Report => {
  let sequences = 0
  let steps = 0
  const counts: Record<string, number> = {}
  const shortest: Record<string, Counterexample> = {}
  const walk = (current: World, path: ReadonlyArray<Step>) => {
    const next = enabled(current, limits)
    if (path.length >= depth || next.length === 0) {
      sequences += 1
      return
    }
    for (const step of next) {
      const result = apply(current, step)
      steps += 1
      const here = [...path, step]
      if (result.broken.length > 0) {
        sequences += 1
        for (const invariant of new Set(result.broken.map((line) => line.slice(0, 2)))) {
          counts[invariant] = (counts[invariant] ?? 0) + 1
          const known = shortest[invariant]
          if (!known || here.length < known.path.length) shortest[invariant] = { seed, path: here, broken: result.broken }
        }
        continue
      }
      walk(result.world, here)
    }
  }
  walk(world, [])
  return { sequences, steps, counts, shortest }
}

/** Reports of several seeds as one. */
export const mergeReports = (reports: ReadonlyArray<Report>): Report => {
  const counts: Record<string, number> = {}
  const shortest: Record<string, Counterexample> = {}
  for (const report of reports) {
    for (const [invariant, count] of Object.entries(report.counts)) counts[invariant] = (counts[invariant] ?? 0) + count
    for (const [invariant, example] of Object.entries(report.shortest)) {
      const known = shortest[invariant]
      if (!known || example.path.length < known.path.length) shortest[invariant] = example
    }
  }
  return {
    sequences: reports.reduce((sum, report) => sum + report.sequences, 0),
    steps: reports.reduce((sum, report) => sum + report.steps, 0),
    counts,
    shortest,
  }
}

export const describeCounterexample = (example: Counterexample): string =>
  `${example.seed}: ${example.path.map(describeStep).join(", ")} => ${example.broken.join("; ")}`
