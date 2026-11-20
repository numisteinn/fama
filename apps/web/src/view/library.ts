import type { Episode, JobState } from "@fama/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { deleteConfirmId } from "~/command"
import { formatDuration } from "~/lib/format"
import { Message } from "~/message"
import type { Model } from "~/model"
import { totalMs } from "~/timeline"
import { buttonClass, cx } from "~/view/button"
import * as Icon from "~/view/icon"

/** The episode list, or the error of the first load with a way to try again. */
export const library = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeEpisodes, {
    onNone: () =>
      Option.match(model.maybeLibraryFailure, {
        onNone: () => h.empty,
        onSome: (failure) =>
          h.div(
            [h.Class("flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 text-sm")],
            [
              h.span([h.Class("text-destructive")], [failure.message]),
              h.button(
                [
                  h.Type("button"),
                  h.OnClick(Message.ClickedTryAgain()),
                  h.Class(buttonClass({ variant: "outline", size: "sm" })),
                ],
                ["Try again"],
              ),
            ],
          ),
      }),
    onSome: (episodes) =>
      h.ul(
        [h.Class("-mx-2 flex flex-col")],
        episodes.map((episode) => row(model, episode, h)),
      ),
  })

const row = (model: Model, episode: Episode, h: HtmlBuilder<Message>): Html => {
  const playback = model.playback
  const isCurrent = playback._tag === "Loaded" && playback.episodeId === episode.id
  const isPlaying = isCurrent && playback.isPlaying
  const isPlayable = episode.chapters.length > 0
  const maybeRowError = Option.fromNullishOr(model.rowErrors[episode.id])
  const maybeErrorText = Option.orElse(maybeRowError, () =>
    episode.job._tag === "Failed" ? Option.some(episode.job.reason) : Option.none(),
  )
  const isArmed = model.armedDeletes.includes(episode.id)

  return h.keyed("li")(
    episode.id,
    [
      h.Class(
        cx(
          "group relative flex min-h-14 items-center gap-3 rounded-xl px-2 py-2 transition-colors duration-150",
          isPlayable && "hover:bg-accent",
          isCurrent && "bg-accent",
        ),
      ),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.Disabled(!isPlayable),
          h.OnClick(Message.ClickedPlayEpisode({ episodeId: episode.id })),
          h.AriaLabel(isPlaying ? `Pause ${episode.title}` : `Play ${episode.title}`),
          h.Class(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left outline-none disabled:cursor-default before:absolute before:inset-0 before:rounded-xl focus-visible:before:ring-2 focus-visible:before:ring-ring",
          ),
        ],
        [
          artwork(model, episode, isCurrent, isPlaying, h),
          h.span(
            [h.Class("min-w-0 flex-1")],
            [
              h.span([h.Class("block truncate text-[15px] leading-snug")], [episode.title]),
              ...Option.match(maybeErrorText, {
                onNone: () => [],
                onSome: (text) => [
                  h.span(
                    [
                      h.Class("block truncate text-[13px] text-destructive"),
                      ...Option.match(maybeRowError, { onNone: () => [], onSome: (title) => [h.Title(title)] }),
                    ],
                    [text],
                  ),
                ],
              }),
            ],
          ),
        ],
      ),
      jobStatus(episode, h),
      ...(episode.job._tag === "Failed"
        ? [
            h.button(
              [
                h.Type("button"),
                h.OnClick(Message.ClickedRetry({ episodeId: episode.id })),
                h.Class(buttonClass({ variant: "outline", size: "sm" }, "relative")),
              ],
              [Icon.rotateCw(), "Retry"],
            ),
          ]
        : []),
      isArmed
        ? h.button(
            [
              h.Id(deleteConfirmId(episode.id)),
              h.Type("button"),
              h.OnClick(Message.ClickedConfirmDelete({ episodeId: episode.id })),
              h.Class(buttonClass({ variant: "destructive", size: "sm" }, "relative")),
            ],
            ["Delete"],
          )
        : h.button(
            [
              h.Type("button"),
              h.AriaLabel(`Delete ${episode.title}`),
              h.OnClick(Message.ClickedArmDelete({ episodeId: episode.id })),
              h.Class(
                buttonClass(
                  { size: "icon-sm" },
                  "relative opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
                ),
              ),
            ],
            [Icon.trash()],
          ),
    ],
  )
}

const SOURCE_ICON = { Url: Icon.link, Text: Icon.alignLeft, File: Icon.fileText } as const

const artwork = (model: Model, episode: Episode, isCurrent: boolean, isPlaying: boolean, h: HtmlBuilder<Message>): Html => {
  const isHoverPlay = episode.chapters.length > 0 && !isPlaying
  const sourceIcon = SOURCE_ICON[episode.source._tag]
  const background = episode.coverUrl
    ? [h.img([h.Src(model.connection.origin + episode.coverUrl), h.Alt(""), h.Class("absolute inset-0 size-full object-cover")])]
    : isPlaying
      ? []
      : [
          sourceIcon(
            cx("absolute size-4 transition-opacity duration-150", isHoverPlay && "group-hover:opacity-0", isCurrent && "opacity-0"),
          ),
        ]
  const foreground = isPlaying
    ? [Icon.audioLines("relative size-4.5 text-foreground")]
    : isHoverPlay
      ? [
          Icon.play(
            cx(
              "relative size-4 fill-current text-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100",
              isCurrent && "opacity-100",
            ),
          ),
        ]
      : []
  return h.span(
    [h.Class("relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-accent text-muted-foreground")],
    [...background, ...foreground],
  )
}

const STAGE: Record<Extract<JobState, { _tag: "Running" }>["stage"], string> = {
  extracting: "Reading",
  synthesizing: "Narrating",
  encoding: "Encoding",
  uploading: "Uploading",
}

const jobStatus = (episode: Episode, h: HtmlBuilder<Message>): Html => {
  const { job } = episode
  switch (job._tag) {
    case "Ready":
      return h.span(
        [h.Class("shrink-0 text-[13px] text-muted-foreground tabular-nums")],
        [formatDuration(episode.durationMs ?? totalMs(episode.chapters))],
      )
    case "Queued":
      return h.span([h.Class("shrink-0 animate-pulse text-[13px] text-muted-foreground")], ["Queued"])
    case "Running": {
      const fraction = job.total > 0 ? Math.min(1, job.done / job.total) : 0
      const count = job.stage === "synthesizing" && job.total > 0 ? ` ${job.done}/${job.total}` : ""
      return h.span(
        [h.Class("flex w-28 shrink-0 flex-col items-end gap-1.5 text-[13px] text-muted-foreground tabular-nums")],
        [
          h.span([], [STAGE[job.stage] + count]),
          h.span(
            [h.Class("h-0.5 w-full overflow-hidden rounded-full bg-faint"), h.AriaHidden(true)],
            [
              h.span(
                [
                  h.Class("block h-full origin-left rounded-full bg-foreground transition-transform duration-700 ease-out"),
                  h.Style({ transform: `scaleX(${fraction})` }),
                ],
                [],
              ),
            ],
          ),
        ],
      )
    }
    case "Failed":
      return h.empty
  }
}
