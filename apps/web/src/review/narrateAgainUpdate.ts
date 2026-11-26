import type { Document, EpisodeId, VoiceRef } from "@fama/contracts"
import { Option } from "effect"
import type { HttpClient } from "effect/http"
import type { Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { Message } from "~/message"
import { type Model, SPEEDS, episodes } from "~/model"
import {
  ChangeNarrateAgainVoice,
  FetchNarrateAgainDocument,
  NarrateAgainWithDocument,
} from "~/review/narrateAgainCommand"
import { NarrateAgainMessage } from "~/review/narrateAgainMessage"
import {
  type EditingNarrateAgain,
  type NarrateAgain,
  NarrateAgainView,
  SubmitState,
  isSubmitting,
  isTextDirty,
  isVoiceDirty,
  toDocument,
} from "~/review/narrateAgainModel"

/** The parent refreshes the Library after queueing narration or hitting a stale-state 409/404. */
export interface NarrateAgainOutMessage {
  readonly refreshLibrary: true
}

type Return = Update.Return<Model, Message, HttpClient.HttpClient>
type ReturnWithQueue = Update.ReturnWithOutMessage<Model, Message, NarrateAgainOutMessage, HttpClient.HttpClient>

const withNarrateAgain = (model: Model, toNarrateAgain: (state: NarrateAgain) => NarrateAgain): Model =>
  modifyFields(model, { narrateAgain: toNarrateAgain })

const withEditing = (model: Model, toEditing: (editing: EditingNarrateAgain) => EditingNarrateAgain): Model =>
  withNarrateAgain(model, (state) =>
    state.view._tag === "Editing" ? { ...state, view: NarrateAgainView.Editing(toEditing(state.view)) } : state,
  )

const openEpisode = (model: Model, episodeId: EpisodeId): ReturnWithQueue => {
  const episode = episodes(model).find((item) => item.id === episodeId)
  if (!episode || (episode.job._tag !== "Ready" && episode.job._tag !== "Failed")) return { model }
  const request = model.narrateAgain.requests + 1
  return {
    model: withNarrateAgain(model, () => ({
      requests: request,
      view: NarrateAgainView.Loading({ episodeId, request }),
    })),
    commands: [FetchNarrateAgainDocument({ connection: model.connection, episodeId, request })],
  }
}

const editingFromDocument = (model: Model, episodeId: EpisodeId, document: Option.Option<Document>) => {
  const episode = episodes(model).find((item) => item.id === episodeId)
  if (!episode) return model
  const chapters = Option.match(document, { onNone: () => [], onSome: (stored) => stored.chapters })
  return withNarrateAgain(model, (state) => ({
    ...state,
    view: NarrateAgainView.Editing({
      episodeId,
      document,
      texts: chapters.map((chapter) => chapter.text),
      maybeExpandedIndex: chapters.length === 1 ? Option.some(0) : Option.none(),
      voice: episode.voice,
      speed: episode.speed,
      initialVoice: episode.voice,
      initialSpeed: episode.speed,
      submit: SubmitState.Idle(),
    }),
  }))
}

export const update = (model: Model, message: NarrateAgainMessage): ReturnWithQueue =>
  NarrateAgainMessage.match<ReturnWithQueue>(message, {
    ClickedEpisode: ({ episodeId }) => openEpisode(model, episodeId),
    ClickedBack: () => ({
      model: withNarrateAgain(model, (state) => ({ ...state, view: NarrateAgainView.Closed() })),
    }),
    ClickedTryAgain: () =>
      model.narrateAgain.view._tag === "LoadFailed"
        ? openEpisode(model, model.narrateAgain.view.episodeId)
        : { model },
    SucceededFetchDocument: ({ episodeId, request, document }) => {
      const view = model.narrateAgain.view
      return view._tag === "Loading" && view.episodeId === episodeId && view.request === request
        ? { model: editingFromDocument(model, episodeId, Option.some(document)) }
        : { model }
    },
    FailedFetchDocument: ({ episodeId, request, failure }) => {
      const view = model.narrateAgain.view
      if (view._tag !== "Loading" || view.episodeId !== episodeId || view.request !== request) return { model }
      if (failure.status === 404) return { model: editingFromDocument(model, episodeId, Option.none()) }
      return {
        model: withNarrateAgain(model, (state) => ({
          ...state,
          view: NarrateAgainView.LoadFailed({ episodeId, message: failure.message }),
        })),
      }
    },
    ClickedChapter: ({ index }) => ({
      model: withEditing(model, (editing) => ({
        ...editing,
        maybeExpandedIndex: Option.contains(editing.maybeExpandedIndex, index) ? Option.none() : Option.some(index),
      })),
    }),
    UpdatedChapterText: ({ index, value }) => ({
      model: withEditing(model, (editing) =>
        isSubmitting(editing)
          ? editing
          : {
              ...editing,
              texts: editing.texts.map((text, chapter) => (chapter === index ? value : text)),
              submit: editing.submit._tag === "Failed" && editing.submit.target === "text" ? SubmitState.Idle() : editing.submit,
            },
      ),
    }),
    ChangedVoice: ({ value }) => ({
      model: withEditing(model, (editing) =>
        isSubmitting(editing)
          ? editing
          : {
              ...editing,
              voice: value === "" ? null : (value as VoiceRef),
              submit: editing.submit._tag === "Failed" && editing.submit.target === "voice" ? SubmitState.Idle() : editing.submit,
            },
      ),
    }),
    ChangedSpeed: ({ value }) => {
      const speed = Number(value)
      return SPEEDS.includes(speed as (typeof SPEEDS)[number])
        ? {
            model: withEditing(model, (editing) =>
              isSubmitting(editing)
                ? editing
                : {
                    ...editing,
                    speed,
                    submit:
                      editing.submit._tag === "Failed" && editing.submit.target === "voice"
                        ? SubmitState.Idle()
                        : editing.submit,
                  },
            ),
          }
        : { model }
    },
    ClickedNarrateText: () => {
      const view = model.narrateAgain.view
      if (view._tag !== "Editing" || isSubmitting(view) || !isTextDirty(view)) return { model }
      return Option.match(toDocument(view), {
        onNone: () => ({ model }),
        onSome: (document) => ({
          model: withEditing(model, (editing) => ({ ...editing, submit: SubmitState.SubmittingText() })),
          commands: [NarrateAgainWithDocument({ connection: model.connection, episodeId: view.episodeId, document })],
        }),
      })
    },
    ClickedChangeVoice: () => {
      const view = model.narrateAgain.view
      if (
        view._tag !== "Editing" ||
        isSubmitting(view) ||
        !isVoiceDirty(view) ||
        view.voice === null ||
        !Number.isFinite(view.speed) ||
        view.speed <= 0
      ) {
        return { model }
      }
      return {
        model: withEditing(model, (editing) => ({ ...editing, submit: SubmitState.SubmittingVoice() })),
        commands: [
          ChangeNarrateAgainVoice({
            connection: model.connection,
            episodeId: view.episodeId,
            input: { voice: view.voice, speed: view.speed },
          }),
        ],
      }
    },
    SucceededQueueNarration: ({ episodeId }) => {
      const view = model.narrateAgain.view
      const shouldClose = view._tag === "Editing" && view.episodeId === episodeId
      return {
        model: shouldClose
          ? withNarrateAgain(model, (state) => ({ ...state, view: NarrateAgainView.Closed() }))
          : model,
        outMessage: { refreshLibrary: true },
      }
    },
    FailedQueueNarration: ({ episodeId, failure }) => {
      const shouldRefresh = failure.status === 409 || failure.status === 404
      return {
        model: withEditing(model, (editing) => {
          if (editing.episodeId !== episodeId || !isSubmitting(editing)) return editing
          const target = editing.submit._tag === "SubmittingVoice" ? "voice" : "text"
          return { ...editing, submit: SubmitState.Failed({ target, message: failure.message }) }
        }),
        ...(shouldRefresh ? { outMessage: { refreshLibrary: true } } : {}),
      }
    },
  })

/** Closes the screen if another device removes the Episode or starts its narration first. */
export const reconcile = (model: Model): Return => {
  const view = model.narrateAgain.view
  if (view._tag === "Closed" || Option.isNone(model.maybeEpisodes)) return { model }
  if (view._tag === "Editing" && isSubmitting(view)) return { model }
  const episode = model.maybeEpisodes.value.find((item) => item.id === view.episodeId)
  if (episode && (episode.job._tag === "Ready" || episode.job._tag === "Failed")) return { model }
  return {
    model: withNarrateAgain(model, (state) => ({ ...state, view: NarrateAgainView.Closed() })),
  }
}
