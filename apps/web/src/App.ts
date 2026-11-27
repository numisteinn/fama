import { Component } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Layer, Option } from "effect"
import { audioCommandsLayer } from "~/core/audio"
import { appCommandsLayer } from "~/command"
import { SettingsDialog } from "~/components/SettingsDialog"
import { Flags } from "~/core/flags"
import { hasText } from "~/core/timeline"
import { languageName, sortedVoices } from "~/core/voices"
import { AppMessage } from "~/message"
import { AppModel, Screen, current, episodes, toDraft } from "~/model"
import { NarrateAgainScreen } from "~/narrate-again/NarrateAgainScreen"
import { RATES, SKIP_BACK_MS, SKIP_FORWARD_MS, isPlayPending } from "~/playback/model"
import { ReaderScreen } from "~/reader/ReaderScreen"
import { ReviewScreen } from "~/review/ReviewScreen"
import { appSubscriptions } from "~/subscription"
import { initApp, updateApp } from "~/update"
import { AddBar, AddBarEvents } from "~/view/addBar"
import { Library, LibraryEvents } from "~/view/library"
import { PlayerBar, PlayerBarEvents } from "~/view/playerBar"

/**
 * Root application component without provided command layers, so unit tests can resolve or stub
 * individual Commands and Queries without HTTP or browser audio.
 */
export const AppComponent = Html.component({
  name: "App",
  props: Flags,
  model: AppModel,
  message: AppMessage,
}).make({
  init: ($) => {
    const initial = initApp($.props)
    return $.set(initial.model).run(...initial.commands)
  },
  update: ($, message) => {
    const next = updateApp($.model, message)
    return $.set(next.model).run(...next.commands)
  },
  subscriptions: appSubscriptions,
  view: (h, model) => {
    const activeLoaded = current(model)
    const isMainPlaying = model.playback._tag === "Loaded" && model.playback.isPlaying
    const isReaderOpen = Option.isSome(model.maybeReaderEpisodeId)

    const reviewContent =
      model.screen._tag === "Review"
        ? (() => {
            const { episodeId, openId } = model.screen
            const episode = episodes(model).find((item) => item.id === episodeId)
            if (!episode) return null
            const reviewSave = Option.fromNullishOr(model.reviewSaves[episodeId])
            const reviewVoice = Option.fromNullishOr(model.reviewVoices[episodeId])
            const reviewStart = Option.fromNullishOr(model.reviewStarts[episodeId])
            const maybeActionError = Option.orElse(
              Option.flatMap(reviewSave, (state) => state.maybeError),
              () => Option.flatMap(reviewStart, (state) => state.maybeError),
            )
            return h.div.class(isReaderOpen ? "hidden" : "contents").children(
              ReviewScreen(h, {
                key: `${episodeId}-${openId}`,
                props: {
                  episodeId,
                  openId,
                  episodeTitle: episode.title,
                  origin: model.connection.origin,
                  connectionGeneration: model.connectionGeneration,
                  speed: episode.speed,
                  initialVoice: Option.match(reviewVoice, {
                    onNone: () => episode.voice,
                    onSome: (state) => state.voice,
                  }),
                  maybePendingVoice: Option.map(reviewVoice, (state) => state.voice),
                  voices: model.voices,
                  isMainPlaying,
                  isSaving: Option.exists(reviewSave, (state) => state.isSaving),
                  isStarting: Option.exists(reviewStart, (state) => state.isStarting),
                  isSavingVoice: Option.exists(reviewVoice, (state) => state.isSaving),
                  maybePendingDocument: Option.flatMap(reviewSave, (state) => state.maybePendingDocument),
                  maybeSavedDocument: Option.flatMap(reviewSave, (state) => state.maybeSavedDocument),
                  maybeActionError,
                  maybeVoiceError: Option.flatMap(reviewVoice, (state) => state.maybeError),
                },
                onEmit: {
                  Closed: () => AppMessage.ClosedSubScreen(),
                  SubmittedSave: ({ episodeId: id, document }) =>
                    AppMessage.SubmittedSaveReview({ episodeId: id, document }),
                  SubmittedStart: ({ episodeId: id, document, voice }) =>
                    AppMessage.SubmittedStartReview({
                      episodeId: id,
                      document,
                      ...(voice !== undefined ? { voice } : {}),
                    }),
                  ClearedActionError: () => AppMessage.ClearedReviewError({ episodeId }),
                  RequestedChangeVoice: ({ episodeId: id, voice, speed }) =>
                    AppMessage.RequestedChangeReviewVoice({ episodeId: id, voice, speed }),
                  RequestedPauseMainPlayback: () => AppMessage.RequestedPauseMainPlayback(),
                },
              }),
            )
          })()
        : null

    const readerContent = Option.match(model.maybeReaderEpisodeId, {
      onNone: () => null,
      onSome: (episodeId) => {
        if (Option.isNone(activeLoaded) || activeLoaded.value.episode.id !== episodeId) return null
        const { playback, episode } = activeLoaded.value
        return ReaderScreen(h, {
          key: episodeId,
          props: {
            episode,
            origin: model.connection.origin,
            chapter: playback.chapter,
            offsetMs: playback.offsetMs,
            isPlaying: playback.isPlaying,
          },
          onEmit: {
            PlayFrom: ({ positionMs }) => AppMessage.RequestedPlayFromReader({ positionMs }),
            UpdatedAudioTime: ({ offsetMs, atMs }) => AppMessage.UpdatedAudioTime({ offsetMs, atMs }),
          },
        })
      },
    })

    const selectedVoice = Option.flatMap(model.maybeVoice, (id) =>
      Option.fromNullishOr(model.voices.find((voice) => voice.id === id)),
    )
    const voiceName = Option.match(selectedVoice, { onNone: () => "Auto", onSome: (voice) => voice.name })
    const voiceOptions = [
      { value: "", name: "Auto" },
      ...sortedVoices(model.voices).map((voice) => ({
        value: voice.id,
        name: voice.name,
        group: languageName(voice.language),
      })),
    ]

    const visibleNonReview = isReaderOpen
      ? null
      : Screen.match(model.screen, {
          Library: () => [
            ...AddBar(
              {
                addText: model.addText,
                batch: model.batch,
                isAdding: model.isAdding,
                maybeAddError: model.maybeAddError,
                isReviewOn: model.isReviewOn,
                isDragging: model.fileDragDepth > 0,
                canSubmit: toDraft(model)._tag !== "Empty",
                speed: model.speed,
                voiceName,
                selectedVoiceId: Option.getOrElse(Option.map(selectedVoice, (voice) => voice.id), () => ""),
                voiceOptions,
              },
              h,
              (event) =>
                AddBarEvents.match(event, {
                  UpdatedText: ({ value }) => AppMessage.UpdatedAddText({ value }),
                  PressedEnter: () => AppMessage.PressedEnterInAddText(),
                  Submitted: () => AppMessage.SubmittedAddForm(),
                  ToggledReview: ({ checked }) => AppMessage.ToggledAddReview({ checked }),
                  ChangedFiles: ({ files }) => AppMessage.ChangedFileInput({ files }),
                  RemovedFile: ({ key }) => AppMessage.ClickedRemoveFile({ key }),
                  RetriedFile: ({ key }) => AppMessage.ClickedRetryFile({ key }),
                  PickedVoice: ({ value }) => AppMessage.PickedVoice({ value }),
                  PickedVoiceSpeed: ({ value }) => AppMessage.PickedVoiceSpeed({ value }),
                }),
            ),
            h.section
              .class("mt-6")
              .children(
                Library(
                  {
                    episodes: model.maybeEpisodes,
                    maybeLibraryFailure: model.maybeLibraryFailure,
                    currentEpisodeId: Option.map(activeLoaded, ({ playback }) => playback.episodeId),
                    isCurrentPlaying: isMainPlaying,
                    rowErrors: model.rowErrors,
                    armedDeletes: model.armedDeletes,
                    origin: model.connection.origin,
                  },
                  h,
                  (event) =>
                    LibraryEvents.match(event, {
                      ClickedTryAgain: () => AppMessage.ClickedTryAgain(),
                      Played: ({ episodeId }) => AppMessage.ClickedPlayEpisode({ episodeId }),
                      OpenedReview: ({ episodeId }) => AppMessage.ClickedOpenReview({ episodeId }),
                      OpenedNarrateAgain: ({ episodeId }) => AppMessage.ClickedOpenNarrateAgain({ episodeId }),
                      Retried: ({ episodeId }) => AppMessage.ClickedRetry({ episodeId }),
                      ArmedDelete: ({ episodeId }) => AppMessage.ClickedArmDelete({ episodeId }),
                      ConfirmedDelete: ({ episodeId }) => AppMessage.ClickedConfirmDelete({ episodeId }),
                    }),
                ),
              ),
          ],
          Review: () => null,
          NarrateAgain: ({ episodeId, openId }) => {
            const episode = episodes(model).find((item) => item.id === episodeId)
            if (!episode) return null
            const submit = Option.fromNullishOr(model.narrateAgainSubmits[episodeId])
            return NarrateAgainScreen(h, {
              key: `${episodeId}-${openId}`,
              props: {
                episodeId,
                openId,
                episodeTitle: episode.title,
                origin: model.connection.origin,
                initialVoice: episode.voice,
                initialSpeed: episode.speed,
                voices: model.voices,
                submittingTarget: Option.flatMap(submit, (state) =>
                  state.isSubmitting ? Option.some(state.target) : Option.none(),
                ),
                maybeSubmitError: Option.flatMap(submit, (state) =>
                  Option.map(state.maybeError, (message) => ({ target: state.target, message })),
                ),
              },
              onEmit: {
                Closed: () => AppMessage.ClosedSubScreen(),
                SubmittedNarrateText: ({ episodeId: id, document }) =>
                  AppMessage.SubmittedNarrateAgainText({ episodeId: id, document }),
                SubmittedChangeVoice: ({ episodeId: id, input }) =>
                  AppMessage.SubmittedNarrateAgainVoice({ episodeId: id, input }),
                ClearedSubmitError: ({ target }) => AppMessage.ClearedNarrateAgainError({ episodeId, target }),
              },
            })
          },
        })

    const playerBar = Option.match(activeLoaded, {
      onNone: () => null,
      onSome: ({ playback, episode }) =>
        PlayerBar(
          {
            playback,
            episode,
            rate: model.rate,
            rates: RATES,
            skipBackMs: SKIP_BACK_MS,
            skipForwardMs: SKIP_FORWARD_MS,
            isReaderOpen: Option.contains(model.maybeReaderEpisodeId, episode.id),
            isPending: isPlayPending(model.maybePendingPlay, episode.id),
            hasText: hasText(episode),
            maybeScrubMs: model.maybeScrubMs,
            origin: model.connection.origin,
          },
          h,
          (event) =>
            PlayerBarEvents.match(event, {
              PickedPlaybackSpeed: ({ value }) => AppMessage.PickedPlaybackSpeed({ value }),
              PickedChapter: ({ value }) => AppMessage.PickedChapter({ value }),
              ToggledReader: () => AppMessage.ClickedToggleReader(),
              ClickedPlayPause: () => AppMessage.ClickedPlayPause(),
              ClickedSkip: ({ deltaMs }) => AppMessage.ClickedSkip({ deltaMs }),
              UpdatedScrub: ({ value }) => AppMessage.UpdatedScrub({ value }),
              CommittedScrub: ({ value }) => AppMessage.CommittedScrub({ value }),
            }),
        ),
    })

    return h.div.children(
      h.main
        .class("mx-auto w-full max-w-2xl px-4 pt-[env(safe-area-inset-top)] sm:px-6")
        .style({ paddingBottom: Option.isSome(activeLoaded) ? "11rem" : "3rem" })
        .children(
          h.header.class("flex h-14 items-center justify-between").children(
            h.span.class("flex items-center").children(
              h.img.attrs({ src: "/lockup-dark.svg", alt: "Fama" }).class("logo-dark h-7 w-auto"),
              h.img.attrs({ src: "/lockup-light.svg", alt: "Fama" }).class("logo-light h-7 w-auto"),
            ),
            SettingsDialog(h, {
              props: {
                open: model.isSettingsOpen,
                openId: model.settingsOpens,
                connection: model.connection,
                connectionGeneration: model.connectionGeneration,
              },
              onEmit: {
                RequestedOpen: () => AppMessage.RequestedOpenSettings(),
                RequestedClose: () => AppMessage.RequestedCloseSettings(),
                Saved: ({ connection }) => AppMessage.SavedSettings({ connection }),
              },
            }),
          ),
          reviewContent,
          readerContent,
          visibleNonReview,
        ),
      playerBar,
    )
  },
})

export const App = AppComponent.pipe(
  Component.provide(Layer.mergeAll(appCommandsLayer, audioCommandsLayer)),
)
