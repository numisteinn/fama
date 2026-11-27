import { Context, Effect, Layer } from "effect"
import { HttpClient, type HttpClientRequest, type HttpClientResponse } from "effect/http"
import type * as Schema from "effect/Schema"
import { type ApiFailure, type Connection, apiToken, send, sendJson } from "~/core/api"

/**
 * Holds the active API connection in memory so `Query.Service` fetchers read the live
 * `Redacted` bearer token without placing secrets inside JSON-encoded query cache keys.
 */
export interface FamaConnectionShape {
  readonly get: () => Connection
  readonly set: (connection: Connection) => void
}

export class FamaConnection extends Context.Service<FamaConnection, FamaConnectionShape>()(
  "fama/web/FamaConnection",
) {
  static readonly make = (initial: Connection): FamaConnectionShape => {
    let current = initial
    return {
      get: () => current,
      set: (next) => {
        current = next
      },
    }
  }

  static readonly layer = (initial: Connection = { origin: "", token: apiToken("") }) =>
    Layer.sync(FamaConnection, () => FamaConnection.make(initial))
}

export interface FamaApiShape {
  readonly send: (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    withBody?: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
    isKeepalive?: boolean,
    overrideConnection?: Connection,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, ApiFailure>
  readonly sendJson: <S extends Schema.Decoder<unknown>>(
    schema: S,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    withBody?: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
    overrideConnection?: Connection,
  ) => Effect.Effect<S["Type"], ApiFailure>
}

export class FamaApi extends Context.Service<FamaApi, FamaApiShape>()("fama/web/FamaApi") {
  static readonly layer = Layer.effect(
    FamaApi,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const connection = yield* FamaConnection
      return {
        send: (method, path, withBody, isKeepalive, overrideConnection) =>
          send(overrideConnection ?? connection.get(), method, path, withBody, isKeepalive).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          ),
        sendJson: (schema, method, path, withBody, overrideConnection) =>
          sendJson(schema, overrideConnection ?? connection.get(), method, path, { withBody }).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          ),
      }
    }),
  )
}
