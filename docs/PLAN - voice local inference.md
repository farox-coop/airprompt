# PLAN — Voice local inference (replacing Web Speech API)

## Context

AirPrompt's dictation currently uses the browser's **Web Speech API** (`SpeechRecognition` / `webkitSpeechRecognition`). It is a black box: audio is captured and transcribed by the browser's own engine (Google's cloud recognizer in Chrome/Chromium, Siri's engine on iOS), and AirPrompt only receives the final text. We have zero control over:

- **Pause/utterance segmentation** — the engine decides where fragments start and end, and it is unpredictable across Chrome desktop, Chrome Android, and iOS Safari. This directly hurts our dictation macros: a "fragment-level" macro (e.g. say `coma` standalone → `,`) only fires when the engine happens to segment it as its own utterance.
- **Word-level timestamps** — not available. We cannot detect real silences (e.g. silence > 500 ms = pause), only whatever the engine reports as final/partial results.
- **The audio path** — on Chrome the audio goes to a Google cloud endpoint; it never stays local.
- **Built-in dictation commands** — the recognizer pre-converts phrases into punctuation/newlines on its own (e.g. "nuevo párrafo" → `\n\n`, "nueva línea" → `\n`), inconsistently even mid-sentence. Our macro engine has to _revert_ these back to the literal words (`revertSttNewlines` in `public/dictation-macros.js`) so its own isolated-only macros decide — a workaround for behavior we can't disable.

This document explores replacing the Web Speech API with **local inference** so AirPrompt owns the audio, the segmentation, and the timestamps. It is research/planning only — no implementation is scheduled.

## Why local inference fixes the macro problem

The core pain point is pause detection. With local STT we can run our own **Voice Activity Detection (VAD)** and, when silence exceeds a threshold (e.g. 500 ms), treat that as a fragment boundary. That is exactly the model the dictation macros need:

1. User speaks a phrase.
2. VAD detects end-of-speech (silence > N ms) → emit the accumulated audio as one fragment.
3. Transcribe that fragment.
4. Feed the transcript to `processFragment()` — a standalone `coma` now reliably fires, and `nueva línea` stops firing mid-sentence.

Because we control VAD, segmentation becomes deterministic (tunable threshold) instead of browser-dependent.

## Candidate engines

### 1. whisper.cpp (and variants)

- C/C++ port of OpenAI Whisper, zero Python deps. Runs CPU, Apple Metal, CUDA, Vulkan/OpenCL.
- Has a `stream` / `whisper-stream` example for real-time mic input, with `--step 0` sliding-window mode + a basic energy-based VAD and `-vth` silence threshold. When silence is detected it transcribes the last `--length` ms and emits a block "suitable for parsing".
- **whisper.wasm** (Timur00Kh) — TypeScript wrapper running Whisper in-browser via WebAssembly, model cached in IndexedDB. Keeps everything client-side but model download is large and inference is slow in-browser.
- Word timestamps: whisper.cpp core gives segment-level; **whisperX** / **whisper-timestamped** add word-level timestamps + confidence.
- **faster-whisper** (CTranslate2) — 4–5× faster than original, int8 quantization, but Python-based.
- **whisper-mcp** — local-first MCP service on whisper.cpp (macOS/Linux) / faster-whisper (Windows), optional word timestamps, auto GPU/CPU.
- Trade-off: excellent accuracy (99 languages, auto punctuation), but **latency on CPU is high** — whisper-small ~2–5 s/sentence, medium 10–30 s on budget CPU. Real-time dictation needs a GPU or a tiny model.

### 2. Vosk (Kaldi-based)

- Offline toolkit, 20+ languages, Apache 2.0.
- **True streaming** with low latency; **native word-level timestamps + confidence** via a `set_words` option.
- Lightweight small models run on Raspberry Pi / embedded / browser (WebAssembly build exists).
- Trade-off: accuracy is below Whisper (worse with noise/accents), and **no automatic punctuation** (needs an external punctuation model — but note our dictation macros already inject punctuation by voice, so this matters less for us).

### 3. Sherpa-ONNX / ox-whisper

- **sherpa-onnx** is an ONNX runtime for speech: supports streaming, VAD (Silero), punctuation, speaker diarization, and runs on CPU/Android/iOS/Web.
- **ox-whisper** — self-hosted Rust HTTP/WS server on sherpa-onnx + Moonshine v2, OpenAI-compatible API, **word-level timestamps**, real-time WebSocket streaming, CPU-only on ARM64. This is a strong "run a local server, send audio over WS" option.

### 4. Silero VAD (component, not a full STT)

- A tiny ONNX model that classifies speech vs silence per ~30 ms frame, runs in <1 ms/frame. It is the standard way to add reliable VAD in front of any ASR.
- Pair Silero VAD with whisper.cpp/faster-whisper/Vosk to get deterministic pause segmentation.

## Quick comparison

|                 | Web Speech API (today) | Vosk          | whisper.cpp                 | faster-whisper | sherpa-onnx / ox-whisper |
| --------------- | ---------------------- | ------------- | --------------------------- | -------------- | ------------------------ |
| Local/offline   | No (Chrome → cloud)    | Yes           | Yes                         | Yes            | Yes                      |
| Streaming       | Yes (black box)        | Yes (native)  | Via stream example          | Via wrappers   | Yes                      |
| Word timestamps | No                     | Yes           | segment (word via whisperX) | via whisperX   | Yes                      |
| Pause control   | No                     | Yes (own VAD) | Basic VAD (`-vth`)          | via Silero VAD | Silero VAD built-in      |
| Accuracy        | Good                   | Average       | High                        | High           | High                     |
| Punctuation     | Auto                   | No            | Yes                         | Yes            | Yes                      |
| CPU latency     | n/a                    | Low           | High (small 2–5 s)          | Lower (int8)   | Low-mid                  |
| Languages       | ~all                   | ~20           | 99                          | 99             | multi                    |
| License         | n/a                    | Apache 2.0    | MIT                         | MIT            | varies                   |

## Architecture options

### A. Local STT server + WebSocket (recommended)

- AirPrompt daemon (Node) spawns/connects to a local STT server (ox-whisper, whisper.cpp server, or Vosk server).
- Browser captures mic via `getUserMedia` + `MediaRecorder`, streams PCM/Opus over the existing WS to the server.
- Server runs VAD, segments by silence, returns fragments with timestamps.
- AirPrompt feeds fragments to the existing `processFragment()` macro engine unchanged.

Pros: keeps browser thin, reuses AirPrompt's existing WS + daemon architecture, deterministic segmentation. Cons: needs a model + native binary per platform (install burden, docs, size).

### B. In-browser WASM (whisper.wasm / Vosk WASM)

- Load model in-browser, cache in IndexedDB, no server component.
- Pros: truly client-side, no daemon install. Cons: large model download, slow CPU inference in browser, memory pressure.

### C. Hybrid / fallback

- Keep Web Speech API as default, allow opting into a local STT server when available. Dictation macros behave identically — only segmentation improves.

## VAD segmentation design (target)

1. `getUserMedia` → capture raw audio chunks (~256 ms each).
2. Run Silero VAD on each chunk; track "speech started / silence started" state.
3. When silence ≥ 500 ms (configurable `--pause-ms`), close the current fragment and ship it to STT.
4. Transcribe → return text → `processFragment(text, lang)`.
5. Optionally use a max-fragment-duration fallback (e.g. 30 s) to avoid unbounded windows during continuous speech.

The 500 ms threshold is the key lever: make it match how a human naturally pauses between "coma" and the next word.

## Effort / risk

- **High effort**: native binary per platform, model download (base.en ~140 MB ggml, small Vosk ~40 MB), latency tuning, and reworking `dictation.js` to capture audio instead of using `SpeechRecognition`.
- **Medium-high risk**: iOS Safari has the most restrictive `getUserMedia`/audio-streaming constraints; a native mobile app (see `PLAN - expo mobile.md`) may be needed for full iOS support.
- The dictation macro engine (`public/dictation-macros.js`) is **already decoupled** — it operates on plain text, so swapping the STT front-end does not touch the macro logic.

## Decision

**Do not implement now.** The Web Speech API's unpredictability is acceptable for the current PoC (single user, LAN, local dev). The macro engine's fragment-level model is already the right abstraction; when we move to local inference, only the audio-capture/segmentation front-end changes.

Revisit when: iOS support becomes a priority, or pause-segmentation unreliability becomes a blocker.

## Sources

- [whisper.cpp stream example (VAD + sliding window)](https://github.com/ggml-org/whisper.cpp/blob/master/examples/stream/README.md)
- [whisper.wasm — in-browser Whisper via WebAssembly](https://github.com/timur00kh/whisper.wasm)
- [ox-whisper — local Rust STT server with word timestamps](https://github.com/anatolykoptev/ox-whisper)
- [whisper-mcp — local STT MCP service](https://github.com/bitfarer/whisper-mcp)
- [Vosk vs Whisper local guide](https://www.sinologic.net/en/2026-05/vosk-vs-whisper-local-the-ultimate-2026-guide-to-self-hosted-speech-recognition-stt.html)
- [openasr VAD windowing proposal (Silero VAD)](https://github.com/vbomfim/openasr/issues/10)
