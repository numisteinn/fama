import { Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"

/** Bearer token for `/api/*`. Redacted, so DevTools and logs never show it. */
export const ApiToken = Schema.Redacted(Schema.String, { label: "API token", disallowJsonEncode: true })
export type ApiToken = typeof ApiToken.Type

/** Where requests go. An empty origin is the page's own origin, which is the production setup. */
export const Connection = Schema.Struct({ origin: Schema.String, token: ApiToken })
export type Connection = typeof Connection.Type

/** A request that did not work. Status 0 means no HTTP response. */
export const ApiFailure = Schema.Struct({ status: Schema.Number, message: Schema.String })
export type ApiFailure = typeof ApiFailure.Type

const unreachable: ApiFailure = { status: 0, message: "Can't reach the server" }
const undecodable: ApiFailure = { status: 0, message: "The server sent a response this app does not understand" }

export function messageFor(status: number, body: string): string {
  if (status === 401) return "The API token is wrong or missing"
  if (status === 404) return "Not found"
  if (status === 413) return "The file is too large"
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
      return parsed.message
    }
  } catch {
    // Not JSON.
  }
  return body.trim() || `Request failed (${status})`
}

/** Sends a request to the Fama API. Fails with an `ApiFailure` the user can read. */
export const send = (
  connection: Connection,
  method: "GET" | "POST" | "DELETE",
  path: string,
  withBody: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest = (request) =>
    request,
): Effect.Effect<HttpClientResponse.HttpClientResponse, ApiFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const token = Redacted.value(connection.token)
    const request = withBody(HttpClientRequest.make(method)(connection.origin + path))
    const response = yield* client
      .execute(token === "" ? request : HttpClientRequest.bearerToken(request, token))
      .pipe(Effect.mapError(() => unreachable))
    if (response.status >= 200 && response.status < 300) return response
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
    return yield* Effect.fail<ApiFailure>({ status: response.status, message: messageFor(response.status, body) })
  })

/** Sends a request and decodes the JSON body with `schema`. */
export const sendJson = <S extends Schema.Decoder<unknown>>(
  schema: S,
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  withBody?: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
): Effect.Effect<S["Type"], ApiFailure, HttpClient.HttpClient> =>
  send(connection, method, path, withBody).pipe(
    Effect.flatMap((response) =>
      response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError(() => undecodable),
      ),
    ),
  )

export const episodePath = (id: string) => `/api/episodes/${encodeURIComponent(id)}`
