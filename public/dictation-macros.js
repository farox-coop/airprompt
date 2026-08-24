// public/dictation-macros.js — Voice dictation macros (formatting & punctuation).
// Exports window.DictationMacros with processFragment/applyInline/applyFormat.

(function() {
  'use strict';

  // ── Macro registry ──────────────────────────────────────────────────────
  // Each entry has a `trigger` (string or array of aliases). Arrays
  // support regional variants (e.g. Argentine "abrí" vs neutral "abre").
  // Inline entries sorted longest-trigger-first to prevent partial matches.
  // Accented triggers MUST use RegExp with [aá]/[eé]/[ií]/[oó]/[uú] classes —
  // never plain strings — so accent-dropping by the recognizer still matches.

  const MACROS = {
    'es-AR': {
      inline: [
        { trigger: [/(abre|abr[ií]) par[eé]ntesis/i],   replace: '(' },
        { trigger: [/([cs]ierra|[cs]err[aá]) par[eé]ntesis/i], replace: ')' },
        { trigger: 'signo de pregunta',         replace: '?', onEnd: true },
        { trigger: [/signo de exclamaci[oó]n/i, /signo de admiraci[oó]n/i], replace: '!', onEnd: true },
        // Quote/tic inline — regex handles all singular/plural + voseo variants
        { trigger: [/(abre|abr[ií]) comillas? simples?/i],  replace: "'", open: true },
        { trigger: [/([cs]ierra|[cs]err[aá]) comillas? simples?/i], replace: "'", close: true },
        { trigger: [/(abre|abr[ií]) comillas?\b(?!\s+simples?)/i],   replace: '"', open: true },
        { trigger: [/([cs]ierra|[cs]err[aá]) comillas?\b(?!\s+simples?)/i], replace: '"', close: true },
        { trigger: [/(abre|abr[ií]) tics?/i],        replace: '`', open: true },
        { trigger: [/([cs]ierra|[cs]err[aá]) tics?/i],     replace: '`', close: true },
      ],
      stateful: [
        // Fragment-level single-char inserts (standalone only — won't match inside longer text)
        { trigger: [/^punto$/i],                insert: '.' },
        { trigger: [/^coma$/i],                 insert: ',' },
        { trigger: [/^gui[oó]n(?:es)?$/i],       insert: '-' },
        { trigger: [/^nueva l[ií]nea$/i],        insert: '\n' },
        { trigger: [/^nuevo p[aá]rrafo$/i],      insert: '\n\n' },
        { trigger: [/^puntos suspensiv[oó]s$/i], insert: '…' },
        { trigger: [/^punto y coma$/i],          insert: ';' },
        { trigger: [/^dos puntos$/i],            insert: ':' },
        // Standalone parens/quote/tic — same chars as inline, fragment-safe
        { trigger: [/^(abre|abr[ií]) par[eé]ntesis$/i], insert: '(' },
        { trigger: [/^([cs]ierra|[cs]err[aá]) par[eé]ntesis$/i], insert: ')' },
        // Wrapping macros
        { trigger: [/entre comillas?/i],         format: 'quotes' },
        { trigger: [/entre comillas? simples?/i], format: 'squotes' },
        { trigger: [/entre tics?/i],             format: 'bticks' },
        { trigger: [/entre par[eé]ntesis/i],     format: 'parens' },
        { trigger: [/^en may[uú]sculas?$/i],     format: 'uppercase' },
        { trigger: [/^todo( en)? may[uú]sculas?$/i], format: 'allcaps' },
      ],
    },
    'en-US': {
      inline: [
        { trigger: [/open (?:parenthesis|paren)/i], replace: '(' },
        { trigger: [/close (?:parenthesis|paren)/i], replace: ')' },
        { trigger: 'question mark',             replace: '?', onEnd: true },
        { trigger: 'exclamation point',         replace: '!', onEnd: true },
        // Quote/tic inline — regex handles singular/plural variants
        { trigger: [/(open|begin) single quotes?/i], replace: "'", open: true },
        { trigger: [/(close|end) single quotes?/i],  replace: "'", close: true },
        { trigger: [/(open|begin) quotes?/i],   replace: '"', open: true },
        { trigger: [/(close|end) quotes?/i],    replace: '"', close: true },
        { trigger: [/(open|begin) backticks?/i], replace: '`', open: true },
        { trigger: [/(close|end) backticks?/i], replace: '`', close: true },
      ],
      stateful: [
        { trigger: [/^period$/i],               insert: '.' },
        { trigger: [/^comma$/i],                insert: ',' },
        { trigger: [/^dash(?:es)?$/i],          insert: '-' },
        { trigger: [/^new lines?$/i],           insert: '\n' },
        { trigger: [/^new paragraphs?$/i],      insert: '\n\n' },
        { trigger: [/^ellipsis$/i],             insert: '…' },
        { trigger: [/^semicolon$/i],            insert: ';' },
        { trigger: [/^colon$/i],                insert: ':' },
        { trigger: [/in quotes?/i],             format: 'quotes' },
        { trigger: [/in single quotes?/i],       format: 'squotes' },
        { trigger: [/in backticks?/i],           format: 'bticks' },
        { trigger: [/in parens?/i],              format: 'parens' },
        { trigger: [/^uppercase$/i],             format: 'uppercase' },
        { trigger: [/^all caps$/i],              format: 'allcaps' },
      ],
    },
  };

  // ── Helpers ─────────────────────────────────────────────────────────────

  // Normalize a trigger field to an array of strings (regex entries left as-is).
  function triggers(entry) {
    const t = entry.trigger;
    if (t instanceof RegExp) return [t];
    return Array.isArray(t) ? t : [t];
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Strip leading/trailing spaces (and tabs) — not newlines, so the
  // recognizer's "\n\n" for "nuevo párrafo" survives to be reverted.
  function trimSpaces(str) {
    return str.replace(/^[ \t]+|[ \t]+$/g, '');
  }

  // The recognizer has its own dictation commands: it transcribes "nuevo párrafo"
  // (or "new paragraph") as "\n\n" and "nueva línea" (or "new line") as "\n" —
  // inconsistently, even mid-sentence. Revert them to the literal phrases (in the
  // current language) so our own isolated-only macros decide.
  function revertSttNewlines(text, lang) {
    const para = (lang === 'es-AR') ? 'nuevo párrafo' : 'new paragraph';
    const line = (lang === 'es-AR') ? 'nueva línea' : 'new line';
    return text
      .replace(/\n{2,}/g, ' ' + para + ' ')
      .replace(/\n/g, ' ' + line + ' ')
      .replace(/ +/g, ' ')
      .trim();
  }

  // Extract the "new" part of a cumulative transcript (per result index).
  // Returns '' when unchanged — including accent/case corrections, which the
  // recognizer emits as a different string for the same words ("parrafo"→"párrafo").
  function extractDelta(transcript, prev) {
    prev = prev || '';
    if (!prev) return trimSpaces(transcript);
    if (transcript.localeCompare(prev, undefined, { sensitivity: 'base' }) === 0) return '';
    if (transcript.length > prev.length &&
        transcript.slice(0, prev.length).localeCompare(prev, undefined, { sensitivity: 'base' }) === 0) {
      return trimSpaces(transcript.slice(prev.length));
    }
    return trimSpaces(transcript);
  }

  // ── Trigger/display helpers ────────────────────────────────────────────
  // Convert a regex source to plain "direct text" for display: strip
  // anchors, group delimiters, and quantifiers; collapse char classes
  // ([aá]→á, [cs]→c — accented variant preferred, else first char).
  function regexToText(source) {
    let s = source;
    s = s.replace(/^\^/, '').replace(/\$$/, '');   // ^…$ anchors
    s = s.replace(/\(\?[=!][^)]*\)/g, '');           // (?=…) / (?!…) lookarounds — assertions, not text
    s = s.replace(/\(\?:/g, '');                     // non-capturing openers
    s = s.replace(/\(/g, '').replace(/\)/g, '');     // group delimiters
    s = s.replace(/[?*+]/g, '');                     // quantifiers
    s = s.replace(/\\[bBdDsSwW]/g, '');              // \b \s \d \w … escape classes
    s = s.replace(/\[([^[\]]*)\]/g, function (m, inner) {
      const acc = inner.match(/[áéíóúÁÉÍÓÚ]/);
      return acc ? acc[0] : inner.charAt(0);
    });
    return s;
  }

  // Human-readable trigger text for a macro entry. Multiple aliases are
  // joined with "|" after eliding their shared word-boundary prefix, so
  // ["signo de exclamación", "signo de admiración"] → "signo de exclamación|admiración".
  function directText(entry) {
    const texts = triggers(entry).map(function (alias) {
      return alias instanceof RegExp ? regexToText(alias.source) : alias;
    });
    if (texts.length < 2) return texts[0] || '';
    let prefix = texts[0];
    for (let i = 1; i < texts.length; i++) {
      while (texts[i].slice(0, prefix.length) !== prefix) {
        prefix = prefix.slice(0, prefix.length - 1);
        if (!prefix) break;
      }
      if (!prefix) break;
    }
    const cut = prefix.lastIndexOf(' ');
    const head = cut === -1 ? prefix : prefix.slice(0, cut + 1);
    return head + texts.map(function (txt) { return txt.slice(head.length); }).join('|');
  }

  // Human-readable value for a macro entry's replace|insert|format.
  function valueLabel(entry) {
    if (entry.insert !== undefined) {
      if (entry.insert === '\n') return '↵';
      if (entry.insert === '\n\n') return '↵↵';
      return entry.insert;
    }
    if (entry.replace !== undefined) return entry.replace;
    if (entry.format !== undefined) {
      const map = {
        quotes: '"…"', squotes: "'…'", bticks: '`…`', parens: '(…)',
        uppercase: 'Aa', allcaps: 'AA',
      };
      return map[entry.format] || entry.format;
    }
    return '';
  }

  // Language-agnostic identity for a macro: category + effect. Equivalent
  // macros across languages (es "abre paréntesis" / en "open parenthesis")
  // share one key, so a single toggle applies to every language.
  function entryKey(category, entry) {
    if (entry.replace !== undefined) {
      let key = category + ':replace:' + entry.replace;
      if (entry.onEnd) key += ':end';
      else if (entry.open) key += ':open';
      else if (entry.close) key += ':close';
      return key;
    }
    if (entry.insert !== undefined) {
      // Standalone paren inserts are the same spoken macro as their inline
      // replace counterparts — share one key so a single toggle covers both.
      if (entry.insert === '(' || entry.insert === ')') {
        return 'inline:replace:' + entry.insert;
      }
      return category + ':insert:' + entry.insert;
    }
    if (entry.format !== undefined) return category + ':format:' + entry.format;
    return '';
  }

  // ── Macro preferences (enable/disable) ─────────────────────────────────
  // Stored as a DISABLED set (default: everything enabled) plus one global
  // master flag. Keys carry no lang, so a toggle set in Spanish applies to
  // the equivalent English macro too. localStorage is guarded so unit tests
  // (no localStorage) fall back to in-memory state.

  const PREFS_DISABLED_KEY = 'airprompt-macro-disabled';
  const PREFS_GLOBAL_KEY = 'airprompt-macro-all';

  let _disabled = loadDisabled();
  let _globalEnabled = loadGlobal();

  function loadDisabled() {
    try {
      const raw = localStorage.getItem(PREFS_DISABLED_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch (_) {}
    return [];
  }

  function loadGlobal() {
    try {
      if (localStorage.getItem(PREFS_GLOBAL_KEY) === 'false') return false;
    } catch (_) {}
    return true;
  }

  function saveDisabled() {
    try { localStorage.setItem(PREFS_DISABLED_KEY, JSON.stringify(_disabled)); } catch (_) {}
  }

  function isMacroDisabled(key) {
    return _disabled.indexOf(key) !== -1;
  }

  function isEnabled(category, entry) {
    if (!_globalEnabled) return false;
    return !isMacroDisabled(entryKey(category, entry));
  }

  function setEnabledByKey(key, enabled) {
    const idx = _disabled.indexOf(key);
    if (enabled && idx !== -1) _disabled.splice(idx, 1);
    else if (!enabled && idx === -1) _disabled.push(key);
    saveDisabled();
  }

  function getGlobalEnabled() { return _globalEnabled; }

  function setGlobalEnabled(v) {
    _globalEnabled = !!v;
    try { localStorage.setItem(PREFS_GLOBAL_KEY, JSON.stringify(_globalEnabled)); } catch (_) {}
  }

  function resetPrefs() {
    _disabled = [];
    _globalEnabled = true;
    saveDisabled();
    setGlobalEnabled(true);
  }

  function getMacroList(lang) {
    const cfg = MACROS[lang] || MACROS['en-US'];
    const out = [];
    const seen = new Set();
    ['inline', 'stateful'].forEach(function (category) {
      const entries = cfg[category];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const key = entryKey(category, entry);
        // Inline + standalone paren share a key — list the macro once.
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          key: key,
          category: category,
          triggerText: directText(entry),
          valueLabel: valueLabel(entry),
          // Per-macro state only — the global flag is separate and must not
          // affect how each macro's own checkbox renders.
          enabled: !isMacroDisabled(key),
        });
      }
    });
    return out;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  function processFragment(segment, lang) {
    const cfg = MACROS[lang] || MACROS['en-US'];
    const normalized = segment.trim().toLowerCase();
    if (!normalized) return { type: 'text' };

    const stateful = cfg.stateful;
    for (let i = 0; i < stateful.length; i++) {
      const entry = stateful[i];
      if (!isEnabled('stateful', entry)) continue;
      const aliases = triggers(entry);
      for (let a = 0; a < aliases.length; a++) {
        const alias = aliases[a];
        if (alias instanceof RegExp) {
          // Anchor to full segment for exact-match semantics
          const anchored = new RegExp('^(?:' + alias.source + ')$', alias.flags);
          if (anchored.test(normalized)) {
            if (entry.insert) return { type: 'macro', insert: entry.insert };
            return { type: 'macro', format: entry.format };
          }
        } else if (normalized.localeCompare(alias, undefined, { sensitivity: 'base' }) === 0) {
          if (entry.insert) return { type: 'macro', insert: entry.insert };
          return { type: 'macro', format: entry.format };
        }
      }
    }
    return { type: 'text' };
  }

  function applyInline(text, lang) {
    const cfg = MACROS[lang] || MACROS['en-US'];
    let result = text;
    const inline = cfg.inline;
    for (let i = 0; i < inline.length; i++) {
      const entry = inline[i];
      if (!isEnabled('inline', entry)) continue;
      const aliases = triggers(entry);
      // Build a single pattern: combine regex entries and escaped-string entries
      const parts = [];
      for (let a = 0; a < aliases.length; a++) {
        const alias = aliases[a];
        if (alias instanceof RegExp) {
          parts.push('(?:' + alias.source + ')');
        } else {
          parts.push(escapeRegex(alias));
        }
      }
      // onEnd: only match when the trigger is at the end of the text
      // (optionally followed by trailing whitespace).
      if (entry.onEnd) {
        const endPattern = new RegExp('\\b(?:' + parts.join('|') + ')\\s*$', 'gi');
        result = result.replace(endPattern, entry.replace);
      } else if (entry.open) {
        // Opener: consume trailing whitespace so no space after the char.
        const openPattern = new RegExp('\\b(?:' + parts.join('|') + ')\\s*', 'gi');
        result = result.replace(openPattern, entry.replace);
      } else if (entry.close) {
        // Closer: consume leading whitespace so no space before the char.
        const closePattern = new RegExp('\\s*(?:' + parts.join('|') + ')\\b', 'gi');
        result = result.replace(closePattern, entry.replace);
      } else {
        const pattern = new RegExp('\\b(?:' + parts.join('|') + ')\\b', 'gi');
        result = result.replace(pattern, entry.replace);
      }
    }
    result = result.replace(/ ([.,;:?!%)…])/g, '$1');
    result = result.replace(/\( /g, '(');
    result = result.replace(/ ?\n ?/g, '\n');
    return result;
  }

  function applyFormat(text, format) {
    if (!text) return text;
    switch (format) {
      case 'quotes':
        return '"' + text + '"';
      case 'squotes':
        return "'" + text + "'";
      case 'bticks':
        return '`' + text + '`';
      case 'parens':
        return '(' + text + ')';
      case 'uppercase':
        return text.charAt(0).toUpperCase() + text.slice(1);
      case 'allcaps':
        return text.toUpperCase();
      default:
        return text;
    }
  }

  // ── Exports ─────────────────────────────────────────────────────────────

  window.DictationMacros = {
    MACROS: MACROS,
    processFragment: processFragment,
    applyInline: applyInline,
    applyFormat: applyFormat,
    extractDelta: extractDelta,
    revertSttNewlines: revertSttNewlines,
    trimSpaces: trimSpaces,
    // Macro preferences
    getMacroList: getMacroList,
    isEnabled: isEnabled,
    setEnabledByKey: setEnabledByKey,
    getGlobalEnabled: getGlobalEnabled,
    setGlobalEnabled: setGlobalEnabled,
    resetPrefs: resetPrefs,
    entryKey: entryKey,
    directText: directText,
    valueLabel: valueLabel,
  };

})();
