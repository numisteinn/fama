import { Layer } from "effect"
import { Http, Runtime } from "foldkit"
import { AudioPlayer } from "~/audio"
import { flags } from "~/flags"
import { Message } from "~/message"
import { Flags, Model } from "~/model"
import { subscriptions } from "~/subscription"
import { init, update } from "~/update"
import { view } from "~/view"
import "~/index.css"

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  resources: Layer.mergeAll(AudioPlayer.layer, Http.layer),
  container: document.getElementById("root"),
  devTools: { Message, excludeFromHistory: ["UpdatedAudioTime"] },
})

Runtime.run(application, { flags })
