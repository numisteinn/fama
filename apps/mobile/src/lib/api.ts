import {
  ChangeVoice,
  CreateEpisode,
  Document,
  Episode,
  EpisodeList,
  EpisodeProgress,
  FeedInfo,
  Me,
  SampleList,
  SamplesRequest,
  VoiceList,
  type Sample,
  type SourceInput,
  type Voice,
  type VoiceRef,
} from "@fama/contracts"
import { Schema } from "effect"
import { File } from "expo-file-system"
import { submitLink } from "./fetchPage"

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
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  // A dev server on the LAN speaks plain HTTP; anything else is assumed to be behind TLS.
  const local = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[^/:]+\.local)(:\d+)?$/i.test(trimmed)
  return `${local ? "http" : "https"}://${trimmed}`
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

  const upload = (form: FormData, voice: VoiceRef | null, speed: number, review: boolean): Promise<Episode> => {
    if (voice !== null) form.append("voice", voice)
    form.append("review", String(review))
    form.append("speed", String(speed))
    return json(Episode, "/api/episodes/upload", { method: "POST", body: form })
  }

  return {
    mediaUrl: (path: string) => `${base}${path}`,
    me: (): Promise<Me> => json(Me, "/api/me"),
    listEpisodes: async (): Promise<ReadonlyArray<Episode>> => (await json(EpisodeList, "/api/episodes")).episodes,
    changeVoice: async (id: string, voice: VoiceRef, speed: number): Promise<void> => {
      await send(`/api/episodes/${encodeURIComponent(id)}/voice`, {
        ...jsonBody(Schema.encodeSync(ChangeVoice)({ voice, speed })),
        method: "PUT",
      })
    },
    createEpisode: (source: SourceInput, voice: VoiceRef | null, speed: number, review = false): Promise<Episode> => {
      const create = () => json(Episode, "/api/episodes", jsonBody(Schema.encodeSync(CreateEpisode)({ source, voice, speed, review })))
      if (source._tag !== "Url") return create()
      return submitLink(source.url, create, ({ url, part }) => {
        const form = new FormData()
        form.append("url", url)
        form.append("file", part as never)
        return upload(form, voice, speed, review)
      })
    },
    uploadEpisode: (file: PickedFile, voice: VoiceRef | null, speed: number, review = false): Promise<Episode> => {
      const form = new FormData()
      // Expo's fetch sends a file part that has `bytes()`. It refuses React Native's `{ uri }` part.
      const part = { name: file.name, type: file.mimeType ?? "application/octet-stream", bytes: () => new File(file.uri).bytes() }
      form.append("file", part as never)
      return upload(form, voice, speed, review)
    },
    document: (id: string): Promise<Document> => json(Document, `/api/episodes/${encodeURIComponent(id)}/document`),
    saveDocument: async (id: string, document: Document): Promise<void> => {
      await send(`/api/episodes/${encodeURIComponent(id)}/document`, { ...jsonBody(document), method: "PUT" })
    },
    requestSamples: (id: string, voices: ReadonlyArray<Sample["voice"]> | null): Promise<ReadonlyArray<Sample>> =>
      json(SampleList, `/api/episodes/${encodeURIComponent(id)}/samples`, jsonBody(Schema.encodeSync(SamplesRequest)({ voices }))).then((list) => list.samples),
    samples: async (id: string): Promise<ReadonlyArray<Sample>> => (await json(SampleList, `/api/episodes/${encodeURIComponent(id)}/samples`)).samples,
    start: (id: string, document: Document, voice: VoiceRef | null = null): Promise<Episode> =>
      json(Episode, `/api/episodes/${encodeURIComponent(id)}/start`, jsonBody(voice === null ? { document } : { document, voice })),
    deleteEpisode: async (id: string): Promise<void> => {
      await send(`/api/episodes/${encodeURIComponent(id)}`, { method: "DELETE" })
    },
    retryEpisode: (id: string): Promise<Episode> =>
      json(Episode, `/api/episodes/${encodeURIComponent(id)}/retry`, { method: "POST" }),
    putProgress: (id: string, progress: EpisodeProgress): Promise<EpisodeProgress> =>
      json(EpisodeProgress, `/api/episodes/${encodeURIComponent(id)}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Schema.encodeSync(EpisodeProgress)(progress)),
      }),
    listVoices: async (): Promise<ReadonlyArray<Voice>> => (await json(VoiceList, "/api/voices")).voices,
    feedUrl: async (): Promise<string> => (await json(FeedInfo, "/api/feed")).url,
  }
}
