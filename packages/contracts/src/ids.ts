import { Schema } from "effect"

export const EpisodeId = Schema.String.pipe(Schema.brand("EpisodeId"))
export type EpisodeId = typeof EpisodeId.Type

export const WorkerId = Schema.String.pipe(Schema.brand("WorkerId"))
export type WorkerId = typeof WorkerId.Type

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

/** The secret `claim` hands out for one attempt at a job or a Sample. Every route of that work needs it. */
export const LeaseToken = Schema.String.pipe(Schema.brand("LeaseToken"))
export type LeaseToken = typeof LeaseToken.Type

/** `engine:voiceId`, for example `kokoro:af_heart` or `piper:is_IS-salka-medium`. */
export const VoiceRef = Schema.String.pipe(Schema.brand("VoiceRef"))
export type VoiceRef = typeof VoiceRef.Type
