import type { Document, Episode, Voice, VoiceRef } from "@fama/contracts"
import { Component, UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { HtmlLocator, HtmlPlay, HtmlScene } from "@effect/ui/html/testing"
import { Locator, Story, TestHost } from "@effect/ui/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { AppComponent } from "~/App"
import { apiToken } from "~/core/api"
import { LoadChapter } from "~/core/audio"
import {
  ChangeNarrateAgainVoice,
  FetchEpisodes,
  FetchVoices,
  NarrateAgainWithDocument,
  StoreConnection,
} from "~/command"
import { baseModel, connection, defaultFlags, harbourDays, queuedArticle, withEpisodes, withPlayback } from "~/fixture"
import { AppMessage } from "~/message"
import { Screen } from "~/model"
import { Playback } from "~/playback/model"
import { InvalidateDocument } from "~/core/queries"
import { ReaderScreenNoDeps } from "~/reader/ReaderScreen"
import {
  NarrateAgainEditor,
  NarrateAgainEditorEvents,
  NarrateAgainEditorMessage,
  NarrateAgainScreen,
  NarrateAgainScreenEvents,
} from "~/narrate-again/NarrateAgainScreen"
import { FamaApi } from "~/core/services"
import { OpenFilePickerOnKey } from "~/view/addBar"
import { required } from "../../../test/required.ts"

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
  previewUrl: null,
}
const sarah: Voice = { ...heart, id: "kokoro:af_sarah" as VoiceRef, name: "Sarah" }

const editorProps = (
  document: Option.Option<Document> = Option.some(storedDocument),
  overrides?: Partial<{
    readonly submittingTarget: Option.Option<"text" | "voice">
    readonly maybeSubmitError: Option.Option<{ readonly target: "text" | "voice"; readonly message: string }>
  }>,
) => ({
  episodeId: harbourDays.id,
  episodeTitle: harbourDays.title,
  document,
  initialVoice: harbourDays.voice,
  initialSpeed: harbourDays.speed,
  voices: [heart, sarah],
  submittingTarget: overrides?.submittingTarget ?? Option.none(),
  maybeSubmitError: overrides?.maybeSubmitError ?? Option.none(),
})

describe("Narrate again", () => {
  it.effect("Ready and Failed rows open it, while a Queued row has no edit action", () =>
    Effect.gen(function* () {
      const failed: Episode = {
        ...harbourDays,
        id: "failed" as Episode["id"],
        title: "Failed Book",
        job: { _tag: "Failed", reason: "No voice", failedAt: "2026-11-20T00:00:00.000Z" },
      }
      const s = yield* HtmlScene.make(AppComponent, defaultFlags())
      s.given(withEpisodes(baseModel(), [harbourDays, failed, queuedArticle]))
        .expectMount(OpenFilePickerOnKey())
        .expect(HtmlLocator.role("button", { name: "Narrate again Harbour Days" })).toExist()
        .expect(HtmlLocator.role("button", { name: "Narrate again Failed Book" })).toExist()
        .expect(HtmlLocator.role("button", { name: `Narrate again ${queuedArticle.title}` })).toBeAbsent()
        .click(HtmlLocator.role("button", { name: "Narrate again Harbour Days" }))
        .expectExact(FetchVoices.make({ connection, generation: 0 }))
        .resolve(FetchVoices, AppMessage.SucceededFetchVoices({ generation: 0, voices: [heart, sarah] }))
        .expect(HtmlLocator.role("button", { name: "Narrate again Harbour Days" })).toBeAbsent()
    }),
  )

  it.effect("Chapter titles and metadata stay fixed; only edited text goes to the Document route", () =>
    Effect.gen(function* () {
      const edited: Document = {
        ...storedDocument,
        chapters: [
          storedDocument.chapters[0],
          { title: "Evening", text: "Orange lanterns guide the last ship home." },
        ],
      }
      const editor = yield* Story.make(NarrateAgainEditor, editorProps())
      editor
        .send(NarrateAgainEditorMessage.ToggledChapterPanel({ index: 1, open: true }))
        .send(NarrateAgainEditorMessage.UpdatedChapterText({ index: 1, value: required(edited.chapters[1]).text }))
        .send(NarrateAgainEditorMessage.ClickedNarrateText())
        .emitted(NarrateAgainEditorEvents.SubmittedNarrateText({ episodeId: harbourDays.id, document: edited }))

      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({
          ...withEpisodes(baseModel(), [harbourDays]),
          screen: Screen.NarrateAgain({ episodeId: harbourDays.id, openId: 1 }),
        })
        .send(AppMessage.SubmittedNarrateAgainText({ episodeId: harbourDays.id, document: edited }))
        .expectExact(NarrateAgainWithDocument)
        .resolve(NarrateAgainWithDocument, undefined)
        .expectExact(FetchEpisodes.make({ connection, generation: 0, request: 2 }), InvalidateDocument)
        .resolve(InvalidateDocument, Component.noop)
        .resolve(
          FetchEpisodes,
          AppMessage.SucceededFetchEpisodes({
            generation: 0,
            request: 2,
            episodes: [{ ...harbourDays, job: { _tag: "Queued" } }],
          }),
        )
      expect(app.model.screen).toEqual(Screen.Library())
    }),
  )

  it.effect("clicking Back while Narrate again is in flight keeps the write running and refreshes the Library", () =>
    Effect.gen(function* () {
      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({
          ...withEpisodes(baseModel(), [harbourDays]),
          screen: Screen.NarrateAgain({ episodeId: harbourDays.id, openId: 1 }),
        })
        .send(AppMessage.SubmittedNarrateAgainVoice({ episodeId: harbourDays.id, input: { voice: sarah.id, speed: 1.3 } }))
        .keepPending(ChangeNarrateAgainVoice)
        .send(AppMessage.ClosedSubScreen())
      expect(app.model.screen).toEqual(Screen.Library())
      app
        .resolve(ChangeNarrateAgainVoice, undefined)
        .expectExact(FetchEpisodes.make({ connection, generation: 0, request: 2 }), InvalidateDocument)
        .resolve(InvalidateDocument, Component.noop)
        .resolve(
          FetchEpisodes,
          AppMessage.SucceededFetchEpisodes({
            generation: 0,
            request: 2,
            episodes: [{ ...harbourDays, job: { _tag: "Queued" } }],
          }),
        )
      expect(app.subscriptions).toContain("app/poll")
    }),
  )

  it.effect("Voice and speed use a separate submit and emit SubmittedChangeVoice", () =>
    Effect.gen(function* () {
      const editor = yield* Story.make(NarrateAgainEditor, editorProps())
      editor
        .send(NarrateAgainEditorMessage.ChangedVoice({ value: sarah.id }))
        .send(NarrateAgainEditorMessage.ChangedSpeed({ value: "1.3" }))
        .send(NarrateAgainEditorMessage.ClickedChangeVoice())
        .emitted(
          NarrateAgainEditorEvents.SubmittedChangeVoice({
            episodeId: harbourDays.id,
            input: { voice: sarah.id, speed: 1.3 },
          }),
        )
    }),
  )

  it.effect("The screen has no title input or chapter-removal control, and a 409 stays visible and refreshes the Library", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(NarrateAgainEditor, editorProps())
      s.expect(HtmlLocator.role("heading", { name: "Narrate again" })).toExist()
        .expect(HtmlLocator.role("textbox", { name: "Title" })).toBeAbsent()
        .expect(HtmlLocator.role("checkbox")).toBeAbsent()
        .expect(HtmlLocator.role("combobox", { name: "Voice" })).toHaveValue(heart.id)
        .expect(HtmlLocator.role("button", { name: "Change voice & speed" })).toBeDisabled()
        .change(HtmlLocator.role("combobox", { name: "Speed" }), "1.2")
        .click(HtmlLocator.role("button", { name: "Change voice & speed" }))
        .emitted(
          NarrateAgainEditorEvents.SubmittedChangeVoice({
            episodeId: harbourDays.id,
            input: { voice: heart.id, speed: 1.2 },
          }),
        )
        .props((prev) => ({
          ...prev,
          maybeSubmitError: Option.some({ target: "voice" as const, message: "Not editable" }),
        }))
        .expect(HtmlLocator.role("alert")).toHaveText("Not editable")

      // App refreshes the Library on 409.
      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({
          ...withEpisodes(baseModel(), [harbourDays]),
          screen: Screen.NarrateAgain({ episodeId: harbourDays.id, openId: 1 }),
        })
        .send(AppMessage.SubmittedNarrateAgainVoice({ episodeId: harbourDays.id, input: { voice: heart.id, speed: 1.2 } }))
        .fail(ChangeNarrateAgainVoice, { status: 409, message: "Not editable" })
        .expectExact(FetchEpisodes.make({ connection, generation: 0, request: 2 }))
        .resolve(
          FetchEpisodes,
          AppMessage.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [harbourDays] }),
        )
      expect(app.model.narrateAgainSubmits[harbourDays.id]).toEqual({
        target: "voice",
        isSubmitting: false,
        maybeError: Option.some("Not editable"),
      })
    }),
  )

  it.effect("A missing Document (404) leaves voice and speed available, reopening loads fresh text via openId, and editor checks edits against its loaded Document", () =>
    Effect.gen(function* () {
      const screen = yield* HtmlScene.make(NarrateAgainScreen, {
        episodeId: harbourDays.id,
        openId: 1,
        episodeTitle: harbourDays.title,
        origin: "",
        initialVoice: harbourDays.voice,
        initialSpeed: harbourDays.speed,
        voices: [heart],
        submittingTarget: Option.none(),
        maybeSubmitError: Option.none(),
      })
      screen
        .loaded("document", Option.none())
        // A later transient 503 refetch keeps the voice-only editor mounted via previousSuccess.
        .loadFailed("document", { status: 503, message: "Transient outage" })
        .expect(HtmlLocator.role("button", { name: "Try again" })).toBeAbsent()
        .expect(HtmlLocator.role("alert")).toBeAbsent()
        .childEmit(NarrateAgainEditor, harbourDays.id, NarrateAgainEditorEvents.Closed())
        .emitted(NarrateAgainScreenEvents.Closed())

      // End-to-end 404 -> edit speed -> 503 refetch keeps the voice-only editor and unsaved speed edit alive.
      let legacyFetches = 0
      const legacyApi = Layer.succeed(FamaApi, {
        send: () => Effect.succeed(undefined as never),
        sendJson: () => {
          legacyFetches += 1
          return legacyFetches === 1
            ? Effect.fail({ status: 404, message: "Not stored" })
            : Effect.fail({ status: 503, message: "Transient outage" })
        },
      })
      const LegacyHostMsg = UiSchema.TaggedEnum({ TriggerRefetch: {} })
      const LegacyHost = Html.component({
        name: "NarrateAgainLegacyRefetchHost",
        props: Schema.Null,
        model: Schema.Null,
        message: LegacyHostMsg,
      }).make({
        init: () => null,
        update: {
          TriggerRefetch: ($) => $.run(InvalidateDocument.make({})),
        },
        view: (h) =>
          h.div.children(
            h.button.on("click", LegacyHostMsg.TriggerRefetch()).children("Refetch"),
            NarrateAgainScreen(h, {
              key: `${harbourDays.id}-99`,
              props: {
                episodeId: harbourDays.id,
                openId: 99,
                episodeTitle: harbourDays.title,
                origin: "",
                initialVoice: harbourDays.voice,
                initialSpeed: harbourDays.speed,
                voices: [heart, sarah],
                submittingTarget: Option.none(),
                maybeSubmitError: Option.none(),
              },
              onEmit: {
                Closed: () => undefined,
                SubmittedNarrateText: () => undefined,
                SubmittedChangeVoice: () => undefined,
                ClearedSubmitError: () => undefined,
              },
            }),
          ),
      })
      const legacyPlay = yield* HtmlPlay.make(LegacyHost, null).pipe(
        Effect.provide(Layer.mergeAll(legacyApi, TestHost.layer())),
      )
      yield* legacyPlay.expect(Locator.text("Chapter text is not stored")).toExist()
      yield* legacyPlay.change(HtmlLocator.role("combobox", { name: "Speed" }), "1.2")
      yield* legacyPlay.expect(HtmlLocator.role("button", { name: "Change voice & speed" })).toBeDisabled(false)
      yield* legacyPlay.click(HtmlLocator.role("button", { name: "Refetch" }))
      yield* legacyPlay.expect(HtmlLocator.role("button", { name: "Try again" })).toBeAbsent()
      yield* legacyPlay.expect(HtmlLocator.role("combobox", { name: "Speed" })).toHaveValue("1.2")
      yield* legacyPlay.expect(HtmlLocator.role("button", { name: "Change voice & speed" })).toBeDisabled(false)
      expect(legacyFetches).toBe(2)

      const reloadScreen = yield* HtmlScene.make(NarrateAgainScreen, {
        episodeId: harbourDays.id,
        openId: 1,
        episodeTitle: harbourDays.title,
        origin: "",
        initialVoice: harbourDays.voice,
        initialSpeed: harbourDays.speed,
        voices: [heart],
        submittingTarget: Option.none(),
        maybeSubmitError: Option.none(),
      })
      reloadScreen
        .loaded("document", Option.some(storedDocument))
        .loadFailed("document", { status: 503, message: "Transient outage" })
        .expect(HtmlLocator.role("button", { name: "Try again" })).toBeAbsent()
        .expect(HtmlLocator.role("alert")).toBeAbsent()
        // Reopening with a new openId starts cold (Loading) until the fresh Document arrives.
        .props((prev) => ({ ...prev, openId: 2 }))
        .expect(HtmlLocator.role("status", { name: "Loading" })).toExist()
        .loaded("document", Option.some(storedDocument))
        .childEmit(NarrateAgainEditor, harbourDays.id, NarrateAgainEditorEvents.Closed())
        .emitted(NarrateAgainScreenEvents.Closed())

      // A changed document, voice, or speed prop after mount never enables submit buttons without a user edit.
      const newerDoc: Document = {
        ...storedDocument,
        chapters: [
          storedDocument.chapters[0],
          { title: "Evening", text: "Changed on server." },
        ],
      }
      const noSpuriousDirty = yield* HtmlScene.make(NarrateAgainEditor, editorProps(Option.some(storedDocument)))
      noSpuriousDirty
        .expect(HtmlLocator.role("button", { name: "Narrate chapter edits" })).toBeDisabled()
        .expect(HtmlLocator.role("button", { name: "Change voice & speed" })).toBeDisabled()
        .props((prev) => ({
          ...prev,
          document: Option.some(newerDoc),
          initialVoice: sarah.id,
          initialSpeed: 1.1,
        }))
        .expect(HtmlLocator.role("button", { name: "Narrate chapter edits" })).toBeDisabled()
        .expect(HtmlLocator.role("button", { name: "Change voice & speed" })).toBeDisabled()

      const editor = yield* HtmlScene.make(NarrateAgainEditor, editorProps(Option.none()))
      editor
        .expect(Locator.text("Chapter text is not stored")).toExist()
        .expect(HtmlLocator.role("combobox", { name: "Voice" })).toBeDisabled(false)
        .expect(HtmlLocator.role("button", { name: "Narrate chapter edits" })).toBeAbsent()
        .change(HtmlLocator.role("combobox", { name: "Speed" }), "1.1")
        .expect(HtmlLocator.role("button", { name: "Change voice & speed" })).toBeDisabled(false)
    }),
  )

  it.effect("A replacement Chapter URL reloads audio at the same place", () =>
    Effect.gen(function* () {
      const oldChapter = required(harbourDays.chapters[0])
      const replacement: Episode = {
        ...harbourDays,
        chapters: [
          { ...oldChapter, url: "/media/t/episodes/harbour-days/chapters/new-000.m4a" },
          required(harbourDays.chapters[1]),
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
      const s = yield* Story.make(AppComponent, defaultFlags())
      s.given(paused)
        .send(AppMessage.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [replacement] }))
        .expectExact(
          LoadChapter.make({
            src: required(replacement.chapters[0]).url,
            offsetMs: 10_000,
            rate: 1,
            isAutoplay: false,
          }),
        )
      expect(s.model.playback).toMatchObject({ chapter: 0, offsetMs: 10_000, url: required(replacement.chapters[0]).url })
      s.resolve(LoadChapter, Component.noop)
    }),
  )

  it.effect("A replacement timing URL updates TimingQuery args and shows the new Read-along text", () =>
    Effect.gen(function* () {
      const oldEpisode: Episode = {
        ...harbourDays,
        chapters: [{ ...required(harbourDays.chapters[0]), url: "/audio/new.m4a", timingUrl: "/timing/old.json" }],
      }
      const newEpisode: Episode = {
        ...harbourDays,
        chapters: [{ ...required(harbourDays.chapters[0]), url: "/audio/new.m4a", timingUrl: "/timing/new.json" }],
      }
      const s = yield* HtmlScene.make(ReaderScreenNoDeps, {
        episode: oldEpisode,
        origin: "",
        chapter: 0,
        offsetMs: 0,
        isPlaying: false,
      })
      s.loaded(
        "timings",
        { origin: "", path: "/timing/old.json", url: Redacted.make("/timing/old.json") },
        {
          segments: [{ text: "Old text.", startMs: 0, endMs: 100, endsParagraph: true }],
        },
      )
        .expect(HtmlLocator.role("button", { name: "Old text." })).toExist()
        .props((prev) => ({ ...prev, episode: newEpisode }))
        .loaded(
          "timings",
          { origin: "", path: "/timing/new.json", url: Redacted.make("/timing/new.json") },
          {
            segments: [{ text: "Orange lanterns guide the last ship home.", startMs: 0, endMs: 100, endsParagraph: true }],
          },
        )
        .expect(HtmlLocator.role("button", { name: "Orange lanterns guide the last ship home." })).toExist()
    }),
  )

  it.effect("A late shorter Library list does not move playing audio", () =>
    Effect.gen(function* () {
      const playingChapter1 = withPlayback(
        withEpisodes(baseModel(), [harbourDays]),
        Playback.Loaded({
          episodeId: harbourDays.id,
          chapter: 1,
          url: required(harbourDays.chapters[1]).url,
          offsetMs: 5_000,
          isPlaying: true,
          isWaiting: false,
        }),
      )
      const lateList: Episode = { ...harbourDays, chapters: [required(harbourDays.chapters[0])] }
      const s = yield* Story.make(AppComponent, defaultFlags())
      s.given(playingChapter1)
        .send(AppMessage.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [lateList] }))
        .expectNone()
      expect(s.model.playback).toMatchObject({ chapter: 1, offsetMs: 5_000, isPlaying: true })
    }),
  )

  it.effect("Replacing a playing Chapter keeps the same fraction through that Chapter", () =>
    Effect.gen(function* () {
      const oldChapter = required(harbourDays.chapters[0])
      const shorter: Episode = {
        ...harbourDays,
        chapters: [
          { ...oldChapter, url: "/media/t/episodes/harbour-days/chapters/v2-000.m4a", durationMs: 17_883 },
          required(harbourDays.chapters[1]),
        ],
      }
      const playing = withPlayback(
        withEpisodes(baseModel(), [harbourDays]),
        Playback.Loaded({
          episodeId: harbourDays.id,
          chapter: 0,
          url: oldChapter.url,
          offsetMs: 20_000,
          isPlaying: true,
          isWaiting: false,
        }),
      )
      const expectedOffset = Math.round((20_000 / oldChapter.durationMs) * 17_883)
      const s = yield* Story.make(AppComponent, defaultFlags())
      s.given(playing)
        .send(AppMessage.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [shorter] }))
        .expectExact(
          LoadChapter.make({
            src: required(shorter.chapters[0]).url,
            offsetMs: expectedOffset,
            rate: 1,
            isAutoplay: true,
          }),
        )
      expect(s.model.playback).toMatchObject({
        chapter: 0,
        offsetMs: expectedOffset,
        url: required(shorter.chapters[0]).url,
        isPlaying: true,
      })
      expect(s.model.loadedChapterDurationMs).toBe(17_883)
      s.resolve(LoadChapter, Component.noop)
    }),
  )

  it.effect("Opening Read-along via Text switches away from Narrate again", () =>
    Effect.gen(function* () {
      const timedHarbour: Episode = {
        ...harbourDays,
        chapters: [{ ...required(harbourDays.chapters[0]), timingUrl: "/timing/000.json" }, required(harbourDays.chapters[1])],
      }
      const withPlayer = withPlayback(
        {
          ...withEpisodes(baseModel(), [timedHarbour]),
          screen: Screen.NarrateAgain({ episodeId: timedHarbour.id, openId: 1 }),
        },
        Playback.Loaded({
          episodeId: timedHarbour.id,
          chapter: 0,
          url: required(timedHarbour.chapters[0]).url,
          offsetMs: 0,
          isPlaying: false,
          isWaiting: false,
        }),
      )
      const s = yield* Story.make(AppComponent, defaultFlags())
      s.given(withPlayer).send(AppMessage.ClickedToggleReader())
      expect(s.model.maybeReaderEpisodeId).toEqual(Option.some(timedHarbour.id))
      expect(s.model.screen).toEqual(Screen.Library())
    }),
  )

  it.effect("changing the API token while Narrate again is open keeps unsaved edits alive, while switching Users closes Narrate again", () =>
    Effect.gen(function* () {
      let documentFetches = 0
      const fakeApi = Layer.succeed(FamaApi, {
        send: () => Effect.succeed(undefined as never),
        sendJson: () => {
          documentFetches += 1
          return Effect.succeed(storedDocument as never)
        },
      })
      const HostMsg = UiSchema.TaggedEnum({ RotatedToken: {}, RestoredVoices: {} })
      const Host = Html.component({
        name: "NarrateAgainTokenHost",
        props: Schema.Null,
        model: Schema.Boolean,
        message: HostMsg,
      }).make({
        init: () => true,
        update: {
          RotatedToken: () => false,
          RestoredVoices: () => true,
        },
        view: (h, hasVoices) =>
          h.div.children(
            h.button.on("click", HostMsg.RotatedToken()).children("Rotate token"),
            h.button.on("click", HostMsg.RestoredVoices()).children("Restore voices"),
            NarrateAgainScreen(h, {
              key: `${harbourDays.id}-1`,
              props: {
                episodeId: harbourDays.id,
                openId: 1,
                episodeTitle: harbourDays.title,
                origin: "",
                initialVoice: harbourDays.voice,
                initialSpeed: harbourDays.speed,
                voices: hasVoices ? [heart, sarah] : [],
                submittingTarget: Option.none(),
                maybeSubmitError: Option.none(),
              },
              onEmit: {
                Closed: () => undefined,
                SubmittedNarrateText: () => undefined,
                SubmittedChangeVoice: () => undefined,
                ClearedSubmitError: () => undefined,
              },
            }),
          ),
      })

      const play = yield* HtmlPlay.make(Host, null).pipe(
        Effect.provide(Layer.mergeAll(fakeApi, TestHost.layer())),
      )
      expect(documentFetches).toBe(1)
      yield* play.click(HtmlLocator.role("button", { name: "2 Evening" }))
      yield* play.type(HtmlLocator.role("textbox", { name: "Text of Evening" }), "Unsaved evening draft.")
      yield* play.change(HtmlLocator.role("combobox", { name: "Speed" }), "1.2")
      // Rotating the API token temporarily clears voices while refetching, without unmounting the editor.
      yield* play.click(HtmlLocator.role("button", { name: "Rotate token" }))
      yield* play.click(HtmlLocator.role("button", { name: "Restore voices" }))
      yield* play.expect(HtmlLocator.role("status", { name: "Loading" })).toBeAbsent()
      yield* play.expect(HtmlLocator.role("textbox", { name: "Text of Evening" })).toHaveValue("Unsaved evening draft.")
      yield* play.expect(HtmlLocator.role("combobox", { name: "Speed" })).toHaveValue("1.2")
      yield* play.expect(HtmlLocator.role("button", { name: "Narrate chapter edits" })).toBeDisabled(false)
      yield* play.expect(HtmlLocator.role("button", { name: "Change voice & speed" })).toBeDisabled(false)
      expect(documentFetches).toBe(1)

      // Switching to another User whose Library lacks the Episode closes Narrate again and clears submit state.
      const secondConnection = { origin: connection.origin, token: apiToken("other-user-token") }
      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({
          ...withEpisodes(baseModel(), [harbourDays]),
          screen: Screen.NarrateAgain({ episodeId: harbourDays.id, openId: 1 }),
          narrateAgainSubmits: {
            [harbourDays.id]: { target: "text", isSubmitting: false, maybeError: Option.some("Old error") },
          },
        })
        .send(AppMessage.SavedSettings({ connection: secondConnection }))
        .expectExact(
          StoreConnection.make({ connection: secondConnection }),
          FetchEpisodes.make({ connection: secondConnection, generation: 1, request: 2 }),
          FetchVoices.make({ connection: secondConnection, generation: 1 }),
        )
        .resolve(StoreConnection, Component.noop)
        .resolve(FetchVoices, AppMessage.SucceededFetchVoices({ generation: 1, voices: [] }))
      expect(app.model.screen).toEqual(Screen.NarrateAgain({ episodeId: harbourDays.id, openId: 1 }))
      expect(app.model.narrateAgainSubmits[harbourDays.id]).toBeDefined()

      app.resolve(FetchEpisodes, AppMessage.SucceededFetchEpisodes({ generation: 1, request: 2, episodes: [] }))
      expect(app.model.screen).toEqual(Screen.Library())
      expect(app.model.narrateAgainSubmits).toEqual({})
    }),
  )
})
