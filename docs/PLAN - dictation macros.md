# Dictation Macros — Voice Formatting & Punctuation

## Context & Research

AirPrompt's voice dictation uses the browser Web Speech API (`SpeechRecognition`). Currently, transcribed text is accumulated as a raw string and sent verbatim to the PTY. There is no post-processing.

**Industry name**: "dictation commands" (also "voice formatting commands", "voice macros"). Used by Dragon NaturallySpeaking, Google Voice Typing, Apple Dictation, nVoq, MacParakeet, Dictee, Murmure. Google Voice Typing distinguishes commands from dictation by **pauses** — you pause before and after saying a command.

**Our term**: "dictation macros" — triggers that control formatting or inject punctuation.

Two macro types:

| Type                  | Example                                                                        | Behavior                                       |
| --------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| **Inline**            | "hola signo de pregunta" → `hola?`                                             | Replaced in-place within a continuous fragment |
| **Stateful/fragment** | say "entre comillas" as standalone fragment → next fragment wrapped in `"..."` | Affects subsequent text                        |

The entire pipeline is client-side (browser, `public/dictation.js`). No server changes needed. The transcribed text sits in the overlay until user taps Accept — we post-process before `_send()`.

## Architecture

### New module: `public/dictation-macros.js`

Pure functions, zero DOM dependencies. Exposes via `window.DictationMacros`:

- **Macro registry** — per-language maps of trigger phrases → actions (sorted longest-first to prevent partial matches)
- **`processFragment(segment, lang)`** → `{ type: 'text'|'macro', text?, format? }` — checks if a standalone fragment is a stateful macro
- **`applyInline(text, lang)`** → text with all inline replacements applied (regex word-boundary)
- **`applyFormat(text, format)`** → text wrapped/transformed per format type

### Integration into `public/dictation.js`

**Hook point**: the `onresult` handler's merge into `dictationAccumulator` (lines 263-273). Currently detects cumulative vs. new-segment via `localeCompare`. When a new non-cumulative segment is detected (line 267 `else if` branch), we intercept:

1. Compute the delta between `running` and the current `dictationAccumulator` (the new fragment text)
2. Run `processFragment(delta, currentLang)`
3. If macro → set `_pendingFormat`, do NOT update `dictationAccumulator` (macro consumed silently)
4. If text + `_pendingFormat` active → apply format, update accumulator, clear format
5. Safeguard: `applyInline(text, currentLang)` run on the full text in `acceptDictation()`/`acceptAndSend()` before sending

**New state** (added to existing state block, ~line 14):

```javascript
let _pendingFormat = null; // string|null — format to apply to next text fragment
```

**Reset on START** in `toggleDictation()` (line 354 area):

```javascript
_pendingFormat = null;
```

**Load order**: add `<script src="dictation-macros.js">` before `dictation.js` in `index.html`.

## Macro registry

```javascript
const DICTATION_MACROS = {
  'es-AR': {
    inline: [
      { trigger: 'puntos suspensivos', replace: '…' },
      { trigger: 'abre paréntesis', replace: '(' },
      { trigger: 'cierra paréntesis', replace: ')' },
      { trigger: 'signo de pregunta', replace: '?' },
      { trigger: 'signo de exclamación', replace: '!' },
      { trigger: 'punto y coma', replace: ';' },
      { trigger: 'dos puntos', replace: ':' },
      { trigger: 'nuevo párrafo', replace: '\n\n' },
      { trigger: 'nueva línea', replace: '\n' },
      { trigger: 'punto', replace: '.' },
      { trigger: 'coma', replace: ',' },
      { trigger: 'guion', replace: '-' },
    ],
    stateful: [
      { trigger: 'entre comillas', format: 'quotes' },
      { trigger: 'en mayúsculas', format: 'uppercase' },
      { trigger: 'todo mayúsculas', format: 'allcaps' },
    ],
  },
  'en-US': {
    inline: [
      { trigger: 'ellipsis', replace: '…' },
      { trigger: 'open parenthesis', replace: '(' },
      { trigger: 'close parenthesis', replace: ')' },
      { trigger: 'question mark', replace: '?' },
      { trigger: 'exclamation point', replace: '!' },
      { trigger: 'semicolon', replace: ';' },
      { trigger: 'colon', replace: ':' },
      { trigger: 'new paragraph', replace: '\n\n' },
      { trigger: 'new line', replace: '\n' },
      { trigger: 'period', replace: '.' },
      { trigger: 'comma', replace: ',' },
      { trigger: 'dash', replace: '-' },
    ],
    stateful: [
      { trigger: 'in quotes', format: 'quotes' },
      { trigger: 'uppercase', format: 'uppercase' },
      { trigger: 'all caps', format: 'allcaps' },
    ],
  },
};
```

Formats: `quotes` → `"${text}"`, `uppercase` → first char uppercase, `allcaps` → `.toUpperCase()`.

## Files changed

| File                          | Action     | Est. lines          |
| ----------------------------- | ---------- | ------------------- |
| `public/dictation-macros.js`  | **CREATE** | ~120                |
| `public/dictation.js`         | MODIFY     | ~25 changed / added |
| `public/index.html`           | MODIFY     | +1 `<script>` line  |
| `test/unit/dictation.test.js` | MODIFY     | ~100 added          |

## Edge cases handled

1. **Partial match**: "dije entre comillas después" → NOT a macro (the fragment must be EXACTLY the trigger phrase, trimmed + case-insensitive)
2. **Longest match first**: sort triggers descending by length → "punto y coma" matches before "punto"
3. **Inline within text**: embedded macros use regex `\b` word boundary to avoid matching inside words
4. **Consecutive stateful macros**: last one wins (overwrites `_pendingFormat`)
5. **Cancel after macro**: cancelling dictation resets `_pendingFormat` (via dismissOverlay)
6. **Language switch mid-recording**: `_pendingFormat` is reset in `setLang()` restart path
7. **Empty/whitespace fragment after macro**: treated as plain text, formatted normally

## Difficulty: Easy

Core logic is ~120 lines of pure JS (dictionary lookup + regex). Integration touches ~25 lines in `dictation.js` at a single well-understood hook point. No server changes. No new dependencies. No audio changes. The main risk is getting the delta extraction right in the `onresult` merge — but the existing code is thoroughly tested (1151-line test file).

## Verification

1. `make -C /home/diego/projects/airprompt test-all` — all existing + new macro tests pass
2. Manual smoke test:
   - Dictate `hola signo de pregunta` → overlay shows `hola?`
   - Dictate `entre comillas` as standalone fragment → overlay does NOT show it (macro consumed)
   - Dictate `mundo` → overlay shows `"mundo"` (format applied)
   - Accept → terminal receives `hola? "mundo"`

## Known issue — multi-line dictation collapses in Claude Code

**Symptom.** Dictation that produces literal newlines — the "nueva línea" / "nuevo párrafo" macros, or STT-inserted line breaks that survive — reaches the Claude Code prompt as a collapsed `[Pasted text #N +M lines]` chip instead of visible inline text. The user cannot see or edit the full text in the prompt.

**Root cause.** Multi-line input must be delivered as a paste so the newlines stay literal; a raw `\n` byte to the shell is Enter and would submit mid-text. The chain:

1. `dictation-macros.js` `processFragment()` inserts `\n` / `\n\n` for the "nueva línea" / "nuevo párrafo" stateful macros.
2. `dictation.js` `acceptDictation()` sends `{ type: 'input', data: text }` with those newlines intact.
3. `server.js` detects `\n` and routes to `tmux load-buffer` + `paste-buffer -p` (bracketed paste) instead of `ptyProcess.write()`.
4. Claude Code's TUI receives a bracketed paste longer than 2 lines or 800 chars and collapses it into a placeholder chip.

The collapse is hardcoded in Claude Code: there is no `pasteCollapseThreshold` / `paste.fold` setting or env var (feature requests [#35581](https://github.com/anthropics/claude-code/issues/35581) and [#55329](https://github.com/anthropics/claude-code/issues/55329) are open). The threshold is >800 chars or >2 lines.

**Not data loss.** The full text is stored in `~/.claude/paste-cache/` (mode 600) and sent intact on Enter. To expand in place, paste the same content again (v2.1.116+; before v2.1.207 re-pasting made a second chip). Ctrl+G opens the prompt in `$EDITOR` with every chip expanded.

**Why AirPrompt can't fix it.** Every delivery mechanism for multi-line text is a paste, and Claude Code collapses all pastes:

| Approach | Result |
| --- | --- |
| Manual bracketed paste via `pty.write('\x1b[200~'+text+'\x1b[201~')` | Same collapse — no benefit over `paste-buffer -p` |
| `tmux send-keys -l` literal typing | Literal `\n` = Enter = submits mid-text |
| Bracketed-paste mode toggle (`ESC[?2004l` … `ESC[?2004h`) | Claude Code ignores DEC 2004 and detects paste by byte-arrival rate → still collapses |
| Slow keystroke replay to evade the arrival-rate heuristic | Slow and fragile for long dictation |

The only mechanism that reliably avoids the collapse is single-line output (no `\n`), which loses real line breaks.

**Options (deferred — left as-is for now):**

1. Keep `\n` and accept the collapse — text arrives intact, just as a chip.
2. Single-line join — replace `\n` / `\n\n` with a visible separator so dictation is always visible inline; loses real newlines.
3. Threshold-aware — emit real `\n` only for "nuevo párrafo", and keep newlines ≤2 and total ≤800 chars; brittle.

**Side note.** `paste-buffer` is safer than a raw node-pty bracketed-paste frame: node-pty <1.1.0 has a partial-write bug that drops the closing `ESC[201~` for multi-byte/CJK text. If anyone swaps to a raw write, chunk at safe boundaries and never split a marker mid-sequence.

Sources: [Claude Code #35581](https://github.com/anthropics/claude-code/issues/35581), [Claude Code #55329](https://github.com/anthropics/claude-code/issues/55329), [chroxy #4270 bracketed-paste toggle](https://github.com/blamechris/chroxy/pull/4270), [chroxy #151 multiline paste](https://github.com/blamechris/chroxy/issues/151), [node-pty CJK partial-write bug](https://forum.cursor.com/t/integrated-terminal-hard-freezes-tui-apps-when-pasting-cjk-text-over-1-kib-bundled-node-pty-1-1-0-beta42-never-closes-the-bracketed-paste-frame-fixed-upstream-in-node-pty-1-1-0-stable/168491).
