import { Schema } from "effect"
import { Document } from "./document.ts"
import { ChangeVoice } from "./stale.ts"

/**
 * Body of `POST /api/episodes/:id/start`: the Document to narrate. It has only the chapters the user kept, with
 * their corrections, in playback order. Optional `voice` and `speed` apply a choice made in Review atomically with
 * queuing narration. Start selects those exact bytes when it queues narration.
 */
export const StartReview = Schema.Struct({
  document: Document,
  voice: Schema.optionalKey(ChangeVoice.fields.voice),
  speed: Schema.optionalKey(ChangeVoice.fields.speed),
})
export interface StartReview extends Schema.Schema.Type<typeof StartReview> {}

/**
 * Response of the worker's Document upload: what comes next for the job. `Narrate`: the worker goes on with this
 * job. `Review`: the job waits for its user and the lease is over, so the worker drops the job and claims the next.
 */
export const DocumentStored = Schema.Struct({ next: Schema.Literals(["Narrate", "Review"]) })
export interface DocumentStored extends Schema.Schema.Type<typeof DocumentStored> {}
