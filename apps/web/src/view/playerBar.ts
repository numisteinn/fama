import type { Episode } from "@fama/contracts"
import type { Html } from "@effect/ui/html"
import { Option } from "effect"
import { Picker, type PickerOption } from "~/components/Picker"
import { formatClock, formatRate } from "~/lib/format"
import { AppMessage } from "~/message"
import {
  type AppModel,
  type LoadedPlayback,
  RATES,
  SKIP_BACK_MS,
  SKIP_FORWARD_MS,
  current,
  isPlayPending,
} from "~/model"
import { hasText } from "~/reader/ReaderScreen"
import { SCRUB_STEP_MS, chapterStartMs, scrubMaxMs, totalMs } from "~/timeline"
import { buttonClass, cx } from "~/view/button"
import * as Icon from "~/view/icon"

const rateOptions: ReadonlyArray<PickerOption> = RATES.map((rate) => ({
  value: String(rate),
  name: formatRate(rate),
}))

/** The bar at the bottom while an episode is loaded. */
export const PlayerBar = (model: AppModel, h: Html.H<AppMessage>) =>
  Option.match(current(model), {
    onNone: () => null,
    onSome: ({ playback, episode }) => bar(model, playback, episode, h),
  })

const bar = (model: AppModel, playback: LoadedPlayback, episode: Episode, h: Html.H<AppMessage>) => {
  const chapter = episode.chapters[playback.chapter]
  const isReaderOpen = Option.contains(model.maybeReaderEpisodeId, episode.id)
  const chapterOptions: ReadonlyArray<PickerOption> = episode.chapters.map((item, index) => ({
    value: String(index),
    name: item.title,
    number: index + 1,
  }))

  return h.footer
    .class("fixed inset-x-0 bottom-0 z-30 border-t border-border pb-[env(safe-area-inset-bottom)]")
    .children(
      // The blur sits on its own layer so it does not create a containing block for top-layer overlays.
      h.div.attr("aria-hidden", "true").class("absolute inset-0 -z-10 bg-background/90 backdrop-blur-xl"),
      h.div
        .class(
          "mx-auto grid max-w-5xl grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)] sm:gap-x-6",
        )
        .children(
          h.div.class("min-w-0").children(
            h.div.class("truncate text-sm font-medium").children(episode.title),
            episode.chapters.length > 1 &&
              chapter &&
              h.div.class("truncate text-[13px] text-muted-foreground").children(chapter.title),
          ),
          h.div.class("contents sm:flex sm:flex-col sm:items-center sm:gap-1").children(
            transport(playback, isPlayPending(model, episode.id), h),
            scrubber(model, playback, episode, h),
          ),
          h.div
            .class(
              "col-span-2 grid grid-cols-[1fr_auto_1fr] items-center gap-1 sm:col-span-1 sm:flex sm:justify-end",
            )
            .children(
              Picker(h, {
                key: "playback-speed",
                props: {
                  label: `Playback speed: ${formatRate(model.rate)}`,
                  triggerText: formatRate(model.rate),
                  triggerKind: "playbackSpeed",
                  triggerClass: buttonClass({ size: "sm" }, "w-14 justify-self-start tabular-nums"),
                  selectedValue: String(model.rate),
                  items: rateOptions,
                  side: "top",
                },
                onEmit: {
                  Picked: ({ value }) => AppMessage.PickedPlaybackSpeed({ value }),
                },
              }),
              h.div.class("flex items-center gap-1 sm:hidden").children(...skipButtons(h, [])),
              h.div.class("flex items-center justify-end gap-1").children(
                hasText(episode) &&
                  h.button
                    .attrs({
                      type: "button",
                      "aria-label": "Text",
                      "aria-pressed": String(isReaderOpen),
                    })
                    .on("click", AppMessage.ClickedToggleReader())
                    .class(buttonClass({ size: "icon-sm" }, cx(isReaderOpen && "bg-accent text-foreground")))
                    .children(Icon.bookOpenText(h)),
                episode.chapters.length > 1 &&
                  Picker(h, {
                    key: "chapters",
                    props: {
                      label: "Chapters",
                      triggerText: "",
                      triggerKind: "chapters",
                      triggerClass: buttonClass({ size: "icon-sm" }),
                      selectedValue: String(playback.chapter),
                      items: chapterOptions,
                      side: "top",
                      align: "end",
                    },
                    onEmit: {
                      Picked: ({ value }) => AppMessage.PickedChapter({ value }),
                    },
                  }),
                episode.bookUrl &&
                  h.a
                    .attrs({
                      href: model.connection.origin + episode.bookUrl,
                      download: `${episode.title}.m4b`,
                      "aria-label": "Download",
                    })
                    .class(buttonClass({ size: "icon-sm" }))
                    .children(Icon.download(h)),
              ),
            ),
        ),
    )
}

const transport = (playback: LoadedPlayback, isPending: boolean, h: Html.H<AppMessage>) =>
  h.div.class("col-start-2 row-start-1 flex items-center gap-1 sm:col-auto sm:row-auto").children(
    h.div.class("hidden items-center gap-1 sm:flex").children(...skipButtons(h, [playButton(playback, isPending, h)])),
    h.div.class("sm:hidden").children(playButton(playback, isPending, h)),
    h.span.attr("aria-live", "polite").class("sr-only").children(playback.isWaiting ? "Waiting for the next chapter" : ""),
  )

/** The spinner shows a Play that waits: for the next chapter, or for the library (`isPending`). */
const playButton = (playback: LoadedPlayback, isPending: boolean, h: Html.H<AppMessage>) =>
  h.button
    .attrs({ type: "button", "aria-label": playback.isPlaying ? "Pause" : "Play" })
    .on("click", AppMessage.ClickedPlayPause())
    .class(buttonClass({ variant: "primary", size: "icon-lg" }))
    .children(
      playback.isWaiting || isPending
        ? Icon.loaderCircle(h, "animate-spin")
        : playback.isPlaying
          ? Icon.pause(h, "fill-current")
          : Icon.play(h, "translate-x-px fill-current"),
    )

const skipButtons = (
  h: Html.H<AppMessage>,
  middle: ReadonlyArray<ReturnType<typeof playButton>>,
) => [
  h.button
    .attrs({ type: "button", "aria-label": "Back 15 seconds" })
    .on("click", AppMessage.ClickedSkip({ deltaMs: -SKIP_BACK_MS }))
    .class(buttonClass({ size: "icon" }))
    .children(skipIcon("Back", SKIP_BACK_MS / 1000, h)),
  ...middle,
  h.button
    .attrs({ type: "button", "aria-label": "Forward 30 seconds" })
    .on("click", AppMessage.ClickedSkip({ deltaMs: SKIP_FORWARD_MS }))
    .class(buttonClass({ size: "icon" }))
    .children(skipIcon("Forward", SKIP_FORWARD_MS / 1000, h)),
]

const skipIcon = (direction: "Back" | "Forward", seconds: number, h: Html.H<AppMessage>) =>
  h.span.class("relative grid size-6 place-items-center").children(
    (direction === "Back" ? Icon.rotateCcw : Icon.rotateCw)(h, "absolute size-6 stroke-[1.5]"),
    h.span.class("relative text-[8.5px] leading-none font-semibold tabular-nums").children(String(seconds)),
  )

/** Position on the whole episode. The value moves while dragging; the seek happens on release. */
const scrubber = (model: AppModel, playback: LoadedPlayback, episode: Episode, h: Html.H<AppMessage>) => {
  const durationMs = totalMs(episode.chapters)
  const positionMs = chapterStartMs(episode.chapters, playback.chapter) + playback.offsetMs
  const max = scrubMaxMs(episode.chapters)
  const value = Option.getOrElse(model.maybeScrubMs, () => (positionMs >= durationMs ? max : positionMs))
  const shownMs = Math.min(value, durationMs)
  return h.div
    .class("col-span-2 flex w-full items-center gap-3 text-xs text-muted-foreground tabular-nums sm:col-span-1")
    .children(
      h.span.class("w-12 text-right").children(formatClock(shownMs)),
      h.div.attrs({ role: "group", "aria-label": "Position" }).class("flex-1").children(
        h.input
          .attrs({
            type: "range",
            min: "0",
            max: String(max),
            step: String(SCRUB_STEP_MS),
            "aria-valuenow": String(shownMs),
            "aria-valuetext": formatClock(shownMs),
          })
          .value(String(value))
          .on("input", ({ value: next }) => AppMessage.UpdatedScrub({ value: next }))
          .on("change", ({ value: next }) => AppMessage.CommittedScrub({ value: next }))
          .class("scrubber")
          .style({ "--fill": `${(value / max) * 100}%` }),
      ),
      h.span.class("w-12").children(formatClock(durationMs)),
    )
}
