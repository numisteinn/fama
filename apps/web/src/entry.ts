import { DevTools } from "@effect/ui-devtools"
import { BrowserHost } from "@effect/ui/html"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { App } from "~/App"
import { AudioPlayer } from "~/audio"
import { flags } from "~/flags"
import { FamaApi, FamaConnection } from "~/services"
import "~/index.css"

const initialFlags = Effect.runSync(flags)
const initialConnection = { origin: initialFlags.origin, token: initialFlags.token }

const appServices = Layer.mergeAll(
  FamaApi.layer.pipe(
    Layer.provideMerge(FamaConnection.layer(initialConnection)),
    Layer.provideMerge(FetchHttpClient.layer),
  ),
  AudioPlayer.layer,
)

const Main = BrowserHost.mount(App, initialFlags, document.getElementById("root")!).pipe(
  Layer.provide(appServices),
  Layer.provide(
    import.meta.env.DEV
      ? DevTools.layer({ position: "BottomRight", exclude: ["UpdatedAudioTime"] })
      : Layer.empty,
  ),
)

Effect.runFork(Layer.launch(Main))
