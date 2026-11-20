import { Dialog } from "@foldkit/ui"
import { Option, Redacted } from "effect"
import { Command, given, message, model, story } from "foldkit/story"
import { describe, expect, test } from "vitest"
import { LoadChapter, SeekAudio, SetAudioRate, StopAudio, ToggleAudio } from "~/audio"
import {
  CopyFeedUrl,
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
  ScrollPickerItem,
  WaitBeforeResetCopied,
  WaitBeforeResetTypeAhead,
} from "~/command"
import { Message } from "~/message"
import { apiToken } from "~/api"
import { Feed, Picker, Playback } from "~/model"
import type { Voice, VoiceRef } from "@fama/contracts"
import { baseModel, connection, harbourDays, queuedArticle, runningHarbourDays, withEpisodes } from "~/fixture"
import { update } from "~/update"

const unauthorized = { status: 401, message: "The API token is wrong or missing" }

describe("library", () => {
  test("the first 401 opens Settings, a second 401 in a row does not", () => {
    story(
      update,
      given(baseModel()),
      message(Message.FailedFetchEpisodes({ connection, failure: unauthorized })),
      model((next) => expect(next.settingsDialog.isOpen).toBe(true)),
      Command.expectExact(Dialog.ShowDialog, FetchFeed),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(FetchFeed, Message.FailedFetchFeed({ connection, failure: unauthorized })),
    )
    const stillUnauthorized = { ...baseModel(), maybeLibraryFailure: Option.some(unauthorized) }
    story(
      update,
      given(stillUnauthorized),
      message(Message.FailedFetchEpisodes({ connection, failure: unauthorized })),
      model((next) => expect(next.settingsDialog.isOpen).toBe(false)),
      Command.expectNone(),
    )
  })

  test("a late library response for a previous connection is dropped: a 401 does not reopen Settings", () => {
    const oldConnection = { origin: "", token: apiToken("old-token") }
    story(
      update,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.FailedFetchEpisodes({ connection: oldConnection, failure: unauthorized })),
      model((next) => {
        expect(next.settingsDialog.isOpen).toBe(false)
        expect(next.maybeLibraryFailure).toEqual(Option.none())
      }),
      Command.expectNone(),
      message(Message.SucceededFetchEpisodes({ connection: oldConnection, episodes: [queuedArticle] })),
      model((next) => expect(Option.getOrThrow(next.maybeEpisodes)).toEqual([harbourDays])),
    )
  })

  test("a poll tick refetches, and the result replaces the list", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [queuedArticle])),
      message(Message.TickedPoll()),
      Command.expectExact(FetchEpisodes),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ connection, episodes: [harbourDays] })),
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

describe("settings", () => {
  const oldConnection = { origin: "", token: apiToken("old-token") }
  const newFeed = "http://localhost:8788/feed/new/rss.xml"

  test("a late feed response for a previous connection does not replace the current feed", () => {
    story(
      update,
      given({ ...baseModel(), feed: Feed.Ready({ url: newFeed }) }),
      message(Message.SucceededFetchFeed({ connection: oldConnection, url: "http://localhost:8788/feed/old/rss.xml" })),
      model((next) => expect(next.feed).toEqual(Feed.Ready({ url: newFeed }))),
      message(Message.FailedFetchFeed({ connection: oldConnection, failure: { status: 500, message: "Boom" } })),
      model((next) => expect(next.feed).toEqual(Feed.Ready({ url: newFeed }))),
    )
  })

  test("Copy feed URL shows Copied until its own timer ends", () => {
    story(
      update,
      given({ ...baseModel(), feed: Feed.Ready({ url: newFeed }) }),
      message(Message.ClickedCopyFeedUrl()),
      Command.resolve(CopyFeedUrl, Message.SucceededCopyFeedUrl()),
      model((next) => expect(next.isFeedUrlCopied).toBe(true)),
      Command.expectExact(WaitBeforeResetCopied({ copy: 1 })),
      Command.resolve(WaitBeforeResetCopied, Message.CompletedWaitBeforeResetCopied({ copy: 1 })),
      model((next) => expect(next.isFeedUrlCopied).toBe(false)),
    )
  })

  test("the timer of an earlier copy does not clear the Copied of a later one", () => {
    // Copy, close, reopen and copy again within 1.5 s: the first timer ends while the second copy shows Copied.
    story(
      update,
      given({ ...baseModel(), feed: Feed.Ready({ url: newFeed }), isFeedUrlCopied: true, feedUrlCopies: 2 }),
      message(Message.CompletedWaitBeforeResetCopied({ copy: 1 })),
      model((next) => expect(next.isFeedUrlCopied).toBe(true)),
      message(Message.CompletedWaitBeforeResetCopied({ copy: 2 })),
      model((next) => expect(next.isFeedUrlCopied).toBe(false)),
    )
  })

  test("a token saved in another tab refetches the library, and the feed while Settings is open", () => {
    const otherTab = { origin: "", token: apiToken("token-from-another-tab") }
    const open = baseModel()
    story(
      update,
      given({ ...open, settingsDialog: { ...open.settingsDialog, isOpen: true }, feed: Feed.Ready({ url: newFeed }) }),
      message(Message.ChangedStoredConnection({ connection: otherTab })),
      model((next) => {
        expect(next.connection.origin).toBe("")
        expect(Redacted.value(next.connection.token)).toBe("token-from-another-tab")
        expect(next.feed).toEqual(Feed.Loading())
      }),
      Command.expectExact(FetchEpisodes, FetchFeed),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ connection: otherTab, episodes: [] })),
      Command.resolve(FetchFeed, Message.SucceededFetchFeed({ connection: otherTab, url: newFeed })),
    )
  })

  test("a storage event with the same connection does nothing", () => {
    story(
      update,
      given(baseModel()),
      message(Message.ChangedStoredConnection({ connection: { origin: "", token: apiToken("dev-api-token") } })),
      Command.expectNone(),
    )
  })

  test("a feed response for the current connection shows the feed", () => {
    story(
      update,
      given(baseModel()),
      message(Message.SucceededFetchFeed({ connection, url: newFeed })),
      model((next) => expect(next.feed).toEqual(Feed.Ready({ url: newFeed }))),
    )
  })
})

describe("menus", () => {
  const voices: ReadonlyArray<Voice> = ["Heart", "Sarah", "Sky", "Steinn"].map((name) => ({
    id: `kokoro:${name.toLowerCase()}` as VoiceRef,
    engine: "kokoro",
    name,
    language: "en",
    gender: null,
  }))
  const voiceMenu = (typedText: string, active: number) => ({
    ...baseModel(),
    voices,
    picker: Picker.Open({ pickerId: "Voice", maybeActiveIndex: Option.some(active), typedText }),
    typeAheadKeys: typedText.length,
  })
  const activeIndex = (next: { picker: Picker }) => next.picker._tag === "Open" && Option.getOrNull(next.picker.maybeActiveIndex)

  test("keys typed close together make one prefix: S, t, e goes to Steinn", () => {
    story(
      update,
      given(voiceMenu("s", 2)),
      message(Message.PressedPickerKey({ key: "t" })),
      model((next) => expect(activeIndex(next)).toBe(4)),
      Command.expectExact(WaitBeforeResetTypeAhead({ keys: 2 }), ScrollPickerItem),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      Command.resolve(WaitBeforeResetTypeAhead, Message.CompletedWaitBeforeResetTypeAhead({ keys: 2 })),
      model((next) => expect(next.picker._tag === "Open" && next.picker.typedText).toBe("")),
    )
  })

  test("the reset timer of an earlier key keeps the prefix of a later one", () => {
    story(
      update,
      given(voiceMenu("st", 4)),
      message(Message.CompletedWaitBeforeResetTypeAhead({ keys: 1 })),
      model((next) => expect(next.picker._tag === "Open" && next.picker.typedText).toBe("st")),
    )
  })

  test("a key with no match clears the prefix, so the next key starts a new search", () => {
    story(
      update,
      given(voiceMenu("", 0)),
      message(Message.PressedPickerKey({ key: "x" })),
      model((next) => {
        expect(activeIndex(next)).toBe(0)
        expect(next.picker._tag === "Open" && next.picker.typedText).toBe("")
      }),
      // An empty prefix has nothing to reset, so `s` right after `x` starts a new search.
      Command.expectNone(),
      message(Message.PressedPickerKey({ key: "s" })),
      model((next) => expect(activeIndex(next)).toBe(2)),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      Command.resolve(WaitBeforeResetTypeAhead, Message.CompletedWaitBeforeResetTypeAhead({ keys: 2 })),
    )
  })

  test("Space inside a typed prefix extends the search; with no prefix it selects", () => {
    const spaced: ReadonlyArray<Voice> = ["Heart", "The Beginning", "The End"].map((name) => ({
      id: `kokoro:${name.toLowerCase().replace(" ", "_")}` as VoiceRef,
      engine: "kokoro",
      name,
      language: "en",
      gender: null,
    }))
    const spacedMenu = (typedText: string, active: number) => ({
      ...voiceMenu(typedText, active),
      voices: spaced,
    })
    story(
      update,
      given(spacedMenu("the", 2)),
      message(Message.PressedPickerKey({ key: " " })),
      model((next) => {
        expect(next.picker._tag === "Open" && next.picker.typedText).toBe("the ")
        expect(activeIndex(next)).toBe(2)
      }),
      Command.expectExact(WaitBeforeResetTypeAhead({ keys: 4 }), ScrollPickerItem),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      Command.resolve(WaitBeforeResetTypeAhead, Message.CompletedWaitBeforeResetTypeAhead({ keys: 4 })),
    )
    story(
      update,
      given(spacedMenu("the ", 2)),
      message(Message.PressedPickerKey({ key: "E" })),
      model((next) => expect(activeIndex(next)).toBe(3)),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      Command.resolve(WaitBeforeResetTypeAhead, Message.CompletedWaitBeforeResetTypeAhead({ keys: 5 })),
    )
    story(
      update,
      given(spacedMenu("", 3)),
      message(Message.PressedPickerKey({ key: " " })),
      model((next) => {
        expect(next.picker._tag).toBe("Closed")
        expect(Option.getOrNull(next.maybeVoice)).toBe("kokoro:the_end")
      }),
      Command.expectExact(FocusPickerTrigger, StoreSetting),
      Command.resolve(FocusPickerTrigger, Message.CompletedFocusPickerTrigger()),
      Command.resolve(StoreSetting, Message.CompletedStoreSetting()),
    )
  })

  test("the same letter again cycles through the items that start with it", () => {
    story(
      update,
      given(voiceMenu("s", 2)),
      message(Message.PressedPickerKey({ key: "s" })),
      model((next) => expect(activeIndex(next)).toBe(3)),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      Command.resolve(WaitBeforeResetTypeAhead, Message.CompletedWaitBeforeResetTypeAhead({ keys: 2 })),
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
      message(Message.SucceededFetchEpisodes({ connection, episodes: [harbourDays] })),
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
