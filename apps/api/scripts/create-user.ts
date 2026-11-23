// Creates a user with a client token and a feed token, and prints them once as JSON.
//
//   node scripts/create-user.ts [options] [-- <wrangler d1 execute flags>]
//
//   --user-id <id>        default: a random UUID
//   --client-token <t>    default: 32 random bytes, base64url
//   --feed-token <t>      default: 32 random bytes, base64url
//   --sql                 print the SQL and run nothing (the tokens go to stderr)
//
// Without --sql it runs `wrangler d1 execute DB` with the flags after `--` (default `--local`), for example
// `-- --local --persist-to <dir>` or `-- --remote`. Running it again with the same id and tokens changes nothing.
// Only the SHA-256 of the client token is stored, so this is the one time it is printed.
import { execFileSync } from "node:child_process"
import { parseArgs } from "node:util"
import { randomToken, sha256Hex } from "../src/secrets.ts"

export interface NewUser {
  readonly userId: string
  readonly clientToken: string
  readonly feedToken: string
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`

/** Idempotent SQL that creates the user, or resets its feed token, and adds the client token. */
export const createUserSql = async (user: NewUser, createdAt = new Date().toISOString()) => {
  const hash = await sha256Hex(user.clientToken)
  return [
    `INSERT INTO users (id, feed_token, created_at) VALUES (${quote(user.userId)}, ${quote(user.feedToken)}, ${quote(createdAt)})`,
    `  ON CONFLICT (id) DO UPDATE SET feed_token = excluded.feed_token;`,
    `INSERT OR IGNORE INTO tokens (hash, user_id, created_at) VALUES (${quote(hash)}, ${quote(user.userId)}, ${quote(createdAt)});`,
  ].join("\n")
}

if (import.meta.main) {
  const dashDash = process.argv.indexOf("--")
  const own = dashDash === -1 ? process.argv.slice(2) : process.argv.slice(2, dashDash)
  const wranglerFlags = dashDash === -1 ? ["--local"] : process.argv.slice(dashDash + 1)
  const { values } = parseArgs({
    args: own,
    options: {
      "user-id": { type: "string" },
      "client-token": { type: "string" },
      "feed-token": { type: "string" },
      sql: { type: "boolean", default: false },
    },
  })
  const user: NewUser = {
    userId: values["user-id"] ?? crypto.randomUUID(),
    clientToken: values["client-token"] ?? randomToken(),
    feedToken: values["feed-token"] ?? randomToken(),
  }
  const sql = await createUserSql(user)
  if (values.sql) {
    console.log(sql)
    console.error(JSON.stringify(user))
  } else {
    const apiDir = new URL("..", import.meta.url).pathname
    execFileSync(`${apiDir}node_modules/.bin/wrangler`, ["d1", "execute", "DB", ...wranglerFlags, "--command", sql], {
      cwd: apiDir,
      stdio: ["ignore", "ignore", "inherit"],
    })
    console.log(JSON.stringify(user))
  }
}
