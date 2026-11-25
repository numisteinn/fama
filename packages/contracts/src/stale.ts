import { Schema } from "effect"
import { VoiceRef } from "./ids.ts"

/** The worker's SHA-256 of the inputs that made a chapter. The API stores and returns it unchanged. */
export const InputHash = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)))

export const NarratedChapter = Schema.Struct({
  index: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  inputHash: InputHash,
})

export const ChangeVoice = Schema.Struct({
  voice: VoiceRef.pipe(Schema.check(Schema.isPattern(/^[^:]+:.+$/))),
  speed: Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0))),
})
