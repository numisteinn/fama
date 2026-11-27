import { Schema } from "effect"

/** Which part of Narrate again a submit touches: the chapter text, or the voice and speed. */
export const NarrateAgainSubmitTarget = Schema.Literals(["text", "voice"])
export type NarrateAgainSubmitTarget = typeof NarrateAgainSubmitTarget.Type
