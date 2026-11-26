import type { Document, JobState, VoiceRef } from "@fama/contracts"
import { describe, expect, test } from "vitest"
import {
  applyChapterText,
  canApplyVoice,
  canSaveText,
  describeNarrateAgainError,
  documentFailed,
  documentLoaded,
  editChapterText,
  editedChapterCount,
  hasTextEdits,
  hasVoiceEdits,
  initialNarrateAgain,
  isChapterEdited,
  retryDocumentLoad,
  selectSpeed,
  selectVoice,
  syncEpisode,
} from "./narrateAgain"

const heart = "kokoro:af_heart" as VoiceRef
const bella = "kokoro:af_bella" as VoiceRef
const readyJob: JobState = { _tag: "Ready", finishedAt: "2026-11-25T00:00:00.000Z" }
const failedJob: JobState = { _tag: "Failed", reason: "interrupted", failedAt: "2026-11-25T00:00:00.000Z" }
const queuedJob: JobState = { _tag: "Queued" }

const doc: Document = {
  title: "Harbour Days",
  author: "Fama Fixtures",
  language: "en",
  chapters: [
    { title: "Morning", text: "Quiet water." },
    { title: "", text: "Untitled interlude." },
    { title: "Evening", text: "The boats come home." },
  ],
}

describe("narrateAgain state and API seam rules", () => {
  test("editChapterText modifies only chapter text and preserves metadata, count, and titles", () => {
    const edited = editChapterText(doc, 1, "Updated interlude.")
    expect(edited.title).toBe(doc.title)
    expect(edited.author).toBe(doc.author)
    expect(edited.language).toBe(doc.language)
    expect(edited.chapters).toHaveLength(3)
    expect(edited.chapters.map((c) => c.title)).toEqual(["Morning", "", "Evening"])
    expect(edited.chapters.map((c) => c.text)).toEqual(["Quiet water.", "Updated interlude.", "The boats come home."])
  })

  test("multiple chapters can be edited before saving once, and reverting disables Save", () => {
    const episode = { job: readyJob, voice: heart, speed: 1 }
    let state = documentLoaded(initialNarrateAgain(episode), doc)
    expect(canSaveText(state, episode.job)).toBe(false)

    state = applyChapterText(state, 0, "Lanterns on the quay.")
    state = applyChapterText(state, 2, "The boats stay out.")
    expect(editedChapterCount(state)).toBe(2)
    expect(hasTextEdits(state)).toBe(true)
    expect(canSaveText(state, episode.job)).toBe(true)
    if (state.document._tag === "Ready") {
      expect(isChapterEdited(state.document, 0)).toBe(true)
      expect(isChapterEdited(state.document, 1)).toBe(false)
      expect(isChapterEdited(state.document, 2)).toBe(true)
    }

    // Reverting both edits disables Save again so an unchanged Document does not queue narration.
    state = applyChapterText(applyChapterText(state, 0, "Quiet water."), 2, "The boats come home.")
    expect(hasTextEdits(state)).toBe(false)
    expect(canSaveText(state, episode.job)).toBe(false)
  })

  test("a 404 Document marks text Missing while keeping Voice & speed available", () => {
    const episode = { job: readyJob, voice: heart, speed: 1 }
    let state = documentFailed(initialNarrateAgain(episode), 404, "Not found on the server.")
    expect(state.document).toEqual({ _tag: "Missing" })
    expect(canSaveText(state, episode.job)).toBe(false)
    expect(canApplyVoice(state, episode)).toBe(false)

    state = selectSpeed(state, 1.25)
    expect(hasVoiceEdits(state, episode)).toBe(true)
    expect(canApplyVoice(state, episode)).toBe(true)
  })

  test("non-404 Document errors can be retried and syncEpisode preserves touched voice choices", () => {
    const episode = { job: failedJob, voice: null, speed: 1 }
    let state = documentFailed(initialNarrateAgain(episode), 500, "The server failed (500).")
    expect(state.document).toEqual({ _tag: "Failed", message: "The server failed (500)." })
    expect(canApplyVoice(state, episode)).toBe(false)

    state = selectVoice(state, bella)
    expect(canApplyVoice(state, episode)).toBe(true)
    expect(syncEpisode(state, { voice: heart, speed: 1.5 }).voice).toBe(bella)
    expect(retryDocumentLoad(state).document).toEqual({ _tag: "Loading" })
  })

  test("queued jobs and in-flight operations block a second write to prevent 409 NotEditable", () => {
    const readyEpisode = { job: readyJob, voice: heart, speed: 1 }
    let state = selectVoice(applyChapterText(documentLoaded(initialNarrateAgain(readyEpisode), doc), 0, "Changed."), bella)

    expect(canSaveText(state, readyEpisode.job)).toBe(true)
    expect(canApplyVoice(state, readyEpisode)).toBe(true)

    const saving = { ...state, operation: "savingDocument" as const }
    expect(canSaveText(saving, readyEpisode.job)).toBe(false)
    expect(canApplyVoice(saving, readyEpisode)).toBe(false)

    const queuedEpisode = { ...readyEpisode, job: queuedJob }
    expect(canSaveText(state, queuedEpisode.job)).toBe(false)
    expect(canApplyVoice(state, queuedEpisode)).toBe(false)
    expect(describeNarrateAgainError(409, "Request failed (409).")).toBe("This episode is already being narrated.")
  })
})
