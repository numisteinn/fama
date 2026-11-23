import type { Episode, EpisodeProgress } from "@fama/contracts"
import { describe, expect, test } from "vitest"
import { IDLE_STATUS, type PlayerEvent, initialCore, isWaitingForChapter, step } from "./core"
import type { NativeStatus } from "./native"

const at = (positionMs: number, updatedAt: string): EpisodeProgress => ({ positionMs, updatedAt })
const older = at(10_000, "2026-11-23T09:00:00.000Z")
const newer = at(40_000, "2026-11-23T11:00:00.000Z")
const NOW = "2026-11-23T12:00:00.000Z"

const chapters = [
  { index: 0, title: "Morning", durationMs: 26_825, url: "/000.m4a" },
  { index: 1, title: "Evening", durationMs: 19_700, url: "/001.m4a" },
]
/** The job still narrates: one chapter so far. */
const running = {
  id: "e1",
  title: "Harbour Days",
  chapters: [chapters[0]!],
  job: { _tag: "Running", workerId: "w", stage: "synthesizing", done: 1, total: 2, heartbeatAt: "x" },
  progress: older,
} as unknown as Episode
const grown = { ...running, chapters } as Episode
const ready = { ...grown, job: { _tag: "Ready", finishedAt: "x" } } as Episode
const other = { ...ready, id: "e2", progress: null } as Episode

/** A phone as a test sees it: what the core holds, each native call so far, and each entry sent to the server. */
const phone = (entries: Record<string, EpisodeProgress> = {}) => {
  let core = initialCore(entries)
  const calls: Array<string> = []
  const sent: Array<EpisodeProgress> = []
  const send = (event: PlayerEvent, now = NOW) => {
    const result = step(core, event, now)
    core = result.core
    for (const effect of result.effects) {
      switch (effect._tag) {
        case "Push":
          sent.push(effect.entry)
          break
        case "Load":
          calls.push(`Load ${effect.episode.id}, ${effect.episode.chapters.length} chapters, at ${effect.positionMs}, ${effect.autoplay ? "play" : "paused"}`)
          break
        case "UpdateTracks":
          calls.push(`UpdateTracks ${effect.episode.chapters.length} chapters, ${effect.episode.job._tag}`)
          break
        case "Seek":
          calls.push(`Seek ${effect.positionMs}`)
          break
        case "Skip":
          calls.push(`Skip ${effect.deltaMs}`)
          break
        default:
          calls.push(effect._tag)
      }
    }
  }
  return {
    send,
    calls,
    sent,
    get core() {
      return core
    },
    /** A library request goes out. */
    refresh(): number {
      send({ _tag: "RefreshStarted" })
      return core.requests
    },
    answer: (request: number, episodes: ReadonlyArray<Episode> | null) => send({ _tag: "RefreshAnswered", request, episodes }),
    /** The library loaded `episodes`: one request, answered. */
    library(episodes: ReadonlyArray<Episode>) {
      send({ _tag: "RefreshStarted" })
      send({ _tag: "RefreshAnswered", request: core.requests, episodes })
    },
    /** The native player says where `e1` is. */
    status: (fields: Partial<NativeStatus>, now = NOW) =>
      send({ _tag: "Status", status: { ...IDLE_STATUS, episodeId: "e1", ...fields } }, now),
    play: (episode: Episode) => send({ _tag: "PlayEpisode", episode }),
  }
}

/** A phone with `episode` loaded and paused at 10 s, as after a relaunch. */
const paused = (episode: Episode = ready) => {
  const device = phone({ e1: older })
  device.library([episode])
  device.send({ _tag: "Restore", episodeId: "e1" })
  device.status({ position: 10 })
  device.calls.length = 0
  return device
}

describe("a Play and the library requests that are out", () => {
  test("with no library request in flight, Play starts at once", () => {
    const device = paused()
    device.send({ _tag: "Toggle" })
    expect(device.calls).toEqual(["Play"])
  })

  test("Play pressed while the library loads starts when the list came", () => {
    // The app came back to the front: the refresh is out when the listener taps Play.
    const device = paused()
    const foreground = device.refresh()
    device.send({ _tag: "Toggle" })
    expect(device.calls).toEqual([])
    device.answer(foreground, [ready])
    expect(device.calls).toEqual(["Play"])
  })

  test("a failed load starts the Play too, from what the phone knows", () => {
    const device = paused()
    const foreground = device.refresh()
    device.send({ _tag: "Toggle" })
    device.answer(foreground, null)
    expect(device.calls).toEqual(["Play"])
  })

  test("a later pull to refresh that fails does not start the Play: it waits for the request of the press", () => {
    const device = paused()
    const foreground = device.refresh()
    device.send({ _tag: "Toggle" })
    // The listener pulls to refresh while the foreground request is still out, and the server answers 503.
    const pull = device.refresh()
    device.answer(pull, null)
    // Nothing plays from the old position, so no pause can stamp it over the other device's entry.
    expect(device.calls).toEqual([])
    device.answer(foreground, [ready])
    expect(device.calls).toEqual(["Play"])
  })

  test("a later request that brings a list starts the Play at once, and the awaited answer starts nothing more", () => {
    const device = paused()
    const foreground = device.refresh()
    device.send({ _tag: "Toggle" })
    const pull = device.refresh()
    device.answer(pull, [ready])
    expect(device.calls).toEqual(["Play"])
    device.answer(foreground, [ready])
    expect(device.calls).toEqual(["Play"])
  })

  test("with two requests in flight, the list of the older one is not enough", () => {
    const device = paused()
    const poll = device.refresh()
    const foreground = device.refresh()
    device.send({ _tag: "Toggle" })
    device.answer(poll, [ready])
    expect(device.calls).toEqual([])
    device.answer(foreground, [ready])
    expect(device.calls).toEqual(["Play"])
  })

  test("with two requests in flight, the list of the newer one starts the Play", () => {
    const device = paused()
    const poll = device.refresh()
    const foreground = device.refresh()
    device.send({ _tag: "Toggle" })
    device.answer(foreground, [ready])
    expect(device.calls).toEqual(["Play"])
    device.answer(poll, [ready])
    expect(device.calls).toEqual(["Play"])
  })

  test("with two requests in flight, the Play starts when both have failed", () => {
    const device = paused()
    const poll = device.refresh()
    const foreground = device.refresh()
    device.send({ _tag: "Toggle" })
    device.answer(foreground, null)
    expect(device.calls).toEqual([])
    device.answer(poll, null)
    expect(device.calls).toEqual(["Play"])
  })

  test("a request that answered before the Play is not waited for", () => {
    const device = paused()
    device.answer(device.refresh(), [ready])
    device.send({ _tag: "Toggle" })
    expect(device.calls).toEqual(["Play"])
  })

  test("a second Play of the same episode does not wait again", () => {
    const device = paused()
    const foreground = device.refresh()
    device.send({ _tag: "Toggle" })
    device.send({ _tag: "Toggle" })
    expect(device.calls).toEqual(["Play"])
    device.status({ position: 10, playing: true })
    device.answer(foreground, [ready])
    expect(device.calls).toEqual(["Play"])
  })

  test("a seek or a skip takes the waiting Play back", () => {
    for (const move of [{ _tag: "Seek", positionMs: 15_000 }, { _tag: "Skip", deltaMs: 30_000 }] as const) {
      const device = paused()
      const foreground = device.refresh()
      device.send({ _tag: "Toggle" })
      device.send(move)
      device.answer(foreground, [ready])
      expect(device.calls).toEqual([move._tag === "Seek" ? "Seek 15000" : "Skip 30000"])
    }
  })

  test("a pause of the episode that plays takes a waiting Play of another one back", () => {
    const device = paused()
    device.library([ready, other])
    device.send({ _tag: "Toggle" })
    device.status({ position: 10, playing: true })
    const foreground = device.refresh()
    device.play(other)
    device.send({ _tag: "Toggle" })
    device.answer(foreground, [ready, other])
    expect(device.calls).toEqual(["Play", "Pause"])
  })

  test("a Play of another episode replaces the waiting one", () => {
    const device = phone()
    device.library([ready, other])
    const foreground = device.refresh()
    device.play(ready)
    device.play(other)
    device.answer(foreground, [ready, other])
    expect(device.calls).toEqual(["Load e2, 2 chapters, at 0, play"])
  })
})

describe("a Play of a library episode", () => {
  /** The other device played it to the end after the job turned Ready. */
  const finishedElsewhere = at(46_525, newer.updatedAt)
  const finished = { ...ready, progress: finishedElsewhere } as Episode

  test("with no library request in flight, it loads the episode as the library lists it", () => {
    const device = phone({ e1: older })
    device.library([running])
    device.play(running)
    expect(device.calls).toEqual(["Load e1, 1 chapters, at 10000, play"])
  })

  test("after a wait, it loads the episode as the answer lists it: both chapters, and a finished one from 0", () => {
    const device = phone({ e1: older })
    device.library([running])
    const foreground = device.refresh()
    device.play(running)
    expect(device.calls).toEqual([])
    // The answer: the job is Ready with two chapters, and the other device finished the episode.
    device.answer(foreground, [finished])
    expect(device.calls).toEqual(["Load e1, 2 chapters, at 0, play"])
  })

  test("an episode the answer no longer lists does not play", () => {
    const device = phone({ e1: older })
    device.library([running])
    const foreground = device.refresh()
    device.play(running)
    device.answer(foreground, [])
    expect(device.calls).toEqual([])
    // The Play is off: a later answer that lists the episode again starts nothing.
    device.answer(device.refresh(), [finished])
    expect(device.calls).toEqual([])
  })

  test("when each awaited request failed, it loads the episode as the library last listed it", () => {
    const device = phone({ e1: older })
    device.library([running])
    const poll = device.refresh()
    const foreground = device.refresh()
    device.play(running)
    // The poll brought the new list; the foreground request then failed.
    device.answer(poll, [finished])
    expect(device.calls).toEqual([])
    device.answer(foreground, null)
    expect(device.calls).toEqual(["Load e1, 2 chapters, at 0, play"])
  })

  test("a failed load with no new list plays the episode of the list the account started with", () => {
    // Offline: the library shows the cached list, and its first request fails.
    const device = phone({ e1: older })
    device.send({ _tag: "Listed", episodes: [running] })
    const first = device.refresh()
    device.play(running)
    device.answer(first, null)
    expect(device.calls).toEqual(["Load e1, 1 chapters, at 10000, play"])
  })

  test("a second Play of the same episode loads at once", () => {
    const device = phone({ e1: older })
    device.library([running])
    const foreground = device.refresh()
    device.play(running)
    device.play(running)
    expect(device.calls).toEqual(["Load e1, 1 chapters, at 10000, play"])
    device.status({ position: 10, playing: true })
    device.answer(foreground, [running])
    expect(device.calls).toHaveLength(1)
  })

  test("a deleted episode takes its waiting Play back, and no other", () => {
    const device = phone({ e1: older })
    device.library([running])
    const foreground = device.refresh()
    device.play(running)
    device.send({ _tag: "Forget", episodeId: "other" })
    device.send({ _tag: "Forget", episodeId: "e1" })
    // The answer was sent before the delete, so it still lists the episode.
    device.answer(foreground, [running])
    expect(device.calls).toEqual([])
  })

  test("the restore after launch loads the last episode paused, and stamps nothing", () => {
    const device = phone({ e1: older })
    device.library([ready])
    device.send({ _tag: "Restore", episodeId: "e1" })
    device.status({ position: 10 })
    device.status({ position: 10 })
    device.send({ _tag: "Background" })
    expect(device.calls).toEqual(["Load e1, 2 chapters, at 10000, paused"])
    expect(device.sent).toEqual([])
  })
})

describe("the native calls of one event, in order", () => {
  test("a Play held at the end of the queue gets the Ready job before it plays (review round 4, finding 2)", () => {
    // The listener heard chapter 1 to its end while the job ran, and paused the wait.
    const end = at(26_825, older.updatedAt)
    const device = phone({ e1: end })
    device.library([{ ...running, progress: end }])
    device.send({ _tag: "Restore", episodeId: "e1" })
    device.status({ position: 26.825, ended: true })
    device.calls.length = 0
    const foreground = device.refresh()
    device.send({ _tag: "Toggle" })
    expect(device.calls).toEqual([])
    // The answer: the job is Ready, with no new chapter. The episode is finished now, so the Play starts at 0.
    device.answer(foreground, [{ ...ready, chapters: [chapters[0]!], progress: end }])
    expect(device.calls).toEqual(["UpdateTracks 1 chapters, Ready", "Seek 0", "Play"])
  })

  test("a Play held while the list grows gets the new chapters before it plays", () => {
    const device = paused(running)
    const foreground = device.refresh()
    device.send({ _tag: "Toggle" })
    device.answer(foreground, [grown])
    expect(device.calls).toEqual(["UpdateTracks 2 chapters, Running", "Play"])
  })

  test("new chapters and a newer entry reach a waiting player in one Load, and it goes on at the entry", () => {
    const device = paused(running)
    device.send({ _tag: "Toggle" })
    // The phone stamps the end of chapter 1 when its audio runs out there. The other device saved 40 s after that.
    device.status({ position: 26.825, ended: true }, "2026-11-23T10:30:00.000Z")
    expect(isWaitingForChapter(device.core)).toBe(true)
    expect(device.sent).toEqual([at(26_825, "2026-11-23T10:30:00.000Z")])
    device.calls.length = 0
    device.sent.length = 0
    device.library([{ ...grown, progress: newer }])
    expect(device.calls).toEqual(["Load e1, 2 chapters, at 40000, play"])
    // The status of before the move does not count as the listener's, and the one after it sets the baseline.
    device.status({ position: 26.825, ended: true })
    device.status({ position: 40, playing: true })
    expect(device.sent).toEqual([])
    device.status({ position: 45, playing: true })
    expect(device.sent.map((entry) => entry.positionMs)).toEqual([45_000])
  })

  test("a paused player moves to a newer entry, and stamps nothing", () => {
    const device = paused()
    device.library([{ ...ready, progress: newer }])
    expect(device.calls).toEqual(["Seek 40000"])
    device.status({ position: 40 })
    device.send({ _tag: "Background" })
    expect(device.sent).toEqual([])
    expect(device.core.entries.e1).toEqual(newer)
  })

  test("a paused player that takes a finished entry rests at its end, and the next Play starts at 0", () => {
    const device = paused()
    device.library([{ ...ready, progress: at(46_525, newer.updatedAt) }])
    expect(device.calls).toEqual(["Seek 46525"])
    // The native player parks just before the end. That is not the listener's place: nothing is stamped.
    device.status({ position: 46.275 })
    device.send({ _tag: "Background" })
    expect(device.sent).toEqual([])
    device.calls.length = 0
    device.send({ _tag: "Toggle" })
    expect(device.calls).toEqual(["Seek 0", "Play"])
  })

  test("a newer entry does not move audio that plays", () => {
    const device = paused()
    device.send({ _tag: "Toggle" })
    device.status({ position: 12, playing: true })
    device.calls.length = 0
    device.library([{ ...ready, progress: newer }])
    expect(device.calls).toEqual([])
    expect(device.core.entries.e1).toEqual(newer)
    // The listening goes on, and its next save is the listener's own.
    device.status({ position: 17, playing: true })
    expect(device.sent.map((entry) => entry.positionMs)).toEqual([17_000])
  })

  test("a Play pressed in the last 3 s of a Ready episode starts at 0, as on the web", () => {
    const device = paused()
    device.status({ position: 45 })
    device.calls.length = 0
    device.send({ _tag: "Toggle" })
    expect(device.calls).toEqual(["Seek 0", "Play"])
  })

  test("the button takes a wait for the next chapter back", () => {
    const device = paused(running)
    device.send({ _tag: "Toggle" })
    device.status({ position: 26.825, ended: true })
    device.calls.length = 0
    device.send({ _tag: "Toggle" })
    expect(device.calls).toEqual(["Pause"])
    expect(isWaitingForChapter(device.core)).toBe(false)
    // The next chapter does not start a Play the listener took back. It only reaches the native player.
    device.library([grown])
    expect(device.calls).toEqual(["Pause", "UpdateTracks 2 chapters, Running"])
  })

  test("a native Pause during a wait keeps the player paused when the next chapter arrives", () => {
    const device = paused(running)
    device.send({ _tag: "Toggle" })
    device.status({ position: 26.825, ended: true, wantsPlay: true }, "2026-11-23T10:30:00.000Z")
    expect(isWaitingForChapter(device.core)).toBe(true)
    device.calls.length = 0
    // The lock screen controls the native player directly, without sending a JS Toggle.
    device.status({ position: 26.825, ended: true, wantsPlay: false })
    expect(isWaitingForChapter(device.core)).toBe(false)
    device.library([{ ...grown, progress: newer }])
    expect(device.calls).toEqual(["Load e1, 2 chapters, at 40000, paused"])
  })

  test("a status sent before an in-app Pause cannot restart a waiting player", () => {
    const device = paused(running)
    device.send({ _tag: "Toggle" })
    const waiting = { position: 26.825, ended: true, wantsPlay: true }
    device.status(waiting, "2026-11-23T10:30:00.000Z")
    device.calls.length = 0
    device.send({ _tag: "Toggle" })
    device.status(waiting)
    expect(isWaitingForChapter(device.core)).toBe(false)
    device.library([{ ...grown, progress: newer }])
    expect(device.calls).toEqual(["Pause", "Load e1, 2 chapters, at 40000, paused"])
    device.status({ ...waiting, wantsPlay: false })
    expect(device.core.awaitingPause).toBe(false)
  })

  test("an entry past the end of the listed audio: the player rests short of it, and moves on when the list has it", () => {
    // The other device is in chapter 2. This phone took the entry with a list from before chapter 2.
    const device = phone({ e1: older })
    device.library([{ ...running, progress: newer }])
    device.play(running)
    expect(device.calls).toEqual(["Load e1, 1 chapters, at 26825, play"])
    // The native player plays the last moment of chapter 1, and its queue runs out. Nothing is the listener's.
    device.status({ position: 26.575, playing: true })
    device.status({ position: 26.825, ended: true })
    device.send({ _tag: "Background" })
    expect(device.sent).toEqual([])
    device.calls.length = 0
    device.library([{ ...grown, progress: newer }])
    expect(device.calls).toEqual(["Load e1, 2 chapters, at 40000, play"])
    expect(device.core.shortOfMs).toBeNull()
  })

  test("deleting the loaded episode unloads it and drops its entry", () => {
    const device = paused()
    device.send({ _tag: "Forget", episodeId: "e1" })
    expect(device.calls).toEqual(["Unload"])
    expect(device.core.entries).toEqual({})
  })
})

describe("the device's progress", () => {
  test("listening is stamped about every 5 s, at a pause and at the end, and each stamp goes to the server", () => {
    const device = paused()
    device.send({ _tag: "Toggle" })
    device.status({ position: 10, playing: true })
    device.status({ position: 14.9, playing: true })
    expect(device.sent).toEqual([])
    device.status({ position: 15, playing: true }, "2026-11-23T12:00:05.000Z")
    device.status({ position: 16, playing: false }, "2026-11-23T12:00:06.000Z")
    expect(device.sent).toEqual([at(15_000, "2026-11-23T12:00:05.000Z"), at(16_000, "2026-11-23T12:00:06.000Z")])
    expect(device.core.entries.e1).toEqual(at(16_000, "2026-11-23T12:00:06.000Z"))
  })

  test("a library load sends an entry the server does not have, and stamps nothing", () => {
    const device = phone({ e1: newer })
    device.library([ready])
    expect(device.sent).toEqual([newer])
  })

  test("the device takes the server's answer to a push, a clamped stamp included, and the player stays", () => {
    const device = paused()
    device.send({ _tag: "Toggle" })
    device.status({ position: 10, playing: true })
    // The device clock runs an hour fast.
    device.status({ position: 20, playing: false }, "2026-11-23T13:00:00.000Z")
    const sent = at(20_000, "2026-11-23T13:00:00.000Z")
    const clamped = at(20_000, "2026-11-23T12:00:00.000Z")
    expect(device.sent).toEqual([sent])
    device.calls.length = 0
    device.send({ _tag: "PushAnswered", episodeId: "e1", sent, stored: clamped })
    expect(device.core.entries.e1).toEqual(clamped)
    expect(device.calls).toEqual([])
  })

  test("the answer to a push with another device's newer entry moves a paused player there", () => {
    const device = paused()
    device.send({ _tag: "Seek", positionMs: 20_000 })
    device.status({ position: 20 }, "2026-11-23T10:00:00.000Z")
    const sent = at(20_000, "2026-11-23T10:00:00.000Z")
    expect(device.sent).toEqual([sent])
    device.calls.length = 0
    device.send({ _tag: "PushAnswered", episodeId: "e1", sent, stored: newer })
    expect(device.calls).toEqual(["Seek 40000"])
  })
})
