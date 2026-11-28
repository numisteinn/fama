import type { Voice, VoiceRef } from "@fama/contracts"
import { Component } from "@effect/ui"
import { HtmlCommand } from "@effect/ui/html"
import { HtmlLocator, HtmlPlay, HtmlScene } from "@effect/ui/html/testing"
import { Locator, Story, TestHost } from "@effect/ui/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { AppComponent } from "~/App"
import { apiToken } from "~/core/api"
import { LoadChapter, PauseAudio, PlayAudio } from "~/core/audio"
import {
  CreateEpisodeFromSource,
  FetchEpisodes,
  FetchVoices,
  PushProgress,
  ReadStoredProgress,
  SaveProgress,
  StoreConnection,
  UploadEpisode,
} from "~/command"
import { Picker, PickerEvents } from "~/ui/Picker"
import {
  CopyFeedUrl,
  SettingsForm,
  SettingsFormEvents,
  SettingsFormMessage,
} from "~/components/SettingsDialog"
import {
  baseModel,
  defaultFlags,
  harbourDays,
  progressAt,
  queuedArticle,
  runningHarbourDays,
  withEpisodes,
} from "~/fixture"
import { AppMessage } from "~/message"
import { StoredProgress } from "~/core/flags"
import { FamaApi } from "~/core/services"
import { FILE_INPUT_ID } from "~/ui/refs"
import { OpenFilePickerOnKey } from "~/view/addBar"
import { sleepOptions } from "~/view/playerBar"
import { SleepTimer, sleepBadge, sleepLabel } from "~/playback/sleepTimer"
import { required } from "../../../test/required.ts"

const linkOrText = HtmlLocator.role("textbox", { name: "Link or text" })
const fileInput = Locator.attr("id", FILE_INPUT_ID)

describe("add a link", () => {
  it.effect("Enter adds a Queued row with the provisional title and empties the box", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(AppComponent, defaultFlags())
      s.given(withEpisodes(baseModel(), []))
        .expectMount(OpenFilePickerOnKey())
        .expect(HtmlLocator.role("button", { name: "Add" })).toBeDisabled()
        .type(linkOrText, "http://localhost:8790/article.html")
        .expect(HtmlLocator.role("button", { name: "Add" })).toBeDisabled(false)
        .keydown(linkOrText, "Enter")
        .expectExact(CreateEpisodeFromSource)
        .resolve(CreateEpisodeFromSource, AppMessage.SucceededCreateEpisode({ episode: queuedArticle }))
        .resolve(HtmlCommand.Focus, { found: true })
        .expect(linkOrText).toHaveValue("")
        .expect(
          Locator.inside(
            HtmlLocator.role("listitem"),
            HtmlLocator.role("button", { name: "Play localhost:8790/article.html" }),
          ),
        ).toBeDisabled()
        .expect(
          Locator.inside(
            HtmlLocator.role("listitem"),
            HtmlLocator.role("button", { name: "Delete localhost:8790/article.html" }),
          ),
        ).toExist()
    }),
  )
})

describe("attach a file", () => {
  it.effect("Attach file is a label for the file input, so the click opens the picker natively", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(AppComponent, defaultFlags())
      s.given(withEpisodes(baseModel(), []))
        .expectMount(OpenFilePickerOnKey())
        .expect(HtmlLocator.role("button", { name: "Attach file" })).toHaveAttribute("for", FILE_INPUT_ID)
        .expect(HtmlLocator.role("button", { name: "Attach file" })).toHaveAttribute("tabindex", "0")
        .expect(fileInput).toHaveAttribute("type", "file")
        .change(fileInput, {
          files: [new File(["book"], "harbour-days.epub", { type: "application/epub+zip" })],
        })
        .expect(HtmlLocator.role("button", { name: "Remove harbour-days.epub" })).toExist()
        .expect(HtmlLocator.role("button", { name: "Add" })).toBeDisabled(false)
    }),
  )

  it.effect("each file of a batch has its row; a refused or failed file says why, and a failed one has Retry", () =>
    Effect.gen(function* () {
      const epub = new File(["book"], "harbour-days.epub")
      const png = new File(["png"], "cover.png")
      const s = yield* HtmlScene.make(AppComponent, defaultFlags())
      s.given(withEpisodes(baseModel(), []))
        .expectMount(OpenFilePickerOnKey())
        .change(fileInput, { files: [epub, png] })
        .expect(linkOrText).toBeAbsent()
        .expect(HtmlLocator.role("button", { name: "Remove harbour-days.epub" })).toExist()
        .expect(HtmlLocator.role("button", { name: "Remove cover.png" })).toExist()
        .expect(HtmlLocator.role("alert")).toHaveText("Unsupported type")
        .click(HtmlLocator.role("button", { name: "Add" }))
        .resolve(
          UploadEpisode,
          AppMessage.FailedUploadFile({ key: 0, failure: { status: 413, message: "The file is too large" } }),
        )
        .expect(HtmlLocator.role("button", { name: "Retry harbour-days.epub" })).toExist()
        .expect(HtmlLocator.role("button", { name: "Add" })).toBeDisabled()
        .click(HtmlLocator.role("button", { name: "Remove harbour-days.epub" }))
        .click(HtmlLocator.role("button", { name: "Remove cover.png" }))
        .resolve(HtmlCommand.Focus, { found: true })
        .expect(linkOrText).toExist()
    }),
  )
})

describe("settings", () => {
  const savedConnection = { origin: "", token: apiToken("dev-api-token-2") }
  const feedUrl = Redacted.make("http://localhost:8788/feed/secret-feed-token/rss.xml")

  it.effect("SettingsForm loads FeedQuery, copies URL with Copied state, redacts token and feed URL, and emits Saved", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(SettingsForm, {
        initialConnection: { origin: "", token: apiToken("dev-api-token") },
        connectionGeneration: 0,
        openId: 1,
      })
      s.loaded("feed", { url: feedUrl }, { waiting: true })
        .expect(Locator.text("http://localhost:8788/feed/secret-feed-token/rss.xml")).toBeAbsent()
        .expect(HtmlLocator.role("button", { name: "Copy feed URL" })).toBeDisabled()
        .loaded("feed", { url: feedUrl })
        .expect(HtmlLocator.role("button", { name: "Copy feed URL" })).toBeDisabled(false)
        .click(HtmlLocator.role("button", { name: "Copy feed URL" }))
        .expectExact(CopyFeedUrl.make({ url: feedUrl }))
        .resolve(CopyFeedUrl, SettingsFormMessage.SucceededCopyFeedUrl())
        .expect(HtmlLocator.role("button", { name: "Copied" })).toExist()
        .resolve(
          required(s.pending[0]).command as never,
          SettingsFormMessage.CompletedWaitBeforeResetCopied() as never,
        )
        .expect(HtmlLocator.role("button", { name: "Copy feed URL" })).toExist()
        .type(HtmlLocator.label("API token"), "dev-api-token-2")
        .expect(HtmlLocator.label("API token")).toHaveValue("dev-api-token-2")
        .click(HtmlLocator.role("button", { name: "Save" }))
        .emitted(SettingsFormEvents.Saved({ connection: savedConnection }))

      // Verify both the API token and private feed URL stay Redacted and never leak through JSON.stringify.
      expect(Redacted.isRedacted(feedUrl)).toBe(true)
      expect(JSON.stringify(feedUrl)).not.toContain("secret-feed-token")
      const story = yield* Story.make(SettingsForm, {
        initialConnection: { origin: "", token: apiToken("dev-api-token") },
        connectionGeneration: 0,
        openId: 1,
      })
      story
        .loaded("feed", { url: feedUrl })
        .send(SettingsFormMessage.UpdatedTokenDraft({ value: apiToken("typed-secret") }))
      expect(Redacted.isRedacted(story.model.tokenDraft)).toBe(true)
      expect(JSON.stringify(story.model.tokenDraft)).not.toContain("typed-secret")
    }),
  )

  it.effect("SettingsForm Play loads FeedQuery, resets Copied via TestClock, and App refetches on Save", () =>
    Effect.gen(function* () {
      const copied: Array<string> = []
      const originalClipboard = navigator.clipboard
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { copied.push(text) } },
      })
      try {
        const fakeApi = Layer.succeed(FamaApi, {
          send: () => Effect.succeed(undefined as never),
          sendJson: () => Effect.succeed({ url: "http://localhost:8788/feed/secret-feed-token/rss.xml" } as never),
        })
        const play = yield* HtmlPlay.make(SettingsForm, {
          initialConnection: { origin: "", token: apiToken("dev-api-token") },
          connectionGeneration: 0,
          openId: 1,
        }).pipe(Effect.provide(Layer.mergeAll(fakeApi, TestHost.layer())))

        yield* play.expect(Locator.text("http://localhost:8788/feed/secret-feed-token/rss.xml")).toExist()
        yield* play.click(HtmlLocator.role("button", { name: "Copy feed URL" }))
        yield* play.expect(HtmlLocator.role("button", { name: "Copied" })).toExist()
        expect(copied).toEqual(["http://localhost:8788/feed/secret-feed-token/rss.xml"])
        yield* TestClock.adjust("1500 millis")
        yield* play.expect(HtmlLocator.role("button", { name: "Copy feed URL" })).toExist()
      } finally {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard })
      }

      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({ ...withEpisodes(baseModel(), []), isSettingsOpen: true })
        .send(AppMessage.SavedSettings({ connection: savedConnection }))
        .expectExact(
          StoreConnection.make({ connection: savedConnection }),
          FetchEpisodes.make({ connection: savedConnection, generation: 1, request: 2 }),
          FetchVoices.make({ connection: savedConnection, generation: 1 }),
        )
        .resolve(StoreConnection, Component.noop)
        .resolve(FetchEpisodes, AppMessage.SucceededFetchEpisodes({ generation: 1, request: 2, episodes: [] }))
        .resolve(FetchVoices, AppMessage.SucceededFetchVoices({ generation: 1, voices: [] }))
      expect(app.model.isSettingsOpen).toBe(false)
    }),
  )
})

describe("menus (Picker backed by @effect/ui-kit Menu)", () => {
  const voice = (id: string, name: string, language: string): Voice => ({
    id: id as VoiceRef,
    engine: "kokoro",
    name,
    language,
    gender: null,
  })
  const voices = [
    voice("kokoro:af_heart", "Heart", "en"),
    voice("kokoro:af_sarah", "Sarah", "en"),
    voice("piper:steinn", "Steinn", "is"),
  ]

  it.effect("Voice picker opens, supports selection, and emits Picked", () =>
    Effect.gen(function* () {
      const play = yield* HtmlPlay.make(Picker, {
        label: "Voice: Auto",
        triggerText: "Auto",
        triggerKind: "voice",
        triggerClass: "",
        selectedValue: "",
        items: [
          { value: "", name: "Auto" },
          ...voices.map((v) => ({ value: v.id, name: v.name, group: v.language })),
        ],
      }).pipe(Effect.provide(TestHost.layer()))

      yield* play.click(HtmlLocator.role("button", { name: "Voice: Auto" }))
      yield* play.expect(HtmlLocator.role("menu")).toExist()
      yield* play.expect(HtmlLocator.role("menuitemradio", { name: "Steinn" })).toExist()
      // Type-ahead within Menu's 500 ms window moves highlight from Sarah to Steinn; pressing Enter on the highlighted item picks it.
      yield* play.keydown(HtmlLocator.role("menu"), "S")
      yield* play.expect(HtmlLocator.role("menuitemradio", { name: "Sarah" })).toHaveAttribute("data-highlighted", "")
      yield* TestClock.adjust("400 millis")
      yield* play.keydown(HtmlLocator.role("menu"), "t")
      yield* play.expect(HtmlLocator.role("menuitemradio", { name: "Steinn" })).toHaveAttribute("data-highlighted", "")
      yield* play.keydown(HtmlLocator.role("menuitemradio", { name: "Steinn" }), "Enter")
      yield* play.expect(HtmlLocator.role("menu")).toBeAbsent()
      expect(play.root.emitted).toEqual([PickerEvents.Picked({ value: "piper:steinn" })])
    }),
  )

  it.effect("Chapters picker renders numbered chapter items and emits selected chapter", () =>
    Effect.gen(function* () {
      const play = yield* HtmlPlay.make(Picker, {
        label: "Chapters",
        triggerText: "",
        triggerKind: "chapters",
        triggerClass: "",
        selectedValue: "0",
        side: "top",
        align: "end",
        items: harbourDays.chapters.map((chapter, index) => ({
          value: String(index),
          name: chapter.title,
          number: index + 1,
        })),
      }).pipe(Effect.provide(TestHost.layer()))

      yield* play.click(HtmlLocator.role("button", { name: "Chapters" }))
      yield* play.expect(HtmlLocator.role("menuitemradio", { name: "1 Morning" })).toExist()
      yield* play.expect(HtmlLocator.role("menuitemradio", { name: "2 Evening" })).toExist()
      yield* play.click(HtmlLocator.role("menuitemradio", { name: "2 Evening" }))
      yield* play.expect(HtmlLocator.role("menu")).toBeAbsent()
      expect(play.root.emitted).toEqual([PickerEvents.Picked({ value: "1" })])
    }),
  )
})

describe("play and pause", () => {
  it.effect("the row and the player bar toggle between Play and Pause", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(AppComponent, defaultFlags())
      s.given(withEpisodes(baseModel(), [harbourDays]))
        .expectMount(OpenFilePickerOnKey())
        .click(HtmlLocator.role("button", { name: "Play Harbour Days" }))
        .expectExact(ReadStoredProgress)
        .resolve(
          ReadStoredProgress,
          AppMessage.GotStoredProgress({ episodeId: harbourDays.id, intent: 1, stored: StoredProgress.NotSaved() }),
        )
        .expectExact(LoadChapter)
        .resolve(LoadChapter, Component.noop)
        .subscription("app/audioEvents", AppMessage.StartedAudio())
        .expect(HtmlLocator.role("button", { name: "Pause Harbour Days" })).toExist()
        .expect(Locator.inside(HtmlLocator.role("contentinfo"), HtmlLocator.role("group", { name: "Position" }))).toExist()
        .expect(Locator.inside(HtmlLocator.role("contentinfo"), HtmlLocator.role("link", { name: "Download" }))).toExist()
        .click(Locator.inside(HtmlLocator.role("contentinfo"), HtmlLocator.role("button", { name: "Pause" })))
        .expectExact(SaveProgress.make({ episodeId: harbourDays.id, positionMs: 0 }), PauseAudio)
        .resolve(PauseAudio, Component.noop)
        .resolve(SaveProgress, AppMessage.SavedProgress({ episodeId: harbourDays.id, progress: progressAt(0) }))
        .resolve(PushProgress, AppMessage.FailedPushProgress({ episodeId: harbourDays.id }))
        .subscription("app/audioEvents", AppMessage.PausedAudio())
        .expect(HtmlLocator.role("button", { name: "Play Harbour Days" })).toExist()
        .click(Locator.inside(HtmlLocator.role("contentinfo"), HtmlLocator.role("button", { name: "Play" })))
        .resolve(PlayAudio, Component.noop)
    }),
  )
})

describe("time left", () => {
  const running = (remainingMs: number | null) => ({
    ...runningHarbourDays,
    job: { ...runningHarbourDays.job, remainingMs },
  })

  it.effect("a running row shows the time left next to the stage once the worker has an estimate", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(AppComponent, defaultFlags())
      s.given(withEpisodes(baseModel(), [running(130_000)]))
        .expectMount(OpenFilePickerOnKey())
        .expect(HtmlLocator.role("listitem")).toHaveText(/Narrating · 2 min left/)
    }),
  )

  it.effect("without an estimate the row shows the count", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(AppComponent, defaultFlags())
      s.given(withEpisodes(baseModel(), [running(null)]))
        .expectMount(OpenFilePickerOnKey())
        .expect(HtmlLocator.role("listitem")).toHaveText(/Narrating 3\/6/)
    }),
  )
})

describe("sleep timer picker", () => {
  const picker = (sleep: SleepTimer, nowMs: number) =>
    HtmlPlay.make(Picker, {
      label: sleepLabel(sleep, nowMs),
      triggerText: sleepBadge(sleep, nowMs) ?? "",
      triggerKind: "sleep",
      triggerClass: "",
      selectedValue: null,
      items: sleepOptions(sleep),
      side: "top",
      align: "end",
    }).pipe(Effect.provide(TestHost.layer()))

  it.effect("the moon menu opens with presets, then offers +5 min and Off once armed", () =>
    Effect.gen(function* () {
      const off = yield* picker(SleepTimer.Off(), 0)
      yield* off.click(HtmlLocator.role("button", { name: "Sleep timer, off" }))
      for (const name of ["15 min", "30 min", "45 min", "60 min", "End of chapter"]) {
        yield* off.expect(HtmlLocator.role("menuitemradio", { name })).toExist()
      }
      yield* off.expect(HtmlLocator.role("menuitemradio", { name: "Off" })).toBeAbsent()
      yield* off.expect(HtmlLocator.role("menuitemradio", { name: "+5 min" })).toBeAbsent()
      yield* off.click(HtmlLocator.role("menuitemradio", { name: "15 min" }))
      expect(off.root.emitted).toEqual([PickerEvents.Picked({ value: "15" })])

      const active = yield* picker(SleepTimer.Countdown({ endsAtMs: 900_000 }), 28_500)
      const trigger = HtmlLocator.role("button", { name: "Sleep timer, 14 minutes 32 seconds left" })
      yield* active.expect(trigger).toHaveText(/14:32/)
      yield* active.click(trigger)
      yield* active.expect(HtmlLocator.role("menuitemradio", { name: "Off" })).toExist()
      yield* active.click(HtmlLocator.role("menuitemradio", { name: "+5 min" }))
      expect(active.root.emitted).toEqual([PickerEvents.Picked({ value: "+5" })])
    }),
  )
})
