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

Torch on MPS is faster in both shapes, and it is the code path that runs on CUDA (Modal) too, so the worker keeps one Kokoro backend. The CPU number shows the MPS run used the GPU. One call per paragraph beats one per sentence. The worker makes one call for each sentence all the same, because read-along needs the start time of each sentence. The next section has the cost.

## One call for each sentence

Measured on 2026-11-24 on an Apple M5 Pro, with `bakeoff/sentence_cost.py`. Read-along needs the time each sentence starts, so the worker makes one synthesis call for each sentence (a Segment). Before, it packed the sentences of a paragraph into one call of up to 400 characters. This is what the change costs. "x" is audio seconds per wall second inside `engine.synthesize`.

| Engine and voice | Text | Calls | Packed | By sentence | Slower |
|---|---|---|---|---|---|
| Kokoro `af_heart` (torch, MPS) | Hallgrímskirkja article, 717 words | 21 to 41 | 31.0x | 26.6x | 14% |
| Kokoro `af_heart` (torch, MPS) | Alice in Wonderland, chapter 1, 2,157 words | 49 to 73 | 31.0x | 27.4x | 12% |
| Piper `is_IS-steinn-medium` (ONNX, CPU) | Reykjavík article, 1,947 words | 57 to 141 | 69.7x | 69.5x | 0%, inside the noise |

- **Method.** No chunk cache. Each run is a new process: it loads the model, reads a warm-up text, then reads the text once. The runs alternate between the two shapes, and the table has the median of 7 runs for each shape (5 for Alice and for Piper). Both shapes read the same words. Wall time of the runs: Kokoro article 10.0 to 14.6 s packed and 11.9 to 14.3 s by sentence, Alice 21.6 to 22.0 s and 24.2 to 26.7 s, Piper 14.5 to 15.5 s and 14.7 to 15.9 s. Other agents used the machine at the same time, which gives the outliers.
- **Why a new process.** On MPS the first Kokoro call with a new input length is slower than a repeat of it. A second read of the same text in the same process took 9.3 s packed and 10.5 s by sentence, which hides part of the cost. An episode is all new text, so the first read is the number that counts.
- **What limits Kokoro.** A fixed cost for each call: 89 ms on the article and 120 ms on Alice, on new text. That is as much as 3 to 4 s of audio costs. It is inside model inference. G2P takes 0.1 s of the 12 s. So the cost follows the number of extra calls. Long paragraphs of short sentences cost most. Dialogue with one line for each paragraph costs nothing, because a call never crossed a paragraph. English text with sentences as short as in the Reykjavík article (141 calls in place of 57) would be about 20% slower (computed from the fixed cost, not measured).
- **What limits Piper.** Nothing changes for it. Piper splits its input into sentences and synthesizes each one alone, so its work is the same in both shapes.
- **Sound.** Kokoro opens each call with 0.31 s of silence and closes it with 0.51 s (median of 40 calls). Its own pause between two sentences inside one call is 0.53 s on Alice and 0.67 s on the article (median). With one call for each sentence, each sentence pause would be 0.3 s longer. So the worker drops the opening silence of a Segment that continues a paragraph and puts 0.2 s after the closing silence. The whole article is then 323.6 s by sentence and 321.9 s packed. Piper opens with 0.04 s (median) and sometimes with 1 s, the likely source of the 1.5 s pauses in the Piper table above. Those are gone inside a paragraph. The Reykjavík article is 1050.4 s by sentence and 1063.2 s packed.
- **Listen.** `~/Developer/fama-samples/read-along/<text>/<voice>-packed.wav` and `<voice>-sentence.wav` hold the first four paragraphs in both shapes. Whisper scores the sentence version the same or better (CER: Alice 0.0% for both, Reykjavík 1.4% by sentence and 3.3% packed, Hallgrímskirkja 3.9% by sentence; the packed Hallgrímskirkja file made Whisper repeat one line at its end, so that score says nothing). Somebody should still listen.
- **Decision.** Both engines stay under the roadmap limit of 20%, so both use one call for each sentence. The other path, sentence times from Kokoro's token timestamps inside packed calls, was not needed. It also exists only for the English voices: `KPipeline` returns tokens for `lang_code` `a` and `b` only. If Kokoro gets too slow on a kind of text, raise `MIN_CHARS` in `chunk.py`: sentences under that length share a call, and a mark.

## End to end

`fama make` on real sources, wall time including download, extraction, model load and encoding:

| Source | Voice | Chapters | Audio | Wall time | x real time |
|---|---|---|---|---|---|
| en.wikipedia.org Hallgrímskirkja (717 words) | kokoro:af_heart | 1 | 5 min 22 s | 28.8 s | 11x (model load dominates) |
| is.wikipedia.org Reykjavík (1,948 words) | piper:is_IS-salka-medium | 1 | 18 min 53 s | 22.5 s | 50x |
| Attention Is All You Need, arXiv PDF (5,814 words) | kokoro:af_heart | 8 | 49 min | not timed cleanly | |
| Alice's Adventures in Wonderland, Gutenberg EPUB (26,466 words) | kokoro:af_heart | 12 | 2 h 25 min | 9 min 26 s | 15x (shared the GPU with other runs) |
