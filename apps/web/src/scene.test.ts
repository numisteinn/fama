import { Dialog } from "@foldkit/ui"
import {
  Command,
  Mount,
  Subscription,
  changeFiles,
  click,
  expect,
  given,
  inside,
  keydown,
  role,
  scene,
  selector,
  type,
} from "foldkit/scene"
import { Option, Redacted } from "effect"
import { describe, test, expect as expectValue } from "vitest"
import { LoadChapter, ToggleAudio } from "~/audio"
import {
  CreateEpisodeFromSource,
  FILE_INPUT_ID,
  FetchEpisodes,
  FetchFeed,
  FocusAddText,
  FocusPicker,
  FocusPickerTrigger,
  PushProgress,
  ReadStoredProgress,
  SaveProgress,
  ScrollPickerItem,
  StoreSetting,
  StoreConnection,
  WaitBeforeResetTypeAhead,
} from "~/command"
import { baseModel, connection, harbourDays, progressAt, queuedArticle, withEpisodes } from "~/fixture"
import { Message } from "~/message"
import { Playback, StoredProgress } from "~/model"
import { apiToken } from "~/api"
import { update } from "~/update"
import { OpenFilePickerOnKey } from "~/view/addBar"
import { AnchorPicker, pickerSide } from "~/view/picker"
import type { Voice, VoiceRef } from "@fama/contracts"
import type { Message as AppMessage } from "~/message"
import { view } from "~/view"

const linkOrText = role("textbox", { name: "Link or text" })
/** The add bar is always on screen, so every scene starts its Attach file key Mount. */
const resolveAttachKeys = Mount.resolve(OpenFilePickerOnKey, Message.CompletedMountFilePickerKeys())

describe("add a link", () => {
  test("Enter adds a Queued row with the provisional title and empties the box", () => {
    scene(
      { update, view },
      given(withEpisodes(baseModel(), [])),
      resolveAttachKeys,
      expect(role("button", { name: "Add" })).toBeDisabled(),
      type(linkOrText, "http://localhost:8790/article.html"),
      expect(role("button", { name: "Add" })).toBeEnabled(),
      keydown(linkOrText, "Enter"),
      Command.expectExact(CreateEpisodeFromSource),
      Command.resolve(CreateEpisodeFromSource, Message.SucceededCreateEpisode({ episode: queuedArticle })),
      Command.resolve(FocusAddText, Message.CompletedFocusAddText()),
      expect(linkOrText).toHaveValue(""),
      inside(
        role("listitem"),
        expect(role("button", { name: "Play localhost:8790/article.html" })).toBeDisabled(),
        expect(role("button", { name: "Delete localhost:8790/article.html" })).toExist(),
      ),
    )
  })
})

describe("attach a file", () => {
  // The click itself opens the picker natively, in the browser; the live check covers it.
  test("Attach file is a label for the file input, so the click opens the picker natively", () => {
    scene(
      { update, view },
      given(withEpisodes(baseModel(), [])),
      expect(role("button", { name: "Attach file" })).toHaveAttr("htmlFor", FILE_INPUT_ID),
      expect(role("button", { name: "Attach file" })).toHaveAttr("tabIndex", "0"),
      expect(selector(`#${FILE_INPUT_ID}`)).toHaveAttr("type", "file"),
      Mount.expectExact(OpenFilePickerOnKey),
      resolveAttachKeys,
      changeFiles(`#${FILE_INPUT_ID}`, [new File(["book"], "harbour-days.epub", { type: "application/epub+zip" })]),
      expect(role("button", { name: "Remove file" })).toExist(),
      expect(role("button", { name: "Add" })).toBeEnabled(),
    )
  })
})

describe("settings", () => {
  const savedConnection = { origin: "", token: apiToken("-2") }

  test("Save stores the token, refetches, and closes the dialog", () => {
    scene(
      { update, view },
      given(withEpisodes(baseModel(), [])),
      resolveAttachKeys,
      click(role("button", { name: "Settings" })),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Command.resolve(FetchFeed, Message.SucceededFetchFeed({ request: 1, url: "http://localhost:8788/feed/t/rss.xml" })),
      expect(role("dialog", { name: "Settings" })).toExist(),
      expect(role("button", { name: "Copy feed URL" })).toBeEnabled(),
      type(role("textbox", { name: "API token" }), "-2"),
      click(role("button", { name: "Save" })),
      Command.expectExact(
        StoreConnection,
        FetchEpisodes({ connection: savedConnection, generation: 1 }),
        FetchFeed({ connection: savedConnection, request: 2 }),
        Dialog.CloseDialog,
      ),
      Command.resolve(StoreConnection, Message.CompletedStoreSetting()),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ generation: 1, episodes: [] })),
      Command.resolve(FetchFeed, Message.SucceededFetchFeed({ request: 2, url: "http://localhost:8788/feed/t/rss.xml" })),
      Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
      Mount.expectEnded(Dialog.AcquireResources),
      expect(role("dialog", { name: "Settings" })).toBeAbsent(),
    )
  })

  test("the token Message is Redacted from the moment it is built", () => {
    const seen: Array<AppMessage> = []
    const recordingUpdate: typeof update = (model, message) => {
      seen.push(message)
      return update(model, message)
    }
    scene(
      { update: recordingUpdate, view },
      given(withEpisodes(baseModel(), [])),
      resolveAttachKeys,
      click(role("button", { name: "Settings" })),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Command.resolve(FetchFeed, Message.SucceededFetchFeed({ request: 1, url: "http://localhost:8788/feed/t/rss.xml" })),
      type(role("textbox", { name: "API token" }), "typed-secret"),
      expect(role("textbox", { name: "API token" })).toHaveValue("typed-secret"),
    )
    const tokenMessages = seen.filter((message) => message._tag === "UpdatedTokenDraft")
    expectValue(tokenMessages.length).toBeGreaterThan(0)
    for (const message of tokenMessages) expectValue(Redacted.isRedacted(message.value)).toBe(true)
    expectValue(JSON.stringify(tokenMessages)).not.toContain("typed-secret")
  })
})

describe("menus", () => {
  const voice = (id: string, name: string, language: string): Voice => ({
    id: id as VoiceRef,
    engine: "kokoro",
    name,
    language,
    gender: null,
  })
  const voices = [voice("kokoro:af_heart", "Heart", "en"), voice("kokoro:af_sarah", "Sarah", "en"), voice("piper:steinn", "Steinn", "is")]
  const voiceMenu = role("menu")

  test("typing a letter moves to the next item that starts with it", () => {
    scene(
      { update, view },
      given({ ...withEpisodes(baseModel(), []), voices }),
      resolveAttachKeys,
      click(role("button", { name: "Voice: Auto" })),
      Command.resolve(FocusPicker, Message.CompletedFocusPicker()),
      Mount.resolve(AnchorPicker, Message.CompletedAnchorPicker()),
      keydown(voiceMenu, "s"),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      Command.resolve(WaitBeforeResetTypeAhead, Message.CompletedWaitBeforeResetTypeAhead({ keys: 1 })),
      expect(voiceMenu).toHaveAttr("aria-activedescendant", "voice-item-2"),
      keydown(voiceMenu, "S"),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      Command.resolve(WaitBeforeResetTypeAhead, Message.CompletedWaitBeforeResetTypeAhead({ keys: 2 })),
      expect(voiceMenu).toHaveAttr("aria-activedescendant", "voice-item-3"),
      keydown(voiceMenu, "Enter"),
      Command.resolve(FocusPickerTrigger, Message.CompletedFocusPickerTrigger()),
      Command.resolve(StoreSetting, Message.CompletedStoreSetting()),
      Mount.expectEnded(AnchorPicker),
      expect(role("button", { name: "Voice: Steinn" })).toExist(),
    )
  })
})

describe("menu placement", () => {
  // A 46-voice menu is taller than the 384 px cap, so it needs 384 px.
  const voiceMenu = { contentHeight: 1_500, triggerTop: 0, triggerBottom: 0, viewportHeight: 500 }

  test("a menu near the bottom of a short window opens above its trigger", () => {
    expectValue(pickerSide({ ...voiceMenu, side: "Bottom", triggerTop: 400, triggerBottom: 432 })).toBe("Top")
  })

  test("a menu keeps its side when that side has room, or more room than the other", () => {
    expectValue(pickerSide({ ...voiceMenu, side: "Bottom", triggerTop: 60, triggerBottom: 92 })).toBe("Bottom")
    expectValue(pickerSide({ ...voiceMenu, side: "Bottom", viewportHeight: 300, triggerTop: 100, triggerBottom: 132 })).toBe(
      "Bottom",
    )
    expectValue(pickerSide({ ...voiceMenu, side: "Top", triggerTop: 440, triggerBottom: 472 })).toBe("Top")
  })
})

describe("chapters menu", () => {
  test("typing a chapter number highlights that chapter, as the item shows it", () => {
    const loaded = {
      ...withEpisodes(baseModel(), [harbourDays]),
      playback: Playback.Loaded({
        episodeId: harbourDays.id,
        chapter: 0,
        offsetMs: 0,
        isPlaying: false,
        isWaiting: false,
        isEnded: false,
      }),
    }
    const chaptersMenu = role("menu")
    scene(
      { update, view },
      given(loaded),
      resolveAttachKeys,
      click(role("button", { name: "Chapters" })),
      Command.resolve(FocusPicker, Message.CompletedFocusPicker()),
      Mount.resolve(AnchorPicker, Message.CompletedAnchorPicker()),
      expect(role("menuitemradio", { name: "1 Morning" })).toExist(),
      expect(role("menuitemradio", { name: "2 Evening" })).toExist(),
      keydown(chaptersMenu, "2"),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      Command.resolve(WaitBeforeResetTypeAhead, Message.CompletedWaitBeforeResetTypeAhead({ keys: 1 })),
      expect(chaptersMenu).toHaveAttr("aria-activedescendant", "chapters-item-1"),
      keydown(chaptersMenu, "Escape"),
      Command.resolve(FocusPickerTrigger, Message.CompletedFocusPickerTrigger()),
      Mount.expectEnded(AnchorPicker),
    )
  })
})

describe("play and pause", () => {
  test("the row and the player bar toggle between Play and Pause", () => {
    scene(
      { update, view },
      given(withEpisodes(baseModel(), [harbourDays])),
      resolveAttachKeys,
      click(role("button", { name: "Play Harbour Days" })),
      Command.expectExact(ReadStoredProgress),
      Command.resolve(
        ReadStoredProgress,
        Message.GotStoredProgress({ episodeId: harbourDays.id, intent: 1, stored: StoredProgress.NotSaved() }),
      ),
      Command.expectExact(LoadChapter),
      Command.resolve(LoadChapter, Message.CompletedLoadChapter()),
      Subscription.emit(Message.StartedAudio()),
      expect(role("button", { name: "Pause Harbour Days" })).toExist(),
      inside(
        role("contentinfo"),
        expect(role("group", { name: "Position" })).toExist(),
        expect(role("button", { name: "Playback speed: 1×" })).toExist(),
        expect(role("button", { name: "Chapters" })).toExist(),
        expect(role("link", { name: "Download" })).toExist(),
      ),
      click(role("button", { name: /^Pause$/ })),
      Command.expectExact(ToggleAudio),
      Command.resolve(ToggleAudio, Message.CompletedToggleAudio()),
      Subscription.emit(Message.PausedAudio()),
      Command.expectExact(SaveProgress({ episodeId: harbourDays.id, positionMs: 0 })),
      Command.resolve(SaveProgress, Message.SavedProgress({ episodeId: harbourDays.id, progress: progressAt(0) })),
      Command.resolve(PushProgress, Message.FailedPushProgress({ episodeId: harbourDays.id })),
      expect(role("button", { name: "Play Harbour Days" })).toExist(),
      click(role("button", { name: /^Play$/ })),
      Command.resolve(ToggleAudio, Message.CompletedToggleAudio()),
    )
  })
})
