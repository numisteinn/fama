import {
  CreateEpisode,
  Episode,
  EpisodeList,
  FeedInfo,
  VoiceList,
  type EpisodeId,
  type VoiceRef,
} from "@fama/contracts"
import { Schema } from "effect"
import { apiOrigin, apiToken } from "~/settings"

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = apiToken.get()
  if (token) headers.set("Authorization", `Bearer ${token}`)
  let response: Response
  try {
    response = await fetch(apiOrigin.get() + path, { ...init, headers })
  } catch {
    throw new ApiError(0, "Can't reach the server")
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new ApiError(response.status, messageFor(response.status, text))
  }
  return response
}

function messageFor(status: number, body: string): string {
  if (status === 401) return "The API token is wrong or missing"
  if (status === 404) return "Not found"
  if (status === 413) return "The file is too large"
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error
    }
  } catch {
    // Not JSON.
  }
  return body.trim() || `Request failed (${status})`
}

async function json<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  path: string,
  init?: RequestInit,
): Promise<S["Type"]> {
  const response = await call(path, init)
  return Schema.decodeUnknownSync(schema)(await response.json())
}

const encodeCreate = Schema.encodeSync(CreateEpisode)

export const api = {
  episodes: async () => (await json(EpisodeList, "/api/episodes")).episodes,
  voices: async () => (await json(VoiceList, "/api/voices")).voices,
  feed: async () => (await json(FeedInfo, "/api/feed")).url,

  create: (input: CreateEpisode) =>
    json(Episode, "/api/episodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encodeCreate(input)),
    }),

  upload: (file: File, voice: VoiceRef | null, speed: number) => {
    const form = new FormData()
    form.set("file", file)
    if (voice) form.set("voice", voice)
    form.set("speed", String(speed))
    return json(Episode, "/api/episodes/upload", { method: "POST", body: form })
  },

  retry: (id: EpisodeId) =>
    json(Episode, `/api/episodes/${encodeURIComponent(id)}/retry`, { method: "POST" }),

  remove: async (id: EpisodeId) => {
    await call(`/api/episodes/${encodeURIComponent(id)}`, { method: "DELETE" })
  },
}
