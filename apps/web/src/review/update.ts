import type { Episode, EpisodeId } from "@fama/contracts"
import { Option } from "effect"
import type { HttpClient } from "effect/http"
import { Command, type Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { FetchVoices } from "~/command"
import { Message } from "~/message"
import { type Model, episodes } from "~/model"
import { FetchDocument, SaveDocument, StartReviewNarration } from "~/review/command"
import { ReviewMessage } from "~/review/message"
import {
  type EditingReview,
  type Review,
  ReviewView,
  SaveState,
  StartState,
  detectRepeatedLines,
  isDirty,
  removeRepeatedLine,
  toFullDocument,
  toStartDocument,
} from "~/review/model"
import {
  type SamplesMessage,
  initSamples,
  selectedVoiceForStart,
  stopSampleCommandIfPlaying,
  stopSampleIfMainPlaying,
  updateSamples,
} from "~/review/samples"

/** Review out-messages: starting narration updates the episode; playing a sample pauses main playback. */
export interface StartedEpisode {
  readonly episode?: Episode
  readonly pausePlayback?: boolean
}

const toSamplesParent = (message: SamplesMessage) =>
  Message.GotReviewMessage({ message: ReviewMessage.GotSamplesMessage({ message }) })

type Return = Update.Return<Model, Message, HttpClient.HttpClient>
type ReturnWithStart = Update.ReturnWithOutMessage<Model, Message, StartedEpisode, HttpClient.HttpClient>

const withReview = (model: Model, toReview: (review: Review) => Review): Model =>
  modifyFields(model, { review: toReview })

const withEditing = (model: Model, toEditing: (editing: EditingReview) => EditingReview): Model =>
  withReview(model, (review) =>
    review.view._tag === "Editing" ? { ...review, view: ReviewView.Editing(toEditing(review.view)) } : review,
  )

const openEpisode = (model: Model, episodeId: EpisodeId): ReturnWithStart => {
  const episode = episodes(model).find((item) => item.id === episodeId)
  if (!episode || episode.job._tag !== "Review") return { model }
  const request = model.review.requests + 1
  return {
    model: withReview(model, () => ({
      requests: request,
      view: ReviewView.Loading({ episodeId, request }),
    })),
    commands: [FetchDocument({ connection: model.connection, episodeId, request })],
  }
}

export const update = (model: Model, message: ReviewMessage): ReturnWithStart =>
  ReviewMessage.match<ReturnWithStart>(message, {
    ClickedEpisode: ({ episodeId }) => openEpisode(model, episodeId),
    ClickedBack: () => ({
      model: withReview(model, (review) => ({ ...review, view: ReviewView.Closed() })),
      commands:
        model.review.view._tag === "Editing"
          ? Command.mapMessages(stopSampleCommandIfPlaying(model.review.view.samples), toSamplesParent)
          : [],
    }),
    ClickedTryAgain: () =>
      model.review.view._tag === "LoadFailed" ? openEpisode(model, model.review.view.episodeId) : { model },
    GotSamplesMessage: ({ message: samplesMessage }) => {
      const view = model.review.view
      if (view._tag !== "Editing") {
        // Apply a late voice-save response even after Back so the library Episode does not stay stale.
        if (samplesMessage._tag === "SucceededChangeVoice") {
          return {
            model: modifyFields(model, {
              maybeEpisodes: Option.map((list) =>
                list.map((item) =>
                  item.id === samplesMessage.episodeId && item.job._tag === "Review"
                    ? { ...item, voice: samplesMessage.voice, speed: samplesMessage.speed }
                    : item,
                ),
              ),
            }),
          }
        }
        return { model }
      }
      const episode = episodes(model).find((item) => item.id === view.episodeId)
      const isBusy = view.save._tag === "Saving" || view.start._tag === "Starting"
      const result = updateSamples(view.samples, samplesMessage, {
        connection: model.connection,
        episodeId: view.episodeId,
        speed: episode?.speed ?? 1,
        isBusy,
      })
      const changed = result.outMessage?.changedVoice
      const withUpdatedSamples = withEditing(model, (editing) => ({ ...editing, samples: result.model }))
      const nextModel = changed
        ? modifyFields(withUpdatedSamples, {
            maybeEpisodes: Option.map((list) =>
              list.map((item) =>
                item.id === changed.episodeId ? { ...item, voice: changed.voice, speed: changed.speed } : item,
              ),
            ),
          })
        : withUpdatedSamples
      const fetchVoices =
        samplesMessage._tag === "RequestedInitialFetch" && !view.samples.hasLoaded && model.voices.length === 0
          ? [FetchVoices({ connection: model.connection })]
          : []
      return {
        model: nextModel,
        commands: [...Command.mapMessages(result.commands, toSamplesParent), ...fetchVoices],
        ...(result.outMessage?.pausePlayback ? { outMessage: { pausePlayback: true } } : {}),
      }
    },
    SucceededFetchDocument: ({ episodeId, request, document }) => {
      const view = model.review.view
      if (view._tag !== "Loading" || view.episodeId !== episodeId || view.request !== request) return { model }
      const episode = episodes(model).find((item) => item.id === episodeId)
      const chapters = document.chapters.map((chapter, index) => ({
        index,
        title: chapter.title,
        text: chapter.text,
        isKept: true,
      }))
      return {
        model: withReview(model, (review) => ({
          ...review,
          view: ReviewView.Editing({
            episodeId,
            loaded: document,
            title: document.title,
            chapters,
            maybeExpandedIndex: chapters.length === 1 ? Option.some(0) : Option.none(),
            repeatedLines: detectRepeatedLines(chapters),
            samples: initSamples(episode?.voice ?? null),
            save: SaveState.Idle(),
            start: StartState.Idle(),
          }),
        })),
      }
    },
    FailedFetchDocument: ({ episodeId, request, failure }) => {
      const view = model.review.view
      if (view._tag !== "Loading" || view.episodeId !== episodeId || view.request !== request) return { model }
      return {
        model: withReview(model, (review) => ({
          ...review,
          view: ReviewView.LoadFailed({ episodeId, message: failure.message }),
        })),
      }
    },
    UpdatedTitle: ({ value }) => ({
      model: withEditing(model, (editing) => ({
        ...editing,
        title: value,
        save: SaveState.Idle(),
        start: StartState.Idle(),
      })),
    }),
    ToggledChapter: ({ index }) => ({
      model: withEditing(model, (editing) => {
        const chapters = editing.chapters.map((chapter) =>
          chapter.index === index ? { ...chapter, isKept: !chapter.isKept } : chapter,
        )
        return {
          ...editing,
          chapters,
          repeatedLines: detectRepeatedLines(chapters),
          start: StartState.Idle(),
        }
      }),
    }),
    ClickedChapter: ({ index }) => ({
      model: withEditing(model, (editing) => ({
        ...editing,
        maybeExpandedIndex: Option.contains(editing.maybeExpandedIndex, index) ? Option.none() : Option.some(index),
        repeatedLines: detectRepeatedLines(editing.chapters),
      })),
    }),
    UpdatedChapterTitle: ({ index, value }) => ({
      model: withEditing(model, (editing) => ({
        ...editing,
        chapters: editing.chapters.map((chapter) => (chapter.index === index ? { ...chapter, title: value } : chapter)),
        save: SaveState.Idle(),
        start: StartState.Idle(),
      })),
    }),
    UpdatedChapterText: ({ index, value }) => ({
      model: withEditing(model, (editing) => ({
        ...editing,
        chapters: editing.chapters.map((chapter) => (chapter.index === index ? { ...chapter, text: value } : chapter)),
        save: SaveState.Idle(),
        start: StartState.Idle(),
      })),
    }),
    ClickedRemoveRepeatedLine: ({ line }) => ({
      model: withEditing(model, (editing) => {
        const chapters = removeRepeatedLine(editing.chapters, line)
        return {
          ...editing,
          chapters,
          repeatedLines: detectRepeatedLines(chapters),
          save: SaveState.Idle(),
          start: StartState.Idle(),
        }
      }),
    }),
    ClickedSave: () => {
      const view = model.review.view
      if (view._tag !== "Editing" || view.save._tag === "Saving" || view.start._tag === "Starting" || !isDirty(view)) {
        return { model }
      }
      return Option.match(toFullDocument(view), {
        onNone: () => ({ model }),
        onSome: (document) => ({
          model: withEditing(model, (editing) => ({ ...editing, save: SaveState.Saving() })),
          commands: [SaveDocument({ connection: model.connection, episodeId: view.episodeId, document })],
        }),
      })
    },
    SucceededSaveDocument: ({ episodeId, document }) => ({
      model: withEditing(model, (editing) => {
        if (editing.episodeId !== episodeId) return editing
        const next: EditingReview = { ...editing, loaded: document }
        return { ...next, save: isDirty(next) ? SaveState.Idle() : SaveState.Saved() }
      }),
    }),
    FailedSaveDocument: ({ episodeId, failure }) => ({
      model: withEditing(model, (editing) =>
        editing.episodeId === episodeId && editing.save._tag === "Saving"
          ? { ...editing, save: SaveState.Failed({ message: failure.message }) }
          : editing,
      ),
    }),
    ClickedStart: () => {
      const view = model.review.view
      if (view._tag !== "Editing" || view.start._tag === "Starting" || view.save._tag === "Saving") return { model }
      const voice = selectedVoiceForStart(view.samples)
      return Option.match(toStartDocument(view), {
        onNone: () => ({ model }),
        onSome: (document) => ({
          model: withEditing(model, (editing) => ({ ...editing, start: StartState.Starting() })),
          commands: [
            StartReviewNarration({
              connection: model.connection,
              episodeId: view.episodeId,
              document,
              ...(voice !== undefined ? { voice } : {}),
            }),
          ],
        }),
      })
    },
    SucceededStartReview: ({ episode }) => ({
      model: withReview(model, (review) => ({ ...review, view: ReviewView.Closed() })),
      commands:
        model.review.view._tag === "Editing"
          ? Command.mapMessages(stopSampleCommandIfPlaying(model.review.view.samples), toSamplesParent)
          : [],
      outMessage: { episode },
    }),
    FailedStartReview: ({ episodeId, failure }) => ({
      model: withEditing(model, (editing) =>
        editing.episodeId === episodeId && editing.start._tag === "Starting"
          ? { ...editing, start: StartState.Failed({ message: failure.message }) }
          : editing,
      ),
    }),
  })

/** Closes Review when its episode leaves the library or moves out of `Review` (e.g. from another tab). */
export const reconcile = (model: Model): Return => {
  const view = model.review.view
  if (view._tag === "Closed" || Option.isNone(model.maybeEpisodes)) return { model }
  if (view._tag === "Editing" && view.start._tag === "Starting") return { model }
  const episode = model.maybeEpisodes.value.find((item) => item.id === view.episodeId)
  if (episode && episode.job._tag === "Review") {
    if (view._tag !== "Editing") return { model }
    const isMainPlaying = model.playback._tag === "Loaded" && model.playback.isPlaying
    const reconciled = stopSampleIfMainPlaying(view.samples, isMainPlaying)
    if (reconciled.commands.length === 0) return { model }
    return {
      model: withEditing(model, (editing) => ({ ...editing, samples: reconciled.samples })),
      commands: Command.mapMessages(reconciled.commands, toSamplesParent),
    }
  }
  return {
    model: withReview(model, (review) => ({ ...review, view: ReviewView.Closed() })),
    commands:
      view._tag === "Editing" ? Command.mapMessages(stopSampleCommandIfPlaying(view.samples), toSamplesParent) : [],
  }
}
