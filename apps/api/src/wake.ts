import { Context, Effect, Layer } from "effect"
import { Bindings } from "./bindings.ts"

/** How long one wake call may take before it is dropped. */
export const WAKE_TIMEOUT_MS = 5000

/**
 * Wakes the cloud worker after a job becomes `Queued` (D5). The call runs after the response, through `waitUntil`.
 * With no `WORKER_WAKE_URL` it does nothing. A failed or slow wake is logged and never fails the request.
 */
export class Wake extends Context.Service<Wake, { readonly wake: Effect.Effect<void> }>()("@fama/api/Wake") {}

export interface WakeOptions {
  /** Keeps the request alive until the wake settles. `waitUntil` from `cloudflare:workers` in the Worker. */
  readonly waitUntil: (promise: Promise<unknown>) => void
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

/** One POST to the wake URL. Never fails: errors, timeouts and non-2xx answers are logged without the secret. */
const send = (url: string, secret: string, fetchFn: typeof fetch, timeoutMs: number) =>
  Effect.tryPromise({
    try: () =>
      fetchFn(url, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(timeoutMs),
      }),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((response) => {
      void response.body?.cancel()
      return response.ok ? Effect.void : Effect.logWarning(`worker wake answered ${response.status}`)
    }),
    Effect.catch((error) =>
      Effect.logWarning(`worker wake failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`),
    ),
  )

export const layer = (options: WakeOptions) =>
  Layer.effect(
    Wake,
    Effect.gen(function* () {
      const env = yield* Bindings
      const fetchFn = options.fetch ?? fetch
      const timeoutMs = options.timeoutMs ?? WAKE_TIMEOUT_MS
      return {
        wake: Effect.suspend(() => {
          const url = env.WORKER_WAKE_URL
          const secret = env.WORKER_WAKE_SECRET
          if (url === undefined || url === "") return Effect.void
          if (secret === undefined || secret === "") return Effect.logWarning("WORKER_WAKE_URL is set without WORKER_WAKE_SECRET")
          return Effect.sync(() => options.waitUntil(Effect.runPromise(send(url, secret, fetchFn, timeoutMs)))).pipe(
            Effect.catchDefect((defect) => Effect.logWarning(`worker wake not scheduled: ${String(defect)}`)),
          )
        }),
      }
    }),
  )
