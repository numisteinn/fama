# Worker makes an episode

The Mac worker pulls the oldest queued job, extracts the document, narrates it chapter by chapter, uploads each chapter as soon as it is done, then uploads the book file and marks the job Ready. The user sees the job move from `Queued` through `Reading`, `Narrating n/m`, `Encoding` and `Uploading` to a duration. When extraction fails, the row shows a plain reason and a `Retry` button. When a worker stops halfway, another worker takes the job after the lease runs out and skips the chapters that already exist.

## Sub-features

- `job-queued` shows `Queued` while no worker has claimed the job.
- `job-progress` shows the stage and `Narrating n/m` while the job runs.
- `job-chapters-stream` adds chapters while the job runs, so chapter 0 can play first.
- `job-ready` shows the duration and a playable row when the job is Ready.
- `job-failed` shows a plain failure reason and `Retry` for a link that does not exist.
- `job-retry` puts a failed job back to `Queued`, and the worker runs it again.
- `job-voices` registers the worker's voices, which fill the voice menus.
- `job-resume` lets a new worker take over a stale job after the 10-minute lease and skip finished chapters.

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
- **Chapters while running.** Add `harbour-days.epub` (two chapters) and poll `fama-verify api GET /api/episodes/<id>` every second. At least one read shows `Running` with one chapter in `chapters`.
- **Failed.** Add `http://localhost:8790/missing.html`. Run `preview_wait_for {text: "Retry", timeoutMs: 60000}`. The row keeps the provisional title `localhost:8790/missing.html`, shows the reason `The page returned 404 File not found.` in red (not a stack trace or an error tag; the text sits inside the disabled `Play` button, so check it with `preview_wait_for {text: ...}`, not with an alert or a name), and has buttons `Retry` and `Delete localhost:8790/missing.html`. `fama-verify wait <id>` starts with `Failed` and has the same reason.
- **Retry.** Choose `Retry`. The row goes back to `Queued`, then fails again with the same reason. `fama-verify api GET /api/episodes/<id>` shows a new `failedAt`.
- **Voice menu.** On the web, choose `Voice: Auto`. The menu lists the registered voices. On the iPhone, `$AD press 'label="Voice, Auto"'` lists the same voices.
- **Proof.** Save the series of status snapshots and the `wait` lines to `$EVIDENCE/worker/`. `down` copies `worker.log` to `$EVIDENCE/logs/`.

## Gotchas

- The worker caches synthesized chunks in `~/.cache/fama/chunks` by text, voice and speed. A second run of the same fixture is much faster and can skip visible stages. To see every stage, change the voice or the speed.
- The worker polls at least every 10 s when idle, so a job can stay `Queued` for up to 10 s after `fama-verify worker`.
- `job-resume` needs a stale lease of 10 minutes (`LEASE_MS`). It is not practical in a normal run. Prove it with the API and worker tests (`pnpm --filter @fama/api test`, `cd worker && uv run pytest`) unless the run is about leases.
- The web page asks for voices only when it loads. In a recorded run, saving the token refetched the library and the feed, but not `/api/voices`. After you save a new token, reload the tab before you check the voice menu.
- Only one worker should be pointed at 8788. A worker from another run would take jobs and make results confusing; `doctor` shows the worker this run started.
