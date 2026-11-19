# Voice bakeoff

Measured on 2026-11-18 on an Apple M5 Pro, with `bakeoff/run.py`. Raw numbers, transcripts and the misheard word lists are in `bakeoff/results.json` and `bakeoff/results-long.json`. Samples are in `~/Developer/fama-samples/<lang>/` (outside git).

## Defaults

| Language | Default | Why |
|---|---|---|
| English | `kokoro:af_heart` | 36x real time with 0.8% CER. Chatterbox Turbo is not clearly better (0.6% CER, inside the noise of one paragraph) and runs 4.5x real time, under the 5x bar. |
| Icelandic | `piper:is_IS-steinn-medium` | Lowest error rate of the commercially usable voices on both texts: 0.8% CER on the paragraph, 2.8% CER and 10.6% WER on the 1,947-word article. 75x real time, 64 MB, data under CC BY 4.0. |

Salka (`piper:is_IS-salka-medium`) is the runner-up and the best female voice: 1.0% and 3.9% CER. Ugla has the highest error rate on the long text (6.1% CER), and the ASR skipped a whole stretch of it.

## How it was measured

- **Text.** One ~80-word paragraph per language, with numbers, an ordinal date, a year and an abbreviation. Every candidate gets the text after Fama's own normalization and chunking (chunks of at most 400 characters, joined with 0.12 s of silence), so it reads what the worker would send it. The Piper voices also read the full Icelandic Wikipedia article on Reykjavík (1,947 words, 17 to 19 minutes of audio) because one paragraph is too small: one word is 1.2% WER.
- **Speed.** Warm timing: a warm-up call, then the best of two renders. RTF = synthesis seconds / audio seconds. "x real time" = 1 / RTF. Model load time is separate. Nothing else ran on the machine during the timed runs.
- **Quality, without listening.** An ASR model transcribes each sample: Whisper large-v3-turbo (MLX) for English, `language-and-voice-lab/whisper-large-icelandic-62640-steps-967h` for Icelandic. WER and CER compare the transcript with the input, after both pass through the same normalizer. Part of every error rate is the ASR's own error, and the ASR often joins two words ("varð verslunarstaður" → "varðverslunarstaður"), which counts as a word error but only one character. CER is the better signal. It catches mispronounced words, skipped words and babble; it does not judge prosody or voice quality. Somebody should still listen before this ships.

## Icelandic

Paragraph (~80 words):

| Model | License | Size MB | Load s | RTF | x real time | WER | CER | Words/min | Notes |
|---|---|---|---|---|---|---|---|---|---|
| piper `is_IS-steinn-medium` (male) | MIT code, CC BY 4.0 data | 64 | 0.2 | 0.0153 | 65.5 | 3.7% | 0.8% | 147 | "öld" heard as "öldu" |
| piper `is_IS-salka-medium` (female) | MIT code, CC BY 4.0 data | 64 | 0.6 | 0.0127 | 78.8 | 6.2% | 1.0% | 138 | "í Vesturbæjarlaug" heard as "í Austurbæjarlaug" |
| piper `is_IS-ugla-medium` (female) | MIT code, CC BY 4.0 data | 64 | 0.2 | 0.0145 | 69.2 | 3.7% | 1.6% | 158 | fastest speaker |
| piper `is_IS-bui-medium` (male) | MIT code, CC BY 4.0 data | 64 | 0.3 | 0.0164 | 60.9 | 8.6% | 2.5% | 146 | babble: "heitu pottarnir" heard as "heituðu pottdaldaðirnir" |
| facebook/mms-tts-isl | CC BY-NC 4.0 | 145 | 1.4 | 0.0743 | 13.5 | 9.9% | 2.0% | 122 | "lýðveldið" heard as "lígveldi", "Faxaflóa" as "Faxablóa"; slow speaker; CPU (torch VITS) |
| k2-fsa/OmniVoice (MLX bf16) | Apache-2.0 code, CC BY-NC weights | 2040 | 3.0 | 0.1207 | 8.3 | 7.4% | 0.8% | 139 | no fixed voice without a reference clip: each chunk can get a different speaker; longest pause 1.3 s |

Full Reykjavík article (1,947 words), Piper only:

| Voice | RTF | x real time | Audio min | WER | CER | Longest pause s |
|---|---|---|---|---|---|---|
| steinn | 0.0133 | 75.4 | 17.5 | 10.6% | 2.8% | 1.48 |
| salka | 0.0139 | 71.8 | 18.6 | 11.5% | 3.9% | 1.32 |
| bui | 0.0134 | 74.4 | 17.7 | 14.8% | 3.9% | 1.68 |
| ugla | 0.0135 | 74.3 | 16.5 | 15.8% | 6.1% | 1.56 |

Numbers: on the paragraph, no voice has a number in its misheard list (years, "140 þúsund", "sautjánda júní"). On the long text, most number misses are ASR word joins ("nítján hundruð" as "nítjánhundruð"); Salka once doubled a word ("nítján hundruð" heard as "nýtján hundruðhundruð"). The long run also found one normalizer bug, now fixed: "20. öld" became "tuttugastu öld"; correct is "tuttugustu öld" (-ast- turns into -ust- before -u). All four voices said it as written, so the ASR heard "tuttugustu" against a wrong reference.

What Piper's espeak-ng does with raw Icelandic text (checked with `PiperVoice.phonemize`), and why `normalize.py` handles numbers itself:

| Input | espeak reads | Fama sends |
|---|---|---|
| `1944` | nítján hundruð fjörutíu og fjögur | the same |
| `1786` | eitt þúsund sjö hundruð áttatíu og sex | sautján hundruð áttatíu og sex |
| `17. júní` | sautján júní (a cardinal) | sautjánda júní |
| `t.d.` | the letters "t d" | til dæmis |
| `25%` | tuttugu og fimm + an English-like "percent" | tuttugu og fimm prósent |
| `3,5` | þrír komma fimm | the same |

Newer espeak-ng also emits `#` for voiceless consonants such as the r in "þrjú". The voices were trained without that symbol, so Piper drops it. That is correct, so the worker silences the warning.

Considered and not run:

- **Talrómur FastSpeech2 (ESPnet, `language-and-voice-lab/talromur_*`, CC BY 4.0).** It needs X-SAMPA input from `ice-g2p`, a separate Style-MelGAN vocoder and an x-vector per speaker. `ice-g2p` 1.2.0 needs fairseq; it installs on Python 3.10 but fails to load its own model (`model_path` is None). It is a 2022 model trained on the same Talrómur recordings as the Piper voices, so it is older, not newer. Stopped at the 15-minute box.
- **fishaudio drama-3 (83 languages, lists Icelandic).** 24 GB even at 4-bit, Fish Audio community license. Too big for a narration worker, and not open for commercial use.
- **bosonai higgs-tts-3-4b (100 languages, lists Icelandic).** Research and non-commercial license.

## English

| Model | License | Size MB | Load s | RTF | x real time | WER | CER | Words/min | Notes |
|---|---|---|---|---|---|---|---|---|---|
| hexgrad/Kokoro-82M `af_heart` (torch, MPS) | Apache-2.0 | 327 | 2.7 | 0.0277 | 36.1 | 3.3% | 0.8% | 171 | all misses are spelling (metres, colourful) and the accent on Reykjavík |
| Chatterbox Turbo (MLX fp16) | MIT | 2990 | 10.1 | 0.2246 | 4.5 | 2.2% | 0.6% | 196 | misses are spelling only; fast talker; under the 5x bar |

Kokoro backend, same text, warm, best of three (`af_heart`):

| Backend | One call per paragraph | One call per sentence |
|---|---|---|
| torch `kokoro` on MPS | 36.9x real time | 32.9x real time |
| mlx-audio | 32.0x real time | 30.6x real time |
| torch `kokoro` on CPU | | 12.9x real time |

Torch on MPS is faster in both shapes, and it is the code path that runs on CUDA (Modal) too, so the worker keeps one Kokoro backend. The CPU number shows the MPS run used the GPU. One call per paragraph beats one per sentence, so the chunker packs sentences up to the engine limit.

## End to end

`fama make` on real sources, wall time including download, extraction, model load and encoding:

| Source | Voice | Chapters | Audio | Wall time | x real time |
|---|---|---|---|---|---|
| en.wikipedia.org Hallgrímskirkja (717 words) | kokoro:af_heart | 1 | 5 min 22 s | 28.8 s | 11x (model load dominates) |
| is.wikipedia.org Reykjavík (1,948 words) | piper:is_IS-salka-medium | 1 | 18 min 53 s | 22.5 s | 50x |
| Attention Is All You Need, arXiv PDF (5,814 words) | kokoro:af_heart | 8 | 49 min | not timed cleanly | |
| Alice's Adventures in Wonderland, Gutenberg EPUB (26,466 words) | kokoro:af_heart | 12 | 2 h 25 min | 9 min 26 s | 15x (shared the GPU with other runs) |
