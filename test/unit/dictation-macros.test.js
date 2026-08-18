// ── Dictation macro unit tests ─────────────────────────────────────────
// Tests the real public/dictation-macros.js module directly.

const test = require('node:test');
const assert = require('node:assert');

// Load the real production module
global.window = {};
require('../../public/dictation-macros.js');
const M = global.window.DictationMacros;

// ──────────────────────────────────────────────────────────────────────

test('dictation macros — applyInline', async (t) => {
  await t.test('replaces inline trigger (es-AR)', () => {
    const r = M.applyInline('hola signo de pregunta', 'es-AR');
    assert.strictEqual(r, 'hola?');
  });

  await t.test('replaces inline trigger (en-US)', () => {
    const r = M.applyInline('hello question mark', 'en-US');
    assert.strictEqual(r, 'hello?');
  });

  await t.test('multiple inline triggers', () => {
    const r = M.applyInline('hola coma cómo estás signo de pregunta', 'es-AR');
    assert.strictEqual(r, 'hola coma cómo estás?');
  });

  await t.test('"punto y coma" NOT inline (fragment-level only)', () => {
    const r = M.applyInline('usa punto y coma aquí punto final', 'es-AR');
    assert.strictEqual(r, 'usa punto y coma aquí punto final');
  });

  await t.test('"signo de pregunta" NOT inline when mid-sentence', () => {
    const r = M.applyInline('cómo estás signo de pregunta bien gracias', 'es-AR');
    assert.strictEqual(r, 'cómo estás signo de pregunta bien gracias');
  });

  await t.test('"signo de pregunta" inline only at end', () => {
    const r = M.applyInline('cómo estás signo de pregunta', 'es-AR');
    assert.strictEqual(r, 'cómo estás?');
  });

  await t.test('onEnd trigger with trailing whitespace still matches', () => {
    const r = M.applyInline('cómo estás signo de pregunta  ', 'es-AR');
    assert.strictEqual(r, 'cómo estás?');
  });

  await t.test('no match → passthrough', () => {
    const r = M.applyInline('texto normal sin triggers', 'es-AR');
    assert.strictEqual(r, 'texto normal sin triggers');
  });

  await t.test('case insensitive matching', () => {
    const r = M.applyInline('Hola SIGNO DE PREGUNTA', 'es-AR');
    assert.strictEqual(r, 'Hola?');
  });

  await t.test('word boundary — does not match inside words', () => {
    const r = M.applyInline('compunto no debe cambiar', 'es-AR');
    assert.strictEqual(r, 'compunto no debe cambiar');
  });

  await t.test('newline and paragraph NOT inline — fragment-level only', () => {
    // "nueva línea" and "nuevo párrafo" moved to fragment-level inserts
    const r = M.applyInline('linea uno nueva línea linea dos', 'es-AR');
    assert.strictEqual(r, 'linea uno nueva línea linea dos');
  });

  await t.test('unknown lang → falls back to en-US', () => {
    const r = M.applyInline('hello question mark', 'fr-FR');
    assert.strictEqual(r, 'hello?');
  });

  await t.test('parentheses inline only (ellipsis moved to fragment-level)', () => {
    const r = M.applyInline('abre paréntesis nota cierra paréntesis', 'es-AR');
    assert.strictEqual(r, '(nota)');
  });

  await t.test('unaccented "abre parentesis" inline still matches', () => {
    const r = M.applyInline('abre parentesis nota cierra parentesis', 'es-AR');
    assert.strictEqual(r, '(nota)');
  });

  await t.test('ellipsis spacing: space before … stripped', () => {
    const r = M.applyInline('texto …', 'es-AR');
    assert.strictEqual(r, 'texto…');
  });

  await t.test('"puntos suspensivos" NOT inline', () => {
    const r = M.applyInline('y seguimos hablando puntos suspensivos más texto', 'es-AR');
    assert.strictEqual(r, 'y seguimos hablando puntos suspensivos más texto');
  });

  await t.test('Argentine alias "abrí paréntesis" works', () => {
    const r = M.applyInline('abrí paréntesis hola cerrá paréntesis', 'es-AR');
    assert.strictEqual(r, '(hola)');
  });

  await t.test('signo de exclamación → ! (onEnd)', () => {
    assert.strictEqual(M.applyInline('hey signo de exclamación', 'es-AR'), 'hey!');
  });

  await t.test('"dos puntos" NOT inline (fragment-level only)', () => {
    assert.strictEqual(M.applyInline('ejemplo dos puntos', 'es-AR'), 'ejemplo dos puntos');
  });

  await t.test('backtick inline (abre/abrí tics?) → `', () => {
    assert.strictEqual(M.applyInline('abrí tic hola cerrá tic', 'es-AR'), '`hola`');
  });

  await t.test('en-US punctuation basics', () => {
    assert.strictEqual(M.applyInline('hello exclamation point', 'en-US'), 'hello!');
    // semicolon/colon now fragment-level, not inline
    assert.strictEqual(M.applyInline('a semicolon b colon c', 'en-US'), 'a semicolon b colon c');
    // ellipsis moved to fragment-level
    assert.strictEqual(M.applyInline('a ellipsis', 'en-US'), 'a ellipsis');
  });

  await t.test('en-US parens and quotes inline', () => {
    assert.strictEqual(M.applyInline('open paren note close paren', 'en-US'), '(note)');
    assert.strictEqual(M.applyInline('open quote hello close quote', 'en-US'), '"hello"');
    assert.strictEqual(M.applyInline('open single quote hi close single quote', 'en-US'), '\'hi\'');
    assert.strictEqual(M.applyInline('open backticks code close backticks', 'en-US'), '`code`');
  });
});

test('dictation macros — processFragment', async (t) => {
  await t.test('exact match → macro (es-AR)', () => {
    const r = M.processFragment('entre comillas', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'quotes');
  });

  await t.test('Argentine alias "abrí comillas" → inline "', () => {
    const r = M.applyInline('abrí comillas hola cerrá comillas', 'es-AR');
    assert.strictEqual(r, '"hola"');
  });

  await t.test('alias "abre comilla" → inline "', () => {
    const r = M.applyInline('abre comilla hola cierra comilla', 'es-AR');
    assert.strictEqual(r, '"hola"');
  });

  await t.test('exact match → macro (en-US)', () => {
    const r = M.processFragment('in quotes', 'en-US');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'quotes');
  });

  await t.test('case insensitive match', () => {
    const r = M.processFragment('ENTRE COMILLAS', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'quotes');
  });

  await t.test('whitespace around match', () => {
    const r = M.processFragment('  entre comillas  ', 'es-AR');
    assert.strictEqual(r.type, 'macro');
  });

  await t.test('non-standalone → text (embedded in longer phrase)', () => {
    const r = M.processFragment('dije entre comillas ayer', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('plain text → text', () => {
    const r = M.processFragment('hola mundo', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('empty string → text', () => {
    const r = M.processFragment('', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('whitespace only → text', () => {
    const r = M.processFragment('   ', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('unknown lang → falls back to en-US', () => {
    const r = M.processFragment('in quotes', 'fr-FR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'quotes');
  });

  await t.test('"en mayúsculas" → uppercase format', () => {
    const r = M.processFragment('en mayúsculas', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'uppercase');
  });

  await t.test('"todo mayúsculas" → allcaps format', () => {
    const r = M.processFragment('todo mayúsculas', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'allcaps');
  });

  await t.test('alias "todo en mayúsculas" → allcaps', () => {
    const r = M.processFragment('todo en mayúsculas', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'allcaps');
  });

  await t.test('"entre paréntesis" → parens format', () => {
    const r = M.processFragment('entre paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'parens');
  });

  await t.test('unaccented "entre parentesis" → parens format', () => {
    const r = M.processFragment('entre parentesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'parens');
  });

  await t.test('"guión" (accented) standalone → insert "-"', () => {
    const r = M.processFragment('guión', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '-');
  });

  await t.test('"entre comillas simples" → squotes format', () => {
    const r = M.processFragment('entre comillas simples', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'squotes');
  });

  await t.test('"coma" standalone → insert ","', () => {
    const r = M.processFragment('coma', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, ',');
  });

  await t.test('"punto" standalone → insert "."', () => {
    const r = M.processFragment('punto', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '.');
  });

  await t.test('"guiones" standalone → insert "-"', () => {
    const r = M.processFragment('guiones', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '-');
  });

  await t.test('"coma" embedded — NOT a macro', () => {
    const r = M.processFragment('se coma esto', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('"abrí paréntesis" standalone → insert "("', () => {
    const r = M.processFragment('abrí paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '(');
  });

  await t.test('unaccented "abre parentesis" standalone → insert "("', () => {
    const r = M.processFragment('abre parentesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '(');
  });

  await t.test('"cerrá paréntesis" standalone → insert ")"', () => {
    const r = M.processFragment('cerrá paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, ')');
  });

  await t.test('"signo de admiración" → inline !', () => {
    assert.strictEqual(M.applyInline('hey signo de admiración', 'es-AR'), 'hey!');
  });

  await t.test('"nueva línea" standalone → insert \\n', () => {
    const r = M.processFragment('nueva línea', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '\n');
  });

  await t.test('"nuevo párrafo" standalone → insert \\n\\n', () => {
    const r = M.processFragment('nuevo párrafo', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '\n\n');
  });

  await t.test('"puntos suspensivos" standalone → insert …', () => {
    const r = M.processFragment('puntos suspensivos', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '…');
  });

  await t.test('"ellipsis" standalone (en-US) → insert …', () => {
    const r = M.processFragment('ellipsis', 'en-US');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '…');
  });

  await t.test('"puntos suspensivos" embedded — NOT a macro', () => {
    const r = M.processFragment('seguimos hablando puntos suspensivos y más', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('"nueva línea" embedded — NOT a macro', () => {
    const r = M.processFragment('esto es una nueva línea de texto', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('"nuevo párrafo" embedded — NOT a macro', () => {
    const r = M.processFragment('empezamos un nuevo párrafo ahora', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('"punto" embedded — NOT a macro', () => {
    const r = M.processFragment('en punto muerto', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('"entre tics" → bticks format', () => {
    const r = M.processFragment('entre tics', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.format, 'bticks');
  });

  await t.test('en-US stateful basics', () => {
    assert.strictEqual(M.processFragment('in quotes', 'en-US').type, 'macro');
    assert.strictEqual(M.processFragment('in single quotes', 'en-US').type, 'macro');
    assert.strictEqual(M.processFragment('in backticks', 'en-US').type, 'macro');
    assert.strictEqual(M.processFragment('in parens', 'en-US').type, 'macro');
    assert.strictEqual(M.processFragment('uppercase', 'en-US').type, 'macro');
    assert.strictEqual(M.processFragment('all caps', 'en-US').type, 'macro');
  });

  await t.test('en-US fragment-level inserts', () => {
    assert.strictEqual(M.processFragment('period', 'en-US').insert, '.');
    assert.strictEqual(M.processFragment('comma', 'en-US').insert, ',');
    assert.strictEqual(M.processFragment('dash', 'en-US').insert, '-');
  });
});

test('dictation macros — applyFormat', async (t) => {
  await t.test('quotes wraps text', () => {
    assert.strictEqual(M.applyFormat('hola', 'quotes'), '"hola"');
  });

  await t.test('uppercase capitalizes first letter', () => {
    assert.strictEqual(M.applyFormat('hola', 'uppercase'), 'Hola');
  });

  await t.test('uppercase — already capitalized → unchanged', () => {
    assert.strictEqual(M.applyFormat('Hola', 'uppercase'), 'Hola');
  });

  await t.test('allcaps uppercases everything', () => {
    assert.strictEqual(M.applyFormat('hola', 'allcaps'), 'HOLA');
  });

  await t.test('unknown format → passthrough', () => {
    assert.strictEqual(M.applyFormat('hola', 'unknown'), 'hola');
  });

  await t.test('empty string → returned as-is', () => {
    assert.strictEqual(M.applyFormat('', 'quotes'), '');
  });

  await t.test('single char uppercase', () => {
    assert.strictEqual(M.applyFormat('a', 'uppercase'), 'A');
  });

  await t.test('quotes preserves internal quotes', () => {
    assert.strictEqual(M.applyFormat('el "tema"', 'quotes'), '"el "tema""');
  });

  await t.test('parens wraps text', () => {
    assert.strictEqual(M.applyFormat('hola', 'parens'), '(hola)');
  });

  await t.test('squotes wraps text in single quotes', () => {
    assert.strictEqual(M.applyFormat('hola', 'squotes'), "'hola'");
  });

  await t.test('bticks wraps text in backticks', () => {
    assert.strictEqual(M.applyFormat('code', 'bticks'), '`code`');
  });

  await t.test('inline single-quote aliases work', () => {
    const r = M.applyInline('abrí comillas simples hola cerrá comillas simples', 'es-AR');
    assert.strictEqual(r, "'hola'");
  });

  await t.test('"abrí comilla simple" → inline single quote', () => {
    const r = M.applyInline('abrí comilla simple hola cerrá comilla simple', 'es-AR');
    assert.strictEqual(r, "'hola'");
  });
});

test('dictation macros — full fragment flow simulation', async (t) => {
  await t.test('text → macro → text (quote next fragment)', () => {
    const segments = [];
    let pendingFormat = null;

    // Fragment 1: "este feature" → text
    const f1 = M.processFragment('este feature', 'es-AR');
    assert.strictEqual(f1.type, 'text');
    segments.push('este feature');

    // Fragment 2: "entre comillas" → macro
    const f2 = M.processFragment('entre comillas', 'es-AR');
    assert.strictEqual(f2.type, 'macro');
    pendingFormat = f2.format;

    // Fragment 3: "lindo" → text, formatted
    const f3 = M.processFragment('lindo', 'es-AR');
    assert.strictEqual(f3.type, 'text');
    segments.push(pendingFormat ? M.applyFormat('lindo', pendingFormat) : 'lindo');
    pendingFormat = null;

    const result = M.applyInline(segments.join(' '), 'es-AR');
    assert.strictEqual(result, 'este feature "lindo"');
  });

  await t.test('consecutive macros → last wins', () => {
    let pf = null;

    let m = M.processFragment('entre comillas', 'es-AR');
    if (m.type === 'macro') pf = m.format;
    assert.strictEqual(pf, 'quotes');

    m = M.processFragment('en mayúsculas', 'es-AR');
    if (m.type === 'macro') pf = m.format;
    assert.strictEqual(pf, 'uppercase');
  });

  await t.test('inline onEnd macro NOT replaced mid-sentence', () => {
    const result = M.applyInline('cómo estás signo de pregunta bien gracias', 'es-AR');
    assert.strictEqual(result, 'cómo estás signo de pregunta bien gracias');
  });

  await t.test('stateful + inline combined', () => {
    const segments = [];
    let pf = null;

    const m = M.processFragment('en mayúsculas', 'es-AR');
    if (m.type === 'macro') pf = m.format;

    const text = pf ? M.applyFormat('hola signo de pregunta', pf) : 'hola signo de pregunta';
    segments.push(text);
    pf = null;

    const result = M.applyInline(segments.join(' '), 'es-AR');
    assert.strictEqual(result, 'Hola?');
  });

  await t.test('uppercase followed by text', () => {
    const segments = [];
    let pf = null;

    const m = M.processFragment('en mayúsculas', 'es-AR');
    if (m.type === 'macro') pf = m.format;

    segments.push(pf ? M.applyFormat('casa', pf) : 'casa');
    pf = null;

    assert.strictEqual(segments.join(' '), 'Casa');
  });

  await t.test('allcaps followed by text', () => {
    const segments = [];
    let pf = null;

    const m = M.processFragment('todo mayúsculas', 'es-AR');
    if (m.type === 'macro') pf = m.format;

    segments.push(pf ? M.applyFormat('gritar', pf) : 'gritar');
    pf = null;

    assert.strictEqual(segments.join(' '), 'GRITAR');
  });

  await t.test('parens: text → macro → text wraps in parentheses', () => {
    const segments = [];
    let pf = null;

    segments.push('este');

    const m = M.processFragment('entre paréntesis', 'es-AR');
    if (m.type === 'macro') pf = m.format;

    segments.push(pf ? M.applyFormat('feature', pf) : 'feature');
    pf = null;

    assert.strictEqual(segments.join(' '), 'este (feature)');
  });

  await t.test('newline spacing: no space before or after \\n', () => {
    // applyInline strips spaces around \n
    assert.strictEqual(M.applyInline('linea1 \n linea2', 'es-AR'), 'linea1\nlinea2');
    assert.strictEqual(M.applyInline('a \n\n b', 'es-AR'), 'a\n\nb');
  });

  await t.test('"nueva línea" embedded in phrase — NOT replaced', () => {
    assert.strictEqual(M.applyInline('esto es una nueva línea de texto', 'es-AR'),
      'esto es una nueva línea de texto');
  });

  await t.test('"nuevo párrafo" embedded in phrase — NOT replaced', () => {
    assert.strictEqual(M.applyInline('empezamos un nuevo párrafo ahora', 'es-AR'),
      'empezamos un nuevo párrafo ahora');
  });
});

test('dictation macros — macro #1: abre/abrí paréntesis (open paren)', async (t) => {
  // ── Inline (applyInline) — full accent/case matrix ──────────────────
  await t.test('inline "abre paréntesis" → (', () => {
    assert.strictEqual(M.applyInline('abre paréntesis', 'es-AR'), '(');
  });

  await t.test('inline "abrí paréntesis" → (', () => {
    assert.strictEqual(M.applyInline('abrí paréntesis', 'es-AR'), '(');
  });

  await t.test('inline "abre parentesis" (unaccented e) → (', () => {
    assert.strictEqual(M.applyInline('abre parentesis', 'es-AR'), '(');
  });

  await t.test('inline "abrí parentesis" (accented í + unaccented e) → (', () => {
    assert.strictEqual(M.applyInline('abrí parentesis', 'es-AR'), '(');
  });

  await t.test('inline "abri parentesis" (fully unaccented) → (', () => {
    assert.strictEqual(M.applyInline('abri parentesis', 'es-AR'), '(');
  });

  await t.test('inline "abri paréntesis" (unaccented í) → (', () => {
    assert.strictEqual(M.applyInline('abri paréntesis', 'es-AR'), '(');
  });

  await t.test('inline "ABRE PARÉNTESIS" (uppercase) → (', () => {
    assert.strictEqual(M.applyInline('ABRE PARÉNTESIS', 'es-AR'), '(');
  });

  await t.test('inline mid-sentence: "hola abre paréntesis nota" → "hola ( nota"', () => {
    assert.strictEqual(M.applyInline('hola abre paréntesis nota', 'es-AR'), 'hola (nota');
  });

  await t.test('inline does NOT match partial "abre par"', () => {
    assert.strictEqual(M.applyInline('abre par', 'es-AR'), 'abre par');
  });

  await t.test('inline does NOT match bare "paréntesis"', () => {
    assert.strictEqual(M.applyInline('paréntesis', 'es-AR'), 'paréntesis');
  });

  await t.test('inline does NOT match no-space "abreparéntesis"', () => {
    assert.strictEqual(M.applyInline('abreparéntesis', 'es-AR'), 'abreparéntesis');
  });

  // ── Stateful (processFragment) — full accent/case matrix ────────────
  await t.test('standalone "abre paréntesis" → insert (', () => {
    const r = M.processFragment('abre paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '(');
  });

  await t.test('standalone "abrí paréntesis" → insert (', () => {
    const r = M.processFragment('abrí paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '(');
  });

  await t.test('standalone "abre parentesis" (unaccented e) → insert (', () => {
    const r = M.processFragment('abre parentesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '(');
  });

  await t.test('standalone "abrí parentesis" (accented í + unaccented e) → insert (', () => {
    const r = M.processFragment('abrí parentesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '(');
  });

  await t.test('standalone "abri parentesis" (fully unaccented) → insert (', () => {
    const r = M.processFragment('abri parentesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '(');
  });

  await t.test('standalone "abri paréntesis" (unaccented í) → insert (', () => {
    const r = M.processFragment('abri paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '(');
  });

  await t.test('standalone "ABRE PARÉNTESIS" (uppercase) → insert (', () => {
    const r = M.processFragment('ABRE PARÉNTESIS', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '(');
  });

  await t.test('standalone with surrounding whitespace → insert (', () => {
    const r = M.processFragment('  abre paréntesis  ', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, '(');
  });

  await t.test('embedded "dije abre paréntesis ayer" → text (NOT macro)', () => {
    const r = M.processFragment('dije abre paréntesis ayer', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('en-US "open paren" → insert ( (sanity, not #1)', () => {
    const r = M.processFragment('open paren', 'en-US');
    // en-US has no stateful "open paren" insert — only inline.
    // Verify inline path instead.
    assert.strictEqual(M.applyInline('open paren note', 'en-US'), '(note');
  });
});

test('dictation macros — macro #2: cierra/cerrá paréntesis (close paren)', async (t) => {
  // ── Inline (applyInline) — full accent/case matrix ──────────────────
  await t.test('inline "cierra paréntesis" → )', () => {
    assert.strictEqual(M.applyInline('cierra paréntesis', 'es-AR'), ')');
  });

  await t.test('inline "cerrá paréntesis" → )', () => {
    assert.strictEqual(M.applyInline('cerrá paréntesis', 'es-AR'), ')');
  });

  await t.test('inline "cierra parentesis" (unaccented e) → )', () => {
    assert.strictEqual(M.applyInline('cierra parentesis', 'es-AR'), ')');
  });

  await t.test('inline "cerrá parentesis" (accented á + unaccented e) → )', () => {
    assert.strictEqual(M.applyInline('cerrá parentesis', 'es-AR'), ')');
  });

  await t.test('inline "cerra parentesis" (fully unaccented) → )', () => {
    assert.strictEqual(M.applyInline('cerra parentesis', 'es-AR'), ')');
  });

  await t.test('inline "cerra paréntesis" (unaccented á) → )', () => {
    assert.strictEqual(M.applyInline('cerra paréntesis', 'es-AR'), ')');
  });

  await t.test('inline "CIERRA PARÉNTESIS" (uppercase) → )', () => {
    assert.strictEqual(M.applyInline('CIERRA PARÉNTESIS', 'es-AR'), ')');
  });

  await t.test('inline mid-sentence: "hola cierra paréntesis nota" → "hola) nota"', () => {
    assert.strictEqual(M.applyInline('hola cierra paréntesis nota', 'es-AR'), 'hola) nota');
  });

  await t.test('inline does NOT match partial "cierra par"', () => {
    assert.strictEqual(M.applyInline('cierra par', 'es-AR'), 'cierra par');
  });

  await t.test('inline does NOT match bare "paréntesis"', () => {
    assert.strictEqual(M.applyInline('paréntesis', 'es-AR'), 'paréntesis');
  });

  await t.test('inline does NOT match no-space "cierraparentesis"', () => {
    assert.strictEqual(M.applyInline('cierraparentesis', 'es-AR'), 'cierraparentesis');
  });

  // ── Stateful (processFragment) — full accent/case matrix ────────────
  await t.test('standalone "cierra paréntesis" → insert )', () => {
    const r = M.processFragment('cierra paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, ')');
  });

  await t.test('standalone "cerrá paréntesis" → insert )', () => {
    const r = M.processFragment('cerrá paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, ')');
  });

  await t.test('standalone "cerra parentesis" (fully unaccented) → insert )', () => {
    const r = M.processFragment('cerra parentesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, ')');
  });

  await t.test('standalone "cerra paréntesis" (unaccented á) → insert )', () => {
    const r = M.processFragment('cerra paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, ')');
  });

  await t.test('standalone "CIERRA PARÉNTESIS" (uppercase) → insert )', () => {
    const r = M.processFragment('CIERRA PARÉNTESIS', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, ')');
  });

  await t.test('standalone with surrounding whitespace → insert )', () => {
    const r = M.processFragment('  cierra paréntesis  ', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, ')');
  });

  await t.test('embedded "dije cierra paréntesis ayer" → text (NOT macro)', () => {
    const r = M.processFragment('dije cierra paréntesis ayer', 'es-AR');
    assert.strictEqual(r.type, 'text');
  });

  await t.test('spacing: no space before closing paren', () => {
    // applyInline strips the space before ")" via spacing normalization.
    assert.strictEqual(M.applyInline('chau cierra paréntesis', 'es-AR'), 'chau)');
  });
});

test('dictation macros — macro #3: signo de pregunta (question mark)', async (t) => {
  await t.test('standalone "signo de pregunta" → ?', () => {
    assert.strictEqual(M.applyInline('signo de pregunta', 'es-AR'), '?');
  });

  await t.test('at end of sentence → ?', () => {
    assert.strictEqual(M.applyInline('cómo estás signo de pregunta', 'es-AR'), 'cómo estás?');
  });

  await t.test('trailing whitespace still → ?', () => {
    assert.strictEqual(M.applyInline('cómo estás signo de pregunta  ', 'es-AR'), 'cómo estás?');
  });

  await t.test('mid-sentence → unchanged (onEnd)', () => {
    assert.strictEqual(M.applyInline('cómo estás signo de pregunta bien', 'es-AR'), 'cómo estás signo de pregunta bien');
  });

  await t.test('case insensitive → ?', () => {
    assert.strictEqual(M.applyInline('cómo estás SIGNO DE PREGUNTA', 'es-AR'), 'cómo estás?');
  });

  await t.test('word boundary — "consigno de pregunta" → unchanged', () => {
    // \b before "signo" must not match inside "consigno".
    assert.strictEqual(M.applyInline('esto es un consigno de pregunta', 'es-AR'), 'esto es un consigno de pregunta');
  });

  await t.test('only last occurrence replaced (onEnd anchors to $)', () => {
    assert.strictEqual(M.applyInline('signo de pregunta aquí signo de pregunta', 'es-AR'), 'signo de pregunta aquí?');
  });

  await t.test('"signo de pregunta" is inline, not stateful (processFragment → text)', () => {
    assert.strictEqual(M.processFragment('signo de pregunta', 'es-AR').type, 'text');
  });

  await t.test('en-US "question mark" → ?', () => {
    assert.strictEqual(M.applyInline('how are you question mark', 'en-US'), 'how are you?');
  });
});

test('dictation macros — macro #4: signo de exclamación/admiración (exclamation)', async (t) => {
  await t.test('standalone "signo de exclamación" → !', () => {
    assert.strictEqual(M.applyInline('signo de exclamación', 'es-AR'), '!');
  });

  await t.test('standalone "signo de admiración" → !', () => {
    assert.strictEqual(M.applyInline('signo de admiración', 'es-AR'), '!');
  });

  await t.test('unaccented "signo de exclamacion" → ! (accent tolerance)', () => {
    assert.strictEqual(M.applyInline('signo de exclamacion', 'es-AR'), '!');
  });

  await t.test('unaccented "signo de admiracion" → ! (accent tolerance)', () => {
    assert.strictEqual(M.applyInline('signo de admiracion', 'es-AR'), '!');
  });

  await t.test('at end of sentence → !', () => {
    assert.strictEqual(M.applyInline('hey signo de exclamación', 'es-AR'), 'hey!');
    assert.strictEqual(M.applyInline('hey signo de admiración', 'es-AR'), 'hey!');
  });

  await t.test('trailing whitespace still → !', () => {
    assert.strictEqual(M.applyInline('hey signo de exclamación  ', 'es-AR'), 'hey!');
  });

  await t.test('mid-sentence → unchanged (onEnd)', () => {
    assert.strictEqual(M.applyInline('hey signo de exclamación bien', 'es-AR'), 'hey signo de exclamación bien');
  });

  await t.test('case insensitive → !', () => {
    assert.strictEqual(M.applyInline('hey SIGNO DE EXCLAMACIÓN', 'es-AR'), 'hey!');
  });

  await t.test('en-US "exclamation point" → !', () => {
    assert.strictEqual(M.applyInline('hello exclamation point', 'en-US'), 'hello!');
  });
});

test('dictation macros — macro #5: abre/abrí comillas simples (open single quote)', async (t) => {
  await t.test('inline "abre comillas simples" → \'', () => {
    assert.strictEqual(M.applyInline('abre comillas simples', 'es-AR'), "'");
  });

  await t.test('inline "abrí comillas simples" → \'', () => {
    assert.strictEqual(M.applyInline('abrí comillas simples', 'es-AR'), "'");
  });

  await t.test('inline "abri comillas simples" (unaccented í) → \'', () => {
    assert.strictEqual(M.applyInline('abri comillas simples', 'es-AR'), "'");
  });

  await t.test('singular "abre comilla simple" → \'', () => {
    assert.strictEqual(M.applyInline('abre comilla simple', 'es-AR'), "'");
  });

  await t.test('singular + unaccented "abri comilla simple" → \'', () => {
    assert.strictEqual(M.applyInline('abri comilla simple', 'es-AR'), "'");
  });

  await t.test('case insensitive → \'', () => {
    assert.strictEqual(M.applyInline('ABRE COMILLAS SIMPLES', 'es-AR'), "'");
  });

  await t.test('does NOT match "abre comillas" (double quote is a separate macro)', () => {
    // "abre comillas simples" must match single-quote entry, not double-quote.
    assert.strictEqual(M.applyInline('abre comillas simples hola', 'es-AR'), "'hola");
  });

  await t.test('open single quote strips trailing space (tight)', () => {
    assert.strictEqual(M.applyInline('abre comillas simples hola', 'es-AR'), "'hola");
  });

  await t.test('close single quote strips leading space, keeps trailing', () => {
    assert.strictEqual(M.applyInline('hola cerrá comillas simples chau', 'es-AR'), "hola' chau");
  });

  await t.test('full pair inline → tight quotes', () => {
    assert.strictEqual(M.applyInline('abre comillas simples hola cerrá comillas simples', 'es-AR'), "'hola'");
  });
});

test('dictation macros — seseo tolerance (cierra/sierra homophones)', async (t) => {
  await t.test('inline "sierra paréntesis" → )', () => {
    assert.strictEqual(M.applyInline('hola sierra paréntesis', 'es-AR'), 'hola)');
  });

  await t.test('inline "serrá paréntesis" → )', () => {
    assert.strictEqual(M.applyInline('hola serrá paréntesis', 'es-AR'), 'hola)');
  });

  await t.test('inline "serra paréntesis" (unaccented) → )', () => {
    assert.strictEqual(M.applyInline('hola serra paréntesis', 'es-AR'), 'hola)');
  });

  await t.test('inline "sierra comillas" → close double quote (tight)', () => {
    assert.strictEqual(M.applyInline('hola sierra comillas', 'es-AR'), 'hola"');
  });

  await t.test('inline "serra comillas simples" → close single quote', () => {
    assert.strictEqual(M.applyInline('hola serra comillas simples', 'es-AR'), "hola'");
  });

  await t.test('inline "serra tics" → close backtick', () => {
    assert.strictEqual(M.applyInline('hola serra tics', 'es-AR'), 'hola`');
  });

  await t.test('standalone "sierra paréntesis" → insert )', () => {
    const r = M.processFragment('sierra paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, ')');
  });

  await t.test('standalone "serra paréntesis" → insert )', () => {
    const r = M.processFragment('serra paréntesis', 'es-AR');
    assert.strictEqual(r.type, 'macro');
    assert.strictEqual(r.insert, ')');
  });

  await t.test('"sierra" alone (mountain) is NOT a macro', () => {
    assert.strictEqual(M.processFragment('sierra', 'es-AR').type, 'text');
    assert.strictEqual(M.applyInline('la sierra maestra', 'es-AR'), 'la sierra maestra');
  });
});

test('dictation macros — stateful inserts (punctuation & breaks)', async (t) => {
  await t.test('"punto" → .', () => {
    assert.strictEqual(M.processFragment('punto', 'es-AR').insert, '.');
  });

  await t.test('"coma" → ,', () => {
    assert.strictEqual(M.processFragment('coma', 'es-AR').insert, ',');
  });

  await t.test('"guion" (unaccented) → -', () => {
    assert.strictEqual(M.processFragment('guion', 'es-AR').insert, '-');
  });

  await t.test('"guión" (accented) → -', () => {
    assert.strictEqual(M.processFragment('guión', 'es-AR').insert, '-');
  });

  await t.test('"guiones" (plural) → -', () => {
    assert.strictEqual(M.processFragment('guiones', 'es-AR').insert, '-');
  });

  await t.test('"puntos suspensivos" → …', () => {
    assert.strictEqual(M.processFragment('puntos suspensivos', 'es-AR').insert, '…');
  });

  await t.test('"punto y coma" → ;', () => {
    assert.strictEqual(M.processFragment('punto y coma', 'es-AR').insert, ';');
  });

  await t.test('"dos puntos" → :', () => {
    assert.strictEqual(M.processFragment('dos puntos', 'es-AR').insert, ':');
  });

  await t.test('"nueva linea" (unaccented) → \\n', () => {
    assert.strictEqual(M.processFragment('nueva linea', 'es-AR').insert, '\n');
  });

  await t.test('"nuevo parrafo" (unaccented) → \\n\\n', () => {
    assert.strictEqual(M.processFragment('nuevo parrafo', 'es-AR').insert, '\n\n');
  });

  await t.test('"punto y coma" embedded → text (NOT macro)', () => {
    assert.strictEqual(M.processFragment('el punto y coma es un signo', 'es-AR').type, 'text');
  });

  await t.test('"dos puntos" embedded → text (NOT macro)', () => {
    assert.strictEqual(M.processFragment('hay dos puntos importantes', 'es-AR').type, 'text');
  });
});

test('dictation macros — extractDelta (cumulative transcript deltas)', async (t) => {
  await t.test('first time → full transcript', () => {
    assert.strictEqual(M.extractDelta('hola', ''), 'hola');
  });

  await t.test('unchanged → empty (skip)', () => {
    assert.strictEqual(M.extractDelta('hola', 'hola'), '');
  });

  await t.test('accent correction → empty (skip)', () => {
    assert.strictEqual(M.extractDelta('nuevo párrafo', 'nuevo parrafo'), '');
  });

  await t.test('case correction → empty (skip)', () => {
    assert.strictEqual(M.extractDelta('Nuevo Párrafo', 'nuevo párrafo'), '');
  });

  await t.test('grew → new part only', () => {
    assert.strictEqual(M.extractDelta('hola mundo', 'hola'), 'mundo');
  });

  await t.test('grew with accent in prefix → new part', () => {
    assert.strictEqual(M.extractDelta('nuevo párrafo final', 'nuevo parrafo'), 'final');
  });

  await t.test('changed entirely → full transcript', () => {
    assert.strictEqual(M.extractDelta('nueva línea', 'nuevo párrafo'), 'nueva línea');
  });

  await t.test('preserves newlines (STT "nuevo párrafo" → "\\n\\n")', () => {
    assert.strictEqual(M.extractDelta('\n\n', ''), '\n\n');
  });

  await t.test('strips spaces but keeps newlines', () => {
    assert.strictEqual(M.extractDelta(' \n\n ', ''), '\n\n');
  });
});

test('dictation macros — revertSttNewlines (STT built-in newline commands)', async (t) => {
  await t.test('"\\n\\n" → "nuevo párrafo" (es-AR)', () => {
    assert.strictEqual(M.revertSttNewlines('\n\n', 'es-AR'), 'nuevo párrafo');
  });

  await t.test('"\\n" → "nueva línea" (es-AR)', () => {
    assert.strictEqual(M.revertSttNewlines('\n', 'es-AR'), 'nueva línea');
  });

  await t.test('embedded "texto \\n\\n texto" → literal (es-AR)', () => {
    assert.strictEqual(M.revertSttNewlines('texto \n\n texto', 'es-AR'), 'texto nuevo párrafo texto');
  });

  await t.test('embedded "texto \\n texto" → literal (es-AR)', () => {
    assert.strictEqual(M.revertSttNewlines('texto \n texto', 'es-AR'), 'texto nueva línea texto');
  });

  await t.test('"\\n\\n" → "new paragraph" (en-US)', () => {
    assert.strictEqual(M.revertSttNewlines('\n\n', 'en-US'), 'new paragraph');
  });

  await t.test('"\\n" → "new line" (en-US)', () => {
    assert.strictEqual(M.revertSttNewlines('\n', 'en-US'), 'new line');
  });

  await t.test('no newlines → unchanged', () => {
    assert.strictEqual(M.revertSttNewlines('hola mundo', 'es-AR'), 'hola mundo');
  });
});

test('dictation macros — trimSpaces', async (t) => {
  await t.test('strips leading/trailing spaces and tabs', () => {
    assert.strictEqual(M.trimSpaces('  hola  '), 'hola');
    assert.strictEqual(M.trimSpaces('\thola\t'), 'hola');
  });

  await t.test('keeps newlines', () => {
    assert.strictEqual(M.trimSpaces('\n\n'), '\n\n');
    assert.strictEqual(M.trimSpaces(' hola \n\n '), 'hola \n\n');
  });
});

test('dictation macros — preferences (enable/disable + display helpers)', async (t) => {
  await t.test('directText — regex → plain text (user example #1)', () => {
    assert.strictEqual(
      M.directText({ trigger: [/(abre|abr[ií]) par[eé]ntesis/i] }),
      'abre|abrí paréntesis'
    );
  });

  await t.test('directText — aliases joined with | (user example #2)', () => {
    assert.strictEqual(
      M.directText({ trigger: [/signo de exclamaci[oó]n/i, /signo de admiraci[oó]n/i] }),
      'signo de exclamación|admiración'
    );
  });

  await t.test('directText — [cs] class collapses to first char', () => {
    assert.strictEqual(
      M.directText({ trigger: [/([cs]ierra|[cs]err[aá]) par[eé]ntesis/i] }),
      'cierra|cerrá paréntesis'
    );
  });

  await t.test('directText — string trigger passthrough', () => {
    assert.strictEqual(M.directText({ trigger: 'signo de pregunta' }), 'signo de pregunta');
  });

  await t.test('directText — negative lookahead + \\b stripped from display', () => {
    assert.strictEqual(
      M.directText({ trigger: [/(abre|abr[ií]) comillas?\b(?!\s+simples?)/i] }),
      'abre|abrí comillas'
    );
  });

  await t.test('valueLabel — insert/replace/format', () => {
    assert.strictEqual(M.valueLabel({ insert: '\n' }), '↵');
    assert.strictEqual(M.valueLabel({ insert: '\n\n' }), '↵↵');
    assert.strictEqual(M.valueLabel({ replace: '(' }), '(');
    assert.strictEqual(M.valueLabel({ insert: '…' }), '…');
    assert.strictEqual(M.valueLabel({ format: 'quotes' }), '"…"');
    assert.strictEqual(M.valueLabel({ format: 'uppercase' }), 'Aa');
    assert.strictEqual(M.valueLabel({ format: 'allcaps' }), 'AA');
  });

  await t.test('disabled inline macro produces no replacement', () => {
    M.resetPrefs();
    assert.strictEqual(M.applyInline('abre paréntesis nota', 'es-AR'), '(nota');
    M.setEnabledByKey('inline:replace:(', false);
    assert.strictEqual(M.applyInline('abre paréntesis nota', 'es-AR'), 'abre paréntesis nota');
    M.setEnabledByKey('inline:replace:(', true);
    assert.strictEqual(M.applyInline('abre paréntesis nota', 'es-AR'), '(nota');
    M.resetPrefs();
  });

  await t.test('disabled stateful macro produces no insert', () => {
    M.resetPrefs();
    assert.strictEqual(M.processFragment('punto', 'es-AR').insert, '.');
    M.setEnabledByKey('stateful:insert:.', false);
    assert.strictEqual(M.processFragment('punto', 'es-AR').type, 'text');
    M.resetPrefs();
  });

  await t.test('toggle is language-agnostic (es + en share one key)', () => {
    M.resetPrefs();
    assert.strictEqual(M.applyInline('open paren note', 'en-US'), '(note');
    M.setEnabledByKey('inline:replace:(', false);
    assert.strictEqual(M.applyInline('abre paréntesis nota', 'es-AR'), 'abre paréntesis nota');
    assert.strictEqual(M.applyInline('open paren note', 'en-US'), 'open paren note');
    M.resetPrefs();
  });

  await t.test('global toggle disables all without touching per-macro state', () => {
    M.resetPrefs();
    assert.strictEqual(M.applyInline('abre paréntesis nota', 'es-AR'), '(nota');
    M.setGlobalEnabled(false);
    assert.strictEqual(M.applyInline('abre paréntesis nota', 'es-AR'), 'abre paréntesis nota');
    assert.strictEqual(M.processFragment('punto', 'es-AR').type, 'text');
    // per-macro checkboxes unchanged by the global flag
    const openParen = M.getMacroList('es-AR').find(function (i) { return i.key === 'inline:replace:('; });
    assert.strictEqual(openParen.enabled, true);
    M.setGlobalEnabled(true);
    assert.strictEqual(M.applyInline('abre paréntesis nota', 'es-AR'), '(nota');
    M.resetPrefs();
  });

  await t.test('getMacroList — shape + inline before stateful', () => {
    M.resetPrefs();
    const list = M.getMacroList('es-AR');
    assert.ok(Array.isArray(list) && list.length > 0);
    const inlineIdx = list.findIndex(function (i) { return i.category === 'inline'; });
    const statefulIdx = list.findIndex(function (i) { return i.category === 'stateful'; });
    assert.strictEqual(inlineIdx, 0);
    assert.ok(statefulIdx > inlineIdx);
    list.forEach(function (i) {
      assert.strictEqual(typeof i.key, 'string');
      assert.strictEqual(typeof i.triggerText, 'string');
      assert.strictEqual(typeof i.valueLabel, 'string');
      assert.strictEqual(typeof i.enabled, 'boolean');
    });
    // exclamation macro → aliased trigger text + '!' value
    const ex = list.find(function (i) { return i.key === 'inline:replace:!:end'; });
    assert.ok(ex);
    assert.strictEqual(ex.triggerText, 'signo de exclamación|admiración');
    assert.strictEqual(ex.valueLabel, '!');
  });
});

test('dictation macros — preferences edge cases', async (t) => {
  await t.test('paren open/close is one macro — single key disables both paths', () => {
    M.resetPrefs();
    // both inline + stateful paths fire by default
    assert.strictEqual(M.processFragment('abre paréntesis', 'es-AR').insert, '(');
    assert.strictEqual(M.applyInline('abre paréntesis nota', 'es-AR'), '(nota');
    // one key covers both
    M.setEnabledByKey('inline:replace:(', false);
    assert.strictEqual(M.processFragment('abre paréntesis', 'es-AR').type, 'text');
    assert.strictEqual(M.applyInline('abre paréntesis nota', 'es-AR'), 'abre paréntesis nota');
    M.resetPrefs();
  });

  await t.test('getMacroList has no duplicate keys (paren listed once)', () => {
    M.resetPrefs();
    const list = M.getMacroList('es-AR');
    const keys = list.map(function (i) { return i.key; });
    assert.strictEqual(new Set(keys).size, keys.length);
    const parenRows = list.filter(function (i) { return i.key === 'inline:replace:('; });
    assert.strictEqual(parenRows.length, 1);
    assert.strictEqual(parenRows[0].category, 'inline');
  });

  await t.test('disabling single-quote does not let double-quote shadow (es-AR)', () => {
    M.resetPrefs();
    assert.strictEqual(M.applyInline('abre comillas simples hola', 'es-AR'), "'hola");
    M.setEnabledByKey("inline:replace:':open", false);
    assert.strictEqual(M.applyInline('abre comillas simples hola', 'es-AR'), 'abre comillas simples hola');
    M.setEnabledByKey("inline:replace:':close", false);
    assert.strictEqual(M.applyInline('hola cerrá comillas simples chau', 'es-AR'), 'hola cerrá comillas simples chau');
    M.resetPrefs();
  });

  await t.test('setEnabledByKey reflects in getMacroList().enabled', () => {
    M.resetPrefs();
    M.setEnabledByKey('inline:replace:(', false);
    const row = M.getMacroList('es-AR').find(function (i) { return i.key === 'inline:replace:('; });
    assert.strictEqual(row.enabled, false);
    M.resetPrefs();
  });

  await t.test('resetPrefs clears disabled set + global flag', () => {
    M.setEnabledByKey('inline:replace:(', false);
    M.setGlobalEnabled(false);
    M.resetPrefs();
    assert.strictEqual(M.getGlobalEnabled(), true);
    const row = M.getMacroList('es-AR').find(function (i) { return i.key === 'inline:replace:('; });
    assert.strictEqual(row.enabled, true);
  });
});
