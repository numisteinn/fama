import { Schema } from "effect"
import { Document } from "./document.ts"

/**
 * Body of `POST /api/episodes/:id/start`: the Document to narrate. It has only the chapters the user kept, with
 * their corrections, in playback order. Start selects those exact bytes when it queues narration.
 */
export const StartReview = Schema.Struct({ document: Document })
export interface StartReview extends Schema.Schema.Type<typeof StartReview> {}

/**
 * Response of the worker's Document upload: what comes next for the job. `Narrate`: the worker goes on with this
 * job. `Review`: the job waits for its user and the lease is over, so the worker drops the job and claims the next.
 */
export const DocumentStored = Schema.Struct({ next: Schema.Literals(["Narrate", "Review"]) })
export interface DocumentStored extends Schema.Schema.Type<typeof DocumentStored> {}
