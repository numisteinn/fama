import { Document, EpisodeId, VoiceRef } from "@fama/contracts"
import { Option, Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"

/** The one request in flight. Each submit queues narration, so the two edits never submit together. */
export const SubmitState = defineTaggedUnion({
  Idle: {},
  SubmittingText: {},
  SubmittingVoice: {},
  Failed: { message: Schema.String },
})
export type SubmitState = typeof SubmitState.Type

export const NarrateAgainView = defineTaggedUnion({
  Closed: {},
  Loading: { episodeId: EpisodeId, request: Schema.Number },
  LoadFailed: { episodeId: EpisodeId, message: Schema.String },
  Editing: {
    episodeId: EpisodeId,
    /** `None` is a legacy Episode with no stored Document. Voice and speed still work. */
    document: Schema.Option(Document),
    texts: Schema.Array(Schema.String),
    maybeExpandedIndex: Schema.Option(Schema.Number),
    voice: Schema.NullOr(VoiceRef),
    speed: Schema.Number,
    initialVoice: Schema.NullOr(VoiceRef),
    initialSpeed: Schema.Number,
    submit: SubmitState,
  },
})
export type NarrateAgainView = typeof NarrateAgainView.Type
export type EditingNarrateAgain = Extract<NarrateAgainView, { _tag: "Editing" }>

export const NarrateAgain = Schema.Struct({
  view: NarrateAgainView,
  /** Counts Document fetches so stale responses are dropped. */
  requests: Schema.Number,
})
export type NarrateAgain = typeof NarrateAgain.Type

export const initNarrateAgain: NarrateAgain = { view: NarrateAgainView.Closed(), requests: 0 }

export const isTextDirty = (editing: EditingNarrateAgain): boolean =>
  Option.exists(editing.document, (document) =>
    document.chapters.some((chapter, index) => chapter.text !== editing.texts[index]),
  )

export const isVoiceDirty = (editing: EditingNarrateAgain): boolean =>
  editing.voice !== editing.initialVoice || editing.speed !== editing.initialSpeed

/** Full Document with Chapter text edits only. Metadata, titles, count and order stay as loaded. */
export const toDocument = (editing: EditingNarrateAgain): Option.Option<Document> =>
  Option.map(editing.document, (document) => {
    const chapters = document.chapters.map((chapter, index) => ({
      ...chapter,
      text: editing.texts[index] ?? chapter.text,
    }))
    return { ...document, chapters: [chapters[0]!, ...chapters.slice(1)] }
  })

export const isSubmitting = (editing: EditingNarrateAgain): boolean =>
  editing.submit._tag === "SubmittingText" || editing.submit._tag === "SubmittingVoice"
