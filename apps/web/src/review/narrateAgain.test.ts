import type { Document, Episode, Voice, VoiceRef } from "@fama/contracts"
import { Option } from "effect"
import * as Scene from "foldkit/scene"
import { Command, given, message, model, story } from "foldkit/story"
import { describe, expect, test } from "vitest"
import { LoadChapter } from "~/audio"
import { FetchEpisodes } from "~/command"
import { baseModel, connection, harbourDays, queuedArticle, withEpisodes, withPlayback } from "~/fixture"
import { Message } from "~/message"
import { Playback } from "~/model"
import { chapterText } from "~/reader/model"
import { FetchTiming } from "~/reader/command"
import { ReaderMessage } from "~/reader/message"
import {
  ChangeNarrateAgainVoice,
  FetchNarrateAgainDocument,
  NarrateAgainWithDocument,
} from "~/review/narrateAgainCommand"
import { NarrateAgainMessage as N } from "~/review/narrateAgainMessage"
import { update } from "~/update"
import { view } from "~/view"
import { OpenFilePickerOnKey } from "~/view/addBar"

const wrap = (message: N) => Message.GotNarrateAgainMessage({ message })

const storedDocument: Document = {
  title: "Harbour Days",
  author: "Fama Fixtures",
  language: "en",
  chapters: [
    { title: "Morning", text: "The harbour wakes before the town does." },
    { title: "Evening", text: "In the evening the light turns gold." },
  ],
}

const heart: Voice = {
  id: "kokoro:af_heart" as VoiceRef,
  engine: "kokoro",
  name: "Heart",
  language: "en",
  gender: null,
}
const sarah: Voice = { ...heart, id: "kokoro:af_sarah" as VoiceRef, name: "Sarah" }

const openedModel = (episode: Episode = harbourDays) => {
  const start = { ...withEpisodes(baseModel(), [episode]), voices: [heart, sarah] }
  const loading = update(start, wrap(N.ClickedEpisode({ episodeId: episode.id }))).model
  return update(
    loading,
    wrap(N.SucceededFetchDocument({ episodeId: episode.id, request: 1, document: storedDocument })),
  ).model
}

describe("Narrate again", () => {
  test("Ready and Failed rows open it, while a Queued row has no edit action", () => {
    const failed: Episode = {
      ...harbourDays,
      id: "failed" as Episode["id"],
      title: "Failed Book",
      job: { _tag: "Failed", reason: "No voice", failedAt: "2026-11-20T00:00:00.000Z" },
    }
    Scene.scene(
      { update, view },
      Scene.given(withEpisodes(baseModel(), [harbourDays, failed, queuedArticle])),
      Scene.Mount.resolve(OpenFilePickerOnKey, Message.CompletedMountFilePickerKeys()),
      Scene.expect(Scene.role("button", { name: "Narrate again Harbour Days" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Narrate again Failed Book" })).toExist(),
      Scene.expect(Scene.role("button", { name: `Narrate again ${queuedArticle.title}` })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Narrate again Harbour Days" })),
      Scene.Mount.expectEnded(OpenFilePickerOnKey),
      Scene.Command.expectExact(FetchNarrateAgainDocument({ connection, episodeId: harbourDays.id, request: 1 })),
      Scene.Command.resolve(
        FetchNarrateAgainDocument,
        wrap(N.SucceededFetchDocument({ episodeId: harbourDays.id, request: 1, document: storedDocument })),
      ),
    )
  })

  test("Chapter titles and metadata stay fixed; only edited text goes to the Document route", () => {
    const edited: Document = {
      ...storedDocument,
      chapters: [
        storedDocument.chapters[0]!,
        { title: "Evening", text: "Orange lanterns guide the last ship home." },
      ],
    }
    story(
      update,
      given(openedModel()),
      message(wrap(N.ClickedChapter({ index: 1 }))),
      message(wrap(N.UpdatedChapterText({ index: 1, value: edited.chapters[1]!.text }))),
      message(wrap(N.ClickedNarrateText())),
      Command.expectExact(NarrateAgainWithDocument({ connection, episodeId: harbourDays.id, document: edited })),
      Command.resolve(
        NarrateAgainWithDocument,
        wrap(N.SucceededQueueNarration({ episodeId: harbourDays.id })),
      ),
      Command.expectExact(FetchEpisodes({ connection, generation: 0, request: 2 })),
      Command.resolve(
        FetchEpisodes,
        Message.SucceededFetchEpisodes({
          generation: 0,
          request: 2,
          episodes: [{ ...harbourDays, job: { _tag: "Queued" } }],
        }),
      ),
      model((next) => expect(next.narrateAgain.view._tag).toBe("Closed")),
    )
  })

  test("Voice and speed use a separate submit and queue a Library refresh", () => {
    story(
      update,
      given(openedModel()),
      message(wrap(N.ChangedVoice({ value: sarah.id }))),
      message(wrap(N.ChangedSpeed({ value: "1.3" }))),
      message(wrap(N.ClickedChangeVoice())),
      Command.expectExact(
        ChangeNarrateAgainVoice({
          connection,
          episodeId: harbourDays.id,
          input: { voice: sarah.id, speed: 1.3 },
        }),
      ),
      Command.resolve(ChangeNarrateAgainVoice, wrap(N.SucceededQueueNarration({ episodeId: harbourDays.id }))),
      Command.expectExact(FetchEpisodes({ connection, generation: 0, request: 2 })),
      Command.resolve(
        FetchEpisodes,
        Message.SucceededFetchEpisodes({
          generation: 0,
          request: 2,
          episodes: [{ ...harbourDays, job: { _tag: "Queued" } }],
        }),
      ),
      model((next) => expect(next.narrateAgain.view._tag).toBe("Closed")),
    )
  })

  test("The screen has no title input or chapter-removal control, and a 409 stays visible", () => {
    const opened = openedModel()
    Scene.scene(
      { update, view },
      Scene.given(opened),
      Scene.expect(Scene.role("heading", { name: "Narrate again" })).toExist(),
      Scene.expect(Scene.role("textbox", { name: "Title" })).toBeAbsent(),
      Scene.expect(Scene.role("checkbox")).toBeAbsent(),
      Scene.expect(Scene.role("combobox", { name: "Voice" })).toHaveValue(heart.id),
      Scene.expect(Scene.role("button", { name: "Change voice & speed" })).toBeDisabled(),
      Scene.change(Scene.role("combobox", { name: "Speed" }), "1.2"),
      Scene.click(Scene.role("button", { name: "Change voice & speed" })),
      Scene.Command.resolve(
        ChangeNarrateAgainVoice,
        wrap(N.FailedQueueNarration({ episodeId: harbourDays.id, failure: { status: 409, message: "Not editable" } })),
      ),
      Scene.expect(Scene.role("alert")).toHaveText("Not editable"),
    )
  })

  test("A missing Document leaves voice and speed available", () => {
    const loading = update(
      { ...withEpisodes(baseModel(), [harbourDays]), voices: [heart] },
      wrap(N.ClickedEpisode({ episodeId: harbourDays.id })),
    ).model
    const opened = update(
      loading,
      wrap(
        N.FailedFetchDocument({
          episodeId: harbourDays.id,
          request: 1,
          failure: { status: 404, message: "Not stored" },
        }),
      ),
    ).model
    Scene.scene(
      { update, view },
      Scene.given(opened),
      Scene.expect(Scene.text(/Chapter text is not stored/)).toExist(),
      Scene.expect(Scene.role("combobox", { name: "Voice" })).toBeEnabled(),
      Scene.expect(Scene.role("button", { name: "Narrate chapter edits" })).toBeAbsent(),
      Scene.change(Scene.role("combobox", { name: "Speed" }), "1.1"),
      Scene.expect(Scene.role("button", { name: "Change voice & speed" })).toBeEnabled(),
    )
  })

  test("A replacement Chapter URL reloads audio at the same place", () => {
    const oldChapter = harbourDays.chapters[0]!
    const replacement: Episode = {
      ...harbourDays,
      chapters: [
        { ...oldChapter, url: "/media/t/episodes/harbour-days/chapters/new-000.m4a" },
        harbourDays.chapters[1]!,
      ],
    }
    const paused = withPlayback(
      withEpisodes(baseModel(), [harbourDays]),
      Playback.Loaded({
        episodeId: harbourDays.id,
        chapter: 0,
        url: oldChapter.url,
        offsetMs: 10_000,
        isPlaying: false,
        isWaiting: false,
      }),
    )
    story(
      update,
      given(paused),
      message(Message.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [replacement] })),
      Command.expectExact(
        LoadChapter({
          src: replacement.chapters[0]!.url,
          offsetMs: 10_000,
          rate: 1,
          isAutoplay: false,
        }),
      ),
      model((next) => expect(next.playback).toMatchObject({ chapter: 0, offsetMs: 10_000, url: replacement.chapters[0]!.url })),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
    )
  })

  test("A replacement timing URL loads the new Read-along text", () => {
    const oldEpisode: Episode = {
      ...harbourDays,
      chapters: [{ ...harbourDays.chapters[0]!, url: "/audio/new.m4a", timingUrl: "/timing/old.json" }],
    }
    const newEpisode: Episode = {
      ...harbourDays,
      chapters: [{ ...harbourDays.chapters[0]!, url: "/audio/new.m4a", timingUrl: "/timing/new.json" }],
    }
    const playing = withPlayback(
      withEpisodes(baseModel(), [oldEpisode]),
      Playback.Loaded({
        episodeId: oldEpisode.id,
        chapter: 0,
        url: newEpisode.chapters[0]!.url,
        offsetMs: 0,
        isPlaying: false,
        isWaiting: false,
      }),
    )
    const opened = update(playing, Message.GotReaderMessage({ message: ReaderMessage.ClickedText() })).model
    const withOldText = update(
      opened,
      Message.GotReaderMessage({
        message: ReaderMessage.SucceededFetchTiming({
          url: "/timing/old.json",
          timing: { segments: [{ text: "Old text.", startMs: 0, endMs: 100, endsParagraph: true }] },
        }),
      }),
    ).model
    const next = update(
      withOldText,
      Message.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [newEpisode] }),
    )
    expect(next.commands?.map((command) => command.name)).toEqual([FetchTiming.name])
    expect(next.commands?.[0]?.args).toEqual({ origin: "", url: "/timing/new.json" })
    const loaded = update(
      next.model,
      Message.GotReaderMessage({
        message: ReaderMessage.SucceededFetchTiming({
          url: "/timing/new.json",
          timing: { segments: [{ text: "Orange lanterns guide the last ship home.", startMs: 0, endMs: 100, endsParagraph: true }] },
        }),
      }),
    ).model
    const text = chapterText(loaded.reader, newEpisode.chapters[0]!)
    expect(text._tag === "Loaded" && text.segments[0]?.text).toBe("Orange lanterns guide the last ship home.")
    expect(Option.isSome(loaded.maybeEpisodes)).toBe(true)
  })
})
