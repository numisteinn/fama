import { Document, SampleFailRequest, SampleQuery, SampleVoice, SamplesRequest } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { EpisodeRepo } from "../episode-repo.ts"
import { keys, MediaStore } from "../media-store.ts"
import { SampleRepo } from "../sample-repo.ts"
import { Wake } from "../wake.ts"
import { stored } from "./document.ts"
import { api, BadRequest, IdParams, json, noContent, NotStored, uploadRequest, webRequest, worker } from "./kit.ts"

const Params = Schema.Struct({ ...IdParams.fields, ...SampleQuery.fields })
const decodeVoice = Schema.decodeUnknownResult(SampleVoice)
const languageOf = (language: string) => language.toLowerCase().split(/[-_]/)[0]

const samples = "/api/episodes/:id/samples"
const work = "/api/worker/samples/:id"

export const sampleRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", samples, api(({ userId }) => Effect.gen(function* () {
    const { id } = yield* HttpRouter.schemaPathParams(IdParams)
    yield* (yield* EpisodeRepo).get(userId, id)
    return json({ samples: yield* (yield* SampleRepo).list(userId, id) })
  }))),
  HttpRouter.route("POST", samples, api(({ userId }) => Effect.gen(function* () {
    const { id } = yield* HttpRouter.schemaPathParams(IdParams)
    const episodes = yield* EpisodeRepo
    yield* episodes.get(userId, id)
    const request = yield* webRequest
    const body = request.body === null ? { voices: null } : yield* HttpServerRequest.schemaBodyJson(SamplesRequest)
    const object = yield* (yield* MediaStore).get(keys.document(userId, id), null)
    if (object === null) return yield* new NotStored({ message: "This episode has no Document." })
    const raw = yield* Effect.tryPromise(() => object.json())
    const document = yield* Schema.decodeUnknownEffect(Document)(raw)
    const known = (yield* episodes.voices)
      .filter((voice) => languageOf(voice.language) === languageOf(document.language))
      .map((voice) => voice.id)
      .filter((voice) => decodeVoice(voice)._tag === "Success")
    const voices = body.voices === null ? known : [...new Set(body.voices)]
    if (voices.some((voice) => !known.includes(voice))) {
      return yield* new BadRequest({ message: "Choose voices registered for the Document's language." })
    }
    const repo = yield* SampleRepo
    if ((yield* repo.request(userId, id, voices)) > 0) yield* (yield* Wake).wake
    return json({ samples: yield* repo.list(userId, id) })
  }))),
  HttpRouter.route("GET", `${work}/document`, worker(Effect.gen(function* () {
    const { id, voice, leaseToken } = yield* HttpRouter.schemaParams(Params)
    const { userId } = yield* (yield* SampleRepo).holdLease(id, voice, leaseToken)
    return yield* stored(keys.document(userId, id), "Document")
  }))),
  HttpRouter.route("PUT", `${work}/clip`, worker(Effect.gen(function* () {
    const { id, voice, leaseToken } = yield* HttpRouter.schemaParams(Params)
    const repo = yield* SampleRepo
    const { userId, ready } = yield* repo.holdLease(id, voice, leaseToken)
    if (ready) return noContent
    const { body } = yield* uploadRequest
    const store = yield* MediaStore
    const key = keys.sample(userId, id, voice)
    yield* store.putSample(key, body)
    const episodes = yield* EpisodeRepo
    yield* repo.ready(id, voice, leaseToken).pipe(
      Effect.tapErrorTag("LeaseLost", () =>
        Effect.catchTag(episodes.get(userId, id), "EpisodeNotFound", () => store.deleteSample(key))),
    )
    return noContent
  }))),
  HttpRouter.route("POST", `${work}/fail`, worker(Effect.gen(function* () {
    const { id } = yield* HttpRouter.schemaPathParams(IdParams)
    const { voice, leaseToken, reason } = yield* HttpServerRequest.schemaBodyJson(SampleFailRequest)
    yield* (yield* SampleRepo).fail(id, voice, leaseToken, reason)
    return noContent
  }))),
])
