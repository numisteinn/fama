# Organize (archive, title, author)

The owner puts an episode away and takes it back, and renames its title or author. One `PATCH /api/episodes/:id` writes the row: no lease, no worker wake, no new audio. An archived episode keeps its audio and its place in the library list, but the private feed leaves it out, so a podcast app drops it without anything being deleted. No screen shows this yet. The proof is the client route, the feed and the media.

## Sub-features

- `organize-rename` sets `title` and `author`. Both arrive trimmed, never blank, at most 300 characters. `author: null` clears the author and leaves the title alone.
- `organize-archive` stamps `archivedAt` on `archived: true` and clears it on `archived: false`. A later archive keeps the first stamp.
- `organize-list` keeps `GET /api/episodes` complete: archived episodes stay in the list with their `archivedAt`, so a client filters the inbox and the archive locally, with no extra round-trip.
- `organize-feed` leaves archived episodes out of `rss.xml` and takes them back after an unarchive. Media URLs keep working either way.
- `organize-private` gives another user's episode `404` and refuses an empty body, a blank field or a wrong type with `400`.

## How to get to it (user POV)

- No screen yet. The library will get an inbox and an archive. Today the owner drives the feature with the API.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`.
- One `Ready` episode with a book file (see [Add a file](./add-file.md)), and one episode in any other state.

- **Rename.** Run `fama-verify api PATCH /api/episodes/<id> -H 'content-type: application/json' -d '{"title":"  Harbour Nights  ","author":"  New Author  "}'`. The answer is the episode: title `Harbour Nights` and author `New Author`, both trimmed. Run it again with `{"author":null}`: the author is `null` and the title stands.
- **Archive.** Run `fama-verify api PATCH /api/episodes/<id> -H 'content-type: application/json' -d '{"archived":true}'`. The answer has an `archivedAt` stamp. `fama-verify api GET /api/episodes` still lists the episode, with the same stamp.
- **Feed omits it.** Save the feed before and after: `curl -s "$(fama-verify feed)" > feed.xml`. The episode's `<guid>` is gone after the archive. Its media stays: `curl -s -o /dev/null -w '%{http_code}' http://localhost:8788<bookUrl>` answers `200`.
- **Unarchive.** Run the PATCH with `{"archived":false}`. `archivedAt` is `null`, the feed has the item again, and the book URL did not change.
- **First stamp kept.** Archive, unarchive, archive again. The third answer has the `archivedAt` of the first archive, not a new one.
- **Refused.** Run `curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer dev-api-token' -H 'content-type: application/json' -X PATCH http://localhost:8788/api/episodes/<id> -d '{}'`: `400`. The same for `{"title":"   "}`, `{"title":"<301 chars>"}` and `{"archived":"yes"}`.
- **Proof.** Save the PATCH answers, the two `feed.xml` files and the status lines to `$EVIDENCE/organize/`.

## Gotchas

- `fama-verify api` runs curl with `-f`, so a `400` only shows as a non-zero exit. Read the error body with plain curl.
- The single dev user cannot prove ownership isolation live: another user's episode gets `404` in the API tests (`apps/api/src/routes/organize.test.ts`).
- A podcast app refreshes the feed on its own schedule, so an archived episode leaves the app at the next refresh, not at the PATCH.
- Tags and folders are not part of this feature. Do not look for them.
