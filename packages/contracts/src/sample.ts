import { Effect, Schema } from "effect"
import { EpisodeId, LeaseToken, VoiceRef } from "./ids.ts"

/**
 * A voice that can have a Sample: `engine:voiceId`, each part of letters, digits, `_` and `-`. The voice is the
 * file name of the clip in storage and in its URL, so no other character gets in.
 */
export const SampleVoice = VoiceRef.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)))

export const SampleState = Schema.TaggedUnion({
  /** Asked for. A worker makes the clip. */
  Requested: {},
  /** `url` is the media path of the clip (AAC `.m4a`). */
  Ready: { url: Schema.String },
  Failed: { reason: Schema.String },
})
export type SampleState = typeof SampleState.Type

/**
 * One voice reading the start of the Document of one episode, so the user can choose a voice by ear. An episode has
 * at most one Sample for each voice, and all of them read the same text.
 */
export const Sample = Schema.Struct({ voice: SampleVoice, state: SampleState })
export interface Sample extends Schema.Schema.Type<typeof Sample> {}

export const SampleList = Schema.Struct({ samples: Schema.Array(Sample) })

/** The most voices one request can name. */
export const MAX_SAMPLE_VOICES = 64

/**
 * Body of `POST /api/episodes/:id/samples`. `voices` is `null` or left out for the default: each known voice of the
 * Document's language.
 */
export const SamplesRequest = Schema.Struct({
  voices: Schema.NullOr(Schema.Array(SampleVoice).pipe(Schema.check(Schema.isMaxLength(MAX_SAMPLE_VOICES)))).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
})
export interface SamplesRequest extends Schema.Schema.Type<typeof SamplesRequest> {}

// Worker API

/** One Sample a worker claimed. It makes the clip from the stored Document, with the episode's speed. */
export const ClaimedSample = Schema.Struct({
  episodeId: EpisodeId,
  voice: SampleVoice,
  leaseToken: LeaseToken,
  /** API path to GET the stored Document. */
  documentPath: Schema.String,
  speed: Schema.Number,
})
export interface ClaimedSample extends Schema.Schema.Type<typeof ClaimedSample> {}

/** Query of the Sample routes of a worker: `GET .../document` and `PUT .../clip`. */
export const SampleQuery = Schema.Struct({ voice: SampleVoice, leaseToken: LeaseToken })

export const SampleFailRequest = Schema.Struct({ voice: SampleVoice, leaseToken: LeaseToken, reason: Schema.String })

/**
 * A claimed Sample that is not ready after this time can be claimed by another worker. A Sample has no heartbeat:
 * a clip takes seconds to make.
 */
export const SAMPLE_LEASE_MS = 2 * 60 * 1000
