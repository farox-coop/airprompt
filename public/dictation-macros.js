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

  var MACROS = {
    'es-AR': {
      inline: [
        { trigger: [/(abre|abr[ií]) par[eé]ntesis/i],   replace: '(' },
        { trigger: [/([cs]ierra|[cs]err[aá]) par[eé]ntesis/i], replace: ')' },
        { trigger: 'signo de pregunta',         replace: '?', onEnd: true },
        { trigger: [/signo de exclamaci[oó]n/i, /signo de admiraci[oó]n/i], replace: '!', onEnd: true },
        // Quote/tic inline — regex handles all singular/plural + voseo variants
        { trigger: [/(abre|abr[ií]) comillas? simples?/i],  replace: "'", open: true },
        { trigger: [/([cs]ierra|[cs]err[aá]) comillas? simples?/i], replace: "'", close: true },
        { trigger: [/(abre|abr[ií]) comillas?/i],   replace: '"', open: true },
        { trigger: [/([cs]ierra|[cs]err[aá]) comillas?/i], replace: '"', close: true },
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
    var t = entry.trigger;
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
    var para = (lang === 'es-AR') ? 'nuevo párrafo' : 'new paragraph';
    var line = (lang === 'es-AR') ? 'nueva línea' : 'new line';
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

  // ── Public API ──────────────────────────────────────────────────────────

  function processFragment(segment, lang) {
    var cfg = MACROS[lang] || MACROS['en-US'];
    var normalized = segment.trim().toLowerCase();
    if (!normalized) return { type: 'text' };

    var stateful = cfg.stateful;
    for (var i = 0; i < stateful.length; i++) {
      var entry = stateful[i];
      var aliases = triggers(entry);
      for (var a = 0; a < aliases.length; a++) {
        var alias = aliases[a];
        if (alias instanceof RegExp) {
          // Anchor to full segment for exact-match semantics
          var anchored = new RegExp('^(?:' + alias.source + ')$', alias.flags);
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
    var cfg = MACROS[lang] || MACROS['en-US'];
    var result = text;
    var inline = cfg.inline;
    for (var i = 0; i < inline.length; i++) {
      var entry = inline[i];
      var aliases = triggers(entry);
      // Build a single pattern: combine regex entries and escaped-string entries
      var parts = [];
      for (var a = 0; a < aliases.length; a++) {
        var alias = aliases[a];
        if (alias instanceof RegExp) {
          parts.push('(?:' + alias.source + ')');
        } else {
          parts.push(escapeRegex(alias));
        }
      }
      // onEnd: only match when the trigger is at the end of the text
      // (optionally followed by trailing whitespace).
      if (entry.onEnd) {
        var endPattern = new RegExp('\\b(?:' + parts.join('|') + ')\\s*$', 'gi');
        result = result.replace(endPattern, entry.replace);
      } else if (entry.open) {
        // Opener: consume trailing whitespace so no space after the char.
        var openPattern = new RegExp('\\b(?:' + parts.join('|') + ')\\s*', 'gi');
        result = result.replace(openPattern, entry.replace);
      } else if (entry.close) {
        // Closer: consume leading whitespace so no space before the char.
        var closePattern = new RegExp('\\s*(?:' + parts.join('|') + ')\\b', 'gi');
        result = result.replace(closePattern, entry.replace);
      } else {
        var pattern = new RegExp('\\b(?:' + parts.join('|') + ')\\b', 'gi');
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
  };

})();
