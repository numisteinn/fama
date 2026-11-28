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
| `POST /api/episodes` | `CreateEpisode` `{ source: {_tag:"Url", url} \| {_tag:"Text", title, text}, voice, speed, review? }` | `201 Episode` |
| `POST /api/episodes/upload` | multipart form: `file` (PDF, EPUB, TXT, MD, HTML), optional `url`, optional `voice`, optional `speed`, optional `review` (`true` or `false`) | `201 Episode` |
| `GET /api/episodes` | | `{ episodes: Episode[] }`, newest first |
| `GET /api/episodes/:id` | | `Episode` or `404` |
| `DELETE /api/episodes/:id` | | `204`, also deletes its media |
| `PATCH /api/episodes/:id` | `UpdateEpisode` `{ title?, author?, archived? }` | `200 Episode`, the episode after the write |
| `POST /api/episodes/:id/retry` | | `Episode`, job back to `Queued` |
| `PUT /api/episodes/:id/progress` | `EpisodeProgress` `{ positionMs, updatedAt }` | `200 EpisodeProgress`, the stored value after the write |
| `GET /api/episodes/:id/document` | | `Document`, or `404` (`NotStored`) until the worker has stored it |
| `PUT /api/episodes/:id/document` | `Document` | `204` in `Review`, `Ready` or `Failed`. `409` (`NotEditable`) in `Queued` or `Running` |
| `PUT /api/episodes/:id/voice` | `ChangeVoice` `{ voice, speed }` | `204` in `Review`, `Ready` or `Failed` (queues narration in `Ready` or `Failed`, stays in `Review` while in `Review`). `409` (`NotEditable`) in `Queued` or `Running` |
| `POST /api/episodes/:id/start` | `StartReview` `{ document: Document, voice?, speed? }` | `200 Episode` after queuing narration, `409` (`NotInReview`) in other states |
| `GET /api/episodes/:id/samples` | | `200 SampleList` for the owner's Episode, or `404` |
| `POST /api/episodes/:id/samples` | Optional `SamplesRequest` `{ voices }` | `200 SampleList`, or `404` when the Episode or Document is missing |
| `GET /api/voices` | | `{ voices: Voice[] }` from workers seen in the last 30 days |
| `GET /api/feed` | | `{ url }`, the full feed URL for "Add to Podcasts" |
| `POST /api/feed/rotate` | | `{ url }`, the feed URL with a new feed token |

`apiVersion` is `API_VERSION` in the contract. It goes up on a breaking change.

The client routes see only the token user's episodes.

`Episode` fields: `id, createdAt, source, title, author, language, voice, speed, durationMs, chapters[{index, title, durationMs, url, timingUrl}], bookUrl, coverUrl, archivedAt, job, progress`.

`progress` is the token user's `EpisodeProgress` for the episode, or `null` when there is none.

`job` is one of:

- `{_tag:"Queued"}`
- `{_tag:"Running", workerId, stage, done, total, heartbeatAt, remainingMs}` with `stage` in `extracting | synthesizing | encoding | uploading`. `remainingMs` is the worker's estimate of the wall time until `Ready`, as of `heartbeatAt`, or `null` when it has none
- `{_tag:"Review"}` while the Document waits for the owner to start narration
- `{_tag:"Ready", finishedAt}`
- `{_tag:"Failed", reason, failedAt}`

A new episode gets a provisional `title`: the URL host and path, the file name, or the first words of the text. The worker replaces it with the real title.

`chapters` grows while the job runs. A client can play chapter 0 while the job is still `Running`.

## Organize

`archivedAt` is `null` while the episode is in the inbox, and the ISO time of the move after the owner archived it. `GET /api/episodes` lists all the user's episodes, archived ones too, so a client filters the inbox and the archive locally.

- `PATCH /api/episodes/:id` writes what the owner gives. `title` and `author` arrive trimmed, never blank, at most 300 characters; `author: null` clears the author. `archived: true` stamps `archivedAt`, and a later archive keeps the first stamp; `archived: false` clears it.
- At least one field must be present. An empty body or `{}` gets `400`.
- Another user's episode gets `404`. The write needs no lease and wakes no worker, because only the row and the feed change.
- The feed leaves archived episodes out. Their audio and media URLs stay, so unarchiving puts an episode back in the feed with nothing re-made.

## Document

`Document` is `{ title, author, language, chapters: [{ title, text }] }`: the clean text the worker extracted from the source. `author` can be `null`. `chapters` has at least one entry. The shape is `packages/contracts/src/document.ts`.

- The Worker uploads the first Document after extraction. The API reads the selected Document revision for the Episode and deletes its revisions with the Episode.
- Audio chapter `i` narrates Document chapter `i`. `Episode.chapters[i]` is the audio of `Document.chapters[i]`.
- The Document has no cover. The cover is a file of its own (`coverUrl`).

## Review

- With an HTTP(S) `url`, the upload creates a `Url` Source. The file part must be HTML (`text/html` or `application/xhtml+xml`), PDF, or EPUB. Its Content-Type is stored with the bytes. Without `url`, the upload creates a `File` Source.
- The `review` flag is available for every Source and defaults to `false`. JSON requests take a boolean. Multipart requests take the text `true` or `false`.
- With Review on, the worker stores the Document and the extracted title, author, language and voice before the job stops in `Review`. There is no active lease, audio chapter or book file at that point.
- Only the owner can edit the Document or start narration. Another user's episode gets `404`. Both writes need a Document with at least one chapter or they return `400`.
- For Start, send the full Document with the edits and only the kept chapters, in playback order, plus optional `voice` and `speed` to apply a choice made in Review. The API selects that Document (and voice/speed if given) and queues the job in the same update. The worker reads it on the next claim and indexes the kept chapters from zero.
- While in `Review`, `PUT /api/episodes/:id/voice` also updates the Episode's `voice` and `speed` without queuing narration or waking a worker.
- A repeated Start gets `409` and leaves the selected Document in place. Retry changes `Failed` to `Queued`, succeeds without a state change in `Queued`, and gets `409` in `Review`, `Running` or `Ready`. Delete works in every state.

## Narrate again

- In `Ready` or `Failed`, send the full stored Document with changes to Chapter text only. The Chapter count, titles in index order and Document metadata must match. A change to any of those fields gets `400`. An Episode with no stored Document gets `404`.
- The same states accept a Voice ID (`engine:voiceId`) and a finite positive speed on the voice route.
- Both changes queue the Job and end its previous lease. Published Chapters stay playable. When a replacement arrives, the new audio and its timing file have new URLs. The worker reuses matching Chapters and builds the Book file from the audio in order. The API lists a new Book file after its upload.
- On requeue, the API removes the previous Ready transcript. Requests for a transcript use the timings of the current Ready.

## Samples

A Sample lets the User hear a Voice read the first body paragraph of the Episode’s Document at the Episode’s speed. The Worker takes up to about 300 characters. It cuts at a sentence end when possible. All Voices read the same passage.

`SampleList` is `{ samples: Sample[] }`, sorted by Voice ID. Each Sample is `{ voice, state }`. The state has one of these shapes.

- `{ _tag: "Requested" }` when the API has queued or leased the Sample.
- `{ _tag: "Ready", url }` with a private media path for the AAC clip. The path supports `HEAD` and byte ranges.
- `{ _tag: "Failed", reason }` with the reason the Worker gave.

Omit the body, use `{}`, or set `voices` to `null` to ask for all registered Voices of the Document’s language. To select a subset, pass up to 64 Voice IDs as an array. An unknown Voice or a Voice of another language gets `400`. Repeating the request keeps Requested and Ready Samples and queues Failed Samples in the selection again. The Episode can be in any Job state once it has a stored Document.

## Timing file

`timingUrl` of a chapter is the media path of its timing file, or `null` for a chapter made before timing files. A client shows no text for such a chapter. `GET` on the path returns `Timing` as `application/json`:

```json
{ "segments": [{ "text": "Hún á 3 bækur.", "startMs": 1500, "endMs": 3240, "endsParagraph": false }] }
```

- A Segment is the text of one synthesis call: one sentence, or a few short ones. `text` is the Document text, not the text the engine reads ("3 bækur", not "þrjár bækur").
- `startMs` and `endMs` are whole milliseconds from the start of the chapter audio. Add the durations of the chapters before it to get a position on the episode timeline.
- `startMs` is where the voice starts the text, so a seek to it starts on the first word. `endMs` is where the audio of the Segment ends: the voice has stopped, and the short silence the engine closes a call with is inside.
- Segments are in reading order and do not overlap. The pause between two Segments is on the timeline and belongs to neither. So the Segment at a position is the last one whose `startMs` is at or before it. `segmentIndexAt` in the contract is that rule, and both readers use it. The first `startMs` of a chapter can be a few hundred ms after 0.
- `endsParagraph` is `true` on the last Segment of a paragraph. The spoken title, author and chapter title come first, each as its own paragraph. The Document text does not have them.
- The last `endMs` is the chapter's `durationMs`, within 50 ms.

## Feed and transcript

`GET /feed/<feedToken>/rss.xml` is RSS 2.0 with the iTunes and the Podcasting 2.0 (`xmlns:podcast="https://podcastindex.org/namespace/1.0"`) namespaces. It has one item for each `Ready` episode with a book file that is not archived, newest first. The enclosure is the book file (`audio/x-m4a`).

An item has `<podcast:transcript url="<origin>/media/<feedToken>/episodes/<episodeId>/transcript.vtt" type="text/vtt" language="<language>"/>` when each chapter of the episode has a timing file. An episode with a chapter made before timing files has no tag. `language` is the episode's language, left out when it is unknown.

`GET` or `HEAD` on the transcript path returns WebVTT as `text/vtt; charset=utf-8`, with `Range` support. It is `404` while the job is not `Ready`, or when a chapter has no timing file.

- One cue for each Segment, in reading order. The spoken title Segments are cues too, because they are in the audio.
- A cue is on the episode timeline, the timeline of the book file: the Segment's `startMs` and `endMs` plus the durations of the chapters before it. These sums are the chapter marks of the book file. A cue ends at the end of its chapter at the latest.
- The cue text is the Segment `text` on one line: white space runs become one space, and `&`, `<`, `>` are escaped (`&amp;`, `&lt;`, `&gt;`). A Segment with empty text keeps its cue time.
- The API makes the file on the first request after a `Ready` and stores it. Later requests read the stored file.

## Listening progress

`EpisodeProgress` is `{ positionMs, updatedAt }`. `positionMs` is a whole number of milliseconds, 0 or more, on the whole episode timeline (all chapters in order). `updatedAt` is an ISO 8601 time: when the listener was at that position.

- The newest `updatedAt` wins. `PUT` stores the body only when its `updatedAt` is later than the stored one. An equal or older write changes nothing. Both get `200` with the stored value.
- An `updatedAt` later than the server clock is stored as the server clock. The client keeps the response in place of what it sent, so a fast device clock does not win every later write.
- A finished episode stores its total length, not 0. `FINISHED_MARGIN_MS` (3000) in the contract: a position at most that far from the end is finished, and the next play starts at 0. The end of the chapters of a job that still runs is not finished.
- Another user's episode gets `404`. Deleting an episode deletes its progress.
- When replacement audio changes a Chapter's duration, the API keeps the same fraction through that Chapter for a saved position inside it. A position after the Chapter shifts by the duration difference. A position before it stays in place. The API stamps a moved position at publication so a client can take the new position on its next library load.

Clients keep `{ positionMs, updatedAt }` per episode on the device and use `mergeProgress` from the contract:

- On every library load, a local entry newer than the episode's `progress` is sent (offline listening syncs this way), and a newer `progress` replaces the local entry.
- While playing, a client sends about every 5 s of playback, on pause, and when the app goes to the background or the page hides.
- Client writes stamp `updatedAt` on listener actions. Loading an episode without playing it, at app start or on a library load, stamps and sends nothing.
- `playStart` in the contract is the one rule for where a Play starts. It takes the position (saved, or where a loaded player rests), and the chapters and the job as the library lists them when the Play acts. A client keeps no "ended" state from an earlier list.
  - The job ended (`Ready` or `Failed`) and the position is finished: the Play starts at 0.
  - The job still works (`Queued`, `Running` or `Review`) and the position is the end of the chapters made so far: the Play waits for the next chapter. When a later list has that chapter, the same position is its start, and the Play goes on there. It never starts at 0.
  - Otherwise the Play starts at the position.
- A Play pressed while library loads are out waits for them, so it does not start from a position another device moved on from. `awaitedAfter` in the contract is the rule: the Play starts on the list of the newest load that was out at the press, or of a later load, or when each of those loads has answered. A later load that fails starts nothing.
- A paused, held or waiting player takes newer server progress before it decides to resume. This adoption keeps the server stamp. If that position is past the available chapters, keep the entry until the audio reaches it; do not stamp the shorter waiting position.
- A paused player rests at the saved position, including the end. Only Play applies `playStart`. A Pause cancels a wait for more chapters. A phone applies the newest chapter list and job before it releases Play.

## Worker endpoints

A worker loops: claim, process, report. All calls are idempotent. A crash at any point is safe to retry. Every call needs the worker token.

| Method and path | Body | Response |
|---|---|---|
| `POST /api/worker/claim` | `{ workerId, voices: Voice[] }` | `200 { work: Work }` or `204` when no work |
| `GET /api/worker/samples/:id/document?voice=<urlenc>&leaseToken=<urlenc>` | | `200 Document` |
| `PUT /api/worker/samples/:id/clip?voice=<urlenc>&leaseToken=<urlenc>` | AAC `.m4a` bytes | `204`, Sample `Ready` |
| `POST /api/worker/samples/:id/fail` | `{ voice, leaseToken, reason }` | `204`, Sample `Failed` |
| `GET /api/worker/jobs/:id/source?leaseToken=<urlenc>` | | the uploaded bytes and their Content-Type (File sources and Url sources with an upload) |
| `POST /api/worker/jobs/:id/progress` | `{ workerId, leaseToken, stage, done, total, title, author, language, voice, remainingMs }` | `204`. Also the heartbeat |
| `GET /api/worker/jobs/:id/chapters/:index?leaseToken=<urlenc>` | | The published Chapter audio for reuse, or `404` (`NotStored`) |
| `PUT /api/worker/jobs/:id/chapters/:index?workerId=<urlenc>&leaseToken=<urlenc>&title=<urlenc>&durationMs=<int>&inputHash=<hex>` | `audio/mp4` bytes (`.m4a`) | `204`. Publishes audio and any staged Timing for that lease and input hash |
| `PUT /api/worker/jobs/:id/chapters/:index/timing?workerId=<urlenc>&leaseToken=<urlenc>&inputHash=<hex>` | `Timing` as JSON | `204`. Stages the file until audio publication. `400` when the body is not a `Timing` |
| `PUT /api/worker/jobs/:id/book?workerId=<urlenc>&leaseToken=<urlenc>` | `audio/mp4` bytes (`.m4b`) | `204` |
| `PUT /api/worker/jobs/:id/cover?workerId=<urlenc>&leaseToken=<urlenc>` | `image/jpeg` or `image/png` | `204` |
| `GET /api/worker/jobs/:id/cover?leaseToken=<urlenc>` | | the cover bytes with their `Content-Type`, or `404` (`NotStored`) |
| `PUT /api/worker/jobs/:id/document?workerId=<urlenc>&leaseToken=<urlenc>&voice=<urlenc>` | `Document` (JSON) | `200 DocumentStored` `{ next: "Review" \| "Narrate" }`. A body that is not a `Document` gets `400` |
| `GET /api/worker/jobs/:id/document?leaseToken=<urlenc>` | | `Document`, or `404` (`NotStored`) |
| `POST /api/worker/jobs/:id/complete` | `{ workerId, leaseToken, durationMs }` | `204`, job `Ready` |
| `POST /api/worker/jobs/:id/fail` | `{ workerId, leaseToken, reason }` | `204`, job `Failed` |

Rules:

- `claim` takes work of all Users. It also registers any Voices sent for `GET /api/voices`. The Worker sends its Voices on the first claim and refreshes them once a minute while it polls.
- `Work` is `{ _tag: "Sample", ...ClaimedSample }` or `{ _tag: "Narrate", ...ClaimedJob }`. The API gives the oldest claimable Sample first. Then it searches for the oldest `Queued` Job or a `Running` Job with a heartbeat at least 10 minutes old.
- `ClaimedSample` is `{ episodeId, voice, leaseToken, documentPath, speed }`. Sample work uses a separate lease that expires after two minutes and has no heartbeat. A call with an expired or replaced lease gets `409`. Repeating a successful clip upload or failure report with the same lease gets `204`. A Worker that lacks the selected Voice fails that Sample and continues to the next claim.
- `ClaimedJob` is `{ episodeId, leaseToken, source, sourcePath, documentPath, coverPath, voice, speed, chapters: [{ index, inputHash }] }`. The list covers Chapters with a known hash. The worker downloads the published audio for matching hashes, then narrates any missing or stale Chapters.
- `sourcePath` is set for a File or a Url with uploaded bytes. For an uploaded Url, the worker extracts the bytes by Content-Type and uses the URL as the HTML base URL. It makes no web requests for the page or its cover. For a Url without uploaded bytes, `sourcePath` is `null` and the worker fetches the page.
- The Worker computes `inputHash` as lowercase SHA-256 hex of the UTF-8 JSON array `["chapter-v1", index, chapterTitle, chapterText, documentTitle, author, language, voice, speed, modelVersion]`, serialized with Python `json.dumps` and a float speed. Titles, author, and language are used in narration or audio tags. `chapterText` is the text in the stored Document before normalization. The API stores and returns the hash. The Worker owns the engine model version.
- `documentPath` is the path of `GET .../document`, or `null` when the episode has no stored Document. With `null`, the worker extracts the source, uploads the cover (if the source has one), and then uploads the Document. With a path, the worker reads the stored Document and does not extract. `coverPath` is the path of `GET .../cover`, or `null` when the episode has no cover. The worker reads the cover back to put it in the book file.
- The worker uploads the cover before the Document and sends its selected voice in the optional `voice` query field on the Document upload. The API saves the metadata with the Document. The worker takes its next claim when the upload returns `next: "Review"`. It continues on the same lease for `next: "Narrate"`.
- A repeated Document upload after the job stops in `Review` gets `409` and leaves the selected Document in place.
- `leaseToken` is a random secret for this one claim. Every job route needs it: reads (Source, Document, cover, Chapter audio) in the query, uploads in the query, JSON `POST` writes in the body. The server stores only its SHA-256. `workerId` is for diagnostics only.
- A call whose `leaseToken` is not the current claim's (another worker claimed the job since, or the job went back to `Queued`), or whose job is no longer `Running`, gets `409`. The worker then drops the job. A repeated `complete` or `fail` with the same lease after it took effect gets `204`.
- The Worker uploads the timing file before the Chapter audio, with the same `inputHash` on both calls. The audio upload publishes the pair. A stop between uploads leaves the previous Chapter in place, if one exists. The next attempt can send both again.
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

- After `POST /api/episodes`, `POST /api/episodes/upload`, `POST /api/episodes/:id/retry`, `POST /api/episodes/:id/start`, `PUT /api/episodes/:id/document` or `PUT /api/episodes/:id/voice` stores a `Queued` Job, the API sends one `POST <WORKER_WAKE_URL>` with no body. The API also sends a wake when `POST /api/episodes/:id/samples` queues at least one Sample. A refused request sends none.
- The call runs after the response (`waitUntil`) and stops after 5 s. A failed, refused or slow wake is logged without the secret. It never changes the client's response.
- Without `WORKER_WAKE_URL` there is no call. A Mac worker needs none: it polls `claim`.
- A missed wake is safe. The worker's own schedule (the Modal `sweep`, every 5 minutes) claims the job later.

## Storage keys (R2)

Every key starts with the owner's prefix, `users/<userId>/`. A media URL leaves the prefix out, because the feed token names the user: `/media/<feedToken>/episodes/<episodeId>/book.m4b` reads `users/<userId>/episodes/<episodeId>/book.m4b`.

- `users/<userId>/uploads/<episodeId>/<fileName>`
- `users/<userId>/episodes/<episodeId>/chapters/<index:000>.m4a`
- `users/<userId>/episodes/<episodeId>/chapters/<index:000>.json` (the timing file)
- `users/<userId>/episodes/<episodeId>/samples/<voice>.m4a` (the colon in the Voice ID is `%3A` in the media URL)
- `users/<userId>/episodes/<episodeId>/book.m4b`
- `users/<userId>/episodes/<episodeId>/transcript/<finishedAtMs>.vtt` (the transcript of the `Ready` that finished at that time, in ms since the epoch; the media path `episodes/<episodeId>/transcript.vtt` serves it)
- `users/<userId>/episodes/<episodeId>/cover.<ext>`
- `users/<userId>/documents/<episodeId>/<digest>.json` (the API selects one revision; revisions are kept until episode deletion)
- `users/<userId>/episodes/<episodeId>/document.json` (legacy Documents)

`DELETE /api/episodes/:id` checks the owner in D1 before it removes the media and Sample rows.
