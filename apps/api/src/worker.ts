import { env, waitUntil } from "cloudflare:workers"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import * as AccountRepo from "./account-repo.ts"
import { Bindings } from "./bindings.ts"
import * as EpisodeRepo from "./episode-repo.ts"
import { routes } from "./http.ts"
import * as MediaStore from "./media-store.ts"
import * as SampleRepo from "./sample-repo.ts"
import * as VoicePreviewRepo from "./voice-preview-repo.ts"
import * as Wake from "./wake.ts"

// Route handlers read these services per request, so the app layer must expose them.
const services = Layer.mergeAll(AccountRepo.layer, EpisodeRepo.layer, MediaStore.layer, SampleRepo.layer, VoicePreviewRepo.layer, Wake.layer({ waitUntil })).pipe(
  Layer.provideMerge(Layer.succeed(Bindings, env)),
)

const app = HttpRouter.toWebHandler(
  routes.pipe(Layer.provideMerge(services), Layer.provide(HttpServer.layerServices)),
  { disableLogger: true },
)

export default {
  fetch: (request) => app.handler(request),
} satisfies ExportedHandler<Env>
