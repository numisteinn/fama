import { ChangeVoice, Document, EpisodeId, Voice, VoiceRef } from "@fama/contracts"
import { Command, Component, UiSchema } from "@effect/ui"
import { Button, Collapsible } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Cause, Effect, Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { formatRate } from "~/lib/format"
import { NarrateAgainSubmitTarget } from "~/narrate-again/model"
import { NarrateAgainDocumentQuery } from "~/core/queries"
import { SPEEDS, languageName, sortedVoices } from "~/core/voices"
import { buttonClass } from "~/ui/button"
import * as Icon from "~/ui/icon"

// --- Editor sub-component ---

export const NarrateAgainError = Schema.Struct({
  target: NarrateAgainSubmitTarget,
  message: Schema.String,
})
export type NarrateAgainError = typeof NarrateAgainError.Type

export const NarrateAgainEditorProps = Schema.Struct({
  episodeId: EpisodeId,
  episodeTitle: Schema.String,
  document: Schema.Option(Document),
  initialVoice: Schema.NullOr(VoiceRef),
  initialSpeed: Schema.Number,
  voices: Schema.Array(Voice),
  submittingTarget: Schema.Option(NarrateAgainSubmitTarget),
  maybeSubmitError: Schema.Option(NarrateAgainError),
})
export type NarrateAgainEditorProps = typeof NarrateAgainEditorProps.Type

export const NarrateAgainEditorModel = Schema.Struct({
  loaded: Schema.Option(Document),
  texts: Schema.Array(Schema.String),
  maybeExpandedIndex: Schema.Option(Schema.Number),
  initialVoice: Schema.NullOr(VoiceRef),
  initialSpeed: Schema.Number,
  voice: Schema.NullOr(VoiceRef),
  speed: Schema.Number,
})
export type NarrateAgainEditorModel = typeof NarrateAgainEditorModel.Type

export const NarrateAgainEditorMessage = UiSchema.TaggedEnum({
  ClickedBack: {},
  ToggledChapterPanel: { index: Schema.Number, open: Schema.Boolean },
  UpdatedChapterText: { index: Schema.Number, value: Schema.String },
  ChangedVoice: { value: Schema.String },
  ChangedSpeed: { value: Schema.String },
  ClickedNarrateText: {},
  ClickedChangeVoice: {},
})
export type NarrateAgainEditorMessage = typeof NarrateAgainEditorMessage.Type

export const NarrateAgainEditorEvents = UiSchema.TaggedEnum({
  Closed: {},
  SubmittedNarrateText: { episodeId: EpisodeId, document: Document },
  SubmittedChangeVoice: { episodeId: EpisodeId, input: ChangeVoice },
  ClearedSubmitError: { target: NarrateAgainSubmitTarget },
})
export type NarrateAgainEditorEvents = typeof NarrateAgainEditorEvents.Type

const isTextDirty = (doc: Option.Option<Document>, texts: ReadonlyArray<string>): boolean =>
  Option.exists(doc, (document) =>
    document.chapters.some((chapter, index) => chapter.text !== texts[index]),
  )

const isVoiceDirty = (model: NarrateAgainEditorModel): boolean =>
  model.voice !== model.initialVoice || model.speed !== model.initialSpeed

const toEditedDocument = (
  doc: Option.Option<Document>,
  texts: ReadonlyArray<string>,
): Option.Option<Document> =>
  Option.map(doc, (document) => {
    const chapters = document.chapters.map((chapter, index) => ({
      ...chapter,
      text: texts[index] ?? chapter.text,
    }))
    return { ...document, chapters: [chapters[0]!, ...chapters.slice(1)] }
  })

export const NarrateAgainEditor = Html.component({
  name: "NarrateAgainEditor",
  props: NarrateAgainEditorProps,
  model: NarrateAgainEditorModel,
  message: NarrateAgainEditorMessage,
  events: NarrateAgainEditorEvents,
}).make({
  init: ($) => {
    const chapters = Option.match($.props.document, {
      onNone: () => [],
      onSome: (stored) => stored.chapters,
    })
    return {
      loaded: $.props.document,
      texts: chapters.map((chapter) => chapter.text),
      maybeExpandedIndex: chapters.length === 1 ? Option.some(0) : Option.none(),
      initialVoice: $.props.initialVoice,
      initialSpeed: $.props.initialSpeed,
      voice: $.props.initialVoice,
      speed: $.props.initialSpeed,
    }
  },
  update: {
    ClickedBack: ($) => $.emit(NarrateAgainEditorEvents.Closed()),
    ToggledChapterPanel: ($, { index, open }) =>
      $.evolve({ maybeExpandedIndex: open ? Option.some(index) : Option.none() }),
    UpdatedChapterText: ($, { index, value }) => {
      const next = $.evolve({
        texts: $.model.texts.map((text, chapter) => (chapter === index ? value : text)),
      })
      return Option.exists($.props.maybeSubmitError, (error) => error.target === "text")
        ? next.emit(NarrateAgainEditorEvents.ClearedSubmitError({ target: "text" }))
        : next
    },
    ChangedVoice: ($, { value }) => {
      const next = $.evolve({
        voice: value === "" ? null : (value as VoiceRef),
      })
      return Option.exists($.props.maybeSubmitError, (error) => error.target === "voice")
        ? next.emit(NarrateAgainEditorEvents.ClearedSubmitError({ target: "voice" }))
        : next
    },
    ChangedSpeed: ($, { value }) => {
      const speed = Number(value)
      if (!SPEEDS.includes(speed as (typeof SPEEDS)[number])) return $.model
      const next = $.evolve({ speed })
      return Option.exists($.props.maybeSubmitError, (error) => error.target === "voice")
        ? next.emit(NarrateAgainEditorEvents.ClearedSubmitError({ target: "voice" }))
        : next
    },
    ClickedNarrateText: ($) => {
      if (Option.isSome($.props.submittingTarget) || !isTextDirty($.model.loaded, $.model.texts)) {
        return $.model
      }
      return Option.match(toEditedDocument($.model.loaded, $.model.texts), {
        onNone: () => $.model,
        onSome: (document) =>
          $.emit(NarrateAgainEditorEvents.SubmittedNarrateText({ episodeId: $.props.episodeId, document })),
      })
    },
    ClickedChangeVoice: ($) => {
      if (
        Option.isSome($.props.submittingTarget) ||
        !isVoiceDirty($.model) ||
        $.model.voice === null ||
        !Number.isFinite($.model.speed) ||
        $.model.speed <= 0
      ) {
        return $.model
      }
      return $.emit(
        NarrateAgainEditorEvents.SubmittedChangeVoice({
          episodeId: $.props.episodeId,
          input: { voice: $.model.voice, speed: $.model.speed },
        }),
      )
    },
  },
  view: (h, model) => {
    const isSubmittingText = Option.contains(h.props.submittingTarget, "text")
    const isSubmittingVoice = Option.contains(h.props.submittingTarget, "voice")
    const busy = isSubmittingText || isSubmittingVoice
    const textDirty = isTextDirty(model.loaded, model.texts)
    const voiceDirty = isVoiceDirty(model)
    const registered = sortedVoices(h.props.voices)
    const voices =
      model.voice !== null && !registered.some((voice) => voice.id === model.voice)
        ? [{ id: model.voice, name: model.voice, language: "", engine: "", gender: null }, ...registered]
        : registered
    const speeds = SPEEDS.includes(model.speed as (typeof SPEEDS)[number])
      ? SPEEDS
      : [...SPEEDS, model.speed].sort((a, b) => a - b)

    const chapterSection = Option.match(model.loaded, {
      onNone: () =>
        h.p
          .attr("role", "status")
          .class("rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground")
          .children("Chapter text is not stored for this episode. You can still change the voice and speed."),
      onSome: (document) =>
        h.section.class("flex flex-col gap-3").children(
          h.h2.class("text-lg font-semibold").children("Chapter text"),
          h.ul
            .class(
              "flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface",
            )
            .children(
              ...document.chapters.map((chapter, index) => {
                const expanded = Option.contains(model.maybeExpandedIndex, index)
                return h.li.key(String(index)).children(
                  Collapsible(h, {
                    key: `chapter-${index}`,
                    props: { open: expanded },
                    onEmit: {
                      Toggled: ({ open }) =>
                        NarrateAgainEditorMessage.ToggledChapterPanel({ index, open }),
                      Settled: () => undefined,
                    },
                    view: (collapsible) =>
                      h.div.children(
                        collapsible
                          .trigger(
                            h.button
                              .attr("aria-label", `${index + 1} ${chapter.title}`)
                              .class(
                                "flex min-h-12 w-full min-w-0 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              ),
                          )
                          .children(
                            h.span.class("flex min-w-0 items-baseline gap-2.5").children(
                              h.span
                                .class("w-6 text-right text-[13px] text-muted-foreground tabular-nums")
                                .children(String(index + 1)),
                              h.span.class("truncate text-[15px]").children(chapter.title),
                            ),
                            Icon.chevronDown(
                              h,
                              expanded
                                ? "size-4 rotate-180 text-muted-foreground"
                                : "size-4 text-muted-foreground",
                            ),
                          ),
                        collapsible.panel(h.div.class("border-t border-border p-3"))?.children(
                          h.textarea
                            .attrs({ "aria-label": `Text of ${chapter.title}`, rows: "10" })
                            .value(model.texts[index] ?? chapter.text)
                            .disabled(busy)
                            .on("input", ({ value }) =>
                              NarrateAgainEditorMessage.UpdatedChapterText({ index, value }),
                            )
                            .class(
                              "min-h-48 max-h-[55vh] w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2.5 text-base leading-relaxed outline-none focus:border-ring disabled:opacity-40",
                            ),
                        ),
                      ),
                  }),
                )
              }),
            ),
          Option.match(h.props.maybeSubmitError, {
            onNone: () => null,
            onSome: (error) =>
              error.target === "text"
                ? h.p.attr("role", "alert").class("text-[13px] text-destructive").children(error.message)
                : null,
          }),
          textDirty &&
            voiceDirty &&
            h.p
              .class("text-[13px] text-muted-foreground")
              .children(
                "Queuing chapter edits starts narration now; apply voice and speed changes after it finishes.",
              ),
          Button(h, {
            props: { disabled: !textDirty || busy },
            onPress: NarrateAgainEditorMessage.ClickedNarrateText(),
          })
            .class(buttonClass({ variant: "primary", size: "sm" }, "self-start"))
            .children(
              isSubmittingText && Icon.loaderCircle(h, "animate-spin"),
              isSubmittingText ? "Queueing…" : "Narrate chapter edits",
            ),
        ),
    })

    return h.section.class("mt-2 flex flex-col gap-5").children(
      h.div.class("flex items-center").children(
        Button(h, { onPress: NarrateAgainEditorMessage.ClickedBack() })
          .class(buttonClass({ size: "sm" }, "-ml-2"))
          .children(Icon.arrowLeft(h), "Back"),
      ),
      h.header.children(
        h.h1.class("text-2xl font-semibold leading-tight").children("Narrate again"),
        h.p.class("mt-1 text-muted-foreground").children(h.props.episodeTitle),
      ),
      chapterSection,
      h.section.class("flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4").children(
        h.h2.class("text-lg font-semibold").children("Voice and speed"),
        h.div.class("flex flex-wrap gap-3").children(
          h.label.class("flex min-w-48 flex-1 flex-col gap-1.5 text-sm").children(
            "Voice",
            h.select
              .attr("aria-label", "Voice")
              .value(model.voice ?? "")
              .disabled(busy || voices.length === 0)
              .on("change", ({ value }) => NarrateAgainEditorMessage.ChangedVoice({ value }))
              .class(
                "h-10 rounded-lg border border-input bg-background px-3 text-base outline-none focus:border-ring",
              )
              .children(
                model.voice === null && h.option.attr("value", "").children("Choose a voice"),
                ...voices.map((voice) =>
                  h.option
                    .key(voice.id)
                    .attr("value", voice.id)
                    .children(voice.language ? `${voice.name} · ${languageName(voice.language)}` : voice.name),
                ),
              ),
          ),
          h.label.class("flex w-28 flex-col gap-1.5 text-sm").children(
            "Speed",
            h.select
              .attr("aria-label", "Speed")
              .value(String(model.speed))
              .disabled(busy)
              .on("change", ({ value }) => NarrateAgainEditorMessage.ChangedSpeed({ value }))
              .class(
                "h-10 rounded-lg border border-input bg-background px-3 text-base tabular-nums outline-none focus:border-ring",
              )
              .children(
                ...speeds.map((speed) =>
                  h.option.key(String(speed)).attr("value", String(speed)).children(formatRate(speed)),
                ),
              ),
          ),
        ),
        Option.match(h.props.maybeSubmitError, {
          onNone: () => null,
          onSome: (error) =>
            error.target === "voice"
              ? h.p.attr("role", "alert").class("text-[13px] text-destructive").children(error.message)
              : null,
        }),
        textDirty &&
          voiceDirty &&
          h.p
            .class("text-[13px] text-muted-foreground")
            .children("Changing voice and speed starts narration now and discards unsaved chapter edits."),
        Button(h, {
          props: { disabled: !voiceDirty || model.voice === null || voices.length === 0 || busy },
          onPress: NarrateAgainEditorMessage.ClickedChangeVoice(),
        })
          .class(buttonClass({ variant: "primary", size: "sm" }, "self-start"))
          .children(
            isSubmittingVoice && Icon.loaderCircle(h, "animate-spin"),
            isSubmittingVoice ? "Queueing…" : "Change voice & speed",
          ),
      ),
    )
  },
})

// --- Outer NarrateAgainScreen (reuses DocumentQuery; 404 opens voice-only legacy mode) ---

export const NarrateAgainScreenProps = Schema.Struct({
  episodeId: EpisodeId,
  openId: Schema.Number,
  episodeTitle: Schema.String,
  origin: Schema.String,
  initialVoice: Schema.NullOr(VoiceRef),
  initialSpeed: Schema.Number,
  voices: Schema.Array(Voice),
  submittingTarget: Schema.Option(NarrateAgainSubmitTarget),
  maybeSubmitError: Schema.Option(NarrateAgainError),
})
export type NarrateAgainScreenProps = typeof NarrateAgainScreenProps.Type

export const NarrateAgainScreenMessage = UiSchema.TaggedEnum({
  ClickedBack: {},
  ClickedTryAgain: {},
  SubmittedNarrateText: { episodeId: EpisodeId, document: Document },
  SubmittedChangeVoice: { episodeId: EpisodeId, input: ChangeVoice },
  ClearedSubmitError: { target: NarrateAgainSubmitTarget },
})
export type NarrateAgainScreenMessage = typeof NarrateAgainScreenMessage.Type

export const NarrateAgainScreenEvents = UiSchema.TaggedEnum({
  Closed: {},
  SubmittedNarrateText: { episodeId: EpisodeId, document: Document },
  SubmittedChangeVoice: { episodeId: EpisodeId, input: ChangeVoice },
  ClearedSubmitError: { target: NarrateAgainSubmitTarget },
})
export type NarrateAgainScreenEvents = typeof NarrateAgainScreenEvents.Type

const RetryNarrateAgainDocument = Command.make(
  "review/RetryNarrateAgainDocument",
  { args: { episodeId: EpisodeId, origin: Schema.String, openId: Schema.Number } },
  (args) => NarrateAgainDocumentQuery.invalidate(args).pipe(Effect.as(Component.noop)),
)

export const NarrateAgainScreen = Html.component({
  name: "NarrateAgainScreen",
  props: NarrateAgainScreenProps,
  model: Schema.Null,
  message: NarrateAgainScreenMessage,
  events: NarrateAgainScreenEvents,
  queries: {
    document: {
      query: NarrateAgainDocumentQuery,
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
    ClickedBack: ($) => $.emit(NarrateAgainScreenEvents.Closed()),
    ClickedTryAgain: ($) =>
      $.run(
        RetryNarrateAgainDocument.make({
          episodeId: $.props.episodeId,
          origin: $.props.origin,
          openId: $.props.openId,
        }),
      ),
    SubmittedNarrateText: ($, { episodeId, document }) =>
      $.emit(NarrateAgainScreenEvents.SubmittedNarrateText({ episodeId, document })),
    SubmittedChangeVoice: ($, { episodeId, input }) =>
      $.emit(NarrateAgainScreenEvents.SubmittedChangeVoice({ episodeId, input })),
    ClearedSubmitError: ($, { target }) =>
      $.emit(NarrateAgainScreenEvents.ClearedSubmitError({ target })),
  },
  view: (h) => {
    const renderEditor = (document: Option.Option<Document>) =>
      NarrateAgainEditor(h, {
        key: h.props.episodeId,
        props: {
          episodeId: h.props.episodeId,
          episodeTitle: h.props.episodeTitle,
          document,
          initialVoice: h.props.initialVoice,
          initialSpeed: h.props.initialSpeed,
          voices: h.props.voices,
          submittingTarget: h.props.submittingTarget,
          maybeSubmitError: h.props.maybeSubmitError,
        },
        onEmit: {
          Closed: () => NarrateAgainScreenMessage.ClickedBack(),
          SubmittedNarrateText: ({ episodeId, document: edited }) =>
            NarrateAgainScreenMessage.SubmittedNarrateText({ episodeId, document: edited }),
          SubmittedChangeVoice: ({ episodeId, input }) =>
            NarrateAgainScreenMessage.SubmittedChangeVoice({ episodeId, input }),
          ClearedSubmitError: ({ target }) => NarrateAgainScreenMessage.ClearedSubmitError({ target }),
        },
      })

    return AsyncResult.match(h.queries.document, {
      onInitial: () =>
        h.section.class("mt-2 flex flex-col gap-4").children(
          h.div.class("flex items-center").children(
            Button(h, { onPress: NarrateAgainScreenMessage.ClickedBack() })
              .class(buttonClass({ size: "sm" }, "-ml-2"))
              .children(Icon.arrowLeft(h), "Back"),
          ),
          h.h1.class("text-2xl font-semibold leading-tight").children("Narrate again"),
          h.p.class("text-muted-foreground").children(h.props.episodeTitle),
          h.div
            .attrs({ role: "status", "aria-label": "Loading" })
            .class("flex items-center justify-center py-12")
            .children(Icon.loaderCircle(h, "size-5 animate-spin text-muted-foreground")),
        ),
      onFailure: ({ cause, previousSuccess }) => {
        if (Option.isSome(previousSuccess)) {
          return renderEditor(previousSuccess.value.value)
        }
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
        return h.section.class("mt-2 flex flex-col gap-4").children(
          h.div.class("flex items-center").children(
            Button(h, { onPress: NarrateAgainScreenMessage.ClickedBack() })
              .class(buttonClass({ size: "sm" }, "-ml-2"))
              .children(Icon.arrowLeft(h), "Back"),
          ),
          h.h1.class("text-2xl font-semibold leading-tight").children("Narrate again"),
          h.div
            .class("flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 text-sm")
            .children(
              h.span
                .attr("role", "alert")
                .class("text-destructive")
                .children(failure?.message ?? "Could not load document"),
              Button(h, { onPress: NarrateAgainScreenMessage.ClickedTryAgain() })
                .class(buttonClass({ variant: "outline", size: "sm" }))
                .children("Try again"),
            ),
        )
      },
      onSuccess: ({ value: doc }) => renderEditor(doc),
    })
  },
}).pipe(Component.provide(NarrateAgainDocumentQuery.layer))
