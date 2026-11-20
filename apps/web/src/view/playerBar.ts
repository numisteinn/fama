import type { Episode } from "@fama/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { formatClock, formatRate } from "~/lib/format"
import { Message } from "~/message"
import { type LoadedPlayback, type Model, RATES, SKIP_BACK_MS, SKIP_FORWARD_MS, current } from "~/model"
import { chapterStartMs, totalMs } from "~/timeline"
import { pickerCheckedIndex } from "~/update"
import { buttonClass } from "~/view/button"
import * as Icon from "~/view/icon"
import { picker } from "~/view/picker"

/** The bar at the bottom while an episode is loaded. */
export const playerBar = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(current(model), {
    onNone: () => [],
    onSome: ({ playback, episode }) => [bar(model, playback, episode, h)],
  })

const bar = (model: Model, playback: LoadedPlayback, episode: Episode, h: HtmlBuilder<Message>): Html => {
  const chapter = episode.chapters[playback.chapter]
  return h.footer(
    [
      h.Class(
        "fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl",
      ),
    ],
    [
      h.div(
        [
          h.Class(
            "mx-auto grid max-w-5xl grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)] sm:gap-x-6",
          ),
        ],
        [
          h.div(
            [h.Class("min-w-0")],
            [
              h.div([h.Class("truncate text-sm font-medium")], [episode.title]),
              ...(episode.chapters.length > 1 && chapter
                ? [h.div([h.Class("truncate text-[13px] text-muted-foreground")], [chapter.title])]
                : []),
            ],
          ),
          h.div(
            [h.Class("contents sm:flex sm:flex-col sm:items-center sm:gap-1")],
            [transport(playback, h), scrubber(model, playback, episode, h)],
          ),
          h.div(
            [h.Class("col-span-2 grid grid-cols-[1fr_auto_1fr] items-center gap-1 sm:col-span-1 sm:flex sm:justify-end")],
            [
              ...picker(model, h, {
                pickerId: "PlaybackSpeed",
                label: `Playback speed: ${formatRate(model.rate)}`,
                side: "Top",
                triggerClass: buttonClass({ size: "sm" }, "w-14 justify-self-start tabular-nums"),
                triggerContent: [formatRate(model.rate)],
                options: RATES.map((value) => ({ label: formatRate(value) })),
                checkedIndex: pickerCheckedIndex(model, "PlaybackSpeed"),
              }),
              h.div([h.Class("flex items-center gap-1 sm:hidden")], skipButtons(h, [])),
              h.div(
                [h.Class("flex items-center justify-end gap-1")],
                [
                  ...(episode.chapters.length > 1
                    ? picker(model, h, {
                        pickerId: "Chapters",
                        label: "Chapters",
                        side: "Top",
                        align: "End",
                        triggerClass: buttonClass({ size: "icon-sm" }),
                        triggerContent: [Icon.listMusic()],
                        options: episode.chapters.map((item) => ({
                          label: h.span(
                            [h.Class("flex gap-3")],
                            [
                              h.span([h.Class("w-5 text-right text-muted-foreground tabular-nums")], [String(item.index + 1)]),
                              h.span([h.Class("truncate")], [item.title]),
                            ],
                          ),
                        })),
                        checkedIndex: pickerCheckedIndex(model, "Chapters"),
                      })
                    : []),
                  ...(episode.bookUrl
                    ? [
                        h.a(
                          [
                            h.Href(model.connection.origin + episode.bookUrl),
                            h.Download(`${episode.title}.m4b`),
                            h.AriaLabel("Download"),
                            h.Class(buttonClass({ size: "icon-sm" })),
                          ],
                          [Icon.download()],
                        ),
                      ]
                    : []),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const transport = (playback: LoadedPlayback, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("col-start-2 row-start-1 flex items-center gap-1 sm:col-auto sm:row-auto")],
    [
      h.div([h.Class("hidden items-center gap-1 sm:flex")], skipButtons(h, [playButton(playback, h)])),
      h.div([h.Class("sm:hidden")], [playButton(playback, h)]),
      h.span([h.Class("sr-only"), h.AriaLive("polite")], [playback.isWaiting ? "Waiting for the next chapter" : ""]),
    ],
  )

const playButton = (playback: LoadedPlayback, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.AriaLabel(playback.isPlaying ? "Pause" : "Play"),
      h.OnClick(Message.ClickedPlayPause()),
      h.Class(buttonClass({ variant: "primary", size: "icon-lg" })),
    ],
    [
      playback.isWaiting
        ? Icon.loaderCircle("animate-spin")
        : playback.isPlaying
          ? Icon.pause("fill-current")
          : Icon.play("translate-x-px fill-current"),
    ],
  )

const skipButtons = (h: HtmlBuilder<Message>, middle: ReadonlyArray<Html>): ReadonlyArray<Html> => [
  h.button(
    [
      h.Type("button"),
      h.AriaLabel("Back 15 seconds"),
      h.OnClick(Message.ClickedSkip({ deltaMs: -SKIP_BACK_MS })),
      h.Class(buttonClass({ size: "icon" })),
    ],
    [skipIcon("Back", SKIP_BACK_MS / 1000, h)],
  ),
  ...middle,
  h.button(
    [
      h.Type("button"),
      h.AriaLabel("Forward 30 seconds"),
      h.OnClick(Message.ClickedSkip({ deltaMs: SKIP_FORWARD_MS })),
      h.Class(buttonClass({ size: "icon" })),
    ],
    [skipIcon("Forward", SKIP_FORWARD_MS / 1000, h)],
  ),
]

const skipIcon = (direction: "Back" | "Forward", seconds: number, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class("relative grid size-6 place-items-center")],
    [
      (direction === "Back" ? Icon.rotateCcw : Icon.rotateCw)("absolute size-6 stroke-[1.5]"),
      h.span([h.Class("relative text-[8.5px] leading-none font-semibold tabular-nums")], [String(seconds)]),
    ],
  )

/** Position on the whole episode. The value moves while dragging; the seek happens on release. */
const scrubber = (model: Model, playback: LoadedPlayback, episode: Episode, h: HtmlBuilder<Message>): Html => {
  const durationMs = totalMs(episode.chapters)
  const positionMs = chapterStartMs(episode.chapters, playback.chapter) + playback.offsetMs
  const max = Math.max(1, durationMs)
  const value = Math.min(Option.getOrElse(model.maybeScrubMs, () => positionMs), max)
  return h.div(
    [h.Class("col-span-2 flex w-full items-center gap-3 text-xs text-muted-foreground tabular-nums sm:col-span-1")],
    [
      h.span([h.Class("w-12 text-right")], [formatClock(value)]),
      h.div(
        [h.Role("group"), h.AriaLabel("Position"), h.Class("flex-1")],
        [
          h.input([
            h.Type("range"),
            h.Min("0"),
            h.Max(String(max)),
            h.Step("1000"),
            h.Value(String(value)),
            h.AriaValuenow(value),
            h.AriaValuetext(formatClock(value)),
            h.OnInput((next) => Message.UpdatedScrub({ value: next })),
            h.OnChange((next) => Message.CommittedScrub({ value: next })),
            h.Class("scrubber"),
            h.Style({ "--fill": `${(value / max) * 100}%` }),
          ]),
        ],
      ),
      h.span([h.Class("w-12")], [formatClock(durationMs)]),
    ],
  )
}
