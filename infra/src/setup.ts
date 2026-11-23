// The pure parts of `fama setup`: the rerun decision and what it prints.
import { connectQr } from "./connect.ts"

/** A DIY server has exactly one user (D1). Setup makes it only on a server with none. */
export type UserStep = "create" | "exists"

export const userStep = (userCount: number): UserStep => (userCount === 0 ? "create" : "exists")

/** Tokens exist only in the run that creates the user. */
export interface CreatedUser {
  readonly clientToken: string
  readonly workerToken: string
}

export const workerCommand = (serverUrl: string, workerToken: string) =>
  `cd worker && uv run fama work --api ${serverUrl} --token ${workerToken}`

export const setupReport = (input: {
  readonly stage: string
  readonly serverUrl: string
  readonly created: CreatedUser | undefined
}): string => {
  const { stage, serverUrl, created } = input
  if (created === undefined) {
    return [
      `Stage ${stage} is up to date.`,
      "",
      `Server:  ${serverUrl}`,
      "",
      "The user exists, so no token is printed. Tokens are printed once, when setup creates the user.",
      "",
      "Start a worker with the worker token from that first run:",
      `  ${workerCommand(serverUrl, "<FAMA_WORKER_TOKEN>")}`,
    ].join("\n")
  }
  return [
    `Stage ${stage} is ready. Copy the tokens now: they are not shown again.`,
    "",
    `Server:        ${serverUrl}`,
    `Client token:  ${created.clientToken}`,
    `Worker token:  ${created.workerToken}`,
    "",
    "Start a worker:",
    `  ${workerCommand(serverUrl, created.workerToken)}`,
    "",
    "Scan with the iPhone camera to connect the app:",
    "",
    connectQr(serverUrl, created.clientToken),
  ].join("\n")
}
