import {
  CreateEpisode,
  Episode,
  EpisodeList,
  FeedInfo,
  VoiceList,
  type SourceInput,
  type Voice,
  type VoiceRef,
} from "@fama/contracts"
import { Schema } from "effect"

export type Connection = { readonly serverUrl: string; readonly token: string }

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
  }
}

export type PickedFile = { readonly uri: string; readonly name: string; readonly mimeType: string | null }

const TIMEOUT_MS = 20_000

function describe(status: number): string {
  if (status === 401 || status === 403) return "The API token was rejected."
  if (status === 404) return "Not found on the server."
  if (status >= 500) return `The server failed (${status}).`
  return `Request failed (${status}).`
}

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (trimmed === "") return ""
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export type Api = ReturnType<typeof createApi>

export function createApi(connection: Connection) {
  const base = normalizeServerUrl(connection.serverUrl)

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${connection.token}`, ...init.headers },
      })
      if (!response.ok) throw new ApiError(describe(response.status), response.status)
      return response
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(controller.signal.aborted ? "The server did not answer." : "Could not reach the server.", null)
    } finally {
      clearTimeout(timer)
    }
  }

  async function json<S extends Schema.ConstraintDecoder<unknown>>(schema: S, path: string, init?: RequestInit): Promise<S["Type"]> {
    const response = await send(path, init)
    const body: unknown = await response.json()
    try {
      return Schema.decodeUnknownSync(schema)(body)
    } catch {
      throw new ApiError("The server sent a response this app does not understand.", response.status)
    }
  }

  const jsonBody = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  return {
    mediaUrl: (path: string) => `${base}${path}`,
    listEpisodes: async (): Promise<ReadonlyArray<Episode>> => (await json(EpisodeList, "/api/episodes")).episodes,
    createEpisode: (source: SourceInput, voice: VoiceRef | null, speed: number): Promise<Episode> =>
      json(Episode, "/api/episodes", jsonBody(Schema.encodeSync(CreateEpisode)({ source, voice, speed }))),
    uploadEpisode: (file: PickedFile, voice: VoiceRef | null, speed: number): Promise<Episode> => {
      const form = new FormData()
      // React Native's FormData takes a { uri, name, type } object for files.
      form.append("file", { uri: file.uri, name: file.name, type: file.mimeType ?? "application/octet-stream" } as never)
      if (voice !== null) form.append("voice", voice)
      form.append("speed", String(speed))
      return json(Episode, "/api/episodes/upload", { method: "POST", body: form })
    },
    deleteEpisode: async (id: string): Promise<void> => {
      await send(`/api/episodes/${encodeURIComponent(id)}`, { method: "DELETE" })
    },
    retryEpisode: (id: string): Promise<Episode> =>
      json(Episode, `/api/episodes/${encodeURIComponent(id)}/retry`, { method: "POST" }),
    listVoices: async (): Promise<ReadonlyArray<Voice>> => (await json(VoiceList, "/api/voices")).voices,
    feedUrl: async (): Promise<string> => (await json(FeedInfo, "/api/feed")).url,
  }
}
