import { Command, given, message, model, story } from "foldkit/story"
import * as Scene from "foldkit/scene"
import { expect, test } from "vitest"
import { LoadChapter } from "~/audio"
import { PushProgress, SaveProgress } from "~/command"
import { baseModel, harbourDays, progressAt, withEpisodes, withPlayback } from "~/fixture"
import { Message } from "~/message"
import { Playback } from "~/model"
import { FetchTiming, ReadSelection, ScrollToMark } from "~/reader/command"
import { ReaderMessage as R } from "~/reader/message"
import { update } from "~/update"
import { view } from "~/view"

const wrap = (message: R) => Message.GotReaderMessage({ message })
const url = "/chapter.json"
const episode = { ...harbourDays, chapters: harbourDays.chapters.map((c) => ({ ...c, timingUrl: c.index === 1 ? url : null })) }
const segments = [
  { text: "First sentence.", startMs: 100, endMs: 600, endsParagraph: false },
  { text: "Next sentence.", startMs: 800, endMs: 1600, endsParagraph: true },
]
const start = (chapter: number) => withPlayback(withEpisodes(baseModel(), [episode]),
  Playback.Loaded({ episodeId: episode.id, chapter, offsetMs: 0, isPlaying: true, isWaiting: false }))
const loaded = wrap(R.SucceededFetchTiming({ url, timing: { segments } }))
const scrolled = wrap(R.CompletedScrollToMark())
const tick = (offsetMs: number) => Message.UpdatedAudioTime({ offsetMs, atMs: 1000 })

test("follow the voice across a pause, stop on manual scroll and return to the current Segment", () => {
  story(update, given(start(1)), message(wrap(R.ClickedText())),
    Command.expectExact(FetchTiming({ url, origin: "" })), Command.resolve(FetchTiming, loaded),
    message(tick(100)), Command.expectExact(ScrollToMark({ id: "segment-1-0", isInstant: true })),
    Command.resolve(ScrollToMark, scrolled), message(tick(799)), Command.expectNone(),
    message(tick(800)), Command.expectExact(ScrollToMark({ id: "segment-1-1", isInstant: false })),
    Command.resolve(ScrollToMark, scrolled), message(wrap(R.SettledScrollByHand({ isMarkInView: false }))),
    message(tick(500)), Command.expectNone(), message(wrap(R.ClickedFollow())),
    Command.expectExact(ScrollToMark({ id: "segment-1-0", isInstant: true })), Command.resolve(ScrollToMark, scrolled))
})

test("click a later chapter's Segment to play and save its episode position", () => {
  const mark = { chapter: 1, segment: 1 }
  const positionMs = episode.chapters[0]!.durationMs + segments[1]!.startMs
  const progress = progressAt(positionMs)
  story(update, given(start(0)), message(wrap(R.ClickedText())), Command.resolve(FetchTiming, loaded),
    message(wrap(R.ClickedSegment(mark))), Command.resolve(ReadSelection, wrap(R.GotSelectionOnClick({ ...mark, isSelecting: false }))),
    Command.expectExact(LoadChapter({ src: episode.chapters[1]!.url, offsetMs: 800, rate: 1, isAutoplay: true }),
      SaveProgress({ episodeId: episode.id, positionMs })),
    model((next) => expect(next.playback).toMatchObject({ chapter: 1, offsetMs: 800 })),
    Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
    Command.resolve(SaveProgress, Message.SavedProgress({ episodeId: episode.id, progress })),
    Command.resolve(PushProgress, Message.SucceededPushProgress({ episodeId: episode.id, sent: progress, stored: progress })))
})

test("a chapter without timing contributes no text to the open reader", () => {
  const open = update(start(0), wrap(R.ClickedText())).model
  Scene.scene({ update, view }, Scene.given(update(open, loaded).model),
    Scene.expect(Scene.role("heading", { name: "Morning" })).toBeAbsent(),
    Scene.expect(Scene.role("button", { name: "Next sentence." })).toExist())
})
