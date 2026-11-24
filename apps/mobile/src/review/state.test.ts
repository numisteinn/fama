import type { Document } from "@fama/contracts"
import { expect, test } from "vitest"
import { editText, removeHeader, repeatedHeader, reviewDocument, startDocument, toggleChapter } from "./state"

const book: Document = { title: "Book", author: "A", language: "en", chapters: [
  { title: "One", text: "Book\r\nBody: Book" }, { title: "Two", text: "Book\nTwo" }, { title: "Three", text: "Book\nThree" },
] }

test("save retains all chapters and Start keeps corrections in narration order", () => {
  const edited = editText(removeHeader(book), 2, "Correction")
  const review = toggleChapter({ ...reviewDocument(book), edited }, 1)
  expect(repeatedHeader(book)).toBe("Book")
  expect(repeatedHeader(edited)).toBeNull()
  expect(removeHeader(edited)).toBe(edited)
  expect(edited.chapters).toHaveLength(3)
  expect(startDocument(review)).toEqual({ ...book, chapters: [
    { title: "One", text: "Body: Book" }, { title: "Three", text: "Correction" },
  ] })
  expect(startDocument(toggleChapter(review, 1))).toEqual(edited)
  expect(startDocument(toggleChapter(toggleChapter(review, 0), 2))).toBeNull()
})
