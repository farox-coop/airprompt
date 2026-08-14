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
    assert.strictEqual(r, '( nota)');
  });

  await t.test('unaccented "abre parentesis" inline still matches', () => {
    const r = M.applyInline('abre parentesis nota cierra parentesis', 'es-AR');
    assert.strictEqual(r, '( nota)');
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
    assert.strictEqual(r, '( hola)');
  });

  await t.test('signo de exclamación → ! (onEnd)', () => {
    assert.strictEqual(M.applyInline('hey signo de exclamación', 'es-AR'), 'hey!');
  });

  await t.test('"dos puntos" NOT inline (fragment-level only)', () => {
    assert.strictEqual(M.applyInline('ejemplo dos puntos', 'es-AR'), 'ejemplo dos puntos');
  });

  await t.test('backtick inline (abre/abrí tics?) → `', () => {
    assert.strictEqual(M.applyInline('abrí tic hola cerrá tic', 'es-AR'), '` hola `');
  });

  await t.test('en-US punctuation basics', () => {
    assert.strictEqual(M.applyInline('hello exclamation point', 'en-US'), 'hello!');
    // semicolon/colon now fragment-level, not inline
    assert.strictEqual(M.applyInline('a semicolon b colon c', 'en-US'), 'a semicolon b colon c');
    // ellipsis moved to fragment-level
    assert.strictEqual(M.applyInline('a ellipsis', 'en-US'), 'a ellipsis');
  });

  await t.test('en-US parens and quotes inline', () => {
    assert.strictEqual(M.applyInline('open paren note close paren', 'en-US'), '( note)');
    assert.strictEqual(M.applyInline('open quote hello close quote', 'en-US'), '" hello "');
    assert.strictEqual(M.applyInline('open single quote hi close single quote', 'en-US'), '\' hi \'');
    assert.strictEqual(M.applyInline('open backticks code close backticks', 'en-US'), '` code `');
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
    assert.strictEqual(r, '" hola "');
  });

  await t.test('alias "abre comilla" → inline "', () => {
    const r = M.applyInline('abre comilla hola cierra comilla', 'es-AR');
    assert.strictEqual(r, '" hola "');
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
    assert.strictEqual(r, "' hola '");
  });

  await t.test('"abrí comilla simple" → inline single quote', () => {
    const r = M.applyInline('abrí comilla simple hola cerrá comilla simple', 'es-AR');
    assert.strictEqual(r, "' hola '");
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
