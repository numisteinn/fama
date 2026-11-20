import { Dialog } from "@foldkit/ui"
import { Option } from "effect"
import { Command, given, message, model, story } from "foldkit/story"
import { describe, expect, test } from "vitest"
import { LoadChapter, SeekAudio, SetAudioRate, StopAudio, ToggleAudio } from "~/audio"
import {
  CreateEpisodeFromSource,
  DeleteEpisode,
  FetchEpisodes,
  FetchFeed,
  FocusAddText,
  FocusDeleteConfirm,
  FocusPicker,
  FocusPickerTrigger,
  SavePosition,
  StoreSetting,
  WaitBeforeDisarmDelete,
} from "~/command"
import { Message } from "~/message"
import { Playback } from "~/model"
import { baseModel, harbourDays, queuedArticle, runningHarbourDays, withEpisodes } from "~/fixture"
import { update } from "~/update"

const unauthorized = { status: 401, message: "The API token is wrong or missing" }

describe("library", () => {
  test("the first 401 opens Settings, a second 401 in a row does not", () => {
    story(
      update,
      given(baseModel()),
      message(Message.FailedFetchEpisodes({ failure: unauthorized })),
      model((next) => expect(next.settingsDialog.isOpen).toBe(true)),
      Command.expectExact(Dialog.ShowDialog, FetchFeed),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(FetchFeed, Message.FailedFetchFeed({ failure: unauthorized })),
    )
    const stillUnauthorized = { ...baseModel(), maybeLibraryFailure: Option.some(unauthorized) }
    story(
      update,
      given(stillUnauthorized),
      message(Message.FailedFetchEpisodes({ failure: unauthorized })),
      model((next) => expect(next.settingsDialog.isOpen).toBe(false)),
      Command.expectNone(),
    )
  })

  test("a poll tick refetches, and the result replaces the list", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [queuedArticle])),
      message(Message.TickedPoll()),
      Command.expectExact(FetchEpisodes),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ episodes: [harbourDays] })),
      model((next) => expect(Option.getOrThrow(next.maybeEpisodes).map((item) => item.title)).toEqual(["Harbour Days"])),
    )
  })

  test("two clicks delete: the first arms and focuses, the timer disarms", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedArmDelete({ episodeId: harbourDays.id })),
      model((next) => expect(next.armedDeletes).toEqual([harbourDays.id])),
      Command.expectExact(WaitBeforeDisarmDelete, FocusDeleteConfirm),
      Command.resolve(FocusDeleteConfirm, Message.CompletedFocusDeleteConfirm()),
      Command.resolve(WaitBeforeDisarmDelete, Message.CompletedWaitBeforeDisarmDelete({ episodeId: harbourDays.id })),
      model((next) => expect(next.armedDeletes).toEqual([])),
    )
  })
})

describe("add bar", () => {
  test("text that is not a link becomes a Text source; success clears the box and focuses it", () => {
    story(
      update,
      given(baseModel()),
      message(Message.UpdatedAddText({ value: "  A short note.  " })),
      message(Message.PressedEnterInAddText()),
      model((next) => expect(next.isAdding).toBe(true)),
      Command.expectExact(CreateEpisodeFromSource),
      Command.resolve(CreateEpisodeFromSource, Message.SucceededCreateEpisode({ episode: queuedArticle })),
      model((next) => {
        expect(next.addText).toBe("")
        expect(next.isAdding).toBe(false)
        expect(Option.getOrThrow(next.maybeEpisodes)).toEqual([queuedArticle])
      }),
      Command.expectExact(FocusAddText),
      Command.resolve(FocusAddText, Message.CompletedFocusAddText()),
    )
  })

  test("an empty box does not submit", () => {
    story(update, given(baseModel()), message(Message.SubmittedAddForm()), Command.expectNone())
  })

  test("a failed add shows the message and keeps the text", () => {
    story(
      update,
      given({ ...baseModel(), addText: "http://localhost:8790/article.html", isAdding: true }),
      message(Message.FailedCreateEpisode({ failure: unauthorized })),
      model((next) => {
        expect(next.maybeAddError).toEqual(Option.some(unauthorized.message))
        expect(next.addText).toBe("http://localhost:8790/article.html")
      }),
    )
  })
})

describe("player", () => {
  test("play resumes at the saved position, across chapters", () => {
    story(
      update,
      given(withEpisodes(baseModel({ [harbourDays.id]: 30_000 }), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      model((next) => {
        expect(next.playback).toEqual(
          Playback.Loaded({
            episodeId: harbourDays.id,
            chapter: 1,
            offsetMs: 30_000 - 26_825,
            isPlaying: true,
            isWaiting: false,
            isEnded: false,
          }),
        )
      }),
      Command.expectExact(LoadChapter),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
    )
  })

  test("a finished episode starts from the top", () => {
    story(
      update,
      given(withEpisodes(baseModel({ [harbourDays.id]: 45_000 }), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(0)),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
    )
  })

  test("the end of a chapter waits for the next one, then plays it when it renders", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [runningHarbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
      message(Message.EndedChapter()),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.isWaiting).toBe(true)),
      Command.expectNone(),
      message(Message.SucceededFetchEpisodes({ episodes: [harbourDays] })),
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
        expect(next.playback._tag === "Loaded" && next.playback.isWaiting).toBe(false)
      }),
      Command.expectExact(LoadChapter),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
    )
  })

  test("a skip inside the chapter seeks and saves the position", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
      message(Message.ClickedSkip({ deltaMs: 15_000 })),
      Command.expectExact(SeekAudio, SavePosition),
      Command.resolve(SeekAudio, Message.CompletedSeekAudio()),
      Command.resolve(SavePosition, Message.CompletedSavePosition()),
      model((next) => expect(next.savedPositions[harbourDays.id]).toBe(15_000)),
    )
  })

  test("after the end, Forward 30 seconds keeps the episode ended, so Play starts from the top", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
      message(Message.EndedChapter()),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
      message(Message.UpdatedAudioTime({ offsetMs: 19_700, atMs: 0 })),
      message(Message.EndedChapter()),
      Command.resolve(SavePosition, Message.CompletedSavePosition()),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.isEnded).toBe(true)),
      message(Message.ClickedSkip({ deltaMs: 30_000 })),
      Command.resolve(SeekAudio, Message.CompletedSeekAudio()),
      Command.resolve(SavePosition, Message.CompletedSavePosition()),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.isEnded).toBe(true)),
      message(Message.ClickedPlayPause()),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(0)),
      Command.expectExact(LoadChapter),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
    )
  })

  test("a seek back from the end leaves the ended state, so Play resumes there", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
      message(Message.EndedChapter()),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
      message(Message.UpdatedAudioTime({ offsetMs: 19_700, atMs: 0 })),
      message(Message.EndedChapter()),
      Command.resolve(SavePosition, Message.CompletedSavePosition()),
      message(Message.ClickedSkip({ deltaMs: -15_000 })),
      Command.resolve(SeekAudio, Message.CompletedSeekAudio()),
      Command.resolve(SavePosition, Message.CompletedSavePosition()),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.isEnded).toBe(false)),
      message(Message.ClickedPlayPause()),
      Command.expectExact(ToggleAudio),
      Command.resolve(ToggleAudio, Message.CompletedToggleAudio()),
    )
  })

  test("deleting the loaded episode stops the audio", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
      message(Message.ClickedConfirmDelete({ episodeId: harbourDays.id })),
      Command.resolve(DeleteEpisode, Message.SucceededDeleteEpisode({ episodeId: harbourDays.id })),
      model((next) => expect(next.playback).toEqual(Playback.Stopped())),
      Command.expectExact(StopAudio),
      Command.resolve(StopAudio, Message.CompletedStopAudio()),
    )
  })

  test("picking a playback speed stores it and sets the audio rate", () => {
    story(
      update,
      given(baseModel()),
      message(Message.ClickedPickerTrigger({ pickerId: "PlaybackSpeed" })),
      Command.resolve(FocusPicker, Message.CompletedFocusPicker()),
      message(Message.ClickedPickerItem({ pickerId: "PlaybackSpeed", index: 3 })),
      model((next) => {
        expect(next.rate).toBe(1.5)
        expect(next.picker._tag).toBe("Closed")
      }),
      Command.expectExact(FocusPickerTrigger, StoreSetting, SetAudioRate),
      Command.resolve(FocusPickerTrigger, Message.CompletedFocusPickerTrigger()),
      Command.resolve(StoreSetting, Message.CompletedStoreSetting()),
      Command.resolve(SetAudioRate, Message.CompletedSetAudioRate()),
    )
  })
})
