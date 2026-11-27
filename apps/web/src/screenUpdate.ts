import type { ChangeVoice, Document, EpisodeId, VoiceRef } from "@fama/contracts"
import { Command } from "@effect/ui"
import { Option, Record } from "effect"
import {
  ChangeNarrateAgainVoice,
  ChangeReviewVoice,
  FetchVoices,
  NarrateAgainWithDocument,
  SaveDocument,
  StartReviewNarration,
} from "~/command"
import { InvalidateDocument } from "~/core/queries"
import { hasText } from "~/core/timeline"
import { fetchEpisodes, withEpisodes } from "~/libraryState"
import { AppMessage } from "~/message"
import { type AppModel, Screen, current, episodes } from "~/model"
import { type Step, type StepReturn, combine } from "~/transition"

const openReview = (episodeId: EpisodeId): Step => (model) => {
  const episode = episodes(model).find((item) => item.id === episodeId)
  if (!episode || episode.job._tag !== "Review") return { model }
  const openId = model.screenOpens + 1
  const existingSave = model.reviewSaves[episodeId]
  const reviewSaves =
    existingSave !== undefined && !existingSave.isSaving
      ? Record.remove(model.reviewSaves, episodeId)
      : existingSave !== undefined
        ? Record.set(model.reviewSaves, episodeId, { ...existingSave, maybeError: Option.none() })
        : model.reviewSaves
  const existingStart = model.reviewStarts[episodeId]
  const reviewStarts =
    existingStart !== undefined && !existingStart.isStarting
      ? Record.remove(model.reviewStarts, episodeId)
      : model.reviewStarts
  return {
    model: {
      ...model,
      screen: Screen.Review({ episodeId, openId }),
      screenOpens: openId,
      maybeReaderEpisodeId: Option.none(),
      reviewSaves,
      reviewStarts,
    },
    commands:
      model.voices.length === 0
        ? [FetchVoices.make({ connection: model.connection, generation: model.connectionGeneration })]
        : [],
  }
}

const openNarrateAgain = (episodeId: EpisodeId): Step => (model) => {
  const episode = episodes(model).find((item) => item.id === episodeId)
  if (!episode || (episode.job._tag !== "Ready" && episode.job._tag !== "Failed")) return { model }
  const openId = model.screenOpens + 1
  const existing = model.narrateAgainSubmits[episodeId]
  const narrateAgainSubmits =
    existing !== undefined && !existing.isSubmitting
      ? Record.remove(model.narrateAgainSubmits, episodeId)
      : model.narrateAgainSubmits
  return {
    model: {
      ...model,
      screen: Screen.NarrateAgain({ episodeId, openId }),
      screenOpens: openId,
      maybeReaderEpisodeId: Option.none(),
      narrateAgainSubmits,
    },
    commands:
      model.voices.length === 0
        ? [FetchVoices.make({ connection: model.connection, generation: model.connectionGeneration })]
        : [],
  }
}

const toggleReader: Step = (model) => {
  if (Option.isSome(model.maybeReaderEpisodeId)) {
    return { model: { ...model, maybeReaderEpisodeId: Option.none() } }
  }
  return Option.match(current(model), {
    onNone: () => ({ model }),
    onSome: ({ episode }) =>
      hasText(episode)
        ? {
            model: {
              ...model,
              maybeReaderEpisodeId: Option.some(episode.id),
              // Opening Read-along closes Narrate again, while keeping Review mounted behind it.
              screen: model.screen._tag === "NarrateAgain" ? Screen.Library() : model.screen,
            },
          }
        : { model },
  })
}

const submitSaveReview =
  (episodeId: EpisodeId, document: Document): Step =>
  (model) => {
    const command = SaveDocument.make({ connection: model.connection, episodeId, document }).pipe(
      Command.match({
        onSuccess: (saved) => AppMessage.SucceededSaveReview({ episodeId, document: saved }),
        onFailure: (failure) => AppMessage.FailedSaveReview({ episodeId, failure }),
      }),
    )
    const previousSaved = model.reviewSaves[episodeId]?.maybeSavedDocument ?? Option.none()
    const existingStart = model.reviewStarts[episodeId]
    return {
      model: {
        ...model,
        reviewSaves: Record.set(model.reviewSaves, episodeId, {
          isSaving: true,
          maybePendingDocument: Option.some(document),
          maybeSavedDocument: previousSaved,
          maybeError: Option.none(),
        }),
        reviewStarts:
          existingStart !== undefined && !existingStart.isStarting
            ? Record.remove(model.reviewStarts, episodeId)
            : model.reviewStarts,
      },
      commands: [command],
    }
  }

const submitStartReview =
  (episodeId: EpisodeId, document: Document, voice?: VoiceRef): Step =>
  (model) => {
    const command = StartReviewNarration.make({
      connection: model.connection,
      episodeId,
      document,
      ...(voice !== undefined ? { voice } : {}),
    }).pipe(
      Command.match({
        onSuccess: (episode) => AppMessage.SucceededStartReview({ episode }),
        onFailure: (failure) => AppMessage.FailedStartReview({ episodeId, failure }),
      }),
    )
    const existingSave = model.reviewSaves[episodeId]
    return {
      model: {
        ...model,
        reviewStarts: Record.set(model.reviewStarts, episodeId, {
          isStarting: true,
          maybeError: Option.none(),
        }),
        reviewSaves:
          existingSave !== undefined
            ? Record.set(model.reviewSaves, episodeId, { ...existingSave, maybeError: Option.none() })
            : model.reviewSaves,
      },
      commands: [command],
    }
  }

const submitNarrateAgainText =
  (episodeId: EpisodeId, document: Document): Step =>
  (model) => {
    const command = NarrateAgainWithDocument.make({ connection: model.connection, episodeId, document }).pipe(
      Command.match({
        onSuccess: () => AppMessage.SucceededNarrateAgain({ episodeId }),
        onFailure: (failure) => AppMessage.FailedNarrateAgain({ episodeId, target: "text", failure }),
      }),
    )
    return {
      model: {
        ...model,
        narrateAgainSubmits: Record.set(model.narrateAgainSubmits, episodeId, {
          target: "text" as const,
          isSubmitting: true,
          maybeError: Option.none(),
        }),
      },
      commands: [command],
    }
  }

const submitNarrateAgainVoice =
  (episodeId: EpisodeId, input: typeof ChangeVoice.Type): Step =>
  (model) => {
    const command = ChangeNarrateAgainVoice.make({ connection: model.connection, episodeId, input }).pipe(
      Command.match({
        onSuccess: () => AppMessage.SucceededNarrateAgain({ episodeId }),
        onFailure: (failure) => AppMessage.FailedNarrateAgain({ episodeId, target: "voice", failure }),
      }),
    )
    return {
      model: {
        ...model,
        narrateAgainSubmits: Record.set(model.narrateAgainSubmits, episodeId, {
          target: "voice" as const,
          isSubmitting: true,
          maybeError: Option.none(),
        }),
      },
      commands: [command],
    }
  }

/** Closes a sub-screen or Read-along when its backing episode or playback state no longer supports it. */
export const reconcileScreen: Step = (model) => {
  let screen = model.screen
  switch (screen._tag) {
    case "Library":
      break
    case "Review": {
      const id = screen.episodeId
      const episode = episodes(model).find((item) => item.id === id)
      if (!episode || episode.job._tag !== "Review") screen = Screen.Library()
      break
    }
    case "NarrateAgain": {
      const id = screen.episodeId
      const episode = episodes(model).find((item) => item.id === id)
      if (!episode || (episode.job._tag !== "Ready" && episode.job._tag !== "Failed")) screen = Screen.Library()
      break
    }
  }

  const maybeReaderEpisodeId = Option.filter(model.maybeReaderEpisodeId, (id) =>
    Option.exists(current(model), ({ episode }) => episode.id === id && hasText(episode)),
  )
  const isInReview = (id: string) =>
    episodes(model).some((episode) => episode.id === id && episode.job._tag === "Review")
  const canNarrateAgain = (id: string) =>
    episodes(model).some(
      (episode) => episode.id === id && (episode.job._tag === "Ready" || episode.job._tag === "Failed"),
    )
  const filterRecord = <T>(record: Record<string, T>, keep: (id: string) => boolean): Record<string, T> => {
    let changed = false
    for (const id of Object.keys(record)) {
      if (!keep(id)) {
        changed = true
        break
      }
    }
    if (!changed) return record
    const next: Record<string, T> = {}
    for (const [id, value] of Object.entries(record)) {
      if (keep(id)) next[id] = value
    }
    return next
  }
  const reviewSaves = filterRecord(model.reviewSaves, isInReview)
  const reviewVoices = filterRecord(model.reviewVoices, isInReview)
  const reviewStarts = filterRecord(model.reviewStarts, isInReview)
  const narrateAgainSubmits = filterRecord(model.narrateAgainSubmits, canNarrateAgain)

  return screen === model.screen &&
    Option.getOrNull(maybeReaderEpisodeId) === Option.getOrNull(model.maybeReaderEpisodeId) &&
    reviewSaves === model.reviewSaves &&
    reviewVoices === model.reviewVoices &&
    reviewStarts === model.reviewStarts &&
    narrateAgainSubmits === model.narrateAgainSubmits
    ? { model }
    : {
        model: {
          ...model,
          screen,
          maybeReaderEpisodeId,
          reviewSaves,
          reviewVoices,
          reviewStarts,
          narrateAgainSubmits,
        },
      }
}

const unchanged: Step = (model) => ({ model })

type ScreenHandlers = {
  [Message in AppMessage as Message["_tag"]]?: (message: Message) => StepReturn
}

export const screenHandlers = (model: AppModel) => ({
    ClickedOpenReview: ({ episodeId }) => openReview(episodeId)(model),
    ClickedOpenNarrateAgain: ({ episodeId }) => openNarrateAgain(episodeId)(model),
    ClosedSubScreen: () => {
      let reviewSaves = model.reviewSaves
      let reviewStarts = model.reviewStarts
      let narrateAgainSubmits = model.narrateAgainSubmits
      if (model.screen._tag === "Review") {
        const id = model.screen.episodeId
        const existingSave = reviewSaves[id]
        if (existingSave !== undefined && !existingSave.isSaving) {
          reviewSaves = Record.remove(reviewSaves, id)
        }
        const existingStart = reviewStarts[id]
        if (existingStart !== undefined && !existingStart.isStarting) {
          reviewStarts = Record.remove(reviewStarts, id)
        }
      } else if (model.screen._tag === "NarrateAgain") {
        const id = model.screen.episodeId
        const existing = narrateAgainSubmits[id]
        if (existing !== undefined && !existing.isSubmitting) {
          narrateAgainSubmits = Record.remove(narrateAgainSubmits, id)
        }
      }
      return {
        model: {
          ...model,
          screen: Screen.Library(),
          reviewSaves,
          reviewStarts,
          narrateAgainSubmits,
        },
      }
    },
    SubmittedSaveReview: ({ episodeId, document }) => submitSaveReview(episodeId, document)(model),
    SucceededSaveReview: ({ episodeId, document }) => ({
      model: {
        ...model,
        reviewSaves:
          model.screen._tag === "Review" && model.screen.episodeId === episodeId
            ? Record.set(model.reviewSaves, episodeId, {
                isSaving: false,
                maybePendingDocument: Option.none(),
                maybeSavedDocument: Option.some(document),
                maybeError: Option.none(),
              })
            : Record.remove(model.reviewSaves, episodeId),
      },
      commands: [InvalidateDocument.make({})],
    }),
    FailedSaveReview: ({ episodeId, failure }) => {
      const previousSaved = model.reviewSaves[episodeId]?.maybeSavedDocument ?? Option.none()
      return {
        model: {
          ...model,
          reviewSaves:
            model.screen._tag === "Review" && model.screen.episodeId === episodeId
              ? Record.set(model.reviewSaves, episodeId, {
                  isSaving: false,
                  maybePendingDocument: Option.none(),
                  maybeSavedDocument: previousSaved,
                  maybeError: Option.some(failure.message),
                })
              : Record.remove(model.reviewSaves, episodeId),
        },
      }
    },
    SubmittedStartReview: ({ episodeId, document, voice }) => submitStartReview(episodeId, document, voice)(model),
    SucceededStartReview: ({ episode }) =>
      combine(
        {
          ...model,
          screen:
            model.screen._tag === "Review" && model.screen.episodeId === episode.id
              ? Screen.Library()
              : model.screen,
          reviewSaves: Record.remove(model.reviewSaves, episode.id),
          reviewVoices: Record.remove(model.reviewVoices, episode.id),
          reviewStarts: Record.remove(model.reviewStarts, episode.id),
        },
        [
          withEpisodes((list) => list.map((item) => (item.id === episode.id ? episode : item))),
          (stepModel) => ({
            model: stepModel,
            commands: [InvalidateDocument.make({})],
          }),
        ],
      ),
    FailedStartReview: ({ episodeId, failure }) => ({
      model: {
        ...model,
        reviewStarts:
          model.screen._tag === "Review" && model.screen.episodeId === episodeId
            ? Record.set(model.reviewStarts, episodeId, {
                isStarting: false,
                maybeError: Option.some(failure.message),
              })
            : Record.remove(model.reviewStarts, episodeId),
      },
    }),
    ClearedReviewError: ({ episodeId }) => {
      const existingSave = model.reviewSaves[episodeId]
      const existingStart = model.reviewStarts[episodeId]
      return {
        model: {
          ...model,
          reviewSaves:
            existingSave !== undefined
              ? Record.set(model.reviewSaves, episodeId, { ...existingSave, maybeError: Option.none() })
              : model.reviewSaves,
          reviewStarts:
            existingStart !== undefined && !existingStart.isStarting
              ? Record.remove(model.reviewStarts, episodeId)
              : model.reviewStarts,
        },
      }
    },
    RequestedChangeReviewVoice: ({ episodeId, voice, speed }) => {
      const existing = model.reviewVoices[episodeId]
      if (existing !== undefined && existing.isSaving) {
        return {
          model: {
            ...model,
            reviewVoices: Record.set(model.reviewVoices, episodeId, {
              ...existing,
              voice,
              maybeQueued: Option.some({ voice, speed, origin: model.connection.origin }),
              maybeError: Option.none(),
            }),
          },
        }
      }
      const request = model.reviewVoiceRequests + 1
      return {
        model: {
          ...model,
          reviewVoiceRequests: request,
          reviewVoices: Record.set(model.reviewVoices, episodeId, {
            request,
            voice,
            isSaving: true,
            maybeQueued: Option.none(),
            maybeError: Option.none(),
          }),
        },
        commands: [ChangeReviewVoice.make({ connection: model.connection, episodeId, request, voice, speed })],
      }
    },
    SucceededChangeReviewVoice: ({ episodeId, origin, request, voice, speed }) => {
      const currentVoice = model.reviewVoices[episodeId]
      const applyEpisode: Step =
        origin === model.connection.origin
          ? withEpisodes((list) =>
              list.map((item) =>
                item.id === episodeId && item.job._tag === "Review" ? { ...item, voice, speed } : item,
              ),
            )
          : unchanged
      if (currentVoice === undefined || currentVoice.request !== request) {
        return applyEpisode(model)
      }
      return Option.match(currentVoice.maybeQueued, {
        onNone: () =>
          combine({ ...model, reviewVoices: Record.remove(model.reviewVoices, episodeId) }, [applyEpisode]),
        onSome: (queued) => {
          if (queued.origin !== model.connection.origin) {
            return combine({ ...model, reviewVoices: Record.remove(model.reviewVoices, episodeId) }, [applyEpisode])
          }
          const nextRequest = model.reviewVoiceRequests + 1
          return combine(
            {
              ...model,
              reviewVoiceRequests: nextRequest,
              reviewVoices: Record.set(model.reviewVoices, episodeId, {
                request: nextRequest,
                voice: queued.voice,
                isSaving: true,
                maybeQueued: Option.none(),
                maybeError: Option.none(),
              }),
            },
            [
              applyEpisode,
              (stepModel) => ({
                model: stepModel,
                commands: [
                  ChangeReviewVoice.make({
                    connection: stepModel.connection,
                    episodeId,
                    request: nextRequest,
                    voice: queued.voice,
                    speed: queued.speed,
                  }),
                ],
              }),
            ],
          )
        },
      })
    },
    FailedChangeReviewVoice: ({ episodeId, request, voice, failure }) => {
      const currentVoice = model.reviewVoices[episodeId]
      if (currentVoice === undefined || currentVoice.request !== request) return { model }
      return Option.match(currentVoice.maybeQueued, {
        onNone: () => ({
          model: {
            ...model,
            reviewVoices: Record.set(model.reviewVoices, episodeId, {
              request,
              voice,
              isSaving: false,
              maybeQueued: Option.none(),
              maybeError: Option.some(failure.message),
            }),
          },
        }),
        onSome: (queued) => {
          if (queued.origin !== model.connection.origin) {
            return { model: { ...model, reviewVoices: Record.remove(model.reviewVoices, episodeId) } }
          }
          const nextRequest = model.reviewVoiceRequests + 1
          return {
            model: {
              ...model,
              reviewVoiceRequests: nextRequest,
              reviewVoices: Record.set(model.reviewVoices, episodeId, {
                request: nextRequest,
                voice: queued.voice,
                isSaving: true,
                maybeQueued: Option.none(),
                maybeError: Option.none(),
              }),
            },
            commands: [
              ChangeReviewVoice.make({
                connection: model.connection,
                episodeId,
                request: nextRequest,
                voice: queued.voice,
                speed: queued.speed,
              }),
            ],
          }
        },
      })
    },
    SubmittedNarrateAgainText: ({ episodeId, document }) => submitNarrateAgainText(episodeId, document)(model),
    SubmittedNarrateAgainVoice: ({ episodeId, input }) => submitNarrateAgainVoice(episodeId, input)(model),
    SucceededNarrateAgain: ({ episodeId }) =>
      combine(
        {
          ...model,
          screen:
            model.screen._tag === "NarrateAgain" && model.screen.episodeId === episodeId
              ? Screen.Library()
              : model.screen,
          narrateAgainSubmits: Record.remove(model.narrateAgainSubmits, episodeId),
        },
        [
          fetchEpisodes,
          (stepModel) => ({
            model: stepModel,
            commands: [InvalidateDocument.make({})],
          }),
        ],
      ),
    FailedNarrateAgain: ({ episodeId, target, failure }) => {
      const nextModel: AppModel = {
        ...model,
        narrateAgainSubmits:
          model.screen._tag === "NarrateAgain" && model.screen.episodeId === episodeId
            ? Record.set(model.narrateAgainSubmits, episodeId, {
                target,
                isSubmitting: false,
                maybeError: Option.some(failure.message),
              })
            : Record.remove(model.narrateAgainSubmits, episodeId),
      }
      return failure.status === 409 || failure.status === 404 ? fetchEpisodes(nextModel) : { model: nextModel }
    },
    ClearedNarrateAgainError: ({ episodeId, target }) => {
      const existing = model.narrateAgainSubmits[episodeId]
      return existing !== undefined && !existing.isSubmitting && existing.target === target
        ? { model: { ...model, narrateAgainSubmits: Record.remove(model.narrateAgainSubmits, episodeId) } }
        : { model }
    },
    ClickedToggleReader: () => toggleReader(model),
} satisfies ScreenHandlers)
