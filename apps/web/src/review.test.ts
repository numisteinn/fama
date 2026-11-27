import type { Document, Episode, EpisodeId, VoiceRef } from "@fama/contracts"
import { Component, UiSchema } from "@effect/ui"
import { Html, HtmlCommand } from "@effect/ui/html"
import { HtmlLocator, HtmlPlay, HtmlScene } from "@effect/ui/html/testing"
import { Locator, Story, TestHost } from "@effect/ui/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { AppComponent } from "~/App"
import { apiToken } from "~/core/api"
import {
  CreateEpisodeFromSource,
  FetchEpisodes,
  FetchVoices,
  SaveDocument,
  StartReviewNarration,
  StoreConnection,
  UploadEpisode,
} from "~/command"
import { baseModel, connection, defaultFlags, harbourDays, queuedArticle, withEpisodes, withPlayback } from "~/fixture"
import { AppMessage } from "~/message"
import { Screen } from "~/model"
import { Playback } from "~/playback/model"
import { InvalidateDocument, SamplesQuery } from "~/core/queries"
import {
  ReviewEditor,
  ReviewEditorEvents,
  ReviewEditorMessage,
  ReviewScreen,
  ReviewScreenEvents,
} from "~/review/ReviewScreen"
import { detectRepeatedLines, removeLineFromText } from "~/review/model"
import { FamaApi } from "~/core/services"
import { OpenFilePickerOnKey } from "~/view/addBar"
import { required } from "../../../test/required.ts"

const reviewEpisode: Episode = {
  ...harbourDays,
  id: "harbour-year" as EpisodeId,
  title: "Harbour Year",
  durationMs: null,
  chapters: [],
  bookUrl: null,
  job: { _tag: "Review" },
}

const sampleDocument: Document = {
  title: "Harbour Year",
  author: "Fama Fixtures",
  language: "en",
  chapters: [
    { title: "Spring", text: "HARBOUR YEAR\n\nSpring arrives along the quay." },
    { title: "Summer", text: "HARBOUR YEAR\n\nBoats cross the bright water." },
    { title: "Autumn", text: "HARBOUR YEAR\n\nWind bends the grass on the hill." },
    { title: "Winter", text: "HARBOUR YEAR\n\nLanterns glow in the early dusk." },
  ],
}

const cleanDocument: Document = {
  title: "Harbour Days",
  author: "Fama Fixtures",
  language: "en",
  chapters: [
    { title: "Morning", text: "The harbour wakes before the town does." },
    { title: "Evening", text: "In the evening the light turns gold." },
  ],
}

const editorProps = (
  doc: Document = sampleDocument,
  overrides?: Partial<{
    readonly initialVoice: VoiceRef | null
    readonly maybePendingVoice: Option.Option<VoiceRef>
    readonly isSaving: boolean
    readonly isStarting: boolean
    readonly isSavingVoice: boolean
    readonly maybePendingDocument: Option.Option<Document>
    readonly maybeSavedDocument: Option.Option<Document>
    readonly maybeActionError: Option.Option<string>
    readonly maybeVoiceError: Option.Option<string>
  }>,
) => ({
  episodeId: reviewEpisode.id,
  origin: "",
  connectionGeneration: 0,
  initialDocument: doc,
  speed: 1,
  initialVoice: overrides?.initialVoice ?? null,
  maybePendingVoice: overrides?.maybePendingVoice ?? Option.none(),
  voices: [],
  isMainPlaying: false,
  isSaving: overrides?.isSaving ?? false,
  isStarting: overrides?.isStarting ?? false,
  isSavingVoice: overrides?.isSavingVoice ?? false,
  maybePendingDocument: overrides?.maybePendingDocument ?? Option.none(),
  maybeSavedDocument: overrides?.maybeSavedDocument ?? Option.none(),
  maybeActionError: overrides?.maybeActionError ?? Option.none(),
  maybeVoiceError: overrides?.maybeVoiceError ?? Option.none(),
})

const stubApiLayer = Layer.succeed(FamaApi, {
  send: () => Effect.succeed(undefined as never),
  sendJson: () => Effect.succeed({ samples: [] } as never),
})

describe("add bar review switch", () => {
  it.effect("Review is off by default and turning it on sends review: true for links, text, and files", () =>
    Effect.gen(function* () {
      const epub = new File(["book"], "harbour-year.epub")
      const s = yield* Story.make(AppComponent, defaultFlags())
      s.given(baseModel())
      expect(s.model.isReviewOn).toBe(false)

      s.send(AppMessage.ToggledAddReview({ checked: true }))
      expect(s.model.isReviewOn).toBe(true)

      s.send(AppMessage.UpdatedAddText({ value: "http://localhost:8790/article.html" }))
        .send(AppMessage.SubmittedAddForm())
        .expectExact(
          CreateEpisodeFromSource.make({
            connection,
            input: {
              source: { _tag: "Url", url: "http://localhost:8790/article.html" },
              voice: null,
              speed: 1,
              review: true,
            },
          }),
        )
        .resolve(CreateEpisodeFromSource, AppMessage.SucceededCreateEpisode({ episode: queuedArticle }))
        .resolve(HtmlCommand.Focus, { found: true })

      s.send(AppMessage.UpdatedAddText({ value: "Short note." }))
        .send(AppMessage.SubmittedAddForm())
        .expectExact(
          CreateEpisodeFromSource.make({
            connection,
            input: {
              source: { _tag: "Text", title: null, text: "Short note." },
              voice: null,
              speed: 1,
              review: true,
            },
          }),
        )
        .resolve(CreateEpisodeFromSource, AppMessage.SucceededCreateEpisode({ episode: queuedArticle }))
        .resolve(HtmlCommand.Focus, { found: true })

      s.send(AppMessage.ChangedFileInput({ files: [epub] }))
        .send(AppMessage.SubmittedAddForm())
        .expectExact(UploadEpisode.make({ connection, key: 0, file: epub, voice: null, speed: 1, review: true }))
        .resolve(UploadEpisode, AppMessage.FailedUploadFile({ key: 0, failure: { status: 500, message: "Boom" } }))
        // Turning Review off does not change a failed file's original review flag on Retry.
        .send(AppMessage.ToggledAddReview({ checked: false }))
        .send(AppMessage.ClickedRetryFile({ key: 0 }))
        .expectExact(UploadEpisode.make({ connection, key: 0, file: epub, voice: null, speed: 1, review: true }))
        .resolve(UploadEpisode, AppMessage.SucceededUploadFile({ key: 0, episode: reviewEpisode }))
        .resolve(HtmlCommand.Focus, { found: true })
    }),
  )
})

describe("library row in Review", () => {
  it.effect("a row in Review shows Review, is enabled, and opens ReviewScreen on click", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(AppComponent, defaultFlags())
      s.given(withEpisodes(baseModel(), [reviewEpisode]))
        .expectMount(OpenFilePickerOnKey())
        .expect(HtmlLocator.role("switch", { name: "Review" })).toHaveAttribute("aria-checked", "false")
        .expect(
          Locator.inside(HtmlLocator.role("listitem"), HtmlLocator.role("button", { name: "Review Harbour Year" })),
        ).toBeDisabled(false)
        .expect(Locator.inside(HtmlLocator.role("listitem"), Locator.text("Review"))).toExist()
        .click(HtmlLocator.role("button", { name: "Review Harbour Year" }))
        // Opening Review with empty voices retries FetchVoices.
        .expectExact(FetchVoices.make({ connection, generation: 0 }))
        .resolve(FetchVoices, AppMessage.SucceededFetchVoices({ generation: 0, voices: [] }))
        .expect(HtmlLocator.role("button", { name: "Review Harbour Year" })).toBeAbsent()
    }),
  )
})

describe("review editing, repeated header removal, save, and start", () => {
  it.effect("unticking updates the Start count, unticking all disables Start, and Start sends kept chapters in order", () =>
    Effect.gen(function* () {
      const expectedDocument: Document = {
        title: "Harbour Days",
        author: "Fama Fixtures",
        language: "en",
        chapters: [{ title: "Evening", text: "The red lantern shines across the harbour." }],
      }
      const queuedAfterStart: Episode = { ...reviewEpisode, job: { _tag: "Queued" } }
      const s = yield* Story.make(ReviewEditor, editorProps(cleanDocument))

      s.send(ReviewEditorMessage.ToggledChapterPanel({ index: 1, open: true }))
      expect(s.model.maybeExpandedIndex).toEqual(Option.some(1))

      s.send(ReviewEditorMessage.UpdatedChapterText({ index: 1, value: "The red lantern shines across the harbour." }))
        .send(ReviewEditorMessage.ToggledChapter({ index: 0, kept: false }))
        // Untick chapter 1 too: Start does nothing with zero kept chapters.
        .send(ReviewEditorMessage.ToggledChapter({ index: 1, kept: false }))
        .send(ReviewEditorMessage.ClickedStart())
        .expectNone()
        // Re-tick chapter 1 and start: emits SubmittedStart to App.
        .send(ReviewEditorMessage.ToggledChapter({ index: 1, kept: true }))
        .send(ReviewEditorMessage.ClickedStart())
        .emitted(
          ReviewEditorEvents.SubmittedStart({
            episodeId: reviewEpisode.id,
            document: expectedDocument,
          }),
        )

      // App runs StartReviewNarration at app scope and moves the episode to Queued.
      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({
          ...withEpisodes(baseModel(), [reviewEpisode]),
          screen: Screen.Review({ episodeId: reviewEpisode.id, openId: 1 }),
        })
        .send(AppMessage.SubmittedStartReview({ episodeId: reviewEpisode.id, document: expectedDocument }))
        .expectExact(StartReviewNarration)
        .resolve(StartReviewNarration, queuedAfterStart)
        .expectExact(InvalidateDocument)
        .resolve(InvalidateDocument, Component.noop)
      expect(app.model.screen).toEqual(Screen.Library())
      expect(Option.getOrThrow(app.model.maybeEpisodes)).toEqual([queuedAfterStart])
    }),
  )

  it.effect("clicking Back while Start is in flight does not interrupt Start and still updates the Library", () =>
    Effect.gen(function* () {
      const queuedAfterStart: Episode = { ...reviewEpisode, job: { _tag: "Queued" } }
      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({
          ...withEpisodes(baseModel(), [reviewEpisode]),
          screen: Screen.Review({ episodeId: reviewEpisode.id, openId: 1 }),
        })
        .send(AppMessage.SubmittedStartReview({ episodeId: reviewEpisode.id, document: cleanDocument }))
        .keepPending(StartReviewNarration)
        .send(AppMessage.ClosedSubScreen())
      expect(app.model.screen).toEqual(Screen.Library())
      // StartReviewNarration is still pending at App scope and resolves cleanly into the Library.
      app
        .resolve(StartReviewNarration, queuedAfterStart)
        .expectExact(InvalidateDocument)
        .resolve(InvalidateDocument, Component.noop)
      expect(Option.getOrThrow(app.model.maybeEpisodes)).toEqual([queuedAfterStart])
      expect(app.subscriptions).toContain("app/poll")
    }),
  )

  it.effect("Save sends all chapters (preserving unticked ones), runs at App scope across Back, and invalidates only on success", () =>
    Effect.gen(function* () {
      const expectedDoc: Document = {
        title: "Harbour Days Revised",
        author: "Fama Fixtures",
        language: "en",
        chapters: [
          { title: "Morning", text: "The harbour wakes before the town does." },
          { title: "Evening", text: "Updated evening text." },
        ],
      }
      const s = yield* Story.make(ReviewEditor, editorProps(cleanDocument))
      s.send(ReviewEditorMessage.UpdatedTitle({ value: "Harbour Days Revised" }))
        .send(ReviewEditorMessage.ToggledChapter({ index: 0, kept: false }))
        .send(ReviewEditorMessage.UpdatedChapterText({ index: 1, value: "Updated evening text." }))
        .send(ReviewEditorMessage.ClickedSave())
        .emitted(ReviewEditorEvents.SubmittedSave({ episodeId: reviewEpisode.id, document: expectedDoc }))

      // Back while SaveDocument is in flight does NOT interrupt SaveDocument; reopening initializes from pendingDocument.
      const episodeB: Episode = { ...reviewEpisode, id: "episode-b" as EpisodeId, title: "Episode B" }
      const docB: Document = { ...cleanDocument, title: "Episode B Revised" }
      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({
          ...withEpisodes(baseModel(), [reviewEpisode, episodeB]),
          voices: [{ id: "piper:is_IS-salka-medium" as VoiceRef, engine: "piper", name: "Salka", language: "is", gender: "female" }],
          screen: Screen.Review({ episodeId: reviewEpisode.id, openId: 1 }),
        })
        .send(AppMessage.SubmittedSaveReview({ episodeId: reviewEpisode.id, document: expectedDoc }))
        .keepPending(SaveDocument)
        .send(AppMessage.ClosedSubScreen())
      expect(app.model.screen).toEqual(Screen.Library())
      expect(app.model.reviewSaves[reviewEpisode.id]).toEqual({
        isSaving: true,
        maybePendingDocument: Option.some(expectedDoc),
        maybeSavedDocument: Option.none(),
        maybeError: Option.none(),
      })

      // Opening Episode B while Episode A is saving keeps A's pending save intact, and A finishing does not clear B's save lock.
      app
        .send(AppMessage.ClickedOpenReview({ episodeId: episodeB.id }))
        .send(AppMessage.SubmittedSaveReview({ episodeId: episodeB.id, document: docB }))
      expect(app.model.reviewSaves[reviewEpisode.id]?.isSaving).toBe(true)
      expect(app.model.reviewSaves[episodeB.id]?.isSaving).toBe(true)
      app
        .resolve(SaveDocument, expectedDoc)
        .expectHas(InvalidateDocument)
        .resolve(InvalidateDocument, Component.noop)
      // A left Review, so A's save entry cleared (fresh DocumentQuery on next open), while B's save lock stays active.
      expect(app.model.reviewSaves[reviewEpisode.id]).toBeUndefined()
      expect(app.model.reviewSaves[episodeB.id]?.isSaving).toBe(true)
      app
        .resolve(SaveDocument, docB)
        .expectExact(InvalidateDocument)
        .resolve(InvalidateDocument, Component.noop)
      expect(app.model.reviewSaves[episodeB.id]).toEqual({
        isSaving: false,
        maybePendingDocument: Option.none(),
        maybeSavedDocument: Option.some(docB),
        maybeError: Option.none(),
      })
      // Leaving Episode B after Save settled clears its saved cache so reopening loads a newer edit from another tab.
      app.send(AppMessage.ClosedSubScreen())
      expect(app.model.reviewSaves[episodeB.id]).toBeUndefined()

      // Reopening Review while Save is still in flight mounts ReviewEditor with pendingDocument and disabled Save/Start.
      const reopened = yield* HtmlScene.make(
        ReviewEditor,
        editorProps(cleanDocument, {
          isSaving: true,
          maybePendingDocument: Option.some(expectedDoc),
        }),
      )
      reopened
        .expect(HtmlLocator.role("textbox", { name: "Title" })).toHaveValue("Harbour Days Revised")
        .expect(HtmlLocator.role("button", { name: "Saving…" })).toBeDisabled()
        .expect(HtmlLocator.role("button", { name: "Start · 2 chapters" })).toBeDisabled()
        // When Save settles, editor compares against savedDocument (identical) and shows Saved (disabled).
        .props((prev) => ({
          ...prev,
          isSaving: false,
          maybePendingDocument: Option.none(),
          maybeSavedDocument: Option.some(expectedDoc),
        }))
        .expect(HtmlLocator.role("button", { name: "Saved" })).toBeDisabled()

      // Reopening Review while a Voice write is pending includes that pending Voice when Start is clicked.
      const salka = "piper:is_IS-salka-medium" as VoiceRef
      const withPendingVoice = yield* Story.make(
        ReviewEditor,
        editorProps(cleanDocument, {
          initialVoice: salka,
          maybePendingVoice: Option.some(salka),
        }),
      )
      withPendingVoice
        .send(ReviewEditorMessage.ClickedStart())
        .emitted(
          ReviewEditorEvents.SubmittedStart({
            episodeId: reviewEpisode.id,
            document: cleanDocument,
            voice: salka,
          }),
        )

      // A failed second Save (editing back to original title) keeps maybeSavedDocument so Save stays enabled for retry.
      app
        .given({
          ...withEpisodes(baseModel(), [reviewEpisode]),
          screen: Screen.Review({ episodeId: reviewEpisode.id, openId: 2 }),
          reviewSaves: {
            [reviewEpisode.id]: {
              isSaving: false,
              maybePendingDocument: Option.none(),
              maybeSavedDocument: Option.some(expectedDoc),
              maybeError: Option.none(),
            },
          },
        })
        .send(AppMessage.SubmittedSaveReview({ episodeId: reviewEpisode.id, document: cleanDocument }))
        .fail(SaveDocument, { status: 500, message: "Save failed" })
        .expectNone()
      expect(app.model.reviewSaves[reviewEpisode.id]).toEqual({
        isSaving: false,
        maybePendingDocument: Option.none(),
        maybeSavedDocument: Option.some(expectedDoc),
        maybeError: Option.some("Save failed"),
      })

      const retryScene = yield* HtmlScene.make(
        ReviewEditor,
        editorProps(cleanDocument, {
          maybeSavedDocument: Option.some(expectedDoc),
          maybeActionError: Option.some("Save failed"),
        }),
      )
      retryScene
        .type(HtmlLocator.role("textbox", { name: "Title" }), "Harbour Days")
        .emitted(ReviewEditorEvents.ClearedActionError())
        .expect(HtmlLocator.role("button", { name: "Save" })).toBeDisabled(false)
    }),
  )

  it.effect("reopening Review uses a fresh openId so stale cached text never mounts before the server responds, while a mounted editor survives later reload failures", () =>
    Effect.gen(function* () {
      const newerFromTabB: Document = { ...cleanDocument, title: "Edited In Tab B" }
      const s = yield* HtmlScene.make(ReviewScreen, {
        episodeId: reviewEpisode.id,
        openId: 1,
        episodeTitle: reviewEpisode.title,
        origin: "",
        connectionGeneration: 0,
        speed: 1,
        initialVoice: null,
        maybePendingVoice: Option.none(),
        voices: [],
        isMainPlaying: false,
        isSaving: false,
        isStarting: false,
        isSavingVoice: false,
        maybePendingDocument: Option.none(),
        maybeSavedDocument: Option.none(),
        maybeActionError: Option.none(),
        maybeVoiceError: Option.none(),
      })
      s.loaded("document", cleanDocument)
        // Once mounted in openId 1, a background reload failure keeps ReviewEditor mounted.
        .loadFailed("document", { status: 503, message: "Temporary outage" })
        .expect(HtmlLocator.role("button", { name: "Try again" })).toBeAbsent()
        .expect(HtmlLocator.role("alert")).toBeAbsent()
        // Reopening with a new openId starts cold (Loading) and shows Try again if the fresh fetch fails.
        .props((prev) => ({ ...prev, openId: 2 }))
        .expect(HtmlLocator.role("status", { name: "Loading" })).toExist()
        .loadFailed("document", { status: 503, message: "Still offline" })
        .expect(HtmlLocator.role("alert")).toHaveText("Still offline")
        .expect(HtmlLocator.role("button", { name: "Try again" })).toBeDisabled(false)
        // Succeeding loads Tab B's newer Document.
        .loaded("document", newerFromTabB)
        .childEmit(ReviewEditor, reviewEpisode.id, ReviewEditorEvents.Closed())
        .emitted(ReviewScreenEvents.Closed())
    }),
  )

  it.effect("detects a header line that repeats across chapters and removes it cleanly in one click", () =>
    Effect.gen(function* () {
      expect(removeLineFromText("HARBOUR YEAR\n\nSpring arrives.", "HARBOUR YEAR")).toBe("Spring arrives.")
      expect(removeLineFromText("First.\n\nHARBOUR YEAR\n\nSecond.", "HARBOUR YEAR")).toBe("First.\n\nSecond.")
      expect(
        detectRepeatedLines([
          { index: 0, title: "A", text: "HEADER\n\nOne.", isKept: true },
          { index: 1, title: "B", text: "HEADER\n\nTwo.", isKept: true },
        ]),
      ).toEqual(["HEADER"])

      const TestEditor = ReviewEditor.pipe(
        Component.provide(
          Layer.mergeAll(
            SamplesQuery.toLayer(() => Effect.succeed({ samples: [] })),
            stubApiLayer,
          ),
        ),
      )

      const play = yield* HtmlPlay.make(TestEditor, editorProps(sampleDocument)).pipe(
        Effect.provide(TestHost.layer()),
      )
      yield* play.expect(HtmlLocator.role("button", { name: 'Remove "HARBOUR YEAR"' })).toExist()
      yield* play.click(HtmlLocator.role("button", { name: 'Remove "HARBOUR YEAR"' }))
      yield* play.expect(HtmlLocator.role("button", { name: 'Remove "HARBOUR YEAR"' })).toBeAbsent()
      yield* play.click(HtmlLocator.role("button", { name: "1 Spring" }))
      yield* play.expect(HtmlLocator.role("textbox", { name: "Text of Spring" })).toHaveValue(
        "Spring arrives along the quay.",
      )
      // Opening another chapter closes the previous editor so only one chapter's text is mounted.
      yield* play.click(HtmlLocator.role("button", { name: "2 Summer" }))
      yield* play.expect(HtmlLocator.role("textbox", { name: "Text of Spring" })).toBeAbsent()
      yield* play.expect(HtmlLocator.role("textbox", { name: "Text of Summer" })).toHaveValue(
        "Boats cross the bright water.",
      )
      // Untick Autumn and verify Start button count updates.
      yield* play.click(HtmlLocator.role("checkbox", { name: "Keep Autumn" }))
      yield* play.expect(HtmlLocator.role("button", { name: "Start · 3 of 4 chapters" })).toBeDisabled(false)
    }),
  )

  it.effect("a clean document shows no repeated-header button and a failed start stays open with the error", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(ReviewEditor, editorProps(cleanDocument))
      s.expect(HtmlLocator.role("button", { name: /^Remove / })).toBeAbsent()
        .click(HtmlLocator.role("button", { name: "Start · 2 chapters" }))
        .emitted(
          ReviewEditorEvents.SubmittedStart({
            episodeId: reviewEpisode.id,
            document: cleanDocument,
          }),
        )
        .props((prev) => ({ ...prev, isStarting: false, maybeActionError: Option.some("Not in review") }))
        .expect(HtmlLocator.role("alert")).toHaveText("Not in review")
        .expect(HtmlLocator.role("button", { name: "Start · 2 chapters" })).toBeDisabled(false)
    }),
  )

  it.effect("opening Read-along while reviewing keeps Review mounted and preserves unsaved edits", () =>
    Effect.gen(function* () {
      const timedHarbour: Episode = {
        ...harbourDays,
        chapters: [{ ...required(harbourDays.chapters[0]), timingUrl: "/timing/000.json" }, required(harbourDays.chapters[1])],
      }
      const startModel = withPlayback(
        {
          ...withEpisodes(baseModel(), [reviewEpisode, timedHarbour]),
          screen: Screen.Review({ episodeId: reviewEpisode.id, openId: 1 }),
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
      s.given(startModel)
        .send(AppMessage.ClickedToggleReader())
      expect(s.model.maybeReaderEpisodeId).toEqual(Option.some(timedHarbour.id))
      expect(s.model.screen).toEqual(Screen.Review({ episodeId: reviewEpisode.id, openId: 1 }))

      s.send(AppMessage.ClickedToggleReader())
      expect(s.model.maybeReaderEpisodeId).toEqual(Option.none())
      expect(s.model.screen).toEqual(Screen.Review({ episodeId: reviewEpisode.id, openId: 1 }))
    }),
  )

  it.effect("reconcile closes Review if the episode leaves Review on another device", () =>
    Effect.gen(function* () {
      const startedElsewhere: Episode = { ...reviewEpisode, job: { _tag: "Queued" } }
      const s = yield* Story.make(AppComponent, defaultFlags())
      s.given({ ...withEpisodes(baseModel(), [reviewEpisode]), screen: Screen.Review({ episodeId: reviewEpisode.id, openId: 1 }) })
        .send(AppMessage.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [startedElsewhere] }))
      expect(s.model.screen).toEqual(Screen.Library())
    }),
  )

  it.effect("load failure shows an error and Try again is enabled; Back emits Closed", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(ReviewScreen, {
        episodeId: reviewEpisode.id,
        openId: 1,
        episodeTitle: reviewEpisode.title,
        origin: "",
        connectionGeneration: 0,
        speed: 1,
        initialVoice: null,
        maybePendingVoice: Option.none(),
        voices: [],
        isMainPlaying: false,
        isSaving: false,
        isStarting: false,
        isSavingVoice: false,
        maybePendingDocument: Option.none(),
        maybeSavedDocument: Option.none(),
        maybeActionError: Option.none(),
        maybeVoiceError: Option.none(),
      })
      s.loadFailed("document", { status: 500, message: "Server error" })
        .expect(HtmlLocator.role("alert")).toHaveText("Server error")
        .expect(HtmlLocator.role("button", { name: "Try again" })).toBeDisabled(false)
        .click(HtmlLocator.role("button", { name: "Back" }))
        .emitted(ReviewScreenEvents.Closed())
    }),
  )

  it.effect("changing the API token while Review is open keeps unsaved edits alive, while switching Users closes Review", () =>
    Effect.gen(function* () {
      let documentFetches = 0
      const fakeApi = Layer.succeed(FamaApi, {
        send: () => Effect.succeed(undefined as never),
        sendJson: (_schema, _method, path) => {
          if (path.endsWith("/document")) {
            documentFetches += 1
            return Effect.succeed(cleanDocument as never)
          }
          return Effect.succeed({ samples: [] } as never)
        },
      })
      const HostMsg = UiSchema.TaggedEnum({ RotatedToken: {} })
      const Host = Html.component({
        name: "ReviewTokenHost",
        props: Schema.Null,
        model: Schema.Number,
        message: HostMsg,
      }).make({
        init: () => 0,
        update: { RotatedToken: ($) => $.model + 1 },
        view: (h, generation) =>
          h.div.children(
            h.button.on("click", HostMsg.RotatedToken()).children("Rotate token"),
            ReviewScreen(h, {
              key: `${reviewEpisode.id}-1`,
              props: {
                episodeId: reviewEpisode.id,
                openId: 1,
                episodeTitle: reviewEpisode.title,
                origin: "",
                connectionGeneration: generation,
                speed: 1,
                initialVoice: null,
                maybePendingVoice: Option.none(),
                voices: [],
                isMainPlaying: false,
                isSaving: false,
                isStarting: false,
                isSavingVoice: false,
                maybePendingDocument: Option.none(),
                maybeSavedDocument: Option.none(),
                maybeActionError: Option.none(),
                maybeVoiceError: Option.none(),
              },
              onEmit: {
                Closed: () => undefined,
                SubmittedSave: () => undefined,
                SubmittedStart: () => undefined,
                ClearedActionError: () => undefined,
                RequestedChangeVoice: () => undefined,
                RequestedPauseMainPlayback: () => undefined,
              },
            }),
          ),
      })

      const play = yield* HtmlPlay.make(Host, null).pipe(
        Effect.provide(Layer.mergeAll(fakeApi, TestHost.layer())),
      )
      yield* play.expect(HtmlLocator.role("textbox", { name: "Title" })).toHaveValue("Harbour Days")
      expect(documentFetches).toBe(1)
      yield* play.type(HtmlLocator.role("textbox", { name: "Title" }), "Harbour Days (draft)")
      yield* play.expect(HtmlLocator.role("button", { name: "Save" })).toBeDisabled(false)
      // Rotating the API token increments connectionGeneration without unmounting ReviewEditor.
      yield* play.click(HtmlLocator.role("button", { name: "Rotate token" }))
      yield* play.expect(HtmlLocator.role("status", { name: "Loading" })).toBeAbsent()
      yield* play.expect(HtmlLocator.role("textbox", { name: "Title" })).toHaveValue("Harbour Days (draft)")
      yield* play.expect(HtmlLocator.role("button", { name: "Save" })).toBeDisabled(false)
      expect(documentFetches).toBe(1)

      // Saving a second valid token for the same User preserves saved state; a different User's Library closes Review.
      const secondConnection = { origin: connection.origin, token: apiToken("second-valid-token") }
      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({
          ...withEpisodes(baseModel(), [reviewEpisode]),
          screen: Screen.Review({ episodeId: reviewEpisode.id, openId: 1 }),
          reviewSaves: {
            [reviewEpisode.id]: {
              isSaving: false,
              maybePendingDocument: Option.none(),
              maybeSavedDocument: Option.some(cleanDocument),
              maybeError: Option.none(),
            },
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
      expect(app.model.screen).toEqual(Screen.Review({ episodeId: reviewEpisode.id, openId: 1 }))
      expect(app.model.reviewSaves[reviewEpisode.id]?.maybeSavedDocument).toEqual(Option.some(cleanDocument))

      app.resolve(FetchEpisodes, AppMessage.SucceededFetchEpisodes({ generation: 1, request: 2, episodes: [] }))
      expect(app.model.screen).toEqual(Screen.Library())
      expect(app.model.reviewSaves).toEqual({})
    }),
  )
})
