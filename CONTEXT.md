# Fama domain language

Fama turns links, files and text into narrated audio for listening on the go.

| Term | Meaning |
|---|---|
| **Source** | What the user submits: a `Url`, a `Text`, or a `File` (PDF, EPUB). |
| **Document** | The clean text the worker extracts from a source: title, author, language, chapters. The worker uploads it after the first extraction, and the API stores it with the episode. |
| **Episode** | One narrated source in the library. The unit the user sees, plays, downloads, and finds in the feed. |
| **Chapter** | One audio file of an episode (AAC `.m4a`). Chapters upload one by one, so playback can start before the episode is done. A Document has chapters too: a title and its text. |
| **Book file** | One `.m4b` of the whole episode with chapter marks, for download and the feed. |
| **Job** | The state of the work that makes an episode: `Queued`, `Running`, `Ready`, `Failed`. Stored on the episode. |
| **Worker** | A process that pulls jobs from the API and makes the audio. Runs on the Mac (local) or Modal (cloud). Same Python package. |
| **Engine** | A TTS model family a worker can run: `kokoro`, `piper`, ... |
| **Voice** | One speaker of an engine, with a language. Written `engine:voiceId`, for example `kokoro:af_heart` or `piper:is_IS-salka-medium`. |
| **Feed** | The private podcast RSS feed of one user's ready episodes. Its URL holds the user's feed token. |
| **User** | The owner of episodes. A DIY server has exactly one; the managed service has many. Every episode, feed and stored file belongs to one user. |
| **Client token** | A bearer secret for the web and phone apps. It acts as one user on `/api/*`. A user can have many. |
| **Feed token** | The secret in the feed and media URLs of one user. It opens only `/feed/` and `/media/`. Rotating it closes the old URLs. |
| **Worker token** | The bearer secret of workers. It opens only `/api/worker/*`, for the jobs of all users. |
| **Lease** | One worker's claim on one job, proven by the lease token `claim` returns. Every job call carries it. A new claim makes the old lease useless. |

Rules:

- Each credential opens one set of routes: the client token the client API, the feed token the feed and media, the worker token the worker API. The code has no branch for DIY or managed; they differ only in how users and tokens are made.
- The worker owns extraction, language detection and synthesis. The API owns state and storage. Clients only talk to the API.
- When the user picks no voice, the worker picks the default voice for the detected language.
- The worker extracts a source one time. Each later attempt narrates from the stored Document.
- Audio chapter `i` narrates Document chapter `i`. No change may break this.
