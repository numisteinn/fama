// The player of the phone app, as one pure state machine. It is free of React Native, so it runs under vitest.
//
// Playback and progress sync have one shape, the same as on the web. The `Core` holds intent (what the listener
// asked for) and facts (the library, the device's progress, what the native player said and was told). `handle`
// changes only intent and facts. `plan` alone works out what the native player must do, and gives the native calls
// in order: the track list first, then the place, then Play or Pause. `player.ts` only runs them. So no order of
// events can make two steps move, start or stamp against each other, and a Play never reaches the native player
// before the track list and the job of the newest library list.
import { type Episode, type EpisodeProgress, awaitedAfter, playStart } from "@fama/contracts"
import { isActive } from "../lib/format"
import type { NativeStatus } from "./native"
import { remapReplacedPosition } from "./remapPosition"
import { IDLE_TRACKER, type Tracker, isSameProgress, planSync, restMs, startMs, takesAnswer, track } from "./progressRules"

export const IDLE_STATUS: NativeStatus = {
  episodeId: null,
  index: 0,
  position: 0,
  duration: 0,
  playing: false,
  buffering: false,
  rate: 1,
  ended: false,
  error: null,
}

/** What the native player was told of an episode: its chapter URLs, durations, and whether the job makes more chapters. */
export interface Told {
  readonly episodeId: string
  readonly urls: ReadonlyArray<string>
  readonly durations: ReadonlyArray<number>
  readonly expectsMore: boolean
}

export interface Core {
  // Intent
  /** The episode the listener plays or paused: the native player has it, or `plan` loads it. */
  readonly episodeId: string | null
  /** A Play or a Pause the listener asked for. `plan` gives it to the native player, once. */
  readonly ask: "Play" | "Pause" | null
  /** A move the listener asked for. `plan` gives it to the native player, once. */
  readonly move: { readonly _tag: "Seek"; readonly positionMs: number } | { readonly _tag: "Skip"; readonly deltaMs: number } | null
  /**
   * A Play that waits for library requests, by number. It acts by the `awaitedAfter` rule of the contract, so it
   * starts from the newer of the phone's and the server's position, and not from one another device moved on from.
   */
  readonly held: { readonly episodeId: string; readonly awaiting: ReadonlyArray<number> } | null
  /**
   * Play was the last ask, as far as the phone knows. The native player holds the truth (the lock screen can pause
   * it), and its status corrects this, including while a Play waits for the next chapter.
   */
  readonly wantsPlay: boolean
  /** Ignore earlier native Play statuses until the native player confirms a Pause sent by JS. */
  readonly awaitingPause: boolean

  // Facts
  /** Counts library requests. `inFlight` holds the numbers of those sent and not answered. */
  readonly requests: number
  readonly inFlight: ReadonlyArray<number>
  /** The newest list of the library. */
  readonly library: ReadonlyArray<Episode>
  /** The device's progress, one entry for each episode. */
  readonly entries: Readonly<Record<string, EpisodeProgress>>
  /** What the native player said last. */
  readonly status: NativeStatus
  /** What the native player was told. `null`: it has no episode. */
  readonly told: Told | null
  /**
   * The `updatedAt` of the device's entry that the native player's place already follows. An entry with another
   * stamp is news from another device: a player whose audio does not play moves there.
   */
  readonly followedAt: string | null
  /** The save rule's memory between native statuses. */
  readonly tracker: Tracker
  /**
   * `plan` sent the native player to this place, and its status has not said so yet. Until it does, a status is
   * from before the move: it is not the listener's, and stamps nothing.
   */
  readonly landingMs: number | null
  /**
   * The player rests short of its entry, which is at this position: the other device has audio that this phone's
   * list does not have yet. Nothing here is the listener's progress, so nothing is stamped, and the player moves on
   * to the entry when a later list has that audio.
   */
  readonly shortOfMs: number | null
}

export const initialCore = (entries: Readonly<Record<string, EpisodeProgress>>): Core => ({
  episodeId: null,
  ask: null,
  move: null,
  held: null,
  wantsPlay: false,
  awaitingPause: false,
  requests: 0,
  inFlight: [],
  library: [],
  entries,
  status: IDLE_STATUS,
  told: null,
  followedAt: null,
  tracker: IDLE_TRACKER,
  landingMs: null,
  shortOfMs: null,
})

export type PlayerEvent =
  /** A list that no request brought: the cache an account starts with, or a change made on this phone. */
  | { readonly _tag: "Listed"; readonly episodes: ReadonlyArray<Episode> }
  /** A library request goes out. Its number is `requests` of the next `Core`. */
  | { readonly _tag: "RefreshStarted" }
  /** Library request `request` answered: with the list the library took, or `null` for none. */
  | { readonly _tag: "RefreshAnswered"; readonly request: number; readonly episodes: ReadonlyArray<Episode> | null }
  /** The listener plays an episode from its row. */
  | { readonly _tag: "PlayEpisode"; readonly episode: Episode }
  /** After launch: the last episode loads, paused. */
  | { readonly _tag: "Restore"; readonly episodeId: string }
  /** The Play or Pause button. */
  | { readonly _tag: "Toggle" }
  | { readonly _tag: "Seek"; readonly positionMs: number; readonly play?: boolean }
  | { readonly _tag: "Skip"; readonly deltaMs: number }
  /** The listener deleted an episode. */
  | { readonly _tag: "Forget"; readonly episodeId: string }
  | { readonly _tag: "Status"; readonly status: NativeStatus }
  /** The app goes to the background. */
  | { readonly _tag: "Background" }
  /** The server answered a `PUT` of `sent` with what it stores. */
  | { readonly _tag: "PushAnswered"; readonly episodeId: string; readonly sent: EpisodeProgress; readonly stored: EpisodeProgress }

/** One call of the native player. `player.ts` makes the tracks of an episode from its chapters. */
export type NativeCall =
  | { readonly _tag: "Load"; readonly episode: Episode; readonly positionMs: number; readonly autoplay: boolean }
  | { readonly _tag: "UpdateTracks"; readonly episode: Episode }
  | { readonly _tag: "Seek"; readonly positionMs: number }
  | { readonly _tag: "Skip"; readonly deltaMs: number }
  | { readonly _tag: "Play" }
  | { readonly _tag: "Pause" }
  | { readonly _tag: "Unload" }

/** What `player.ts` does for one event, in this order. */
export type PlayerEffect = NativeCall | { readonly _tag: "Push"; readonly episodeId: string; readonly entry: EpisodeProgress }

type Outcome = { readonly core: Core; readonly effects: ReadonlyArray<PlayerEffect> }

const listed = (core: Core, episodeId: string | null): Episode | undefined =>
  core.library.find((episode) => episode.id === episodeId)

const lengthMs = (episode: Episode): number => episode.chapters.reduce((sum, chapter) => sum + chapter.durationMs, 0)

const positionMs = (status: NativeStatus): number => Math.round(status.position * 1000)

/**
 * The native player parks this far before the end of a chapter when it is sent to that end or past it (`locate` in
 * `EpisodePlayer.swift`), so that its queue is not empty.
 */
const PARK_MS = 250

/** A Play is on at the end of the native queue: it waits for the next chapter of a job that still works. */
export const isWaitingForChapter = (core: Core): boolean => {
  const episode = listed(core, core.status.episodeId)
  return core.wantsPlay && core.status.ended && episode !== undefined && isActive(episode.job)
}

// FACTS AND INTENT

/**
 * A listener's action left `episodeId` at `ms`: the entry gets the device clock, and goes to the server. A position
 * the device already holds is not stamped again.
 */
const stamp = (core: Core, episodeId: string, ms: number, now: string): Outcome => {
  const rounded = Math.max(0, Math.round(ms))
  const held = core.entries[episodeId]
  if (held?.positionMs === rounded) return { core, effects: [] }
  if (episodeId === core.told?.episodeId) {
    // A player that rests short of a newer entry has nothing of its own to stamp.
    if (core.shortOfMs !== null) return { core, effects: [] }
    // A player sent to its entry at the end of a chapter parks just before it. That is not a move of the listener.
    const behindMs = held && held.updatedAt === core.followedAt ? held.positionMs - rounded : 0
    if (behindMs > 0 && behindMs <= PARK_MS) return { core, effects: [] }
  }
  const entry = { positionMs: rounded, updatedAt: now }
  return {
    core: {
      ...core,
      entries: { ...core.entries, [episodeId]: entry },
      followedAt: episodeId === core.told?.episodeId ? now : core.followedAt,
    },
    effects: [{ _tag: "Push", episodeId, entry }],
  }
}

/** Stamps where the loaded episode is now, when the listener moved it since the last save. */
const saveNow = (core: Core, now: string): Outcome => {
  const { status, tracker } = core
  const ms = positionMs(status)
  if (!status.episodeId || status.episodeId !== tracker.episodeId || ms === tracker.savedMs || core.landingMs !== null) {
    return { core, effects: [] }
  }
  return stamp({ ...core, tracker: { ...tracker, savedMs: ms } }, status.episodeId, ms, now)
}

// At the end of a growing queue, only native intent distinguishes a wait from a Pause.
const stillWantsPlay = (core: Core, status: NativeStatus, episode: Episode | undefined): boolean =>
  !core.awaitingPause && status.episodeId !== null &&
  (status.playing || (status.ended && (status.wantsPlay ?? core.wantsPlay) && (episode === undefined || isActive(episode.job))))

/** The native player said where it is. The save rule (`track`) says whether that is the listener's progress. */
const takeStatus = (core: Core, status: NativeStatus, now: string): Outcome => {
  const ms = positionMs(status)
  const episode = listed(core, status.episodeId)
  const awaitingPause = core.awaitingPause &&
    !(status.episodeId === core.told?.episodeId && !status.playing && status.wantsPlay !== true)
  const wantsPlay = stillWantsPlay(core, status, episode)
  const next = { ...core, status, wantsPlay, awaitingPause }
  if (core.landingMs !== null && status.episodeId === core.tracker.episodeId) {
    // `plan` moved the native player. A status that still has the old place is from before the move.
    const isLanded = Math.abs(ms - core.landingMs) < 1_000 || ms !== positionMs(core.status)
    return isLanded
      ? {
          core: { ...next, landingMs: null, tracker: { ...core.tracker, savedMs: ms, playing: status.playing, ended: status.ended } },
          effects: [],
        }
      : { core: next, effects: [] }
  }
  const step = track(core.tracker, { episodeId: status.episodeId, positionMs: ms, playing: status.playing, ended: status.ended })
  const tracked = { ...next, tracker: step.tracker, landingMs: null }
  return step.isSaved && status.episodeId ? stamp(tracked, status.episodeId, step.tracker.savedMs, now) : { core: tracked, effects: [] }
}

/**
 * A library list merges with the device's entries (`planSync`): each newer server entry is taken with its stamp,
 * and each local entry the server does not have goes out. Nothing gets a new stamp.
 */
const mergeProgress = (core: Core, episodes: ReadonlyArray<Episode>): Outcome => {
  const sync = planSync(core.entries, episodes)
  return {
    core: sync.adopt.length === 0 ? core : { ...core, entries: { ...core.entries, ...Object.fromEntries(sync.adopt) } },
    effects: sync.push.map(([episodeId, entry]) => ({ _tag: "Push", episodeId, entry })),
  }
}

/** A Play acts: the listener listens to `episodeId`, and `plan` gives the Play to the native player. */
const actPlay = (core: Core, episodeId: string): Core =>
  listed(core, episodeId) === undefined && core.told?.episodeId !== episodeId
    ? // The library no longer lists it: nothing plays.
      { ...core, held: null }
    : { ...core, held: null, episodeId, ask: "Play" }

/**
 * The listener asks for playback of `episodeId`. While library requests are in flight, the Play waits for them. A
 * second Play of the same episode does not wait again, so a slow request never leaves Play dead.
 */
const askPlay = (core: Core, episodeId: string): Core =>
  core.inFlight.length > 0 && core.held?.episodeId !== episodeId
    ? { ...core, held: { episodeId, awaiting: core.inFlight } }
    : actPlay(core, episodeId)

const refreshAnswered = (core: Core, event: Extract<PlayerEvent, { _tag: "RefreshAnswered" }>): Outcome => {
  const answered = { ...core, inFlight: core.inFlight.filter((sent) => sent !== event.request) }
  const merged =
    event.episodes === null
      ? { core: answered, effects: [] }
      : mergeProgress({ ...answered, library: event.episodes }, event.episodes)
  const { held } = merged.core
  if (held === null) return merged
  const awaiting = awaitedAfter(held.awaiting, event.request, event.episodes !== null)
  return {
    core: awaiting.length > 0 ? { ...merged.core, held: { ...held, awaiting } } : actPlay(merged.core, held.episodeId),
    effects: merged.effects,
  }
}

const pushAnswered = (core: Core, event: Extract<PlayerEvent, { _tag: "PushAnswered" }>): Outcome => {
  // A clamped stamp included, so a fast device clock does not win every later write.
  if (!takesAnswer(core.entries[event.episodeId], event.sent) || isSameProgress(event.stored, event.sent)) {
    return { core, effects: [] }
  }
  // The same position with the server's stamp is still the listener's own entry. Another one is news.
  const isOwn = event.stored.positionMs === event.sent.positionMs && core.followedAt === event.sent.updatedAt
  return {
    core: {
      ...core,
      entries: { ...core.entries, [event.episodeId]: event.stored },
      followedAt: isOwn ? event.stored.updatedAt : core.followedAt,
    },
    effects: [],
  }
}

/** Changes intent and facts for `event`. It makes no native call. */
const handle = (core: Core, event: PlayerEvent, now: string): Outcome => {
  switch (event._tag) {
    case "Listed":
      return { core: { ...core, library: event.episodes }, effects: [] }
    case "RefreshStarted": {
      const request = core.requests + 1
      return { core: { ...core, requests: request, inFlight: [...core.inFlight, request] }, effects: [] }
    }
    case "RefreshAnswered":
      return refreshAnswered(core, event)
    case "PlayEpisode": {
      // The row the listener tapped lists the episode. The library's own entry of it is newer, when it has one.
      const known = listed(core, event.episode.id) ? core : { ...core, library: [...core.library, event.episode] }
      return { core: askPlay(known, event.episode.id), effects: [] }
    }
    case "Restore":
      return { core: core.episodeId === null ? { ...core, episodeId: event.episodeId } : core, effects: [] }
    case "Toggle": {
      const loaded = core.status.episodeId ?? core.told?.episodeId ?? null
      if (loaded === null) return { core, effects: [] }
      // The button shows Pause while audio plays, and a spinner while a Play waits for the next chapter.
      return core.status.playing || isWaitingForChapter(core)
        ? { core: { ...core, held: null, ask: "Pause" }, effects: [] }
        : { core: askPlay(core, loaded), effects: [] }
    }
    // A move takes a held Play back. The listener chose the place, so it is their own.
    case "Seek":
      return { core: { ...core, ask: event.play === true ? "Play" : core.ask, held: null, shortOfMs: null, move: { _tag: "Seek", positionMs: event.positionMs } }, effects: [] }
    case "Skip":
      return { core: { ...core, held: null, shortOfMs: null, move: { _tag: "Skip", deltaMs: event.deltaMs } }, effects: [] }
    case "Forget": {
      const { [event.episodeId]: _, ...entries } = core.entries
      return {
        core: {
          ...core,
          entries,
          held: core.held?.episodeId === event.episodeId ? null : core.held,
          episodeId: core.episodeId === event.episodeId ? null : core.episodeId,
        },
        effects: [],
      }
    }
    case "Status":
      return takeStatus(core, event.status, now)
    case "Background":
      return saveNow(core, now)
    case "PushAnswered":
      return pushAnswered(core, event)
  }
}

// PLAN

const done = { ask: null, move: null } as const

const loadEpisode = (core: Core, episode: Episode | undefined, now: string): Outcome => {
  if (episode === undefined || episode.chapters.length === 0) {
    return { core: { ...core, ...done, episodeId: core.told?.episodeId ?? null }, effects: [] }
  }
  const saved = saveNow(core, now)
  const entry = saved.core.entries[episode.id] ?? null
  const autoplay = core.ask === "Play"
  return {
    core: {
      ...saved.core,
      ...done,
      told: {
        episodeId: episode.id,
        urls: episode.chapters.map((chapter) => chapter.url),
        durations: episode.chapters.map((chapter) => chapter.durationMs),
        expectsMore: isActive(episode.job),
      },
      wantsPlay: autoplay,
      awaitingPause: false,
      followedAt: entry?.updatedAt ?? null,
      landingMs: null,
      shortOfMs: entry !== null && entry.positionMs > lengthMs(episode) ? entry.positionMs : null,
    },
    effects: [
      ...saved.effects,
      { _tag: "Load", episode, positionMs: autoplay ? startMs(entry, episode) : restMs(entry, episode), autoplay },
    ],
  }
}

const trackChanges = (told: Told, episode: Episode | undefined) => {
  if (episode === undefined) return { nextTold: told, urlsReplaced: false, hasNewTracks: false }
  const expectsMore = isActive(episode.job)
  // A late, shorter library list keeps all known tracks unless a shared URL changed.
  const { chapters } = episode
  const urlsReplaced = chapters.some((chapter, index) => index < told.urls.length && chapter.url !== told.urls[index])
  const keepToldChapters = !urlsReplaced && chapters.length < told.urls.length
  return {
    nextTold: {
      ...told,
      urls: keepToldChapters ? told.urls : chapters.map((chapter) => chapter.url),
      durations: keepToldChapters ? told.durations : chapters.map((chapter) => chapter.durationMs),
      expectsMore,
    },
    urlsReplaced,
    hasNewTracks: urlsReplaced || chapters.length > told.urls.length || expectsMore !== told.expectsMore,
  }
}

const followEntry = (core: Core, episode: Episode, entry: EpisodeProgress, hasNewTracks: boolean, autoplay: boolean) => {
  const targetMs = autoplay ? startMs(entry, episode) : restMs(entry, episode)
  const totalMs = lengthMs(episode)
  const shortOfMs = entry.positionMs > totalMs ? entry.positionMs : null
  let landingMs: number | null = Math.min(targetMs, totalMs)
  const effects: Array<NativeCall> = []
  if (hasNewTracks) effects.push({ _tag: "Load", episode, positionMs: targetMs, autoplay })
  else {
    // Seeking again at the end of the queue would play its last moment again.
    if (Math.abs(targetMs - positionMs(core.status)) >= 1) effects.push({ _tag: "Seek", positionMs: targetMs })
    else landingMs = core.landingMs
    if (core.ask === "Play") effects.push({ _tag: "Play" })
    if (core.ask === "Pause") effects.push({ _tag: "Pause" })
  }
  return { landingMs, shortOfMs, effects }
}

const replaceTracks = (core: Core, told: Told, episode: Episode, autoplay: boolean) => {
  const here = remapReplacedPosition(core.landingMs ?? positionMs(core.status), told.durations, told.urls, episode.chapters)
  const totalMs = lengthMs(episode)
  const targetMs =
    core.move?._tag === "Seek" ? core.move.positionMs
      : core.move?._tag === "Skip" ? Math.max(0, Math.min(totalMs, here + core.move.deltaMs))
      : core.ask === "Play" ? playStart(here, episode.chapters, episode.job).positionMs
      : Math.min(here, totalMs)
  return {
    landingMs: Math.min(targetMs, totalMs),
    shortOfMs: core.shortOfMs,
    effects: [{ _tag: "Load", episode, positionMs: targetMs, autoplay }] satisfies Array<NativeCall>,
  }
}

const applyIntent = (core: Core, episode: Episode | undefined, hasNewTracks: boolean) => {
  const effects: Array<NativeCall> = []
  if (hasNewTracks && episode !== undefined) effects.push({ _tag: "UpdateTracks", episode })
  if (core.move !== null) effects.push(core.move)
  if (core.ask === "Play") {
    // The native player waits by itself at the end of its queue.
    const here = positionMs(core.status)
    const start = episode !== undefined && core.move === null ? playStart(here, episode.chapters, episode.job) : undefined
    if (start !== undefined && !start.isWaiting && Math.abs(start.positionMs - here) >= 1) {
      effects.push({ _tag: "Seek", positionMs: start.positionMs })
    }
    effects.push({ _tag: "Play" })
  }
  if (core.ask === "Pause") effects.push({ _tag: "Pause" })
  return { landingMs: core.landingMs, shortOfMs: core.shortOfMs, effects }
}

const shouldFollowEntry = (core: Core, hasNews: boolean, hasNewTracks: boolean): boolean => {
  if (core.ask === "Play" && core.move !== null) return false
  if (core.shortOfMs !== null) return hasNews || hasNewTracks
  return hasNews && !(core.wantsPlay && !core.status.ended)
}

/**
 * The one step that decides what the native player does. It is a function of the `Core` alone: intent and facts in,
 * the native calls out, in order.
 *
 * - Another episode than the native player has: one `Load`, with the track list and the job of the newest list. A
 *   Play starts where `startMs` says, a paused load rests where `restMs` says. The place of the episode the
 *   listener left is stamped first, when they moved it.
 * - The same episode: `UpdateTracks` comes first when the list has new chapters or the job changed. So each call
 *   after it acts on the newest list.
 * - A device entry the player does not follow yet is news from another device. A player whose audio does not play
 *   (paused, held for the library, waiting at the end of its queue) moves there, and stamps nothing. With a new
 *   track list too, the move is one `Load`: the place and the list arrive together. Audio that plays is not moved.
 *   An entry past the end of the listed audio leaves the player short of it: it moves on when a list has that audio.
 * - Then the listener's own seek, and last their Play or Pause. A Play starts by `playStart` of the contract: at 0
 *   on a finished position, and in place everywhere else. At the end of the queue of a job that still works, the
 *   native player waits for the next chapter.
 */
export const plan = (core: Core, now: string): Outcome => {
  const { told } = core
  if (core.episodeId === null) {
    return told === null
      ? { core: { ...core, ...done }, effects: [] }
      : {
          core: { ...core, ...done, told: null, wantsPlay: false, awaitingPause: false, followedAt: null, landingMs: null, shortOfMs: null },
          effects: [{ _tag: "Unload" }],
        }
  }
  const episode = listed(core, core.episodeId)
  if (told === null || told.episodeId !== core.episodeId) return loadEpisode(core, episode, now)

  const { nextTold, urlsReplaced, hasNewTracks } = trackChanges(told, episode)
  const entry = core.entries[told.episodeId]
  const nextStamp = entry?.updatedAt ?? core.followedAt
  const wantsPlay = core.ask === null ? core.wantsPlay : core.ask === "Play"
  const { landingMs, shortOfMs, effects } =
    episode !== undefined && entry !== undefined && shouldFollowEntry(core, nextStamp !== core.followedAt, hasNewTracks)
      ? followEntry(core, episode, entry, hasNewTracks, wantsPlay)
      : urlsReplaced && episode !== undefined
        ? replaceTracks(core, told, episode, wantsPlay)
        : applyIntent(core, episode, hasNewTracks)

  return {
    core: {
      ...core,
      ...done,
      told: nextTold,
      wantsPlay,
      awaitingPause: core.ask === null ? core.awaitingPause : core.ask === "Pause",
      followedAt: nextStamp,
      landingMs,
      shortOfMs,
    },
    effects,
  }
}

/** One event: `handle` changes intent and facts, then `plan` decides what the native player does. */
export const step = (core: Core, event: PlayerEvent, now: string): Outcome => {
  const handled = handle(core, event, now)
  const planned = plan(handled.core, now)
  return { core: planned.core, effects: [...handled.effects, ...planned.effects] }
}
