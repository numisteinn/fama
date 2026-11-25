import type { Document, DocumentChapter, Episode, JobState, VoiceRef } from "@fama/contracts"

export type DocumentLoad =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly loaded: Document; readonly edited: Document }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Failed"; readonly message: string }

export type Operation = "idle" | "savingDocument" | "changingVoice"

export type NarrateAgain = {
  readonly document: DocumentLoad
  readonly voice: VoiceRef | null
  readonly speed: number
  readonly voiceTouched: boolean
  readonly operation: Operation
}

type EpisodeSnapshot = Pick<Episode, "job" | "voice" | "speed">

export const initialNarrateAgain = (episode: Pick<Episode, "voice" | "speed"> | null): NarrateAgain => ({
  document: { _tag: "Loading" },
  voice: episode?.voice ?? null,
  speed: episode?.speed ?? 1,
  voiceTouched: false,
  operation: "idle",
})

export function syncEpisode(state: NarrateAgain, episode: Pick<Episode, "voice" | "speed"> | null): NarrateAgain {
  if (state.voiceTouched || !episode) return state
  if (state.voice === episode.voice && state.speed === episode.speed) return state
  return { ...state, voice: episode.voice, speed: episode.speed }
}

export const selectVoice = (state: NarrateAgain, voice: VoiceRef): NarrateAgain => ({
  ...state,
  voice,
  voiceTouched: true,
})

export const selectSpeed = (state: NarrateAgain, speed: number): NarrateAgain => ({
  ...state,
  speed,
  voiceTouched: true,
})

export const documentLoaded = (state: NarrateAgain, document: Document): NarrateAgain => ({
  ...state,
  document: { _tag: "Ready", loaded: document, edited: document },
})

export const documentFailed = (state: NarrateAgain, status: number | null, message: string): NarrateAgain => ({
  ...state,
  document: status === 404 ? { _tag: "Missing" } : { _tag: "Failed", message },
})

export const retryDocumentLoad = (state: NarrateAgain): NarrateAgain => ({
  ...state,
  document: { _tag: "Loading" },
})

/**
 * Updates only `chapters[index].text`. Document metadata, chapter count, and chapter titles in index order stay
 * untouched, matching `PUT /api/episodes/:id/document` after narration starts.
 */
export function editChapterText(document: Document, index: number, text: string): Document {
  const [first, ...rest] = document.chapters
  const edit = (chapter: DocumentChapter, i: number): DocumentChapter =>
    i === index ? { title: chapter.title, text } : chapter
  return { ...document, chapters: [edit(first, 0), ...rest.map((chapter, i) => edit(chapter, i + 1))] }
}

export function applyChapterText(state: NarrateAgain, index: number, text: string): NarrateAgain {
  if (state.document._tag !== "Ready") return state
  return {
    ...state,
    document: { ...state.document, edited: editChapterText(state.document.edited, index, text) },
  }
}

export function isChapterEdited(document: Extract<DocumentLoad, { _tag: "Ready" }>, index: number): boolean {
  return document.edited.chapters[index]?.text !== document.loaded.chapters[index]?.text
}

export function editedChapterCount(state: NarrateAgain): number {
  const { document } = state
  if (document._tag !== "Ready") return 0
  return document.edited.chapters.filter((chapter, index) => chapter.text !== document.loaded.chapters[index]?.text).length
}

export const hasTextEdits = (state: NarrateAgain): boolean => editedChapterCount(state) > 0

export const hasVoiceEdits = (state: NarrateAgain, episode: Pick<Episode, "voice" | "speed"> | null): boolean =>
  state.voice !== null && (episode === null || state.voice !== episode.voice || state.speed !== episode.speed)

export const isEditableJob = (job: JobState | undefined): boolean =>
  job?._tag === "Ready" || job?._tag === "Failed"

export const canSaveText = (state: NarrateAgain, job: JobState | undefined): boolean =>
  isEditableJob(job) && state.operation === "idle" && hasTextEdits(state)

export const canApplyVoice = (state: NarrateAgain, episode: EpisodeSnapshot | null): boolean =>
  episode !== null &&
  isEditableJob(episode.job) &&
  state.operation === "idle" &&
  state.voice !== null &&
  (episode.job._tag === "Failed" || hasVoiceEdits(state, episode))

export const describeNarrateAgainError = (status: number | null, fallback: string): string =>
  status === 409 ? "This episode is already being narrated." : fallback
