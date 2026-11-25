import type { Document, Episode, EpisodeId } from "@fama/contracts"
import { Option } from "effect"
import * as Scene from "foldkit/scene"
import { Command, given, message, model, story } from "foldkit/story"
import { describe, expect, test } from "vitest"
import { CreateEpisodeFromSource, FocusAddText, UploadEpisode } from "~/command"
import { baseModel, connection, harbourDays, queuedArticle, withEpisodes } from "~/fixture"
import { Message } from "~/message"
import { FetchDocument, SaveDocument, StartReviewNarration } from "~/review/command"
import { ReviewMessage as R } from "~/review/message"
import { detectRepeatedLines, removeLineFromText } from "~/review/model"
import { update } from "~/update"
import { view } from "~/view"
import { OpenFilePickerOnKey } from "~/view/addBar"

const wrap = (message: R) => Message.GotReviewMessage({ message })

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

const openedModel = (doc: Document = sampleDocument) => {
  const start = withEpisodes(baseModel(), [reviewEpisode])
  const loading = update(start, wrap(R.ClickedEpisode({ episodeId: reviewEpisode.id }))).model
  return update(
    loading,
    wrap(R.SucceededFetchDocument({ episodeId: reviewEpisode.id, request: 1, document: doc })),
  ).model
}

describe("add bar review switch", () => {
  test("Review is off by default and turning it on sends review: true for links, text, and files", () => {
    const epub = new File(["book"], "harbour-year.epub")
    story(
      update,
      given(baseModel()),
      model((next) => expect(next.isReviewOn).toBe(false)),
      message(Message.ToggledAddReview()),
      model((next) => expect(next.isReviewOn).toBe(true)),
      message(Message.UpdatedAddText({ value: "http://localhost:8790/article.html" })),
      message(Message.SubmittedAddForm()),
      Command.expectExact(
        CreateEpisodeFromSource({
          connection,
          input: { source: { _tag: "Url", url: "http://localhost:8790/article.html" }, voice: null, speed: 1, review: true },
        }),
      ),
      Command.resolve(CreateEpisodeFromSource, Message.SucceededCreateEpisode({ episode: queuedArticle })),
      Command.resolve(FocusAddText, Message.CompletedFocusAddText()),
      message(Message.UpdatedAddText({ value: "Short note." })),
      message(Message.SubmittedAddForm()),
      Command.expectExact(
        CreateEpisodeFromSource({
          connection,
          input: { source: { _tag: "Text", title: null, text: "Short note." }, voice: null, speed: 1, review: true },
        }),
      ),
      Command.resolve(CreateEpisodeFromSource, Message.SucceededCreateEpisode({ episode: queuedArticle })),
      Command.resolve(FocusAddText, Message.CompletedFocusAddText()),
      message(Message.ChangedFileInput({ files: [epub] })),
      message(Message.SubmittedAddForm()),
      Command.expectExact(UploadEpisode({ connection, key: 0, file: epub, voice: null, speed: 1, review: true })),
      Command.resolve(UploadEpisode, Message.FailedUploadFile({ key: 0, failure: { status: 500, message: "Boom" } })),
      // Turning Review off does not change a failed file's original review flag on Retry.
      message(Message.ToggledAddReview()),
      message(Message.ClickedRetryFile({ key: 0 })),
      Command.expectExact(UploadEpisode({ connection, key: 0, file: epub, voice: null, speed: 1, review: true })),
      Command.resolve(UploadEpisode, Message.SucceededUploadFile({ key: 0, episode: reviewEpisode })),
      Command.resolve(FocusAddText, Message.CompletedFocusAddText()),
    )
  })
})

describe("library row in Review", () => {
  test("a row in Review shows Review, is enabled, and opens Review on click", () => {
    Scene.scene(
      { update, view },
      Scene.given(withEpisodes(baseModel(), [reviewEpisode])),
      Scene.Mount.resolve(OpenFilePickerOnKey, Message.CompletedMountFilePickerKeys()),
      Scene.expect(Scene.role("switch", { name: "Review" })).toHaveAttr("aria-checked", "false"),
      Scene.inside(
        Scene.role("listitem"),
        Scene.expect(Scene.role("button", { name: "Review Harbour Year" })).toBeEnabled(),
        Scene.expect(Scene.text("Review")).toExist(),
      ),
      Scene.click(Scene.role("button", { name: "Review Harbour Year" })),
      Scene.Mount.expectEnded(OpenFilePickerOnKey),
      Scene.Command.expectExact(FetchDocument({ connection, episodeId: reviewEpisode.id, request: 1 })),
      Scene.Command.resolve(
        FetchDocument,
        wrap(R.SucceededFetchDocument({ episodeId: reviewEpisode.id, request: 1, document: sampleDocument })),
      ),
      Scene.expect(Scene.role("textbox", { name: "Title" })).toHaveValue("Harbour Year"),
      Scene.expect(Scene.role("button", { name: "Start · 4 chapters" })).toBeEnabled(),
    )
  })
})

describe("review editing, repeated header removal, save, and start", () => {
  test("unticking updates the Start count, unticking all disables Start, and Start sends kept chapters in order", () => {
    const queuedAfterStart: Episode = { ...reviewEpisode, job: { _tag: "Queued" } }
    story(
      update,
      given(openedModel(cleanDocument)),
      // Edit chapter 1 text and untick chapter 0.
      message(wrap(R.ClickedChapter({ index: 1 }))),
      model((next) => expect(next.review.view._tag === "Editing" && next.review.view.maybeExpandedIndex).toEqual(Option.some(1))),
      message(wrap(R.UpdatedChapterText({ index: 1, value: "The red lantern shines across the harbour." }))),
      message(wrap(R.ToggledChapter({ index: 0 }))),
      // Untick chapter 1 too: Start does nothing with zero kept chapters.
      message(wrap(R.ToggledChapter({ index: 1 }))),
      message(wrap(R.ClickedStart())),
      Command.expectNone(),
      // Re-tick chapter 1 and start.
      message(wrap(R.ToggledChapter({ index: 1 }))),
      message(wrap(R.ClickedStart())),
      Command.expectExact(
        StartReviewNarration({
          connection,
          episodeId: reviewEpisode.id,
          document: {
            title: "Harbour Days",
            author: "Fama Fixtures",
            language: "en",
            chapters: [{ title: "Evening", text: "The red lantern shines across the harbour." }],
          },
        }),
      ),
      Command.resolve(StartReviewNarration, wrap(R.SucceededStartReview({ episode: queuedAfterStart }))),
      model((next) => {
        expect(next.review.view._tag).toBe("Closed")
        expect(Option.getOrThrow(next.maybeEpisodes)[0]?.job._tag).toBe("Queued")
      }),
    )
  })

  test("Save sends all chapters (preserving unticked ones) and clears dirty state on success", () => {
    story(
      update,
      given(openedModel(cleanDocument)),
      message(wrap(R.UpdatedTitle({ value: "Harbour Days Revised" }))),
      message(wrap(R.ToggledChapter({ index: 0 }))),
      message(wrap(R.UpdatedChapterText({ index: 1, value: "Updated evening text." }))),
      message(wrap(R.ClickedSave())),
      Command.expectExact(
        SaveDocument({
          connection,
          episodeId: reviewEpisode.id,
          document: {
            title: "Harbour Days Revised",
            author: "Fama Fixtures",
            language: "en",
            chapters: [
              { title: "Morning", text: "The harbour wakes before the town does." },
              { title: "Evening", text: "Updated evening text." },
            ],
          },
        }),
      ),
      Command.resolve(
        SaveDocument,
        wrap(
          R.SucceededSaveDocument({
            episodeId: reviewEpisode.id,
            document: {
              title: "Harbour Days Revised",
              author: "Fama Fixtures",
              language: "en",
              chapters: [
                { title: "Morning", text: "The harbour wakes before the town does." },
                { title: "Evening", text: "Updated evening text." },
              ],
            },
          }),
        ),
      ),
      model((next) => {
        expect(next.review.view._tag === "Editing" && next.review.view.save._tag).toBe("Saved")
      }),
    )
  })

  test("detects a header line that repeats across chapters and removes it cleanly in one click", () => {
    expect(removeLineFromText("HARBOUR YEAR\n\nSpring arrives.", "HARBOUR YEAR")).toBe("Spring arrives.")
    expect(removeLineFromText("First.\n\nHARBOUR YEAR\n\nSecond.", "HARBOUR YEAR")).toBe("First.\n\nSecond.")
    expect(
      detectRepeatedLines([
        { index: 0, title: "A", text: "HEADER\n\nOne.", isKept: true },
        { index: 1, title: "B", text: "HEADER\n\nTwo.", isKept: true },
      ]),
    ).toEqual(["HEADER"])

    Scene.scene(
      { update, view },
      Scene.given(openedModel(sampleDocument)),
      Scene.expect(Scene.role("button", { name: 'Remove "HARBOUR YEAR"' })).toExist(),
      Scene.click(Scene.role("button", { name: 'Remove "HARBOUR YEAR"' })),
      Scene.expect(Scene.role("button", { name: 'Remove "HARBOUR YEAR"' })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "1 Spring" })),
      Scene.expect(Scene.role("textbox", { name: "Text of Spring" })).toHaveValue("Spring arrives along the quay."),
      // Opening another chapter closes the previous editor so only one chapter's text is mounted.
      Scene.click(Scene.role("button", { name: "2 Summer" })),
      Scene.expect(Scene.role("textbox", { name: "Text of Spring" })).toBeAbsent(),
      Scene.expect(Scene.role("textbox", { name: "Text of Summer" })).toHaveValue("Boats cross the bright water."),
      // Untick Autumn and verify Start button count updates.
      Scene.click(Scene.role("checkbox", { name: "Keep Autumn" })),
      Scene.expect(Scene.role("button", { name: "Start · 3 of 4 chapters" })).toBeEnabled(),
    )
  })

  test("a clean document shows no repeated-header button and a failed start stays open with the error", () => {
    Scene.scene(
      { update, view },
      Scene.given(openedModel(cleanDocument)),
      Scene.expect(Scene.role("button", { name: /^Remove / })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Start · 2 chapters" })),
      Scene.Command.resolve(
        StartReviewNarration,
        wrap(R.FailedStartReview({ episodeId: reviewEpisode.id, failure: { status: 409, message: "Not in review" } })),
      ),
      Scene.expect(Scene.role("alert")).toHaveText("Not in review"),
      Scene.expect(Scene.role("button", { name: "Start · 2 chapters" })).toBeEnabled(),
    )
  })

  test("reconcile closes Review if the episode leaves Review on another device", () => {
    const startedElsewhere: Episode = { ...reviewEpisode, job: { _tag: "Queued" } }
    story(
      update,
      given(openedModel(cleanDocument)),
      message(Message.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [startedElsewhere] })),
      model((next) => expect(next.review.view._tag).toBe("Closed")),
    )
  })

  test("load failure shows an error and Try again refetches; stale fetch responses are dropped", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [reviewEpisode])),
      message(wrap(R.ClickedEpisode({ episodeId: reviewEpisode.id }))),
      Command.expectExact(FetchDocument({ connection, episodeId: reviewEpisode.id, request: 1 })),
      Command.resolve(
        FetchDocument,
        wrap(R.FailedFetchDocument({ episodeId: reviewEpisode.id, request: 1, failure: { status: 500, message: "Server error" } })),
      ),
      model((next) => expect(next.review.view).toEqual({ _tag: "LoadFailed", episodeId: reviewEpisode.id, message: "Server error" })),
      message(wrap(R.ClickedTryAgain())),
      Command.expectExact(FetchDocument({ connection, episodeId: reviewEpisode.id, request: 2 })),
      Command.resolve(
        FetchDocument,
        wrap(R.SucceededFetchDocument({ episodeId: reviewEpisode.id, request: 2, document: cleanDocument })),
      ),
      model((next) => expect(next.review.view._tag).toBe("Editing")),
      message(wrap(R.ClickedBack())),
      model((next) => expect(next.review.view._tag).toBe("Closed")),
    )
    const loadingSecond = update(
      withEpisodes(baseModel(), [reviewEpisode]),
      wrap(R.ClickedEpisode({ episodeId: reviewEpisode.id })),
    ).model
    story(
      update,
      given({ ...loadingSecond, review: { requests: 2, view: { _tag: "Loading", episodeId: reviewEpisode.id, request: 2 } } }),
      message(wrap(R.SucceededFetchDocument({ episodeId: reviewEpisode.id, request: 1, document: sampleDocument }))),
      model((next) => expect(next.review.view._tag).toBe("Loading")),
      message(wrap(R.SucceededFetchDocument({ episodeId: reviewEpisode.id, request: 2, document: cleanDocument }))),
      model((next) => expect(next.review.view._tag === "Editing" && next.review.view.title).toBe("Harbour Days")),
    )
  })
})
