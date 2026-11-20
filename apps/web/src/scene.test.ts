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
import { describe, test } from "vitest"
import { LoadChapter, ToggleAudio } from "~/audio"
import {
  CreateEpisodeFromSource,
  FetchEpisodes,
  FetchFeed,
  FocusAddText,
  SavePosition,
  StoreConnection,
} from "~/command"
import { baseModel, harbourDays, queuedArticle, withEpisodes } from "~/fixture"
import { Message } from "~/message"
import { update } from "~/update"
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
  test("Save stores the token, refetches, and closes the dialog", () => {
    scene(
      { update, view },
      given(withEpisodes(baseModel(), [])),
      click(role("button", { name: "Settings" })),
      Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Command.resolve(FetchFeed, Message.SucceededFetchFeed({ url: "http://localhost:8788/feed/t/rss.xml" })),
      expect(role("dialog", { name: "Settings" })).toExist(),
      expect(role("button", { name: "Copy feed URL" })).toBeEnabled(),
      type(role("textbox", { name: "API token" }), "-2"),
      click(role("button", { name: "Save" })),
      Command.expectExact(StoreConnection, FetchEpisodes, FetchFeed, Dialog.CloseDialog),
      Command.resolve(StoreConnection, Message.CompletedStoreSetting()),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ episodes: [] })),
      Command.resolve(FetchFeed, Message.SucceededFetchFeed({ url: "http://localhost:8788/feed/t/rss.xml" })),
      Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
      Mount.expectEnded(Dialog.AcquireResources),
      expect(role("dialog", { name: "Settings" })).toBeAbsent(),
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
