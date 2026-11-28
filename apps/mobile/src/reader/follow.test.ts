import { describe, expect, test } from "vitest"
import { followNext, showsBackToNow } from "./follow"

describe("the reader's scroll-follow state", () => {
  test("dragging pauses auto-scroll", () => {
    expect(followNext({ _tag: "DragStart" })).toBe("scrolled")
  })

  test("Back to now and a sentence tap follow the active sentence again", () => {
    expect(followNext({ _tag: "BackToNow" })).toBe("following")
    expect(followNext({ _tag: "SentenceTap" })).toBe("following")
  })

  test("the Back to now pill shows only while scrolled away", () => {
    expect(showsBackToNow("following")).toBe(false)
    expect(showsBackToNow("scrolled")).toBe(true)
  })
})
