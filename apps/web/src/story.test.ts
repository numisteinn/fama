import { Dialog } from "@foldkit/ui"
import { Effect, Option, Redacted } from "effect"
import { Command, type StorySimulation, given, message, model, steps, story } from "foldkit/story"
import { afterEach, describe, expect, test, vi } from "vitest"
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
  ReadSavedPosition,
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
import type { EpisodeId, Voice, VoiceRef } from "@fama/contracts"
import { baseModel, connection, harbourDays, queuedArticle, runningHarbourDays, withEpisodes } from "~/fixture"
import { storageEventMessage } from "~/subscription"
import { update } from "~/update"

const unauthorized = { status: 401, message: "The API token is wrong or missing" }

describe("library", () => {
  test("the first 401 opens Settings, a second 401 in a row does not", () => {
    story(
      update,
      given(baseModel()),
      message(Message.FailedFetchEpisodes({ generation: 0, failure: unauthorized })),
      model((next) => expect(next.settingsDialog.isOpen).toBe(true)),
      Command.expectExact(Dialog.ShowDialog, FetchFeed),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Command.resolve(FetchFeed, Message.FailedFetchFeed({ request: 1, failure: unauthorized })),
    )
    const stillUnauthorized = { ...baseModel(), maybeLibraryFailure: Option.some(unauthorized) }
    story(
      update,
      given(stillUnauthorized),
      message(Message.FailedFetchEpisodes({ generation: 0, failure: unauthorized })),
      model((next) => expect(next.settingsDialog.isOpen).toBe(false)),
      Command.expectNone(),
    )
  })

  test("a late library response for a previous connection is dropped: a 401 does not reopen Settings", () => {
    // The connection changed once since the request went out.
    story(
      update,
      given({ ...withEpisodes(baseModel(), [harbourDays]), connectionGeneration: 1 }),
      message(Message.FailedFetchEpisodes({ generation: 0, failure: unauthorized })),
      model((next) => {
        expect(next.settingsDialog.isOpen).toBe(false)
        expect(next.maybeLibraryFailure).toEqual(Option.none())
      }),
      Command.expectNone(),
      message(Message.SucceededFetchEpisodes({ generation: 0, episodes: [queuedArticle] })),
      model((next) => expect(Option.getOrThrow(next.maybeEpisodes)).toEqual([harbourDays])),
    )
  })

  test("a poll tick refetches, and the result replaces the list", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [queuedArticle])),
      message(Message.TickedPoll()),
      Command.expectExact(FetchEpisodes({ connection, generation: 0 })),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ generation: 0, episodes: [harbourDays] })),
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
  /** What the storage Subscription sends when another tab saves a setting. */
  const storedSettings = (fields: Partial<Omit<Extract<Message, { _tag: "ChangedStoredSettings" }>, "_tag">>) =>
    Message.ChangedStoredSettings({ connection, maybeVoice: Option.none(), speed: 1, rate: 1, ...fields })
  const newFeed = "http://localhost:8788/feed/new/rss.xml"

  test("a late feed response for a previous connection does not replace the current feed", () => {
    story(
      update,
      given({ ...baseModel(), connectionGeneration: 1, feedRequests: 1, feed: Feed.Ready({ url: newFeed }) }),
      message(Message.SucceededFetchFeed({ request: 0, url: "http://localhost:8788/feed/old/rss.xml" })),
      model((next) => expect(next.feed).toEqual(Feed.Ready({ url: newFeed }))),
      message(Message.FailedFetchFeed({ request: 0, failure: { status: 500, message: "Boom" } })),
      model((next) => expect(next.feed).toEqual(Feed.Ready({ url: newFeed }))),
    )
  })

  test("a late feed failure from an earlier Settings open does not replace the feed of a later open", () => {
    const open = (start: ReturnType<typeof baseModel>) => update(start, Message.ClickedSettings()).model
    const first = open(baseModel())
    const second = open({ ...first, settingsDialog: { ...first.settingsDialog, isOpen: false } })
    story(
      update,
      given(second),
      message(Message.SucceededFetchFeed({ request: second.feedRequests, url: newFeed })),
      message(Message.FailedFetchFeed({ request: first.feedRequests, failure: { status: 500, message: "Boom" } })),
      model((next) => expect(next.feed).toEqual(Feed.Ready({ url: newFeed }))),
    )
  })

  test("switching A to B and back to A drops a library response fetched before the switch", () => {
    const tokenB = { origin: "", token: apiToken("token-b") }
    // A poll for A is in flight when another tab saves B, and then A again.
    const polledA = update(withEpisodes(baseModel(), [harbourDays]), Message.TickedPoll())
    const pollA = polledA.commands?.find((command) => command.name === FetchEpisodes.name) as
      | ReturnType<typeof FetchEpisodes>
      | undefined
    if (!pollA) throw new Error("the poll issued no FetchEpisodes")
    story(
      update,
      given(polledA.model),
      message(storedSettings({ connection: tokenB })),
      Command.expectExact(FetchEpisodes({ connection: tokenB, generation: 1 })),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ generation: 1, episodes: [harbourDays] })),
      message(storedSettings({ connection })),
      Command.expectExact(FetchEpisodes({ connection, generation: 2 })),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ generation: 2, episodes: [harbourDays] })),
      // The poll for A from before the switch returns now, with an older list.
      message(Message.SucceededFetchEpisodes({ generation: pollA.args.generation, episodes: [queuedArticle] })),
      model((next) => expect(Option.getOrThrow(next.maybeEpisodes)).toEqual([harbourDays])),
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
      message(storedSettings({ connection: otherTab })),
      model((next) => {
        expect(next.connection.origin).toBe("")
        expect(Redacted.value(next.connection.token)).toBe("token-from-another-tab")
        expect(next.feed).toEqual(Feed.Loading())
      }),
      Command.expectExact(FetchEpisodes, FetchFeed),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ generation: 1, episodes: [] })),
      Command.resolve(FetchFeed, Message.SucceededFetchFeed({ request: 1, url: newFeed })),
    )
  })

  test("a Voice, Voice speed and Playback speed saved in another tab reach the add bar and the audio", () => {
    const sarah = "kokoro:af_sarah" as VoiceRef
    story(
      update,
      given({ ...baseModel(), addText: "A short note." }),
      message(storedSettings({ maybeVoice: Option.some(sarah), speed: 1.2, rate: 2 })),
      model((next) => {
        expect(next.maybeVoice).toEqual(Option.some(sarah))
        expect(next.speed).toBe(1.2)
        expect(next.rate).toBe(2)
      }),
      Command.expectExact(SetAudioRate({ rate: 2 })),
      Command.resolve(SetAudioRate, Message.CompletedSetAudioRate()),
      message(Message.SubmittedAddForm()),
      Command.expectExact(
        CreateEpisodeFromSource({
          connection,
          input: { source: { _tag: "Text", title: null, text: "A short note." }, voice: sarah, speed: 1.2 },
        }),
      ),
      Command.resolve(CreateEpisodeFromSource, Message.SucceededCreateEpisode({ episode: queuedArticle })),
      Command.resolve(FocusAddText, Message.CompletedFocusAddText()),
    )
  })

  test("the storage Subscription follows the token, server, Voice, Voice speed and Playback speed keys", () => {
    localStorage.setItem("fama.voice", JSON.stringify("kokoro:af_sarah"))
    localStorage.setItem("fama.speed", "1.2")
    localStorage.setItem("fama.rate", "2")
    try {
      for (const key of ["fama.token", "fama.origin", "fama.voice", "fama.speed", "fama.rate", null]) {
        const maybeMessage = storageEventMessage(key)
        expect(Option.isSome(maybeMessage)).toBe(true)
        const changed = Option.getOrThrow(maybeMessage)
        expect(changed._tag === "ChangedStoredSettings" && [Option.getOrNull(changed.maybeVoice), changed.speed, changed.rate]).toEqual([
          "kokoro:af_sarah",
          1.2,
          2,
        ])
      }
      expect(storageEventMessage("fama.position.harbour-days")).toEqual(Option.none())
    } finally {
      localStorage.clear()
    }
  })

  test("a storage event with the same settings does nothing", () => {
    story(
      update,
      given(baseModel()),
      message(storedSettings({ connection: { origin: "", token: apiToken("dev-api-token") } })),
      Command.expectNone(),
    )
  })

  test("a feed response for the current connection shows the feed", () => {
    story(
      update,
      given(baseModel()),
      message(Message.SucceededFetchFeed({ request: 0, url: newFeed })),
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
    // The prefix started with nothing highlighted.
    picker: Picker.Open({ pickerId: "Voice", maybeActiveIndex: Option.some(active), typedText, typeAheadFrom: -1 }),
    typeAheadKeys: typedText.length,
  })
  const activeIndex = (next: { picker: Picker }) => next.picker._tag === "Open" && Option.getOrNull(next.picker.maybeActiveIndex)
  /** Voices with these names, all in one language, so the Voice menu is Auto and then the names in order. */
  const named = (names: ReadonlyArray<string>): ReadonlyArray<Voice> =>
    names.map((name) => ({ id: `kokoro:${name.toLowerCase()}` as VoiceRef, engine: "kokoro", name, language: "en", gender: null }))
  /**
   * A key in the open menu that highlights an item. The next key comes within 750 ms, so this key's reset
   * timer ends after it, stale: a Story must resolve it first, so it resolves with a key count no key has.
   */
  const typeKey = (key: string) =>
    steps(
      message(Message.PressedPickerKey({ key })),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      Command.resolve(WaitBeforeResetTypeAhead, Message.CompletedWaitBeforeResetTypeAhead({ keys: -1 })),
    )
  /** The last key of a prefix: 750 ms pass and its reset timer, the `keys`th, clears the prefix. */
  const typeLastKey = (key: string, keys: number) =>
    steps(
      message(Message.PressedPickerKey({ key })),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      Command.resolve(WaitBeforeResetTypeAhead, Message.CompletedWaitBeforeResetTypeAhead({ keys })),
    )

  test("after cycling with a repeated letter, the next key extends it: s, s, k goes to Sky", () => {
    story(
      update,
      given({ ...baseModel(), voices: named(["Santa", "Sarah", "Sky"]) }),
      message(Message.ClickedPickerTrigger({ pickerId: "Voice" })),
      Command.resolve(FocusPicker, Message.CompletedFocusPicker()),
      typeKey("s"),
      model((next) => expect(activeIndex(next)).toBe(1)),
      typeKey("s"),
      model((next) => expect(activeIndex(next)).toBe(2)),
      typeLastKey("k", 3),
      model((next) => {
        expect(activeIndex(next)).toBe(3)
        expect(next.picker._tag === "Open" && next.picker.typedText).toBe("")
      }),
    )
  })

  test("a list with a doubled first letter does not cycle: l, l searches for `ll`, as in base-ui", () => {
    story(
      update,
      given({ ...baseModel(), voices: named(["Lara", "Llama", "Lukas"]) }),
      message(Message.ClickedPickerTrigger({ pickerId: "Voice" })),
      Command.resolve(FocusPicker, Message.CompletedFocusPicker()),
      typeKey("l"),
      model((next) => expect(activeIndex(next)).toBe(1)),
      typeLastKey("l", 2),
      model((next) => expect(activeIndex(next)).toBe(2)),
    )
  })

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
  /** The ReadSavedPosition Commands update returned, oldest first, so a step can run their real storage read. */
  const issuedReads: Array<ReturnType<typeof ReadSavedPosition>> = []
  const updateKeepingReads: typeof update = (current, sent) => {
    const result = update(current, sent)
    for (const command of result.commands ?? []) {
      if (command.name === ReadSavedPosition.name) issuedReads.push(command as ReturnType<typeof ReadSavedPosition>)
    }
    return result
  }
  /** Runs the oldest ReadSavedPosition against the real localStorage and feeds its Message back. */
  const readStorage = <M, Msg, Out>(simulation: StorySimulation<M, Msg, Out>): StorySimulation<M, Msg, Out> => {
    const command = issuedReads.shift()
    if (!command) throw new Error("update issued no ReadSavedPosition")
    return Command.resolve(command, Effect.runSync(command.effect))(simulation)
  }
  const savePositionInStorage = (positionMs: number) =>
    localStorage.setItem(`fama.position.${harbourDays.id}`, JSON.stringify(positionMs))

  afterEach(() => {
    localStorage.clear()
    issuedReads.length = 0
  })

  test("play reads the latest saved position from storage, not the one read at boot", () => {
    // Another tab paused at 30 s after this tab booted with 5 s.
    savePositionInStorage(30_000)
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel({ [harbourDays.id]: 5_000 }), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      model((next) => expect(next.playback).toEqual(Playback.Stopped())),
      Command.expectExact(ReadSavedPosition),
      readStorage,
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
        expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(30_000 - 26_825)
      }),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
    )
  })

  test("with no position in storage, play starts at 0, even after this session saved one", () => {
    // The user cleared site data while Fama was open.
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel({ [harbourDays.id]: 30_000 }), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(0)
        expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(0)
      }),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
    )
  })

  test("with storage unreadable, play falls back to the position saved in this session", () => {
    savePositionInStorage(5_000)
    const blocked = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError")
    })
    try {
      story(
        updateKeepingReads,
        given(withEpisodes(baseModel({ [harbourDays.id]: 30_000 }), [harbourDays])),
        message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
        readStorage,
        model((next) => {
          expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
          expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(30_000 - 26_825)
        }),
        Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
      )
    } finally {
      blocked.mockRestore()
    }
  })

  test("play resumes at the saved position, across chapters", () => {
    savePositionInStorage(30_000)
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
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
    savePositionInStorage(45_000)
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(0)),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
    )
  })

  test("Pause on A while Play on B still reads storage: B's late read does not start B", () => {
    const tideTables = { ...harbourDays, id: "tide-tables" as EpisodeId, title: "Tide Tables" }
    const playingA = {
      ...withEpisodes(baseModel(), [harbourDays, tideTables]),
      playback: Playback.Loaded({
        episodeId: harbourDays.id,
        chapter: 0,
        offsetMs: 1_000,
        isPlaying: true,
        isWaiting: false,
        isEnded: false,
      }),
    }
    // Play on B. Its storage read is still running when the user clicks Pause on A.
    const clickedB = update(playingA, Message.ClickedPlayEpisode({ episodeId: tideTables.id }))
    const readB = clickedB.commands?.find((command) => command.name === ReadSavedPosition.name) as
      | ReturnType<typeof ReadSavedPosition>
      | undefined
    if (!readB) throw new Error("Play on B issued no ReadSavedPosition")
    story(
      update,
      given(clickedB.model),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      Command.expectExact(ToggleAudio),
      Command.resolve(ToggleAudio, Message.CompletedToggleAudio()),
      message(Message.PausedAudio()),
      Command.resolve(SavePosition, Message.CompletedSavePosition()),
      // B's read returns now, late.
      message(Effect.runSync(readB.effect)),
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.episodeId).toBe(harbourDays.id)
        expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(false)
      }),
      Command.expectNone(),
    )
  })

  test("the end of a chapter waits for the next one, then plays it when it renders", () => {
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [runningHarbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
      message(Message.EndedChapter()),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.isWaiting).toBe(true)),
      Command.expectNone(),
      message(Message.SucceededFetchEpisodes({ generation: 0, episodes: [harbourDays] })),
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
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
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
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
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
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
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
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
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
