# Fama domain language

Fama turns links, files and text into narrated audio for listening on the go.

| Term | Meaning |
|---|---|
| **Source** | What the user submits: a `Url`, a `Text`, or a `File` (PDF, EPUB). |
| **Document** | The clean text the worker extracts from a source: title, author, language, chapters. Lives only inside the worker. |
| **Episode** | One narrated source in the library. The unit the user sees, plays, downloads, and finds in the feed. |
| **Chapter** | One audio file of an episode (AAC `.m4a`). Chapters upload one by one, so playback can start before the episode is done. |
| **Book file** | One `.m4b` of the whole episode with chapter marks, for download and the feed. |
| **Job** | The state of the work that makes an episode: `Queued`, `Running`, `Ready`, `Failed`. Stored on the episode. |
| **Worker** | A process that pulls jobs from the API and makes the audio. Runs on the Mac (local) or Modal (cloud). Same Python package. |
| **Engine** | A TTS model family a worker can run: `kokoro`, `piper`, ... |
| **Voice** | One speaker of an engine, with a language. Written `engine:voiceId`, for example `kokoro:af_heart` or `piper:is_IS-salka-medium`. |
| **Feed** | The private podcast RSS feed of all ready episodes. Its URL holds a secret feed token. |

Rules:

- One user per deployment. The API token guards the API. The feed token guards the feed and audio URLs.
- The worker owns extraction, language detection and synthesis. The API owns state and storage. Clients only talk to the API.
- When the user picks no voice, the worker picks the default voice for the detected language.
