# Worker makes an episode

The Mac worker pulls the oldest queued job, extracts the document, narrates it chapter by chapter, uploads each chapter as soon as it is done, then uploads the book file and marks the job Ready. The user sees the job move from `Queued` through `Reading`, `Narrating n/m`, `Encoding` and `Uploading` to a duration. While it narrates, the row shows the time left once the worker has measured its speed: `Narrating · 25 s left`. When extraction fails, the row shows a plain reason and a `Retry` button. When a worker stops halfway, another worker takes the job after the lease runs out and skips the chapters that already exist. A cloud worker that sleeps is woken by the API each time a job becomes Queued.

## Sub-features

- `job-queued` shows `Queued` while no worker has claimed the job.
- `job-progress` shows the stage and `Narrating n/m` while the job runs.
- `job-time-left` shows `Narrating · <time> left` once the worker has an estimate. The time goes down from one heartbeat to the next and is close to the real time to Ready.
- `job-chapters-stream` adds chapters while the job runs, so chapter 0 can play first.
- `job-ready` shows the duration and a playable row when the job is Ready.
- `job-failed` shows a plain failure reason and `Retry` for a link that does not exist.
- `job-retry` puts a failed job back to `Queued`, and the worker runs it again.
- `job-voices` registers the worker's voices, which fill the voice menus.
- `job-resume` lets a new worker take over a stale job after the 10-minute lease and skip finished chapters.
- `job-wake` sends one `POST` to `WORKER_WAKE_URL` with `Authorization: Bearer <WORKER_WAKE_SECRET>` after a create, upload or retry stores a Queued job. A failed or slow wake never changes the client's response. No URL, no call.
- `job-lease` gives each claim its own lease token. Every job call needs it, the source read included, and a call with another token gets `409`. The worker token opens only `/api/worker/*`.

## How to get to it (user POV)

- Add any source (see [Add a link](./add-link.md) and [Add a file](./add-file.md)) and watch its row in the library, on the web or the iPhone.
- The user never starts the worker from the app. It runs on the Mac (`pnpm dev`, or `fama-verify worker` here).

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`, but launched with `fama-verify up --no-worker`, so the queued state can be seen.

- **Queued.** On the web, add `http://localhost:8790/article.html`. The row shows status `Queued`. `fama-verify api GET /api/episodes` shows `"job": {"_tag": "Queued"}`.
- **Start the worker.** Run `fama-verify worker`. It prints `worker ready` once voices are registered. `fama-verify api GET /api/voices` lists voices from engines `kokoro` and `piper`, including `piper:is_IS-steinn-medium`.
- **Progress.** Take `preview_snapshot` every second or two. The status passes `Reading`, `Narrating 1/1` or similar, `Encoding` and `Uploading`, and ends at a duration. A short fixture can pass a stage between two snapshots; record the stages that were seen.
- **Ready.** Run `fama-verify wait <id>`. The output starts with `Ready`, with `durationMs` above 0 and a `bookUrl`. The worker log in `$TMPDIR/fama-verify/worker.log` has `<id>: ready, ...s in 1 chapters`.
- **Time left.** With the worker running, add `harbour-year.epub` (four chapters, 62 chunks, about 80 s of work on the Mac). Before you add it, start a recorder in the page with `preview_evaluate`: a `setInterval` of 250 ms that pushes `[Date.now(), li.innerText]` for the `Harbour Year` row whenever the text changes. Also poll `fama-verify api GET /api/episodes` every second into a file, with `job.remainingMs`, `job.heartbeatAt` and `job.finishedAt`. The row goes `Narrating 0/62`, `Narrating 1/62` (the first chunk loads the model), then `Narrating · 1 min left` and a falling count in seconds, then the duration. For each heartbeat, compare `remainingMs` with `finishedAt − heartbeatAt`. Recorded on 2026-11-24: 11 estimates, each lower than the one before; the first was 8.5 s above the real 56.7 s, and from the third on they were within 5 s. Take `preview_snapshot {save: true}` while the row shows a time. A second run of the same fixture comes from the chunk cache and shows no time: pick another speed first.
- **Chapters while running.** Add `harbour-days.epub` (two chapters) and poll `fama-verify api GET /api/episodes/<id>` every second. At least one read shows `Running` with one chapter in `chapters`.
- **Failed.** Add `http://localhost:8790/missing.html`. Run `preview_wait_for {text: "Retry", timeoutMs: 60000}`. The row keeps the provisional title `localhost:8790/missing.html`, shows the reason `The page returned 404 File not found.` in red (not a stack trace or an error tag; the text sits inside the disabled `Play` button, so check it with `preview_wait_for {text: ...}`, not with an alert or a name), and has buttons `Retry` and `Delete localhost:8790/missing.html`. `fama-verify wait <id>` starts with `Failed` and has the same reason.
- **Retry.** Choose `Retry`. The row goes back to `Queued`, then fails again with the same reason. `fama-verify api GET /api/episodes/<id>` shows a new `failedAt`.
- **Voice menu.** On the web, choose `Voice: Auto`. The menu lists the registered voices. On the iPhone, `$AD press 'label="Voice, Auto"'` lists the same voices.
- **Wake.** Start a sink that logs requests: `python3 -m http.server 8791 --bind 127.0.0.1 >"$EVIDENCE/worker/wake-sink.log" 2>&1 &` (it answers `POST` with `501`, which is fine). Run `FAMA_VERIFY_WAKE_URL=http://127.0.0.1:8791/wake fama-verify up --no-worker`. Add a link on the web. The sink log has one `"POST /wake HTTP/1.1" 501` line, the add bar shows no error, and `$TMPDIR/fama-verify/api.log` has `worker wake answered 501`. Stop the sink and add another link: the row still appears, and `api.log` has `worker wake failed`. The secret header is proven by the API tests (`worker wake` in `apps/api/src/http.test.ts`), not here.
- **Proof.** Save the series of status snapshots and the `wait` lines to `$EVIDENCE/worker/`. `down` copies `worker.log` to `$EVIDENCE/logs/`.

## Gotchas

- The worker sends a time left only while it narrates, and only after it has measured five chunks that the engine made (not from the cache, not the first one, which loads the model). The short fixtures end before that, so they show `Narrating n/m` only. That is correct.
- The worker caches synthesized chunks in `~/.cache/fama/chunks` by text, voice and speed. A second run of the same fixture is much faster and can skip visible stages. To see every stage, change the voice or the speed.
- The worker polls at least every 10 s when idle, so a job can stay `Queued` for up to 10 s after `fama-verify worker`.
- `job-resume` and `job-lease` need a second worker or a stale lease of 10 minutes (`LEASE_MS`). They are not practical in a normal run. Prove it with the API and worker tests (`pnpm --filter @fama/api test`, `cd worker && uv run pytest`) unless the run is about leases.
- The web page asks for voices only when it loads. In a recorded run, saving the token refetched the library and the feed, but not `/api/voices`. After you save a new token, reload the tab before you check the voice menu.
- `fama-verify up` sets no wake URL unless `FAMA_VERIFY_WAKE_URL` is set. Never point it at a real Modal app: verify-fama stays local.
- Only one worker should be pointed at 8788. A worker from another run would take jobs and make results confusing; `doctor` shows the worker this run started.
