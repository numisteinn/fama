# Fama HTTP API

The source of truth for every shape is `packages/contracts/src/index.ts` (Effect Schema). This file is the same contract in words, for the Python worker and for humans. Terms follow `CONTEXT.md`.

All JSON. Tagged unions use a `_tag` field. Times are ISO 8601 strings. Nullable fields are always present and set to `null`, never left out.

## Auth

- `/api/*` needs `Authorization: Bearer <FAMA_API_TOKEN>`.
- `/feed/<FAMA_FEED_TOKEN>/rss.xml` and `/media/<FAMA_FEED_TOKEN>/<key>` need no header. The token in the path is the secret, because podcast apps cannot send headers.
- Every `url` the API returns (chapter, book, cover) is a path that starts with `/media/<feedToken>/`. Clients prefix the server origin. They never build media paths.
- `/media/*` supports HTTP `Range` requests (`206`), because AVPlayer and podcast apps need it.

## Client endpoints

| Method and path | Body | Response |
|---|---|---|
| `POST /api/episodes` | `CreateEpisode` `{ source: {_tag:"Url", url} \| {_tag:"Text", title, text}, voice, speed }` | `201 Episode` |
| `POST /api/episodes/upload` | multipart form: `file` (PDF, EPUB, TXT, MD, HTML), optional `voice`, optional `speed` | `201 Episode` |
| `GET /api/episodes` | | `{ episodes: Episode[] }`, newest first |
| `GET /api/episodes/:id` | | `Episode` or `404` |
| `DELETE /api/episodes/:id` | | `204`, also deletes its media |
| `POST /api/episodes/:id/retry` | | `Episode`, job back to `Queued` |
| `GET /api/voices` | | `{ voices: Voice[] }` from workers seen in the last 30 days |
| `GET /api/feed` | | `{ url }`, the full feed URL for "Add to Podcasts" |

`Episode` fields: `id, createdAt, source, title, author, language, voice, speed, durationMs, chapters[{index, title, durationMs, url}], bookUrl, coverUrl, job`.

`job` is one of:

- `{_tag:"Queued"}`
- `{_tag:"Running", workerId, stage, done, total, heartbeatAt}` with `stage` in `extracting | synthesizing | encoding | uploading`
- `{_tag:"Ready", finishedAt}`
- `{_tag:"Failed", reason, failedAt}`

A new episode gets a provisional `title`: the URL host and path, the file name, or the first words of the text. The worker replaces it with the real title.

`chapters` grows while the job runs. A client can play chapter 0 while the job is still `Running`.

## Worker endpoints

A worker loops: claim, process, report. All calls are idempotent. A crash at any point is safe to retry.

| Method and path | Body | Response |
|---|---|---|
| `POST /api/worker/claim` | `{ workerId, voices: Voice[] }` | `200 { job: ClaimedJob }` or `204` when no work |
| `GET /api/worker/jobs/:id/source` | | the uploaded file bytes (File sources only) |
| `POST /api/worker/jobs/:id/progress` | `{ workerId, stage, done, total, title, author, language, voice }` | `204`. Also the heartbeat |
| `PUT /api/worker/jobs/:id/chapters/:index?workerId=<urlenc>&title=<urlenc>&durationMs=<int>` | `audio/mp4` bytes (`.m4a`) | `204`. Overwrites the same index |
| `PUT /api/worker/jobs/:id/book?workerId=<urlenc>` | `audio/mp4` bytes (`.m4b`) | `204` |
| `PUT /api/worker/jobs/:id/cover?workerId=<urlenc>` | `image/jpeg` or `image/png` | `204` |
| `POST /api/worker/jobs/:id/complete` | `{ workerId, durationMs }` | `204`, job `Ready` |
| `POST /api/worker/jobs/:id/fail` | `{ workerId, reason }` | `204`, job `Failed` |

Rules:

- `claim` also registers the worker's voices for `GET /api/voices`.
- `claim` returns the oldest `Queued` job, or a `Running` job whose `heartbeatAt` is older than `LEASE_MS` (10 minutes).
- `ClaimedJob` is `{ episodeId, source, sourcePath, voice, speed, completedChapters }`. The worker skips chapter indexes in `completedChapters`.
- Every write from a worker that no longer holds the lease (another `workerId` is now `Running`, or the job is no longer `Running`) gets `409`. The worker then drops the job. Byte uploads name the worker in the `workerId` query parameter, JSON writes in the body.
- Byte uploads (`PUT`) need a `Content-Length` header and are at most 100 MB.
- The worker sends `progress` at least once a minute while it works.

## Storage keys (R2)

- `uploads/<episodeId>/<fileName>`
- `episodes/<episodeId>/chapters/<index:000>.m4a`
- `episodes/<episodeId>/book.m4b`
- `episodes/<episodeId>/cover.<ext>`
