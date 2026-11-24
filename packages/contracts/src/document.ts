import { Schema } from "effect"

/** One part of a Document. Audio chapter `i` of an episode narrates Document chapter `i`. */
export const DocumentChapter = Schema.Struct({ title: Schema.String, text: Schema.String })
export interface DocumentChapter extends Schema.Schema.Type<typeof DocumentChapter> {}

/**
 * The clean text the worker extracts from a source. The API stores one for each episode, and the worker narrates
 * from the stored one. A Document always has a chapter, because there is nothing to narrate without one.
 */
export const Document = Schema.Struct({
  title: Schema.String,
  author: Schema.NullOr(Schema.String),
  language: Schema.String,
  chapters: Schema.NonEmptyArray(DocumentChapter),
})
export interface Document extends Schema.Schema.Type<typeof Document> {}
