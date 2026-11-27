import type { Document } from "@fama/contracts"
import { Option, Schema } from "effect"

/** Which part of Narrate again a submit touches: the chapter text, or the voice and speed. */
export const NarrateAgainSubmitTarget = Schema.Literals(["text", "voice"])
export type NarrateAgainSubmitTarget = typeof NarrateAgainSubmitTarget.Type

export const toEditedDocument = (
  doc: Option.Option<Document>,
  texts: ReadonlyArray<string>,
): Option.Option<Document> =>
  Option.map(doc, (document) => {
    const [first, ...rest] = document.chapters
    return {
      ...document,
      chapters: [
        { ...first, text: texts[0] ?? first.text },
        ...rest.map((chapter, index) => ({ title: chapter.title, text: texts[index + 1] ?? chapter.text })),
      ],
    }
  })
