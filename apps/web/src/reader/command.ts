import { Timing } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { Command, Render } from "foldkit"
import { apiToken, sendJson } from "~/api"
import { Message } from "~/message"
import { ReaderMessage } from "~/reader/message"

const toParent = (message: ReaderMessage) => Message.GotReaderMessage({ message })

/** A timing file is a media path: the feed token is in the path, and it takes no bearer token. */
export const FetchTiming = Command.define("FetchTiming", {
  args: { origin: Schema.String, url: Schema.String },
  messages: [Message.GotReaderMessage],
  execute: ({ origin, url }) =>
    sendJson(Timing, { origin, token: apiToken("") }, "GET", url).pipe(
      Effect.map((timing) => toParent(ReaderMessage.SucceededFetchTiming({ url, timing }))),
      Effect.catch(() => Effect.succeed(toParent(ReaderMessage.FailedFetchTiming({ url })))),
    ),
})

export const ReadSelection = Command.define("ReadSelection", {
  args: { chapter: Schema.Number, segment: Schema.Number },
  messages: [Message.GotReaderMessage],
  execute: ({ chapter, segment }) =>
    Effect.sync(() =>
      toParent(
        ReaderMessage.GotSelectionOnClick({
          chapter,
          segment,
          isSelecting: !(window.getSelection()?.isCollapsed ?? true),
        }),
      ),
    ),
})

export const MARK_SELECTOR = '#reader [aria-current="true"]'

/** The bottom of the space the text shows in: the top of the player bar. */
const sightBottom = (): number => window.innerHeight - (document.querySelector("footer")?.offsetHeight ?? 0)

/** Some of the element is on screen, above the player bar. */
export const isInSight = (element: Element): boolean => {
  const rect = element.getBoundingClientRect()
  return rect.bottom > 0 && rect.top < sightBottom()
}

/**
 * Keeps the mark in the upper part of the screen. While it stays between 15% and 70% of the space above the player
 * bar, nothing moves, so the text does not jump on each sentence. When it leaves that band, the page scrolls it to 30%.
 */
export const ScrollToMark = Command.define("ScrollToMark", {
  args: { id: Schema.String, isInstant: Schema.Boolean },
  messages: [Message.GotReaderMessage],
  execute: ({ id, isInstant }) =>
    Render.afterCommit.pipe(
      Effect.andThen(
        Effect.sync(() => {
          const element = document.getElementById(id)
          if (element) {
            const space = sightBottom()
            const { top, bottom } = element.getBoundingClientRect()
            if (top < space * 0.15 || bottom > space * 0.7) {
              const isReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
              window.scrollTo({ top: window.scrollY + top - space * 0.3, behavior: isInstant || isReduced ? "instant" : "smooth" })
            }
          }
          return toParent(ReaderMessage.CompletedScrollToMark())
        }),
      ),
    ),
})
