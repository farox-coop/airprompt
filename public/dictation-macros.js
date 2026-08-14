// public/dictation-macros.js — Voice dictation macros (formatting & punctuation).
// Exports window.DictationMacros with processFragment/applyInline/applyFormat.

(function() {
  'use strict';

  // ── Macro registry ──────────────────────────────────────────────────────
  // Each entry has a `trigger` (string or array of aliases). Arrays
  // support regional variants (e.g. Argentine "abrí" vs neutral "abre").
  // Inline entries sorted longest-trigger-first to prevent partial matches.

  var MACROS = {
    'es-AR': {
      inline: [
        { trigger: [/(abre|abrí) par[eé]ntesis/i],   replace: '(' },
        { trigger: [/(cierra|cerrá) par[eé]ntesis/i], replace: ')' },
        { trigger: 'signo de pregunta',         replace: '?', onEnd: true },
        { trigger: ['signo de exclamación', 'signo de admiración'], replace: '!', onEnd: true },
        // Quote/tic inline — regex handles all singular/plural + voseo variants
        { trigger: [/(abre|abrí) comillas? simples?/i],  replace: "'" },
        { trigger: [/(cierra|cerrá) comillas? simples?/i], replace: "'" },
        { trigger: [/(abre|abrí) comillas?/i],   replace: '"' },
        { trigger: [/(cierra|cerrá) comillas?/i], replace: '"' },
        { trigger: [/(abre|abrí) tics?/i],        replace: '`' },
        { trigger: [/(cierra|cerrá) tics?/i],     replace: '`' },
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
        { trigger: [/^(abre|abrí) par[eé]ntesis$/i], insert: '(' },
        { trigger: [/^(cierra|cerrá) par[eé]ntesis$/i], insert: ')' },
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
        { trigger: [/(open|begin) single quotes?/i], replace: "'" },
        { trigger: [/(close|end) single quotes?/i],  replace: "'" },
        { trigger: [/(open|begin) quotes?/i],   replace: '"' },
        { trigger: [/(close|end) quotes?/i],    replace: '"' },
        { trigger: [/(open|begin) backticks?/i], replace: '`' },
        { trigger: [/(close|end) backticks?/i], replace: '`' },
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
        } else if (normalized === alias.toLowerCase()) {
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
      } else {
        var pattern = new RegExp('\\b(?:' + parts.join('|') + ')\\b', 'gi');
        result = result.replace(pattern, entry.replace);
      }
    }
    result = result.replace(/ ([.,;:?!%)…])/g, '$1');
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
  };

})();
