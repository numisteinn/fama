import { Schema } from "effect"
import { VoiceRef } from "./ids.ts"

export const MissingVoicePreviews = Schema.Struct({ voiceIds: Schema.Array(VoiceRef) })
