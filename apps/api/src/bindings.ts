import { Context } from "effect"

export class Bindings extends Context.Service<Bindings, Env>()("@fama/api/Bindings") {}
