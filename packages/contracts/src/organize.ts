import { Schema } from "effect"

/** An episode title or author as the owner writes it: trimmed, never blank, at most 300 characters. */
const EditableText = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(300)))

/**
 * Body of `PATCH /api/episodes/:id`: what the owner changes on one episode. `title` and `author` arrive trimmed,
 * so a blank one is refused. `author: null` clears the author. `archived: true` stamps `archivedAt` (a later
 * archive keeps the first stamp), `archived: false` clears it. At least one field must be present.
 */
export const UpdateEpisode = Schema.Struct({
  title: Schema.optionalKey(EditableText),
  author: Schema.optionalKey(Schema.NullOr(EditableText)),
  archived: Schema.optionalKey(Schema.Boolean),
})
export interface UpdateEpisode extends Schema.Schema.Type<typeof UpdateEpisode> {}
