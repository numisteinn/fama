/**
 * Cloudflare resource names for one deployment stage.
 *
 * The `prod` stage keeps the names of the deployment that predates Alchemy, so
 * Alchemy adopts it in place. Every other stage gets names that carry the stage,
 * so two stages in one account never share (and silently adopt) a database or bucket.
 */
export interface ResourceNames {
  readonly worker: string
  readonly database: string
  readonly bucket: string
}

export const PROD_STAGE = "prod"

const STAGE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_STAGE_LENGTH = 40

/** Why a stage name is not usable, or `undefined` when it is. */
export const stageProblem = (stage: string): string | undefined => {
  if (stage.length === 0) return "The stage name is empty."
  if (stage.length > MAX_STAGE_LENGTH) return `The stage name is longer than ${MAX_STAGE_LENGTH} characters.`
  if (!STAGE_PATTERN.test(stage))
    return "Use lowercase letters, digits and single hyphens for the stage name, for example `home`."
  return undefined
}

export const isProd = (stage: string) => stage === PROD_STAGE

export const resourceNames = (stage: string): ResourceNames => {
  const problem = stageProblem(stage)
  if (problem !== undefined) throw new Error(`Bad stage "${stage}": ${problem}`)
  return isProd(stage)
    ? { worker: "fama", database: "fama", bucket: "fama-media" }
    : { worker: `fama-${stage}`, database: `fama-${stage}`, bucket: `fama-${stage}-media` }
}
