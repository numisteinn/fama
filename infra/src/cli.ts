// `fama setup`: deploy one Fama stage to your Cloudflare account and make its user.
//
//   pnpm fama setup --stage <name> [--yes] [--adopt]      (from the repo root)
//
// Safe to rerun. Order: build the web app, deploy the stack (Alchemy applies the
// D1 migrations as part of it), make the one user if the database has none, and
// print what the phone app and the worker need. Tokens go to stdout once, in
// the run that makes the user. Nothing here writes a token to a file.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Alchemist from "alchemy/Alchemist"
import { AuthProvidersLive } from "alchemy/Auth/AuthProvider"
import * as SigilRenderer from "alchemy/Cli/SigilRenderer"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as CliError from "effect/cli/CliError"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import { randomToken } from "../../apps/api/src/secrets.ts"
import stack from "../alchemy.run.ts"
import { countUsers, createUser } from "./d1.ts"
import { stageProblem } from "./names.ts"
import { type CreatedUser, setupReport, userStep } from "./setup.ts"

const infraDir = fileURLToPath(new URL("..", import.meta.url))
const repoDir = fileURLToPath(new URL("../..", import.meta.url))

/** A failure the CLI prints as a plain message. */
const fail = (message: string) => Effect.fail(new CliError.UserError({ cause: message, userMessage: message }))

const LOGIN_HINT =
  "No Cloudflare credentials. Log in once with `pnpm --filter @fama/infra exec alchemy profile edit --add Cloudflare`, " +
  "or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."

const isTagged = (value: unknown, tag: string) =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === tag

const buildWeb = Effect.suspend(() => {
  console.log("Building the web app ...")
  const result = spawnSync("pnpm", ["--filter", "@fama/web", "build"], { cwd: repoDir, stdio: "inherit" })
  return result.status === 0 ? Effect.void : fail("The web build failed. See the output above.")
})

const deploy = (options: { readonly stage: string; readonly yes: boolean; readonly adopt: boolean }) =>
  Effect.gen(function* () {
    const { stage } = options
    const plan = yield* Alchemist.plan({ stack, operation: "deploy", stage, adopt: options.adopt }).pipe(
      SigilRenderer.planning({ operation: "Deploy", stage }),
    )
    if (Alchemist.hasChanges(plan) && !options.yes) {
      const approved = yield* SigilRenderer.approve(plan, { stage })
      if (!approved) return yield* fail("Deploy not approved. Nothing changed.")
    }
    return yield* Alchemist.apply(plan).pipe(SigilRenderer.apply(plan, { stage }))
  }).pipe(Effect.scoped)

const setup = Command.make(
  "setup",
  {
    stage: Flag.String("stage").pipe(
      Flag.withDescription("The deployment to create or update, for example `home`. Use the same name on every rerun."),
    ),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false), Flag.withDescription("Deploy without asking to approve the plan.")),
    adopt: Flag.Boolean("adopt").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Take over a Worker made outside Alchemy with the same name (first prod deploy only)."),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const problem = stageProblem(options.stage)
      if (problem !== undefined) return yield* fail(problem)
      // Alchemy resolves the stack's relative paths and `.env` from infra/.
      process.chdir(infraDir)

      yield* buildWeb
      const output = yield* deploy(options)
      const db = { accountId: output.accountId, databaseId: output.databaseId }

      let created: CreatedUser | undefined
      if (userStep(yield* countUsers(db)) === "create") {
        const user = { userId: crypto.randomUUID(), clientToken: randomToken(), feedToken: randomToken() }
        yield* createUser(db, user)
        created = { clientToken: user.clientToken, workerToken: Redacted.value(output.workerToken) }
      }
      console.log(`\n${setupReport({ stage: options.stage, serverUrl: output.url, created })}`)
    }).pipe(
      // Alchemy reports missing credentials as a defect. Turn that one into a plain message.
      Effect.catchDefect((defect) => (isTagged(defect, "CredentialsUnavailable") ? fail(LOGIN_HINT) : Effect.die(defect))),
      Effect.catchIf((error) => isTagged(error, "CredentialsRequired"), () => fail(LOGIN_HINT)),
      Effect.provide(Cloudflare.CloudflareApiLive().pipe(Layer.provideMerge(AuthProvidersLive))),
      Effect.provide([Alchemist.layer(), SigilRenderer.layer()]),
    ),
).pipe(Command.withDescription("Deploy Fama to your Cloudflare account, or update it. Safe to rerun."))

const fama = Command.make("fama").pipe(Command.withSubcommands([setup]))

Command.run(fama, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
