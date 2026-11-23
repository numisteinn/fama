// Plans the Fama stack with Alchemy's local providers and in-memory state.
// Needs no Cloudflare account and changes nothing. It proves the stack program
// builds and shows the resources a fresh stage gets.
//
//   node scripts/plan-offline.ts [stage]     (from infra/, default stage: offline)
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Alchemist from "alchemy/Alchemist"
import * as SigilRenderer from "alchemy/Cli/SigilRenderer"
import { inMemoryState } from "alchemy/State/InMemoryState"
import * as Effect from "effect/Effect"
import { famaProgram, STACK_NAME } from "../src/stack.ts"

const stage = process.argv[2] ?? "offline"
const stack = Alchemy.Stack(STACK_NAME, { providers: Cloudflare.providers(), state: inMemoryState() }, famaProgram)

const program = Effect.gen(function* () {
  const plan = yield* Alchemist.plan({ stack, operation: "deploy", stage, dev: true })
  yield* SigilRenderer.display(plan, { stage, detailed: true })
})

await Effect.runPromise(program.pipe(Effect.provide([Alchemist.layer(), SigilRenderer.layer()]), Effect.scoped))
