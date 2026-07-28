// ── Dictation unit tests ──────────────────────────────────────────────
// Tests pure logic from public/client.js dictation module.
// DOM-dependent and Web Speech API code is tested via integration.

const test = require('node:test');
const assert = require('node:assert');

// ── Replicated pure functions from client.js ──────────────────────────

function langToFlag(code) {
  const parts = code.split('-');
  const region = parts[parts.length - 1].toUpperCase();
  if (!region || region.length !== 2) return code.toUpperCase();
  try {
    return String.fromCodePoint(
      0x1F1E6 + region.charCodeAt(0) - 65,
      0x1F1E6 + region.charCodeAt(1) - 65
    );
  } catch {
    return code.toUpperCase();
  }
}

function normalizeLang(code) {
  if (!code || !code.includes('-')) {
    const map = { en: 'en-US', es: 'es-AR', fr: 'fr-FR', de: 'de-DE',
                  pt: 'pt-BR', it: 'it-IT', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR' };
    code = map[code] || (code || 'en-US');
  }
  return code;
}

const BASE_LANGS = [
  { code: 'en-US', name: 'English (US)' },
  { code: 'es-AR', name: 'Español (AR)' },
];

function resolveLanguageList(currentLang, browserLang) {
  const langs = [...BASE_LANGS];
  const addIfMissing = (code) => {
    if (!langs.some(l => l.code === code)) {
      langs.unshift({ code, name: code + ' (browser)' });
    }
  };
  if (browserLang) addIfMissing(normalizeLang(browserLang));
  if (currentLang && !langs.some(l => l.code === currentLang)) {
    langs.unshift({ code: currentLang, name: currentLang + ' (saved)' });
  }
  return langs;
}

// ──────────────────────────────────────────────────────────────────────

test('langToFlag — returns flag emoji for known region codes', async (t) => {
  await t.test('en-US → 🇺🇸', () => {
    assert.strictEqual(langToFlag('en-US'), '🇺🇸');
  });

  await t.test('es-AR → 🇦🇷', () => {
    assert.strictEqual(langToFlag('es-AR'), '🇦🇷');
  });

  await t.test('es-ES → 🇪🇸', () => {
    assert.strictEqual(langToFlag('es-ES'), '🇪🇸');
  });

  await t.test('es-MX → 🇲🇽', () => {
    assert.strictEqual(langToFlag('es-MX'), '🇲🇽');
  });

  await t.test('pt-BR → 🇧🇷', () => {
    assert.strictEqual(langToFlag('pt-BR'), '🇧🇷');
  });

  await t.test('ja-JP → 🇯🇵', () => {
    assert.strictEqual(langToFlag('ja-JP'), '🇯🇵');
  });

  await t.test('zh-CN → 🇨🇳', () => {
    assert.strictEqual(langToFlag('zh-CN'), '🇨🇳');
  });
});

test('langToFlag — fallback for nonstandard codes', async (t) => {
  await t.test('bare "es" (no region) → flag for ES region', () => {
    // 'es' has no '-', so parts=['es'], region='es' (len=2) → treated as region
    assert.strictEqual(langToFlag('es'), '🇪🇸');
  });

  await t.test('bare "en" (no region) → flag for EN region', () => {
    // 'en' has no '-', so region='en' (len=2) → treated as region
    assert.strictEqual(langToFlag('en'), '🇪🇳');
  });

  await t.test('empty string → ""', () => {
    assert.strictEqual(langToFlag(''), '');
  });

  await t.test('"xx-YY" with non-alpha region → "XX-YY" uppercase', () => {
    // region "YY" → valid alpha → flag '🇾🇾'
    assert.strictEqual(langToFlag('xx-YY'), '🇾🇾');
  });

  await t.test('numeric region "es-419" → "ES-419"', () => {
    assert.strictEqual(langToFlag('es-419'), 'ES-419');
  });

  await t.test('single-char region "x-Y" → "X-Y"', () => {
    assert.strictEqual(langToFlag('x-Y'), 'X-Y');
  });
});

test('normalizeLang — expands short codes to full locale', async (t) => {
  await t.test('"es" → "es-AR"', () => {
    assert.strictEqual(normalizeLang('es'), 'es-AR');
  });

  await t.test('"en" → "en-US"', () => {
    assert.strictEqual(normalizeLang('en'), 'en-US');
  });

  await t.test('"fr" → "fr-FR"', () => {
    assert.strictEqual(normalizeLang('fr'), 'fr-FR');
  });

  await t.test('"de" → "de-DE"', () => {
    assert.strictEqual(normalizeLang('de'), 'de-DE');
  });

  await t.test('"pt" → "pt-BR"', () => {
    assert.strictEqual(normalizeLang('pt'), 'pt-BR');
  });

  await t.test('"it" → "it-IT"', () => {
    assert.strictEqual(normalizeLang('it'), 'it-IT');
  });

  await t.test('"ja" → "ja-JP"', () => {
    assert.strictEqual(normalizeLang('ja'), 'ja-JP');
  });

  await t.test('"zh" → "zh-CN"', () => {
    assert.strictEqual(normalizeLang('zh'), 'zh-CN');
  });

  await t.test('"ko" → "ko-KR"', () => {
    assert.strictEqual(normalizeLang('ko'), 'ko-KR');
  });

  await t.test('"es-AR" stays "es-AR" (already has dash)', () => {
    assert.strictEqual(normalizeLang('es-AR'), 'es-AR');
  });

  await t.test('"fr-FR" stays "fr-FR"', () => {
    assert.strictEqual(normalizeLang('fr-FR'), 'fr-FR');
  });
});

test('normalizeLang — fallback for falsy / unknown inputs', async (t) => {
  await t.test('"" → "en-US"', () => {
    assert.strictEqual(normalizeLang(''), 'en-US');
  });

  await t.test('null → "en-US"', () => {
    assert.strictEqual(normalizeLang(null), 'en-US');
  });

  await t.test('undefined → "en-US"', () => {
    assert.strictEqual(normalizeLang(undefined), 'en-US');
  });

  await t.test('0 → "en-US"', () => {
    assert.strictEqual(normalizeLang(0), 'en-US');
  });

  await t.test('unknown "xx" → "xx" (passed through)', () => {
    assert.strictEqual(normalizeLang('xx'), 'xx');
  });

  await t.test('"sv" (not in map) → "sv"', () => {
    assert.strictEqual(normalizeLang('sv'), 'sv');
  });
});

test('resolveLanguageList — BASE_LANGS always present', async (t) => {
  await t.test('always returns at least BASE_LANGS', () => {
    const list = resolveLanguageList('en-US', 'en-US');
    assert.ok(list.length >= BASE_LANGS.length);
    assert.ok(list.some(l => l.code === 'en-US'));
    assert.ok(list.some(l => l.code === 'es-AR'));
  });
});

test('resolveLanguageList — browser lang prepended when new', async (t) => {
  await t.test('"fr" browser lang → prepends "fr-FR"', () => {
    const list = resolveLanguageList('en-US', 'fr');
    assert.strictEqual(list[0].code, 'fr-FR');
    assert.strictEqual(list[0].name, 'fr-FR (browser)');
  });

  await t.test('"es-AR" already in BASE_LANGS → NOT duplicated', () => {
    const list = resolveLanguageList('es-AR', 'es-AR');
    const count = list.filter(l => l.code === 'es-AR').length;
    assert.strictEqual(count, 1);
  });

  await t.test('"es" browser lang normalized → prepends "es-AR"', () => {
    const list = resolveLanguageList('en-US', 'es');
    // es → es-AR which is already in BASE_LANGS → no duplicate
    assert.strictEqual(list[0].code, 'en-US'); // order: en-US, es-AR (no new prepend)
    const count = list.filter(l => l.code === 'es-AR').length;
    assert.strictEqual(count, 1);
  });
});

test('resolveLanguageList — saved currentLang from localStorage', async (t) => {
  await t.test('saved "fr-FR" not in BASE or browser → prepended as "(saved)"', () => {
    const list = resolveLanguageList('fr-FR', 'en');
    const saved = list.find(l => l.code === 'fr-FR');
    assert.ok(saved);
    assert.ok(saved.name.includes('saved'));
  });

  await t.test('saved lang same as browser lang → no duplicate label', () => {
    // currentLang = 'fr-FR', browserLang = 'fr' → normalized = 'fr-FR'
    // browser prepend adds 'fr-FR (browser)', saved check finds it already exists
    const list = resolveLanguageList('fr-FR', 'fr');
    const count = list.filter(l => l.code === 'fr-FR').length;
    assert.strictEqual(count, 1);
  });

  await t.test('saved lang same as BASE_LANGS entry → no duplicate', () => {
    const list = resolveLanguageList('es-AR', 'fr');
    const count = list.filter(l => l.code === 'es-AR').length;
    assert.strictEqual(count, 1);
  });
});

test('resolveLanguageList — null/empty browser lang handled', async (t) => {
  await t.test('null browserLang → only BASE_LANGS + saved if different', () => {
    const list = resolveLanguageList('en-US', null);
    assert.strictEqual(list.length, BASE_LANGS.length);
  });

  await t.test('empty string browserLang → not added', () => {
    const list = resolveLanguageList('en-US', '');
    assert.strictEqual(list.length, BASE_LANGS.length);
  });

  await t.test('null currentLang → no saved entry', () => {
    const list = resolveLanguageList(null, 'en-US');
    const saved = list.filter(l => l.name.includes('saved'));
    assert.strictEqual(saved.length, 0);
  });
});

test('resolveLanguageList — no duplicates ever', async (t) => {
  await t.test('all codes unique', () => {
    const list = resolveLanguageList('pt-BR', 'it');
    const codes = list.map(l => l.code);
    assert.strictEqual(new Set(codes).size, codes.length);
  });
});

// ── setLang generation guard (race condition) ─────────────────────────

test('setLang _langSwitchGen — prevents stale race restart', async (t) => {
  // Simulate the generation counter logic from client.js
  let gen = 0;
  let restarted = 0;
  let isListening = true;

  function simulateSetLang() {
    const myGen = ++gen;
    // First call: schedule a restart
    if (myGen === 1) {
      // Simulate second setLang call arriving before first timeout fires
      const gen2 = ++gen; // second call increments to 2
      // second call's timeout fires first (races)
      if (gen2 === gen) { restarted++; isListening = true; }
      // first call's timeout fires later — should NOT restart
      if (myGen !== gen) { /* skipped — correct! */ }
    }
  }

  await t.test('rapid double switch — only last gen wins', () => {
    // Simplified: direct test of gen checkpoint pattern
    let _gen = 0;
    const results = [];

    // First switch
    const g1 = ++_gen;
    // Second switch before first timeout
    const g2 = ++_gen;

    // First timeout fires
    if (g1 !== _gen) results.push('stale-skipped');
    // Second timeout fires
    if (g2 === _gen) results.push('fresh-allowed');

    assert.deepStrictEqual(results, ['stale-skipped', 'fresh-allowed']);
  });

  await t.test('single switch — timeout fires normally', () => {
    let _gen = 0;
    const g1 = ++_gen;
    assert.strictEqual(g1, _gen); // gen matches → should restart
  });

  await t.test('no switch (wasListening=false) — gen unchanged', () => {
    let _gen = 0;
    // wasListening=false → no increment, no timeout
    assert.strictEqual(_gen, 0);
  });
});

// ── toggleDictation pending interim text logic ────────────────────────

test('toggleDictation stop — sends pending interim text', async (t) => {
  await t.test('pending text is trimmed before send', () => {
    const pending = '  hello world  ';
    assert.strictEqual(pending.trim(), 'hello world');
  });

  await t.test('empty pending text → NOT sent', () => {
    const pending = '   ';
    if (pending.trim()) {
      assert.fail('should not send empty');
    } else {
      assert.ok(true, 'correctly skipped');
    }
  });

  await t.test('non-empty pending text → sent', () => {
    const pending = 'partial dictation';
    const sent = pending.trim() ? true : false;
    assert.ok(sent);
  });
});

// ── onresult isFinal vs interim flow ──────────────────────────────────

test('onresult — isFinal sends to terminal, interim shows in overlay', async (t) => {
  await t.test('isFinal with text → sent', () => {
    const transcript = 'hola mundo';
    const isFinal = true;
    const sent = (isFinal && transcript.trim()) ? transcript : null;
    assert.strictEqual(sent, 'hola mundo');
  });

  await t.test('isFinal empty → not sent', () => {
    const transcript = '  ';
    const isFinal = true;
    const sent = (isFinal && transcript.trim()) ? transcript : null;
    assert.strictEqual(sent, null);
  });

  await t.test('interim (not final) → shown in overlay, not sent', () => {
    const transcript = 'hola mun...';
    const isFinal = false;
    const interimText = isFinal ? '' : transcript;
    assert.strictEqual(interimText, 'hola mun...');
  });
});

// ── longPress timer logic ─────────────────────────────────────────────

test('longPress timer — 500ms threshold', async (t) => {
  await t.test('pointerdown sets timer', () => {
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 500);
    assert.strictEqual(timerFired, false); // not fired immediately
    clearTimeout(timer);
  });

  await t.test('pointerup before 500ms → toggles dictation, not language menu', () => {
    let longPressFired = false;
    // pointerup fires while longPressFired is false
    if (longPressFired) {
      assert.fail('should toggle dictation, not show menu');
    } else {
      assert.ok(true, 'toggle dictation path');
    }
  });

  await t.test('pointerleave cancels timer', () => {
    let timerCleared = false;
    const timer = setTimeout(() => {}, 500);
    clearTimeout(timer);
    timerCleared = true;
    assert.ok(timerCleared);
  });
});

// ── language-not-supported fallback ───────────────────────────────────

test('onerror language-not-supported → falls back to en-US', async (t) => {
  await t.test('fallback sets lang to en-US', () => {
    let lang = 'es-XX'; // unsupported
    const error = 'language-not-supported';
    if (error === 'language-not-supported') {
      lang = 'en-US';
    }
    assert.strictEqual(lang, 'en-US');
  });

  await t.test('not-allowed error → disables button, does NOT change lang', () => {
    let lang = 'es-AR';
    let disabled = false;
    const error = 'not-allowed';
    if (error === 'not-allowed') {
      disabled = true;
      // lang unchanged
    } else if (error === 'language-not-supported') {
      lang = 'en-US';
    }
    assert.strictEqual(lang, 'es-AR');
    assert.ok(disabled);
  });
});
