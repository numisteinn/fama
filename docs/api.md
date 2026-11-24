# Fama HTTP API

The source of truth for every shape is `packages/contracts/src/index.ts` (Effect Schema). This file is the same contract in words, for the Python worker and for humans. Terms follow `CONTEXT.md`.

All JSON. Tagged unions use a `_tag` field. Times are ISO 8601 strings. Nullable fields are always present and set to `null`, never left out.

## Auth

Every episode has one owner, a user. There are three credentials, and each opens one set of routes:

| Credential | Sent as | Opens |
|---|---|---|
| Client token | `Authorization: Bearer <token>` | the client routes under `/api/*` (not `/api/worker/*`), as its user |
| Feed token | in the path: `/feed/<token>/...`, `/media/<token>/...` | that user's feed and media. Never `/api/*` |
| Worker token (`FAMA_WORKER_TOKEN` secret) | `Authorization: Bearer <token>` | `/api/worker/*`, for jobs of all users |

- A user has any number of client tokens. The server stores only their SHA-256, so it shows a client token once, when it is made.
- A user has one feed token. It is a capability URL, so the server can print it again. `POST /api/feed/rotate` replaces it, and the old feed and media URLs stop working.
- A wrong or missing credential gets `401`. Another user's episode gets `404`, as if it did not exist.
- Every `url` the API returns (chapter, book, cover) is a path that starts with `/media/<feedToken>/episodes/`. Clients prefix the server origin. They never build media paths.
- `/media/<feedToken>/<path>` serves only `episodes/...` of the feed token's user. A path with a `.` or `..` segment, or under `uploads/`, gets `404`.
- `/media/*` supports HTTP `Range` requests (`206`), because AVPlayer and podcast apps need it.

## Client endpoints

| Method and path | Body | Response |
|---|---|---|
| `GET /api/me` | | `Me` `{ userId, apiVersion }`. Clients key caches, downloads and pending writes by server and `userId` |
| `POST /api/episodes` | `CreateEpisode` `{ source: {_tag:"Url", url} \| {_tag:"Text", title, text}, voice, speed }` | `201 Episode` |
| `POST /api/episodes/upload` | multipart form: `file` (PDF, EPUB, TXT, MD, HTML), optional `voice`, optional `speed` | `201 Episode` |
| `GET /api/episodes` | | `{ episodes: Episode[] }`, newest first |
| `GET /api/episodes/:id` | | `Episode` or `404` |
| `DELETE /api/episodes/:id` | | `204`, also deletes its media |
| `POST /api/episodes/:id/retry` | | `Episode`, job back to `Queued` |
| `PUT /api/episodes/:id/progress` | `EpisodeProgress` `{ positionMs, updatedAt }` | `200 EpisodeProgress`, the stored value after the write |
| `GET /api/episodes/:id/document` | | `Document`, or `404` (`NotStored`) until the worker has stored it |
| `GET /api/voices` | | `{ voices: Voice[] }` from workers seen in the last 30 days |
| `GET /api/feed` | | `{ url }`, the full feed URL for "Add to Podcasts" |
| `POST /api/feed/rotate` | | `{ url }`, the feed URL with a new feed token |

`apiVersion` is `API_VERSION` in the contract. It goes up on a breaking change.

The client routes see only the token user's episodes.

`Episode` fields: `id, createdAt, source, title, author, language, voice, speed, durationMs, chapters[{index, title, durationMs, url}], bookUrl, coverUrl, job, progress`.

`progress` is the token user's `EpisodeProgress` for the episode, or `null` when there is none.

`job` is one of:

- `{_tag:"Queued"}`
- `{_tag:"Running", workerId, stage, done, total, heartbeatAt, remainingMs}` with `stage` in `extracting | synthesizing | encoding | uploading`. `remainingMs` is the worker's estimate of the wall time until `Ready`, as of `heartbeatAt`, or `null` when it has none
- `{_tag:"Ready", finishedAt}`
- `{_tag:"Failed", reason, failedAt}`

A new episode gets a provisional `title`: the URL host and path, the file name, or the first words of the text. The worker replaces it with the real title.

`chapters` grows while the job runs. A client can play chapter 0 while the job is still `Running`.

## Document

`Document` is `{ title, author, language, chapters: [{ title, text }] }`: the clean text the worker extracted from the source. `author` can be `null`. `chapters` has at least one entry. The shape is `packages/contracts/src/document.ts`.

- The worker stores the Document once, after the first extraction. The API keeps it with the episode and deletes it with the episode.
- Audio chapter `i` narrates Document chapter `i`. `Episode.chapters[i]` is the audio of `Document.chapters[i]`.
- The Document has no cover. The cover is a file of its own (`coverUrl`).

## Listening progress

`EpisodeProgress` is `{ positionMs, updatedAt }`. `positionMs` is a whole number of milliseconds, 0 or more, on the whole episode timeline (all chapters in order). `updatedAt` is an ISO 8601 time: when the listener was at that position.

- The newest `updatedAt` wins. `PUT` stores the body only when its `updatedAt` is later than the stored one. An equal or older write changes nothing. Both get `200` with the stored value.
- An `updatedAt` later than the server clock is stored as the server clock. The client keeps the response in place of what it sent, so a fast device clock does not win every later write.
- A finished episode stores its total length, not 0. `FINISHED_MARGIN_MS` (3000) in the contract: a position at most that far from the end is finished, and the next play starts at 0. The end of the chapters of a job that still runs is not finished.
- Another user's episode gets `404`. Deleting an episode deletes its progress.

Clients keep `{ positionMs, updatedAt }` per episode on the device and use `mergeProgress` from the contract:

- On every library load, a local entry newer than the episode's `progress` is sent (offline listening syncs this way), and a newer `progress` replaces the local entry.
- While playing, a client sends about every 5 s of playback, on pause, and when the app goes to the background or the page hides.
- Only the listener's own actions stamp a new `updatedAt`. Loading an episode without playing it, at app start or on a library load, stamps and sends nothing.
- `playStart` in the contract is the one rule for where a Play starts. It takes the position (saved, or where a loaded player rests), and the chapters and the job as the library lists them when the Play acts. A client keeps no "ended" state from an earlier list.
  - The job ended (`Ready` or `Failed`) and the position is finished: the Play starts at 0.
  - The job still works (`Queued` or `Running`) and the position is the end of the chapters made so far: the Play waits for the next chapter. When a later list has that chapter, the same position is its start, and the Play goes on there. It never starts at 0.
  - Otherwise the Play starts at the position.
- A Play pressed while library loads are out waits for them, so it does not start from a position another device moved on from. `awaitedAfter` in the contract is the rule: the Play starts on the list of the newest load that was out at the press, or of a later load, or when each of those loads has answered. A later load that fails starts nothing.
- A paused, held or waiting player takes newer server progress before it decides to resume. This adoption keeps the server stamp. If that position is past the available chapters, keep the entry until the audio reaches it; do not stamp the shorter waiting position.
- A paused player rests at the saved position, including the end. Only Play applies `playStart`. A Pause cancels a wait for more chapters. A phone applies the newest chapter list and job before it releases Play.

## Worker endpoints

A worker loops: claim, process, report. All calls are idempotent. A crash at any point is safe to retry. Every call needs the worker token.

| Method and path | Body | Response |
|---|---|---|
| `POST /api/worker/claim` | `{ workerId, voices: Voice[] }` | `200 { job: ClaimedJob }` or `204` when no work |
| `GET /api/worker/jobs/:id/source?leaseToken=<urlenc>` | | the uploaded file bytes (File sources only) |
| `POST /api/worker/jobs/:id/progress` | `{ workerId, leaseToken, stage, done, total, title, author, language, voice, remainingMs }` | `204`. Also the heartbeat |
| `PUT /api/worker/jobs/:id/chapters/:index?workerId=<urlenc>&leaseToken=<urlenc>&title=<urlenc>&durationMs=<int>` | `audio/mp4` bytes (`.m4a`) | `204`. Overwrites the same index |
| `PUT /api/worker/jobs/:id/book?workerId=<urlenc>&leaseToken=<urlenc>` | `audio/mp4` bytes (`.m4b`) | `204` |
| `PUT /api/worker/jobs/:id/cover?workerId=<urlenc>&leaseToken=<urlenc>` | `image/jpeg` or `image/png` | `204` |
| `GET /api/worker/jobs/:id/cover?leaseToken=<urlenc>` | | the cover bytes with their `Content-Type`, or `404` (`NotStored`) |
| `PUT /api/worker/jobs/:id/document?workerId=<urlenc>&leaseToken=<urlenc>` | `Document` (JSON) | `204`. Overwrites the stored Document. A body that is not a `Document` gets `400` |
| `GET /api/worker/jobs/:id/document?leaseToken=<urlenc>` | | `Document`, or `404` (`NotStored`) |
| `POST /api/worker/jobs/:id/complete` | `{ workerId, leaseToken, durationMs }` | `204`, job `Ready` |
| `POST /api/worker/jobs/:id/fail` | `{ workerId, leaseToken, reason }` | `204`, job `Failed` |

Rules:

- `claim` takes jobs of all users. It also registers the worker's voices for `GET /api/voices`.
- `claim` returns the oldest `Queued` job, or a `Running` job whose `heartbeatAt` is older than `LEASE_MS` (10 minutes).
- `ClaimedJob` is `{ episodeId, leaseToken, source, sourcePath, documentPath, coverPath, voice, speed, completedChapters }`. The worker skips chapter indexes in `completedChapters`.
- `documentPath` is the path of `GET .../document`, or `null` when the episode has no stored Document. With `null`, the worker extracts the source, uploads the cover (if the source has one), and then uploads the Document. With a path, the worker reads the stored Document and does not extract. `coverPath` is the path of `GET .../cover`, or `null` when the episode has no cover. The worker reads the cover back to put it in the book file.
- The worker uploads the cover before the Document. So a stored Document means the first extraction is complete.
- `leaseToken` is a random secret for this one claim. Every job route needs it: reads (source, Document, cover) in the query, uploads in the query, JSON `POST` writes in the body. The server stores only its SHA-256. `workerId` is for diagnostics only.
- A call whose `leaseToken` is not the current claim's (another worker claimed the job since, or the job went back to `Queued`), or whose job is no longer `Running`, gets `409`. The worker then drops the job. A repeated `complete` or `fail` with the same lease after it took effect gets `204`.
- Byte uploads (`PUT`) need a `Content-Length` header and are at most 100 MB.
- The worker sends `progress` at least once a minute while it works.
- `remainingMs` is a whole number of milliseconds, 0 or more, or `null`. The worker measures its own speed in this job: only chunks the engine made count, not chunks from its cache. It moves the estimate slower than the clock, so the time left goes down from one heartbeat to the next. It sends `null` before it has measured enough chunks and after narration. A worker that leaves the field out sends `null`.

## Connect link

`fama setup` prints a QR code of `fama://connect?server=<url>&token=<client token>`, both values URL-encoded. `connectUrl` and `parseConnectLink` in the contract build and check it. The phone app accepts the link only when:

- `server` is `https`, or `http` on a local host (`isLocalHost`: loopback, private and link-local IPv4, `100.64.0.0/10`, IPv6 loopback and unique-local, `localhost`, a single-label name, `.local`, `.home.arpa`). No user name, query or fragment.
- `token` is 1 to 512 visible ASCII characters.
- `GET /api/me` on that server with that token answers `200`. Only then does the app save the connection.

## Wake

A cloud worker can sleep while the queue is empty. Two optional secrets let the API wake it (D5):

| Secret | Meaning |
|---|---|
| `WORKER_WAKE_URL` | the worker's wake endpoint, for example the Modal `wake` URL |
| `WORKER_WAKE_SECRET` | sent as `Authorization: Bearer <secret>` |

- After `POST /api/episodes`, `POST /api/episodes/upload` or `POST /api/episodes/:id/retry` stores a `Queued` job, the API sends one `POST <WORKER_WAKE_URL>` with no body. A refused request sends none.
- The call runs after the response (`waitUntil`) and stops after 5 s. A failed, refused or slow wake is logged without the secret. It never changes the client's response.
- Without `WORKER_WAKE_URL` there is no call. A Mac worker needs none: it polls `claim`.
- A missed wake is safe. The worker's own schedule (the Modal `sweep`, every 5 minutes) claims the job later.

## Storage keys (R2)

Every key starts with the owner's prefix, `users/<userId>/`. A media URL leaves the prefix out, because the feed token names the user: `/media/<feedToken>/episodes/<episodeId>/book.m4b` reads `users/<userId>/episodes/<episodeId>/book.m4b`.

- `users/<userId>/uploads/<episodeId>/<fileName>`
- `users/<userId>/episodes/<episodeId>/chapters/<index:000>.m4a`
- `users/<userId>/episodes/<episodeId>/book.m4b`
- `users/<userId>/episodes/<episodeId>/cover.<ext>`
- `users/<userId>/episodes/<episodeId>/document.json`

`DELETE /api/episodes/:id` checks the owner in D1 before it removes any of these.
