# Fama HTTP API

The source of truth for every shape is `packages/contracts/src/` (Effect Schema; `index.ts` exports all of it). This file is the same contract in words, for the Python worker and for humans. Terms follow `CONTEXT.md`.

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
- Every `url` the API returns (chapter, timing file, book, cover) is a path that starts with `/media/<feedToken>/episodes/`. Clients prefix the server origin. They never build media paths.
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
| `GET /api/voices` | | `{ voices: Voice[] }` from workers seen in the last 30 days |
| `GET /api/feed` | | `{ url }`, the full feed URL for "Add to Podcasts" |
| `POST /api/feed/rotate` | | `{ url }`, the feed URL with a new feed token |

`apiVersion` is `API_VERSION` in the contract. It goes up on a breaking change.

The client routes see only the token user's episodes.

`Episode` fields: `id, createdAt, source, title, author, language, voice, speed, durationMs, chapters[{index, title, durationMs, url, timingUrl}], bookUrl, coverUrl, job, progress`.

`progress` is the token user's `EpisodeProgress` for the episode, or `null` when there is none.

`job` is one of:

- `{_tag:"Queued"}`
- `{_tag:"Running", workerId, stage, done, total, heartbeatAt}` with `stage` in `extracting | synthesizing | encoding | uploading`
- `{_tag:"Ready", finishedAt}`
- `{_tag:"Failed", reason, failedAt}`

A new episode gets a provisional `title`: the URL host and path, the file name, or the first words of the text. The worker replaces it with the real title.

`chapters` grows while the job runs. A client can play chapter 0 while the job is still `Running`.

## Timing file

`timingUrl` of a chapter is the media path of its timing file, or `null` for a chapter made before timing files. A client shows no text for such a chapter. `GET` on the path returns `Timing` as `application/json`:

```json
{ "segments": [{ "text": "Hún á 3 bækur.", "startMs": 1500, "endMs": 3240, "endsParagraph": false }] }
```

- A Segment is the text of one synthesis call: one sentence, or a few short ones. `text` is the Document text, not the text the engine reads ("3 bækur", not "þrjár bækur").
- `startMs` and `endMs` are whole milliseconds from the start of the chapter audio. Add the durations of the chapters before it to get a position on the episode timeline.
- `startMs` is where the voice starts the text, so a seek to it starts on the first word. `endMs` is where the audio of the Segment ends: the voice has stopped, and the short silence the engine closes a call with is inside.
- Segments are in reading order and do not overlap. The pause between two Segments is on the timeline and belongs to neither. So the Segment at a position is the last one whose `startMs` is at or before it. The first `startMs` of a chapter can be a few hundred ms after 0.
- `endsParagraph` is `true` on the last Segment of a paragraph. The spoken title, author and chapter title come first, each as its own paragraph. The Document text does not have them.
- The last `endMs` is the chapter's `durationMs`, within 50 ms.

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
| `POST /api/worker/jobs/:id/progress` | `{ workerId, leaseToken, stage, done, total, title, author, language, voice }` | `204`. Also the heartbeat |
| `PUT /api/worker/jobs/:id/chapters/:index?workerId=<urlenc>&leaseToken=<urlenc>&title=<urlenc>&durationMs=<int>` | `audio/mp4` bytes (`.m4a`) | `204`. Overwrites the same index |
| `PUT /api/worker/jobs/:id/chapters/:index/timing?workerId=<urlenc>&leaseToken=<urlenc>` | `Timing` as JSON | `204`. Overwrites the same index. `400` when the body is not a `Timing` |
| `PUT /api/worker/jobs/:id/book?workerId=<urlenc>&leaseToken=<urlenc>` | `audio/mp4` bytes (`.m4b`) | `204` |
| `PUT /api/worker/jobs/:id/cover?workerId=<urlenc>&leaseToken=<urlenc>` | `image/jpeg` or `image/png` | `204` |
| `POST /api/worker/jobs/:id/complete` | `{ workerId, leaseToken, durationMs }` | `204`, job `Ready` |
| `POST /api/worker/jobs/:id/fail` | `{ workerId, leaseToken, reason }` | `204`, job `Failed` |

Rules:

- `claim` takes jobs of all users. It also registers the worker's voices for `GET /api/voices`.
- `claim` returns the oldest `Queued` job, or a `Running` job whose `heartbeatAt` is older than `LEASE_MS` (10 minutes).
- `ClaimedJob` is `{ episodeId, leaseToken, source, sourcePath, voice, speed, completedChapters }`. The worker skips chapter indexes in `completedChapters`.
- `leaseToken` is a random secret for this one claim. Every job route needs it: the source read in the query, byte uploads in the query, JSON writes in the body. The server stores only its SHA-256. `workerId` is for diagnostics only.
- A call whose `leaseToken` is not the current claim's (another worker claimed the job since, or the job went back to `Queued`), or whose job is no longer `Running`, gets `409`. The worker then drops the job. A repeated `complete` or `fail` with the same lease after it took effect gets `204`.
- The worker uploads the timing file of a chapter before the chapter audio. The API lists a chapter when its audio arrives, so a listed chapter already has its `timingUrl`, and a stop between the two uploads leaves no chapter: the next attempt sends both again.
- Byte uploads (`PUT`) need a `Content-Length` header and are at most 100 MB.
- The worker sends `progress` at least once a minute while it works.

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
- `users/<userId>/episodes/<episodeId>/chapters/<index:000>.json` (the timing file)
- `users/<userId>/episodes/<episodeId>/book.m4b`
- `users/<userId>/episodes/<episodeId>/cover.<ext>`

`DELETE /api/episodes/:id` checks the owner in D1 before it removes any of these.
