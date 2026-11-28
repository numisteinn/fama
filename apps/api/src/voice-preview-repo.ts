import { type MissingVoicePreviews, Voice, VoiceRef } from "@fama/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { Bindings } from "./bindings.ts"
import { query, type DatabaseError } from "./db.ts"

const VOICE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const voiceColumns = "id, engine, name, language, gender, preview_revision"
const { engine, name, language, gender } = Voice.fields
const VoiceRow = Schema.Struct({
  id: VoiceRef,
  engine,
  name,
  language,
  gender,
  preview_revision: Schema.NullOr(Schema.String),
})
const decodeVoiceRow = Schema.decodeUnknownEffect(VoiceRow)
const decodeVoiceRows = Schema.decodeUnknownEffect(Schema.Array(VoiceRow))
const decodeMissingRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: VoiceRef })))

const toVoice = ({ preview_revision, ...voice }: typeof VoiceRow.Type): Voice => ({
  ...voice,
  previewUrl: preview_revision === null ? null : `/voice-previews/${encodeURIComponent(voice.id)}?v=${preview_revision}`,
})

export const registerVoices = (db: D1Database, voices: ReadonlyArray<Voice>, now: number) => {
  if (voices.length === 0) return Effect.void
  const seenAt = new Date(now).toISOString()
  return query("voices.register", () =>
    db.batch(voices.map((voice) =>
      db.prepare(
        `INSERT INTO voices (id, engine, name, language, gender, seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET engine = excluded.engine, name = excluded.name,
           language = excluded.language, gender = excluded.gender, seen_at = excluded.seen_at`,
      ).bind(voice.id, voice.engine, voice.name, voice.language, voice.gender, seenAt),
    )),
  ).pipe(Effect.asVoid)
}

type Failure = DatabaseError | Schema.SchemaError

interface Interface {
  readonly register: (voices: ReadonlyArray<Voice>) => Effect.Effect<void, DatabaseError>
  readonly list: Effect.Effect<ReadonlyArray<Voice>, Failure>
  readonly missing: Effect.Effect<typeof MissingVoicePreviews.Type, Failure>
  readonly exists: (id: VoiceRef) => Effect.Effect<boolean, DatabaseError>
  readonly publish: (id: VoiceRef, revision: string) => Effect.Effect<Voice | null, Failure>
}

export class VoicePreviewRepo extends Context.Service<VoicePreviewRepo, Interface>()("@fama/api/VoicePreviewRepo") {}

export const layer = Layer.effect(
  VoicePreviewRepo,
  Effect.gen(function* () {
    const { DB: db } = yield* Bindings
    const now = Effect.clockWith((clock) => clock.currentTimeMillis)
    const register = (voices: ReadonlyArray<Voice>) => Effect.flatMap(now, (at) => registerVoices(db, voices, at))

    const list = Effect.gen(function* () {
      const since = new Date((yield* now) - VOICE_TTL_MS).toISOString()
      const { results } = yield* query("voices.list", () =>
        db.prepare(`SELECT ${voiceColumns} FROM voices WHERE seen_at >= ? ORDER BY language, id`).bind(since).all())
      return (yield* decodeVoiceRows(results)).map(toVoice)
    }).pipe(Effect.withSpan("VoicePreviewRepo.list"))

    const missing = Effect.gen(function* () {
      const { results } = yield* query("voices.missingPreviews", () =>
        db.prepare("SELECT id FROM voices WHERE preview_revision IS NULL ORDER BY id").all())
      return { voiceIds: (yield* decodeMissingRows(results)).map(({ id }) => id) }
    }).pipe(Effect.withSpan("VoicePreviewRepo.missing"))

    const exists = (id: VoiceRef) => query("voices.exists", () =>
      db.prepare("SELECT id FROM voices WHERE id = ?").bind(id).first()).pipe(Effect.map((row) => row !== null))

    const publish = Effect.fn("VoicePreviewRepo.publish")(function* (id: VoiceRef, revision: string) {
      const row = yield* query("voices.publishPreview", () =>
        db.prepare(`UPDATE voices SET preview_revision = ? WHERE id = ? RETURNING ${voiceColumns}`)
          .bind(revision, id).first())
      return row === null ? null : toVoice(yield* decodeVoiceRow(row))
    })

    return VoicePreviewRepo.of({ register, list, missing, exists, publish })
  }),
)
