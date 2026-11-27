import { Document, EpisodeId, Voice, VoiceRef } from "@fama/contracts"
import { Command, Component, UiSchema } from "@effect/ui"
import { Button, Checkbox, Collapsible } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Cause, Effect, Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { DocumentQuery } from "~/queries"
import {
  type ReviewChapter,
  ReviewChapter as ReviewChapterSchema,
  detectRepeatedLines,
  removeRepeatedLine,
  startButtonLabel,
} from "~/review/model"
import { VoiceSamples } from "~/review/VoiceSamples"
import { buttonClass, cx } from "~/view/button"
import * as Icon from "~/view/icon"

// --- Editor sub-component (mounts once DocumentQuery succeeds) ---

export const ReviewEditorProps = Schema.Struct({
  episodeId: EpisodeId,
  origin: Schema.String,
  connectionGeneration: Schema.Number,
  initialDocument: Document,
  speed: Schema.Number,
  initialVoice: Schema.NullOr(VoiceRef),
  maybePendingVoice: Schema.Option(VoiceRef),
  voices: Schema.Array(Voice),
  isMainPlaying: Schema.Boolean,
  isSaving: Schema.Boolean,
  isStarting: Schema.Boolean,
  isSavingVoice: Schema.Boolean,
  maybePendingDocument: Schema.Option(Document),
  maybeSavedDocument: Schema.Option(Document),
  maybeActionError: Schema.Option(Schema.String),
  maybeVoiceError: Schema.Option(Schema.String),
})
export type ReviewEditorProps = typeof ReviewEditorProps.Type

export const ReviewEditorModel = Schema.Struct({
  loaded: Document,
  title: Schema.String,
  chapters: Schema.Array(ReviewChapterSchema),
  maybeExpandedIndex: Schema.Option(Schema.Number),
  repeatedLines: Schema.Array(Schema.String),
  maybeSelectedVoice: Schema.Option(VoiceRef),
})
export type ReviewEditorModel = typeof ReviewEditorModel.Type

export const ReviewEditorMessage = UiSchema.TaggedEnum({
  ClickedBack: {},
  UpdatedTitle: { value: Schema.String },
  ToggledChapter: { index: Schema.Number, kept: Schema.Boolean },
  ToggledChapterPanel: { index: Schema.Number, open: Schema.Boolean },
  UpdatedChapterTitle: { index: Schema.Number, value: Schema.String },
  UpdatedChapterText: { index: Schema.Number, value: Schema.String },
  ClickedRemoveRepeatedLine: { line: Schema.String },
  SelectedSampleVoice: { voice: VoiceRef },
  RequestedChangeSampleVoice: { episodeId: EpisodeId, voice: VoiceRef, speed: Schema.Number },
  RequestedPauseMain: {},
  ClickedSave: {},
  ClickedStart: {},
})
export type ReviewEditorMessage = typeof ReviewEditorMessage.Type

export const ReviewEditorEvents = UiSchema.TaggedEnum({
  Closed: {},
  SubmittedSave: { episodeId: EpisodeId, document: Document },
  SubmittedStart: {
    episodeId: EpisodeId,
    document: Document,
    voice: Schema.optionalKey(VoiceRef),
  },
  ClearedActionError: {},
  RequestedChangeVoice: { episodeId: EpisodeId, voice: VoiceRef, speed: Schema.Number },
  RequestedPauseMainPlayback: {},
})
export type ReviewEditorEvents = typeof ReviewEditorEvents.Type

const effectiveLoaded = (props: ReviewEditorProps, model: ReviewEditorModel): Document =>
  Option.getOrElse(props.maybeSavedDocument, () => model.loaded)

const isEditorDirty = (loaded: Document, model: ReviewEditorModel): boolean =>
  model.title !== loaded.title ||
  model.chapters.length !== loaded.chapters.length ||
  model.chapters.some((chapter, index) => {
    const original = loaded.chapters[index]
    return !original || chapter.title !== original.title || chapter.text !== original.text
  })

const editorKeptCount = (chapters: ReadonlyArray<ReviewChapter>): number =>
  chapters.reduce((count, chapter) => (chapter.isKept ? count + 1 : count), 0)

const toDocument = (model: ReviewEditorModel, onlyKept: boolean): Option.Option<Document> => {
  const source = onlyKept ? model.chapters.filter((chapter) => chapter.isKept) : model.chapters
  const [first, ...rest] = source.map(({ title, text }) => ({ title, text }))
  if (!first) return Option.none()
  return Option.some({
    title: model.title,
    author: model.loaded.author,
    language: model.loaded.language,
    chapters: [first, ...rest],
  })
}

export const ReviewEditor = Html.component({
  name: "ReviewEditor",
  props: ReviewEditorProps,
  model: ReviewEditorModel,
  message: ReviewEditorMessage,
  events: ReviewEditorEvents,
}).make({
  init: ($) => {
    const loaded = Option.getOrElse($.props.maybeSavedDocument, () => $.props.initialDocument)
    const draft = Option.getOrElse($.props.maybePendingDocument, () => loaded)
    const chapters = draft.chapters.map((chapter, index) => ({
      index,
      title: chapter.title,
      text: chapter.text,
      isKept: true,
    }))
    return {
      loaded,
      title: draft.title,
      chapters,
      maybeExpandedIndex: chapters.length === 1 ? Option.some(0) : Option.none(),
      repeatedLines: detectRepeatedLines(chapters),
      maybeSelectedVoice: $.props.maybePendingVoice,
    }
  },
  update: {
    ClickedBack: ($) => $.emit(ReviewEditorEvents.Closed()),
    UpdatedTitle: ($, { value }) => {
      const next = $.evolve({ title: value })
      return Option.isSome($.props.maybeActionError) ? next.emit(ReviewEditorEvents.ClearedActionError()) : next
    },
    ToggledChapter: ($, { index, kept }) => {
      const chapters = $.model.chapters.map((chapter) =>
        chapter.index === index ? { ...chapter, isKept: kept } : chapter,
      )
      const next = $.evolve({
        chapters,
        repeatedLines: detectRepeatedLines(chapters),
      })
      return Option.isSome($.props.maybeActionError) ? next.emit(ReviewEditorEvents.ClearedActionError()) : next
    },
    ToggledChapterPanel: ($, { index, open }) =>
      $.evolve({
        maybeExpandedIndex: open ? Option.some(index) : Option.none(),
        repeatedLines: detectRepeatedLines($.model.chapters),
      }),
    UpdatedChapterTitle: ($, { index, value }) => {
      const next = $.evolve({
        chapters: $.model.chapters.map((chapter) =>
          chapter.index === index ? { ...chapter, title: value } : chapter,
        ),
      })
      return Option.isSome($.props.maybeActionError) ? next.emit(ReviewEditorEvents.ClearedActionError()) : next
    },
    UpdatedChapterText: ($, { index, value }) => {
      const next = $.evolve({
        chapters: $.model.chapters.map((chapter) =>
          chapter.index === index ? { ...chapter, text: value } : chapter,
        ),
      })
      return Option.isSome($.props.maybeActionError) ? next.emit(ReviewEditorEvents.ClearedActionError()) : next
    },
    ClickedRemoveRepeatedLine: ($, { line }) => {
      const chapters = removeRepeatedLine($.model.chapters, line)
      const next = $.evolve({
        chapters,
        repeatedLines: detectRepeatedLines(chapters),
      })
      return Option.isSome($.props.maybeActionError) ? next.emit(ReviewEditorEvents.ClearedActionError()) : next
    },
    SelectedSampleVoice: ($, { voice }) =>
      $.evolve({ maybeSelectedVoice: Option.some(voice) }),
    RequestedChangeSampleVoice: ($, { episodeId, voice, speed }) =>
      $.emit(ReviewEditorEvents.RequestedChangeVoice({ episodeId, voice, speed })),
    RequestedPauseMain: ($) => $.emit(ReviewEditorEvents.RequestedPauseMainPlayback()),
    ClickedSave: ($) => {
      const loaded = effectiveLoaded($.props, $.model)
      if (!isEditorDirty(loaded, $.model) || $.props.isSaving || $.props.isStarting) return $.model
      return Option.match(toDocument($.model, false), {
        onNone: () => $.model,
        onSome: (document) =>
          $.emit(ReviewEditorEvents.SubmittedSave({ episodeId: $.props.episodeId, document })),
      })
    },
    ClickedStart: ($) => {
      if ($.props.isSaving || $.props.isStarting) return $.model
      return Option.match(toDocument($.model, true), {
        onNone: () => $.model,
        onSome: (document) => {
          const voice = Option.getOrUndefined($.model.maybeSelectedVoice)
          return $.emit(
            ReviewEditorEvents.SubmittedStart({
              episodeId: $.props.episodeId,
              document,
              ...(voice !== undefined ? { voice } : {}),
            }),
          )
        },
      })
    },
  },
  view: (h, model) => {
    const kept = editorKeptCount(model.chapters)
    const total = model.chapters.length
    const loaded = effectiveLoaded(h.props, model)
    const dirty = isEditorDirty(loaded, model)
    const isSaving = h.props.isSaving
    const isStarting = h.props.isStarting
    const isBusy = isSaving || isStarting
    const isSaved = !dirty && Option.isSome(h.props.maybeSavedDocument)
    const saveLabel = isSaving ? "Saving…" : isSaved ? "Saved" : "Save"
    const maybeError = h.props.maybeActionError

    return h.section.class("mt-2 flex flex-col gap-4").children(
      h.div.class("flex flex-wrap items-center justify-between gap-2").children(
        Button(h, { onPress: ReviewEditorMessage.ClickedBack() })
          .class(buttonClass({ size: "sm" }, "-ml-2"))
          .children(Icon.arrowLeft(h), "Back"),
        h.div.class("flex items-center gap-2").children(
          Button(h, {
            props: { disabled: !dirty || isBusy },
            onPress: ReviewEditorMessage.ClickedSave(),
          })
            .class(buttonClass({ variant: "outline", size: "sm" }))
            .children(saveLabel),
          Button(h, {
            props: { disabled: kept === 0 || isBusy },
            onPress: ReviewEditorMessage.ClickedStart(),
          })
            .class(buttonClass({ variant: "primary", size: "sm" }, "tabular-nums"))
            .children(
              isStarting && Icon.loaderCircle(h, "animate-spin"),
              startButtonLabel(kept, total, isStarting),
            ),
        ),
      ),
      Option.match(maybeError, {
        onNone: () => null,
        onSome: (message) =>
          h.p.attr("role", "alert").class("text-[13px] text-destructive").children(message),
      }),
      h.input
        .attrs({ type: "text", "aria-label": "Title" })
        .value(model.title)
        .disabled(isBusy)
        .on("input", ({ value }) => ReviewEditorMessage.UpdatedTitle({ value }))
        .class(
          "-mx-2 w-[calc(100%+1rem)] rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold leading-tight tracking-tight text-foreground outline-none hover:border-input focus:border-ring disabled:opacity-40",
        ),
      VoiceSamples(h, {
        props: {
          episodeId: h.props.episodeId,
          origin: h.props.origin,
          connectionGeneration: h.props.connectionGeneration,
          language: model.loaded.language,
          speed: h.props.speed,
          voices: h.props.voices,
          initialVoice: h.props.initialVoice,
          isBusy,
          isSavingVoice: h.props.isSavingVoice,
          maybeVoiceError: h.props.maybeVoiceError,
          isMainPlaying: h.props.isMainPlaying,
        },
        onEmit: {
          SelectedVoice: ({ voice }) => ReviewEditorMessage.SelectedSampleVoice({ voice }),
          RequestedChangeVoice: ({ episodeId, voice, speed }) =>
            ReviewEditorMessage.RequestedChangeSampleVoice({ episodeId, voice, speed }),
          RequestedPauseMainPlayback: () => ReviewEditorMessage.RequestedPauseMain(),
        },
      }),
      model.repeatedLines.length > 0 &&
        h.div.class("flex flex-wrap items-center gap-2").children(
          ...model.repeatedLines.map((line) =>
            Button(h, {
              props: { disabled: isBusy },
              onPress: ReviewEditorMessage.ClickedRemoveRepeatedLine({ line }),
            })
              .key(line)
              .attrs({ "aria-label": `Remove "${line}"`, title: `Remove "${line}"` })
              .class(buttonClass({ variant: "outline", size: "sm" }, "max-w-full"))
              .children(Icon.x(h, "size-3.5"), h.span.class("truncate").children(`Remove "${line}"`)),
          ),
        ),
      h.ul
        .class("flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface")
        .children(
          ...model.chapters.map((chapter) => {
            const isExpanded = Option.contains(model.maybeExpandedIndex, chapter.index)
            return h.li.key(String(chapter.index)).class("flex flex-col").children(
              Collapsible(h, {
                key: `chapter-${chapter.index}`,
                props: { open: isExpanded },
                onEmit: {
                  Toggled: ({ open }) =>
                    ReviewEditorMessage.ToggledChapterPanel({ index: chapter.index, open }),
                  Settled: () => undefined,
                },
                view: (collapsible) =>
                  h.div.class("flex flex-col").children(
                    h.div.class("flex min-h-12 items-center gap-3 px-3 py-2").children(
                      Checkbox(h, {
                        key: `keep-${chapter.index}`,
                        props: { checked: chapter.isKept, disabled: isBusy },
                        onEmit: {
                          Toggled: ({ checked }) =>
                            ReviewEditorMessage.ToggledChapter({ index: chapter.index, kept: checked }),
                        },
                        view: (checkbox) =>
                          checkbox
                            .root(
                              h.button
                                .attr("aria-label", `Keep ${chapter.title}`)
                                .class(
                                  cx(
                                    "relative grid size-5 shrink-0 cursor-pointer place-items-center rounded-md border transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
                                    chapter.isKept
                                      ? "border-transparent bg-foreground text-background"
                                      : "border-input bg-transparent text-transparent hover:border-foreground/40",
                                  ),
                                ),
                            )
                            .children(
                              checkbox.indicator(h.span).children(Icon.check(h, "size-3.5 stroke-[2.5]")),
                            ),
                      }),
                      collapsible
                        .trigger(
                          h.button
                            .attr("aria-label", `${chapter.index + 1} ${chapter.title}`)
                            .class(
                              "flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            ),
                        )
                        .children(
                          h.span.class("flex min-w-0 flex-1 items-baseline gap-2.5").children(
                            h.span
                              .class("w-6 shrink-0 text-right text-[13px] text-muted-foreground tabular-nums")
                              .children(String(chapter.index + 1)),
                            h.span
                              .class(
                                cx(
                                  "min-w-0 flex-1 truncate text-[15px] leading-snug",
                                  chapter.isKept ? "text-foreground" : "text-muted-foreground line-through",
                                ),
                              )
                              .children(chapter.title),
                          ),
                          Icon.chevronDown(
                            h,
                            cx(
                              "size-4 shrink-0 text-muted-foreground transition-transform duration-150",
                              isExpanded && "rotate-180",
                            ),
                          ),
                        ),
                    ),
                    collapsible.panel(
                      h.div.class("flex flex-col gap-2.5 border-t border-border bg-background/40 px-3 py-3"),
                    )?.children(
                      h.input
                        .attrs({ type: "text", "aria-label": "Chapter title" })
                        .value(chapter.title)
                        .disabled(isBusy)
                        .on("input", ({ value }) =>
                          ReviewEditorMessage.UpdatedChapterTitle({ index: chapter.index, value }),
                        )
                        .class(
                          "h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm font-medium outline-none focus:border-ring disabled:opacity-40",
                        ),
                      h.textarea
                        .attrs({ "aria-label": `Text of ${chapter.title}`, rows: "10" })
                        .value(chapter.text)
                        .disabled(isBusy)
                        .on("input", ({ value }) =>
                          ReviewEditorMessage.UpdatedChapterText({ index: chapter.index, value }),
                        )
                        .class(
                          "min-h-48 max-h-[55vh] w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2.5 text-[15px] leading-relaxed outline-none focus:border-ring disabled:opacity-40",
                        ),
                    ),
                  ),
              }),
            )
          }),
        ),
    )
  },
})

// --- Outer ReviewScreen (owns DocumentQuery loading / failure / retry) ---

export const ReviewScreenProps = Schema.Struct({
  episodeId: EpisodeId,
  openId: Schema.Number,
  episodeTitle: Schema.String,
  origin: Schema.String,
  connectionGeneration: Schema.Number,
  speed: Schema.Number,
  initialVoice: Schema.NullOr(VoiceRef),
  maybePendingVoice: Schema.Option(VoiceRef),
  voices: Schema.Array(Voice),
  isMainPlaying: Schema.Boolean,
  isSaving: Schema.Boolean,
  isStarting: Schema.Boolean,
  isSavingVoice: Schema.Boolean,
  maybePendingDocument: Schema.Option(Document),
  maybeSavedDocument: Schema.Option(Document),
  maybeActionError: Schema.Option(Schema.String),
  maybeVoiceError: Schema.Option(Schema.String),
})
export type ReviewScreenProps = typeof ReviewScreenProps.Type

export const ReviewScreenMessage = UiSchema.TaggedEnum({
  ClickedBack: {},
  ClickedTryAgain: {},
  SubmittedSaveEditor: { episodeId: EpisodeId, document: Document },
  SubmittedStartEditor: {
    episodeId: EpisodeId,
    document: Document,
    voice: Schema.optionalKey(VoiceRef),
  },
  ClearedActionError: {},
  RequestedChangeVoice: { episodeId: EpisodeId, voice: VoiceRef, speed: Schema.Number },
  RequestedPauseMain: {},
})
export type ReviewScreenMessage = typeof ReviewScreenMessage.Type

export const ReviewScreenEvents = UiSchema.TaggedEnum({
  Closed: {},
  SubmittedSave: { episodeId: EpisodeId, document: Document },
  SubmittedStart: {
    episodeId: EpisodeId,
    document: Document,
    voice: Schema.optionalKey(VoiceRef),
  },
  ClearedActionError: {},
  RequestedChangeVoice: { episodeId: EpisodeId, voice: VoiceRef, speed: Schema.Number },
  RequestedPauseMainPlayback: {},
})
export type ReviewScreenEvents = typeof ReviewScreenEvents.Type

const RetryReviewDocument = Command.make(
  "review/RetryDocument",
  { args: { episodeId: EpisodeId, origin: Schema.String, openId: Schema.Number } },
  (args) => DocumentQuery.invalidate(args).pipe(Effect.as(Component.noop)),
)

export const ReviewScreen = Html.component({
  name: "ReviewScreen",
  props: ReviewScreenProps,
  model: Schema.Null,
  message: ReviewScreenMessage,
  events: ReviewScreenEvents,
  queries: {
    document: {
      query: DocumentQuery,
      args: ({ props }) => ({
        episodeId: props.episodeId,
        origin: props.origin,
        openId: props.openId,
      }),
    },
  },
}).make({
  init: () => null,
  update: {
    ClickedBack: ($) => $.emit(ReviewScreenEvents.Closed()),
    ClickedTryAgain: ($) =>
      $.run(
        RetryReviewDocument.make({
          episodeId: $.props.episodeId,
          origin: $.props.origin,
          openId: $.props.openId,
        }),
      ),
    SubmittedSaveEditor: ($, { episodeId, document }) =>
      $.emit(ReviewScreenEvents.SubmittedSave({ episodeId, document })),
    SubmittedStartEditor: ($, { episodeId, document, voice }) =>
      $.emit(
        ReviewScreenEvents.SubmittedStart({
          episodeId,
          document,
          ...(voice !== undefined ? { voice } : {}),
        }),
      ),
    ClearedActionError: ($) => $.emit(ReviewScreenEvents.ClearedActionError()),
    RequestedChangeVoice: ($, { episodeId, voice, speed }) =>
      $.emit(ReviewScreenEvents.RequestedChangeVoice({ episodeId, voice, speed })),
    RequestedPauseMain: ($) => $.emit(ReviewScreenEvents.RequestedPauseMainPlayback()),
  },
  view: (h) => {
    const renderEditor = (doc: Document) =>
      ReviewEditor(h, {
        key: h.props.episodeId,
        props: {
          episodeId: h.props.episodeId,
          origin: h.props.origin,
          connectionGeneration: h.props.connectionGeneration,
          initialDocument: doc,
          speed: h.props.speed,
          initialVoice: h.props.initialVoice,
          maybePendingVoice: h.props.maybePendingVoice,
          voices: h.props.voices,
          isMainPlaying: h.props.isMainPlaying,
          isSaving: h.props.isSaving,
          isStarting: h.props.isStarting,
          isSavingVoice: h.props.isSavingVoice,
          maybePendingDocument: h.props.maybePendingDocument,
          maybeSavedDocument: h.props.maybeSavedDocument,
          maybeActionError: h.props.maybeActionError,
          maybeVoiceError: h.props.maybeVoiceError,
        },
        onEmit: {
          Closed: () => ReviewScreenMessage.ClickedBack(),
          SubmittedSave: ({ episodeId, document }) =>
            ReviewScreenMessage.SubmittedSaveEditor({ episodeId, document }),
          SubmittedStart: ({ episodeId, document, voice }) =>
            ReviewScreenMessage.SubmittedStartEditor({
              episodeId,
              document,
              ...(voice !== undefined ? { voice } : {}),
            }),
          ClearedActionError: () => ReviewScreenMessage.ClearedActionError(),
          RequestedChangeVoice: ({ episodeId, voice, speed }) =>
            ReviewScreenMessage.RequestedChangeVoice({ episodeId, voice, speed }),
          RequestedPauseMainPlayback: () => ReviewScreenMessage.RequestedPauseMain(),
        },
      })

    return AsyncResult.match(h.queries.document, {
      onInitial: () =>
        h.section.class("mt-2 flex flex-col gap-4").children(
          h.div.class("flex items-center").children(
            Button(h, { onPress: ReviewScreenMessage.ClickedBack() })
              .class(buttonClass({ size: "sm" }, "-ml-2"))
              .children(Icon.arrowLeft(h), "Back"),
          ),
          h.h1.class("text-2xl font-semibold leading-tight").children(h.props.episodeTitle),
          h.div
            .attrs({ role: "status", "aria-label": "Loading" })
            .class("flex items-center justify-center py-12")
            .children(Icon.loaderCircle(h, "size-5 animate-spin text-muted-foreground")),
        ),
      onFailure: ({ cause, previousSuccess }) => {
        if (Option.isSome(previousSuccess)) {
          return renderEditor(previousSuccess.value.value)
        }
        const message =
          Option.getOrUndefined(Cause.findErrorOption(cause))?.message ?? "Could not load document"
        return h.section.class("mt-2 flex flex-col gap-4").children(
          h.div.class("flex items-center").children(
            Button(h, { onPress: ReviewScreenMessage.ClickedBack() })
              .class(buttonClass({ size: "sm" }, "-ml-2"))
              .children(Icon.arrowLeft(h), "Back"),
          ),
          h.div
            .class("flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 text-sm")
            .children(
              h.span.attr("role", "alert").class("text-destructive").children(message),
              Button(h, { onPress: ReviewScreenMessage.ClickedTryAgain() })
                .class(buttonClass({ variant: "outline", size: "sm" }))
                .children("Try again"),
            ),
        )
      },
      onSuccess: ({ value: doc }) => renderEditor(doc),
    })
  },
}).pipe(Component.provide(DocumentQuery.layer))
