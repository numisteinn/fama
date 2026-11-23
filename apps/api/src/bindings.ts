import { Context } from "effect"

declare global {
  // Optional secrets that `wrangler types` cannot see. Both or neither (infra/src/stack.ts).
  interface OptionalBindings {
    /** The cloud worker's wake endpoint (D5). Unset: no wake call. */
    readonly WORKER_WAKE_URL?: string
    /** Sent as `Authorization: Bearer <secret>` on the wake call. */
    readonly WORKER_WAKE_SECRET?: string
  }
  interface Env extends OptionalBindings {}
  namespace Cloudflare {
    interface Env extends OptionalBindings {}
  }
}

export class Bindings extends Context.Service<Bindings, Env>()("@fama/api/Bindings") {}
