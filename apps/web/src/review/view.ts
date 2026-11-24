import type { EpisodeId } from "@fama/contracts"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "~/message"
import { type Model, episodes } from "~/model"
import { ReviewMessage } from "~/review/message"
import {
  type EditingReview,
  type ReviewChapter,
  chapterPanelId,
  isDirty,
  keptCount,
  startButtonLabel,
} from "~/review/model"
import { buttonClass, cx } from "~/view/button"
import * as Icon from "~/view/icon"

const toParent = (message: ReviewMessage) => Message.GotReviewMessage({ message })

export const isReviewShown = (model: Model): boolean => model.review.view._tag !== "Closed"

export const openReviewMessage = (episodeId: EpisodeId): Message =>
  toParent(ReviewMessage.ClickedEpisode({ episodeId }))

/** The Review switch in the add bar. Off by default. */
export const reviewSwitch = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Role("switch"),
      h.AriaChecked(model.isReviewOn),
      h.OnClick(Message.ToggledAddReview()),
      h.Class(
        buttonClass(
          { size: "sm" },
          "gap-2 aria-checked:border-input aria-checked:bg-accent aria-checked:text-foreground",
        ),
      ),
    ],
    [
      h.span(
        [
          h.AriaHidden(true),
          h.Class(
            cx(
              "inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150",
              model.isReviewOn ? "bg-foreground" : "bg-faint",
            ),
          ),
        ],
        [
          h.span(
            [
              h.Class(
                cx(
                  "block size-3 rounded-full transition-transform duration-150",
                  model.isReviewOn ? "translate-x-3 bg-background" : "translate-x-0 bg-muted-foreground",
                ),
              ),
            ],
            [],
          ),
        ],
      ),
      "Review",
    ],
  )

/** Status badge on a Library row whose job waits in Review. */
export const reviewBadge = (h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-input bg-accent px-2.5 py-0.5 text-[13px] font-medium text-foreground",
      ),
    ],
    ["Review", Icon.chevronRight("size-3.5 text-muted-foreground")],
  )

const backButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.OnClick(toParent(ReviewMessage.ClickedBack())),
      h.Class(buttonClass({ size: "sm" }, "-ml-2")),
    ],
    [Icon.arrowLeft(), "Back"],
  )

const chapterRow = (
  chapter: ReviewChapter,
  isExpanded: boolean,
  isBusy: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const panelId = chapterPanelId(chapter.index)
  return h.keyed("li")(
    String(chapter.index),
    [h.Class("flex flex-col")],
    [
      h.div(
        [h.Class("flex min-h-12 items-center gap-3 px-3 py-2")],
        [
          h.button(
            [
              h.Type("button"),
              h.Role("checkbox"),
              h.AriaChecked(chapter.isKept),
              h.AriaLabel(`Keep ${chapter.title}`),
              h.Disabled(isBusy),
              h.OnClick(toParent(ReviewMessage.ToggledChapter({ index: chapter.index }))),
              h.Class(
                cx(
                  "relative grid size-5 shrink-0 cursor-pointer place-items-center rounded-md border transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
                  chapter.isKept
                    ? "border-transparent bg-foreground text-background"
                    : "border-input bg-transparent text-transparent hover:border-foreground/40",
                ),
              ),
            ],
            [Icon.check("size-3.5 stroke-[2.5]")],
          ),
          h.button(
            [
              h.Type("button"),
              h.AriaLabel(`${chapter.index + 1} ${chapter.title}`),
              h.AriaExpanded(isExpanded),
              h.AriaControls(panelId),
              h.OnClick(toParent(ReviewMessage.ClickedChapter({ index: chapter.index }))),
              h.Class(
                "flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ),
            ],
            [
              h.span(
                [h.Class("flex min-w-0 flex-1 items-baseline gap-2.5")],
                [
                  h.span(
                    [h.Class("w-6 shrink-0 text-right text-[13px] text-muted-foreground tabular-nums")],
                    [String(chapter.index + 1)],
                  ),
                  h.span(
                    [
                      h.Class(
                        cx(
                          "min-w-0 flex-1 truncate text-[15px] leading-snug",
                          chapter.isKept ? "text-foreground" : "text-muted-foreground line-through",
                        ),
                      ),
                    ],
                    [chapter.title],
                  ),
                ],
              ),
              Icon.chevronDown(
                cx(
                  "size-4 shrink-0 text-muted-foreground transition-transform duration-150",
                  isExpanded && "rotate-180",
                ),
              ),
            ],
          ),
        ],
      ),
      ...(isExpanded
        ? [
            h.div(
              [h.Id(panelId), h.Class("flex flex-col gap-2.5 border-t border-border bg-background/40 px-3 py-3")],
              [
                h.input([
                  h.Type("text"),
                  h.AriaLabel("Chapter title"),
                  h.Value(chapter.title),
                  h.Disabled(isBusy),
                  h.OnInput((value) => toParent(ReviewMessage.UpdatedChapterTitle({ index: chapter.index, value }))),
                  h.Class(
                    "h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm font-medium outline-none focus:border-ring disabled:opacity-40",
                  ),
                ]),
                h.textarea([
                  h.AriaLabel(`Text of ${chapter.title}`),
                  h.Value(chapter.text),
                  h.Rows(10),
                  h.Disabled(isBusy),
                  h.OnInput((value) => toParent(ReviewMessage.UpdatedChapterText({ index: chapter.index, value }))),
                  h.Class(
                    "min-h-48 max-h-[55vh] w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2.5 text-[15px] leading-relaxed outline-none focus:border-ring disabled:opacity-40",
                  ),
                ]),
              ],
            ),
          ]
        : []),
    ],
  )
}

const editingView = (editing: EditingReview, h: HtmlBuilder<Message>): Html => {
  const kept = keptCount(editing)
  const total = editing.chapters.length
  const dirty = isDirty(editing)
  const isSaving = editing.save._tag === "Saving"
  const isStarting = editing.start._tag === "Starting"
  const isBusy = isSaving || isStarting
  const errorMessage =
    editing.start._tag === "Failed"
      ? editing.start.message
      : editing.save._tag === "Failed"
        ? editing.save.message
        : null
  const saveLabel = isSaving ? "Saving…" : editing.save._tag === "Saved" ? "Saved" : "Save"

  return h.section(
    [h.Class("mt-2 flex flex-col gap-4")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-2")],
        [
          backButton(h),
          h.div(
            [h.Class("flex items-center gap-2")],
            [
              h.button(
                [
                  h.Type("button"),
                  h.Disabled(!dirty || isBusy),
                  h.OnClick(toParent(ReviewMessage.ClickedSave())),
                  h.Class(buttonClass({ variant: "outline", size: "sm" })),
                ],
                [saveLabel],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Disabled(kept === 0 || isBusy),
                  h.OnClick(toParent(ReviewMessage.ClickedStart())),
                  h.Class(buttonClass({ variant: "primary", size: "sm" }, "tabular-nums")),
                ],
                [
                  ...(isStarting ? [Icon.loaderCircle("animate-spin")] : []),
                  startButtonLabel(kept, total, isStarting),
                ],
              ),
            ],
          ),
        ],
      ),
      ...(errorMessage ? [h.p([h.Role("alert"), h.Class("text-[13px] text-destructive")], [errorMessage])] : []),
      h.input([
        h.Type("text"),
        h.AriaLabel("Title"),
        h.Value(editing.title),
        h.Disabled(isBusy),
        h.OnInput((value) => toParent(ReviewMessage.UpdatedTitle({ value }))),
        h.Class(
          "-mx-2 w-[calc(100%+1rem)] rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold leading-tight tracking-tight text-foreground outline-none hover:border-input focus:border-ring disabled:opacity-40",
        ),
      ]),
      ...(editing.repeatedLines.length > 0
        ? [
            h.div(
              [h.Class("flex flex-wrap items-center gap-2")],
              editing.repeatedLines.map((line) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Disabled(isBusy),
                    h.AriaLabel(`Remove "${line}"`),
                    h.Title(`Remove "${line}"`),
                    h.OnClick(toParent(ReviewMessage.ClickedRemoveRepeatedLine({ line }))),
                    h.Class(buttonClass({ variant: "outline", size: "sm" }, "max-w-full")),
                  ],
                  [Icon.x("size-3.5"), h.span([h.Class("truncate")], [`Remove "${line}"`])],
                ),
              ),
            ),
          ]
        : []),
      h.ul(
        [h.Class("flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface")],
        editing.chapters.map((chapter) =>
          chapterRow(chapter, Option.contains(editing.maybeExpandedIndex, chapter.index), isBusy, h),
        ),
      ),
    ],
  )
}

/** The Review screen for an episode waiting in `Review`. */
export const review = (model: Model, h: HtmlBuilder<Message>): Html => {
  const view = model.review.view
  switch (view._tag) {
    case "Closed":
      return h.empty
    case "Loading": {
      const episode = episodes(model).find((item) => item.id === view.episodeId)
      return h.section(
        [h.Class("mt-2 flex flex-col gap-4")],
        [
          h.div([h.Class("flex items-center")], [backButton(h)]),
          ...(episode ? [h.h1([h.Class("text-2xl font-semibold leading-tight")], [episode.title])] : []),
          h.div(
            [h.Role("status"), h.AriaLabel("Loading"), h.Class("flex items-center justify-center py-12")],
            [Icon.loaderCircle("size-5 animate-spin text-muted-foreground")],
          ),
        ],
      )
    }
    case "LoadFailed":
      return h.section(
        [h.Class("mt-2 flex flex-col gap-4")],
        [
          h.div([h.Class("flex items-center")], [backButton(h)]),
          h.div(
            [h.Class("flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 text-sm")],
            [
              h.span([h.Role("alert"), h.Class("text-destructive")], [view.message]),
              h.button(
                [
                  h.Type("button"),
                  h.OnClick(toParent(ReviewMessage.ClickedTryAgain())),
                  h.Class(buttonClass({ variant: "outline", size: "sm" })),
                ],
                ["Try again"],
              ),
            ],
          ),
        ],
      )
    case "Editing":
      return editingView(view, h)
  }
}
