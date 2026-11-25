import type { Document, DocumentChapter } from "@fama/contracts"

export type Review = {
  loaded: Document
  edited: Document
  excluded: ReadonlySet<number>
  operation: "idle" | "saving" | "starting" | "deleting"
}

export const reviewDocument = (document: Document): Review => ({
  loaded: document, edited: document, excluded: new Set(), operation: "idle",
})

export function toggleChapter(review: Review, index: number): Review {
  const excluded = new Set(review.excluded)
  if (excluded.has(index)) excluded.delete(index)
  else excluded.add(index)
  return { ...review, excluded }
}

function mapChapters(document: Document, edit: (chapter: DocumentChapter, i: number) => DocumentChapter): Document {
  const [first, ...rest] = document.chapters
  return { ...document, chapters: [edit(first, 0), ...rest.map((chapter, i) => edit(chapter, i + 1))] }
}

export function editText(document: Document, index: number, text: string): Document {
  return mapChapters(document, (chapter, i) => i === index ? { ...chapter, text } : chapter)
}

// Remove only an identical first line. Keep matching words in chapter bodies.
const firstLine = (text: string) => text.match(/^([^\r\n]+)\r?\n/)?.[1]?.trim()

export function repeatedHeader(document: Document): string | null {
  const header = firstLine(document.chapters[0].text)
  return header && document.chapters.length > 1 && document.chapters.every(c => firstLine(c.text) === header) ? header : null
}

export function removeHeader(document: Document): Document {
  if (!repeatedHeader(document)) return document
  return mapChapters(document, c => ({ ...c, text: c.text.slice(c.text.indexOf("\n") + 1) }))
}

export function startDocument(review: Review): Document | null {
  const [first, ...rest] = review.edited.chapters.filter((_, i) => !review.excluded.has(i))
  return first ? { ...review.edited, chapters: [first, ...rest] } : null
}
