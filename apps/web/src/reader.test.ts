import { Component } from "@effect/ui"
import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing"
import { Story } from "@effect/ui/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Redacted } from "effect"
import { AppComponent } from "~/App"
import { LoadChapter } from "~/core/audio"
import { PushProgress, SaveProgress } from "~/command"
import { baseModel, defaultFlags, harbourDays, progressAt, withEpisodes, withPlayback } from "~/fixture"
import { AppMessage } from "~/message"
import { Playback } from "~/playback/model"
import { publicMediaPath } from "~/core/queries"
import {
  ReadSelection,
  ReaderScreenEvents,
  ReaderScreenMessage,
  ReaderScreenNoDeps,
  ScrollToMark,
} from "~/reader/ReaderScreen"
import { required } from "../../../test/required.ts"

const url = "/media/secret-feed-token/episodes/harbour-days/chapters/001.timing.json"
const timingArgs = { origin: "", path: publicMediaPath(url), url: Redacted.make(url) }
const episode = {
  ...harbourDays,
  chapters: harbourDays.chapters.map(({ index, title, durationMs, url: audioUrl }) => ({
    index, title, durationMs, url: audioUrl,
    timingUrl: index === 1 ? url : null,
  })),
}
const segments = [
  { text: "First sentence.", startMs: 100, endMs: 600, endsParagraph: false },
  { text: "Next sentence.", startMs: 800, endMs: 1600, endsParagraph: true },
]

describe("ReaderScreen", () => {
  it("strips the private feed token from publicMediaPath", () => {
    expect(publicMediaPath(url)).toBe("/episodes/harbour-days/chapters/001.timing.json")
    expect(publicMediaPath("/chapter.json")).toBe("/chapter.json")
    expect(JSON.stringify(timingArgs)).not.toContain("secret-feed-token")
  })

  it.effect("follows the voice across a pause, stops on manual scroll, and returns to the current Segment", () =>
    Effect.gen(function* () {
      const s = yield* Story.make(ReaderScreenNoDeps, {
        episode,
        origin: "",
        chapter: 1,
        offsetMs: 0,
        isPlaying: true,
      })
      s.loaded("timings", timingArgs, { segments })

      // Move to offset 100 ms: first mark appears and scrolls instantly.
      s.props((prev) => ({ ...prev, offsetMs: 100 }))
      const scrollKey1 = s.subscriptions.find((key) => key.startsWith("scroll-to-mark:"))
      expect(scrollKey1).toBeDefined()
      s.subscription(
        required(scrollKey1),
        ReaderScreenMessage.RequestedScrollToMark({ mark: { chapter: 1, segment: 0 }, isInstant: true }),
      )
        .expectExact(ScrollToMark.make({ id: "segment-1-0", isInstant: true }))
        .resolve(ScrollToMark, Component.noop)

      // Still inside first segment (799 ms): no new scroll subscription.
      s.props((prev) => ({ ...prev, offsetMs: 799 }))
      expect(s.subscriptions.some((key) => key.startsWith("scroll-to-mark:"))).toBe(false)

      // Cross into segment 1 (800 ms): smooth scroll to segment-1-1.
      s.props((prev) => ({ ...prev, offsetMs: 800 }))
      const scrollKey2 = s.subscriptions.find((key) => key.startsWith("scroll-to-mark:"))
      expect(scrollKey2).toBeDefined()
      s.subscription(
        required(scrollKey2),
        ReaderScreenMessage.RequestedScrollToMark({ mark: { chapter: 1, segment: 1 }, isInstant: false }),
      )
        .expectExact(ScrollToMark.make({ id: "segment-1-1", isInstant: false }))
        .resolve(ScrollToMark, Component.noop)

      // User scrolls away: following pauses, so moving back to 500 ms does not scroll.
      s.send(ReaderScreenMessage.SettledScrollByHand({ isMarkInView: false }))
      s.props((prev) => ({ ...prev, offsetMs: 500 }))
      expect(s.subscriptions.some((key) => key.startsWith("scroll-to-mark:"))).toBe(false)

      // Clicking Follow jumps straight back to segment-1-0.
      s.send(ReaderScreenMessage.ClickedFollow())
        .expectExact(ScrollToMark.make({ id: "segment-1-0", isInstant: true }))
        .resolve(ScrollToMark, Component.noop)
    }),
  )

  it.effect("clicks a later chapter's Segment to emit PlayFrom and App loads and saves its position", () =>
    Effect.gen(function* () {
      const mark = { chapter: 1, segment: 1 }
      const positionMs = required(episode.chapters[0]).durationMs + required(segments[1]).startMs

      const reader = yield* Story.make(ReaderScreenNoDeps, {
        episode,
        origin: "",
        chapter: 0,
        offsetMs: 0,
        isPlaying: true,
      })
      reader
        .loaded("timings", timingArgs, { segments })
        .send(ReaderScreenMessage.ClickedSegment(mark))
        .expectExact(ReadSelection.make(mark))
        .resolve(ReadSelection, ReaderScreenMessage.GotSelectionOnClick({ ...mark, isSelecting: false }))
        .emitted(ReaderScreenEvents.PlayFrom({ positionMs }))

      const progress = progressAt(positionMs)
      const startModel = withPlayback(
        withEpisodes(baseModel(), [episode]),
        Playback.Loaded({
          episodeId: episode.id,
          chapter: 0,
          url: required(episode.chapters[0]).url,
          offsetMs: 0,
          isPlaying: true,
          isWaiting: false,
        }),
      )
      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({ ...startModel, maybeReaderEpisodeId: Option.some(episode.id) })
        .send(AppMessage.RequestedPlayFromReader({ positionMs }))
        .expectExact(
          SaveProgress.make({ episodeId: episode.id, positionMs }),
          LoadChapter.make({ src: required(episode.chapters[1]).url, offsetMs: 800, rate: 1, isAutoplay: true }),
        )
      expect(app.model.playback).toMatchObject({ chapter: 1, offsetMs: 800 })
      app
        .resolve(LoadChapter, Component.noop)
        .resolve(SaveProgress, AppMessage.SavedProgress({ episodeId: episode.id, progress }))
        .resolve(PushProgress, AppMessage.SucceededPushProgress({ episodeId: episode.id, sent: progress, stored: progress }))
    }),
  )

  it.effect("a chapter without timing contributes no text to the open reader", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(ReaderScreenNoDeps, {
        episode,
        origin: "",
        chapter: 0,
        offsetMs: 0,
        isPlaying: false,
      })
      s.loaded("timings", timingArgs, { segments })
        .expect(HtmlLocator.role("heading", { name: "Morning" })).toBeAbsent()
        .expect(HtmlLocator.role("button", { name: "Next sentence." })).toExist()
    }),
  )
})
