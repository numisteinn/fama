// The Fama stack: one Worker (API, feed, media and the web build as static
// assets), one D1 database, one R2 bucket, and the Worker's secrets.
//
// One stage is one deployment. `fama setup --stage <name>` deploys it. The
// `prod` stage keeps the fixed names of the deployment made before Alchemy and
// protects every resource from replacement and deletion (see src/names.ts).
//
// State lives in a Cloudflare state store in the same account
// (`Cloudflare.state()`), encrypted at rest. So the worker token, which is an
// `Alchemy.Random`, stays stable across reruns and never lands in a local file.
//
// Run Alchemy from `infra/`: the paths in src/worker-config.ts are relative to it.
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import { famaProgram, STACK_NAME } from "./src/stack.ts"

export default Alchemy.Stack(
  STACK_NAME,
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  famaProgram,
)
