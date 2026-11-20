import { Dialog } from "@foldkit/ui"
import {
  Command,
  Mount,
  Subscription,
  click,
  expect,
  given,
  inside,
  keydown,
  role,
  scene,
  type,
} from "foldkit/scene"
import { Redacted } from "effect"
import { describe, test, expect as expectValue } from "vitest"
import { LoadChapter, ToggleAudio } from "~/audio"
import {
  CreateEpisodeFromSource,
  FetchEpisodes,
  FetchFeed,
  FocusAddText,
  FocusPicker,
  FocusPickerTrigger,
  SavePosition,
  ScrollPickerItem,
  StoreSetting,
  StoreConnection,
} from "~/command"
import { baseModel, connection, harbourDays, queuedArticle, withEpisodes } from "~/fixture"
import { Message } from "~/message"
import { apiToken } from "~/api"
import { update } from "~/update"
import { AnchorPicker } from "~/view/picker"
import type { Voice, VoiceRef } from "@fama/contracts"
import type { Message as AppMessage } from "~/message"
import { view } from "~/view"

const linkOrText = role("textbox", { name: "Link or text" })

describe("add a link", () => {
  test("Enter adds a Queued row with the provisional title and empties the box", () => {
    scene(
      { update, view },
      given(withEpisodes(baseModel(), [])),
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

describe("settings", () => {
  const savedConnection = { origin: "", token: apiToken("-2") }

  test("Save stores the token, refetches, and closes the dialog", () => {
    scene(
      { update, view },
      given(withEpisodes(baseModel(), [])),
      click(role("button", { name: "Settings" })),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Command.resolve(FetchFeed, Message.SucceededFetchFeed({ connection, url: "http://localhost:8788/feed/t/rss.xml" })),
      expect(role("dialog", { name: "Settings" })).toExist(),
      expect(role("button", { name: "Copy feed URL" })).toBeEnabled(),
      type(role("textbox", { name: "API token" }), "-2"),
      click(role("button", { name: "Save" })),
      Command.expectExact(StoreConnection, FetchEpisodes, FetchFeed, Dialog.CloseDialog),
      Command.resolve(StoreConnection, Message.CompletedStoreSetting()),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ episodes: [] })),
      Command.resolve(FetchFeed, Message.SucceededFetchFeed({ connection: savedConnection, url: "http://localhost:8788/feed/t/rss.xml" })),
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
      click(role("button", { name: "Settings" })),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Command.resolve(FetchFeed, Message.SucceededFetchFeed({ connection, url: "http://localhost:8788/feed/t/rss.xml" })),
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
      click(role("button", { name: "Voice: Auto" })),
      Command.resolve(FocusPicker, Message.CompletedFocusPicker()),
      Mount.resolve(AnchorPicker, Message.CompletedAnchorPicker()),
      keydown(voiceMenu, "s"),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      expect(voiceMenu).toHaveAttr("aria-activedescendant", "voice-item-2"),
      keydown(voiceMenu, "S"),
      Command.resolve(ScrollPickerItem, Message.CompletedScrollPickerItem()),
      expect(voiceMenu).toHaveAttr("aria-activedescendant", "voice-item-3"),
      keydown(voiceMenu, "Enter"),
      Command.resolve(FocusPickerTrigger, Message.CompletedFocusPickerTrigger()),
      Command.resolve(StoreSetting, Message.CompletedStoreSetting()),
      Mount.expectEnded(AnchorPicker),
      expect(role("button", { name: "Voice: Steinn" })).toExist(),
    )
  })
})

describe("play and pause", () => {
  test("the row and the player bar toggle between Play and Pause", () => {
    scene(
      { update, view },
      given(withEpisodes(baseModel(), [harbourDays])),
      click(role("button", { name: "Play Harbour Days" })),
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
      Command.resolve(SavePosition, Message.CompletedSavePosition()),
      expect(role("button", { name: "Play Harbour Days" })).toExist(),
      click(role("button", { name: /^Play$/ })),
      Command.resolve(ToggleAudio, Message.CompletedToggleAudio()),
    )
  })
})
