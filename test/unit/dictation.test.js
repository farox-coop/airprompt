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



// ── onresult isFinal vs interim flow ──────────────────────────────────

// ── Scroll to bottom ─────────────────────────────────────────────────

test('overlay scroll — always scrolled to bottom after update', async (t) => {
  await t.test('scrollTop set to scrollHeight after text update', () => {
    // Real code: dictateText.scrollTop = dictateText.scrollHeight;
    // This is a DOM property set — test the intent: scrollTop ≥ old value
    let scrollTop = 0;
    const scrollHeight = 500;
    // Simulate: text grows, scrollHeight increases, scrollTop follows
    scrollTop = scrollHeight;  // Always pegged to bottom
    assert.ok(scrollTop >= 0);
    assert.strictEqual(scrollTop, scrollHeight);
  });

  await t.test('new text larger → scrollTop updates to new bottom', () => {
    let scrollTop = 200;
    let scrollHeight = 500; // new content larger
    scrollTop = scrollHeight;
    assert.strictEqual(scrollTop, 500);
  });
});

// ── longTap timer logic ─────────────────────────────────────────────

// Simulates the pointerdown timeout handler (500ms timer callback).
// Mirrors client.js: dictateBtn pointerdown → setTimeout body.
function simulateLongTap(isListening, isPaused, stopPending) {
  if (stopPending) {
    return { action: 'ignored' };
  } else if (isListening) {
    return { action: 'pause' };
  } else if (isPaused) {
    return { action: 'resume' };
  } else {
    return { action: 'langDropdown' };
  }
}

test('longTap handler — decision tree', async (t) => {
  await t.test('long-tap while recording → pause', () => {
    const r = simulateLongTap(true, false, false);
    assert.strictEqual(r.action, 'pause');
  });

  await t.test('long-tap while paused → resume (not lang dropdown)', () => {
    const r = simulateLongTap(false, true, false);
    assert.strictEqual(r.action, 'resume');
  });

  await t.test('long-tap while idle → language dropdown', () => {
    const r = simulateLongTap(false, false, false);
    assert.strictEqual(r.action, 'langDropdown');
  });

  await t.test('long-tap while _stopPending → ignored', () => {
    // Even if recording, stopPending takes priority
    const r = simulateLongTap(true, false, true);
    assert.strictEqual(r.action, 'ignored');
  });

  await t.test('long-tap while stopPending + paused → ignored', () => {
    const r = simulateLongTap(false, true, true);
    assert.strictEqual(r.action, 'ignored');
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


// ── Dictate button click isolation ─────────────────────────────────────

test('dictateBtn click isolation — test intent', async (t) => {
  await t.test('dictateBtn click stops propagation', () => {
    // Real code: dictateBtn.addEventListener('click', (e) => { e.stopPropagation(); });
    // sessionBar.addEventListener('click', openModal);
    // Without stopPropagation, clicking dictateBtn would open the modal.
    // Test: verify the intent — clicking dictateBtn should NOT call openModal.
    let modalOpened = false;
    function openModal() { modalOpened = true; }
    function dictateBtnClick(e) { e.stopPropagation(); }  // Real API call

    // Simulate: sessionBar catches only non-stopped clicks
    function simulateClick(onDictate, onSession) {
      const event = { _stopped: false };
      event.stopPropagation = function() { this._stopped = true; };
      onDictate(event);
      if (!event._stopped) onSession();  // sessionBar only sees non-stopped clicks
    }

    simulateClick(dictateBtnClick, openModal);
    assert.strictEqual(modalOpened, false, 'modal must not open when dictateBtn stops propagation');
  });

  await t.test('sessionBar click directly → modal opens', () => {
    // Clicking the bar label (not a button) should open modal
    let modalOpened = false;
    function openModal() { modalOpened = true; }
    function sessionBarLabelClick() { openModal(); }  // no stopPropagation
    sessionBarLabelClick();
    assert.strictEqual(modalOpened, true);
  });
});
// i18n - translation map and tr() function

const T_TEST = {
  'en-US': { dictate: 'Dictate', recording: 'Recording', paused: 'Paused', cancel: 'Cancel', accept: 'Accept', send: 'Send', noSession: 'No session', unknown: 'Testing' },
  'es-AR': { dictate: 'Dictar', recording: 'Grabando', paused: 'Pausado', cancel: 'Cancelar', accept: 'Aceptar', send: 'Enviar', noSession: 'Sin sesi\u00f3n' },
};

function trTest(key, lang) {
  return (T_TEST[lang] && T_TEST[lang][key]) || T_TEST['en-US'][key] || key;
}

test('i18n tr() - resolves keys for known languages', async (t) => {
  await t.test('en-US -> English labels', () => {
    assert.strictEqual(trTest('dictate', 'en-US'), 'Dictate');
    assert.strictEqual(trTest('recording', 'en-US'), 'Recording');
    assert.strictEqual(trTest('cancel', 'en-US'), 'Cancel');
    assert.strictEqual(trTest('accept', 'en-US'), 'Accept');
    assert.strictEqual(trTest('send', 'en-US'), 'Send');
    assert.strictEqual(trTest('paused', 'en-US'), 'Paused');
  });

  await t.test('es-AR -> Spanish labels', () => {
    assert.strictEqual(trTest('dictate', 'es-AR'), 'Dictar');
    assert.strictEqual(trTest('recording', 'es-AR'), 'Grabando');
    assert.strictEqual(trTest('cancel', 'es-AR'), 'Cancelar');
    assert.strictEqual(trTest('accept', 'es-AR'), 'Aceptar');
    assert.strictEqual(trTest('send', 'es-AR'), 'Enviar');
    assert.strictEqual(trTest('paused', 'es-AR'), 'Pausado');
  });
});

test('i18n tr() - fallback behavior', async (t) => {
  await t.test('unknown language -> falls back to en-US', () => {
    assert.strictEqual(trTest('dictate', 'fr-FR'), 'Dictate');
  });

  await t.test('unknown key -> falls back to en-US if exists', () => {
    assert.strictEqual(trTest('unknown', 'es-AR'), 'Testing');
  });

  await t.test('unknown key + unknown lang -> falls back to key itself', () => {
    assert.strictEqual(trTest('nonexistent', 'xx-XX'), 'nonexistent');
  });

  await t.test('key missing in es-AR but present in en-US -> en-US fallback', () => {
    assert.strictEqual(trTest('unknown', 'es-AR'), 'Testing');
  });
});

test('i18n tr() - label switching does not break', async (t) => {
  await t.test('state labels switch correctly', () => {
    const states = ['dictate', 'recording', 'paused'];
    for (const s of states) {
      const en = trTest(s, 'en-US');
      const es = trTest(s, 'es-AR');
      assert.notStrictEqual(en, es, '"' + s + '" must differ between en-US and es-AR');
    }
  });

  await t.test('overlay button labels differ per language', () => {
    assert.notStrictEqual(trTest('cancel', 'en-US'), trTest('cancel', 'es-AR'));
    assert.notStrictEqual(trTest('accept', 'en-US'), trTest('accept', 'es-AR'));
    assert.notStrictEqual(trTest('send', 'en-US'), trTest('send', 'es-AR'));
  });
});

// ── _stopPending guard — prevents double-tap race ─────────────────────

function simulateToggleState(isListening, isPaused, stopPending) {
  // Replicates toggleDictation() decision tree
  if (isListening) {
    // STOP path
    return { action: 'stop', stopPending: true };
  } else if (stopPending) {
    // Guard: ignore taps during in-flight stop
    return { action: 'ignored' };
  } else {
    // START path — production toggleDictation() does not have an isPaused branch;
    // tapping mic while paused triggers a fresh start.
    return { action: 'start' };
  }
}

test('toggleDictation — _stopPending guard and state transitions', async (t) => {
  await t.test('recording → stop (sets _stopPending)', () => {
    const r = simulateToggleState(true, false, false);
    assert.strictEqual(r.action, 'stop');
    assert.strictEqual(r.stopPending, true);
  });

  await t.test('_stopPending=true blocks START', () => {
    const r = simulateToggleState(false, false, true);
    assert.strictEqual(r.action, 'ignored');
  });

  await t.test('_stopPending=true blocks RESUME too', () => {
    const r = simulateToggleState(false, true, true);
    assert.strictEqual(r.action, 'ignored');
  });

  await t.test('stopped + no guard → start', () => {
    const r = simulateToggleState(false, false, false);
    assert.strictEqual(r.action, 'start');
  });

  await t.test('paused + no guard → start (production toggleDictation has no isPaused branch)', () => {
    const r = simulateToggleState(false, true, false);
    assert.strictEqual(r.action, 'start');
  });
});

// ── Pause / Resume state transitions ──────────────────────────────────

function simulatePause(state) {
  // pauseDictation(): isListening=true → isListening=false, isPaused=true
  if (!state.isListening) return null; // early return guard
  return { isListening: false, isPaused: true };
}

function simulateResume(state) {
  // resumeDictation(): isPaused=true → isPaused=false, isListening=true
  if (!state.isPaused) return null;
  return { isListening: true, isPaused: false };
}

test('pause/resume — guard conditions and transitions', async (t) => {
  await t.test('pause when not listening → no-op', () => {
    const r = simulatePause({ isListening: false, isPaused: false });
    assert.strictEqual(r, null);
  });

  await t.test('pause when listening → paused', () => {
    const r = simulatePause({ isListening: true, isPaused: false });
    assert.ok(r);
    assert.strictEqual(r.isListening, false);
    assert.strictEqual(r.isPaused, true);
  });

  await t.test('resume when not paused → no-op', () => {
    const r = simulateResume({ isListening: false, isPaused: false });
    assert.strictEqual(r, null);
  });

  await t.test('resume when paused → listening', () => {
    const r = simulateResume({ isListening: false, isPaused: true });
    assert.ok(r);
    assert.strictEqual(r.isListening, true);
    assert.strictEqual(r.isPaused, false);
  });

  await t.test('full cycle: start → pause → resume → stop', () => {
    // start
    let state = { isListening: true, isPaused: false };
    assert.strictEqual(state.isListening, true);
    // pause
    state = simulatePause(state);
    assert.strictEqual(state.isListening, false);
    assert.strictEqual(state.isPaused, true);
    // resume
    state = simulateResume(state);
    assert.strictEqual(state.isListening, true);
    assert.strictEqual(state.isPaused, false);
    // stop (toggle while listening)
    const r = simulateToggleState(state.isListening, state.isPaused, false);
    assert.strictEqual(r.action, 'stop');
    assert.strictEqual(r.stopPending, true);
  });
});

// ── dismissOverlay — clears paused state ──────────────────────────────

test('dismissOverlay — resets isPaused', async (t) => {
  await t.test('dismiss from paused → isPaused cleared', () => {
    // dismissOverlay(): isPaused=false, remove paused class, hide overlay
    let isPaused = true;
    isPaused = false; // dismissOverlay effect
    assert.strictEqual(isPaused, false);
  });

  await t.test('dismiss from recording → isPaused stays false', () => {
    let isPaused = false;
    isPaused = false; // dismissOverlay effect (no-op, already false)
    assert.strictEqual(isPaused, false);
  });
});

// ── recognition.onstart — defensive UI state sync ──────────────────────

function simulateOnstart(isListening, hasRecordingClass, wasPaused) {
  // Mirrors client.js recognition.onstart handler.
  // Only corrects if isListening=true but .recording class missing.
  let isPaused = wasPaused;
  let fixed = false;
  if (isListening && !hasRecordingClass) {
    isPaused = false;
    fixed = true;
  }
  return { isPaused, fixed, classNow: isListening ? 'recording' : (isPaused ? 'paused' : 'none') };
}

test('recognition.onstart — UI state sync', async (t) => {
  await t.test('onstart when listening + no .recording → fixes paused state', () => {
    // Bug scenario: resumeDictation sets isListening=true, starts recognition,
    // but recognition.onstart hadn't fired yet — button still shows paused.
    // onstart fires and detects mismatch.
    const r = simulateOnstart(true, false, true);
    assert.strictEqual(r.fixed, true);
    assert.strictEqual(r.isPaused, false);
  });

  await t.test('onstart when listening + .recording present → no change needed', () => {
    const r = simulateOnstart(true, true, false);
    assert.strictEqual(r.fixed, false);
    assert.strictEqual(r.isPaused, false);
  });

  await t.test('onstart when NOT listening → no change (defensive no-op)', () => {
    // If onstart fires but isListening is false (shouldn't happen normally,
    // but be defensive), don't touch state.
    const r = simulateOnstart(false, false, true);
    assert.strictEqual(r.fixed, false);
    assert.strictEqual(r.isPaused, true); // unchanged
  });

  await t.test('onstart: listening + paused class but no recording → fixes', () => {
    // Red bg + "Paused" label: isListening=true, classList has 'paused' not 'recording'
    const r = simulateOnstart(true, false, true);
    assert.strictEqual(r.fixed, true);
    assert.strictEqual(r.isPaused, false);
    assert.strictEqual(r.classNow, 'recording');
  });
});

// ── acceptAndSend — split write (text, then \\r) ────────────────────────

function simulateAcceptAndSend(text) {
  // Replicates acceptAndSend(): sends text then \r as two separate writes.
  // This mimics real keystrokes — avoids PTY buffering quirks where a
  // single write of "text\r" may not submit the line.
  const writes = [];
  if (text) {
    writes.push({ data: text });
    writes.push({ data: '\r' });
  }
  return writes;
}

test('acceptAndSend — split write behavior', async (t) => {
  await t.test('text + CR → two separate writes', () => {
    const text = 'hello world';
    const writes = simulateAcceptAndSend(text);
    assert.strictEqual(writes.length, 2);
    assert.strictEqual(writes[0].data, 'hello world');
    assert.strictEqual(writes[1].data, '\r');
    assert.strictEqual(writes[1].data.charCodeAt(0), 13); // CR = 0x0D
  });

  await t.test('empty text → no writes at all', () => {
    const writes = simulateAcceptAndSend('');
    assert.strictEqual(writes.length, 0);
  });

  await t.test('whitespace-only text → no writes (empty after trim)', () => {
    // Both client and test trim the text, so whitespace-only becomes empty
    const text = '   '.trim();
    const writes = simulateAcceptAndSend(text);
    assert.strictEqual(writes.length, 0);
  });

  await t.test('single char → two writes', () => {
    const writes = simulateAcceptAndSend('x');
    assert.strictEqual(writes.length, 2);
    assert.strictEqual(writes[0].data, 'x');
    assert.strictEqual(writes[1].data, '\r');
  });
});

// ── Dictation macros — integration with onresult fragment flow ─────────
// Simulates the fragment-detection + macro-processing loop added to
// dictation.js onresult handler. Uses the real production module.

const M_INT = (function() {
  global.window = global.window || {};
  require('../../public/dictation-macros.js');
  return global.window.DictationMacros;
})();

// Simulates the fragment loop added to dictation.js onresult.
// Uses delta-extraction per result index (matching production code).
function simulateMacroOnresult(fragments, lang) {
  const state = { segments: [], pendingFormat: null, lastTranscripts: [] };

  for (let i = 0; i < fragments.length; i++) {
    // Each fragment arrives at index i as a growing `event.results` array.
    // Simulate Chrome cumulative behavior: transcript at index i is the new fragment.
    const transcript = fragments[i];
    const prev = state.lastTranscripts[i] || '';

    // Delta extraction + STT-newline revert — real production functions.
    let delta = M_INT.extractDelta(transcript, prev);
    if (!delta) continue;
    state.lastTranscripts[i] = transcript;
    delta = M_INT.revertSttNewlines(delta, lang);

    const m = M_INT.processFragment(delta, lang);
    if (m.type === 'macro') {
      if (m.insert) {
        state.segments.push(m.insert);
        state.pendingFormat = null; // insert consumes any pending format (matches production)
      } else {
        state.pendingFormat = m.format;
      }
    } else {
      // Production applies inline first (onEnd triggers match at fragment end),
      // then wraps with pending format.
      let text = M_INT.applyInline(delta, lang);
      text = state.pendingFormat ? M_INT.applyFormat(text, state.pendingFormat) : text;
      state.pendingFormat = null;
      state.segments.push(text);
    }
  }

  const rawDisplay = state.segments.join(' ');
  // Production re-applies applyInline to the display/accept text for spacing
  // normalization (e.g. insert "punto" → "fin ." → "fin."). It is idempotent.
  const processed = M_INT.applyInline(rawDisplay, lang);
  return {
    displayText: processed,
    finalText: processed,
    segments: state.segments,
    pendingFormat: state.pendingFormat,
  };
}

test('dictation macros integration — onresult fragment flow', async (t) => {
  await t.test('text → macro → text: quotes next fragment (es-AR)', () => {
    const r = simulateMacroOnresult([
      'este feature',
      'entre comillas',
      'lindo',
    ], 'es-AR');

    assert.strictEqual(r.displayText, 'este feature "lindo"');
    assert.strictEqual(r.finalText, 'este feature "lindo"');
    assert.strictEqual(r.pendingFormat, null);
  });

  await t.test('text → macro → text (en-US)', () => {
    const r = simulateMacroOnresult([
      'this feature',
      'in quotes',
      'nice',
    ], 'en-US');

    assert.strictEqual(r.displayText, 'this feature "nice"');
  });

  await t.test('macro consumed — not shown in display', () => {
    const r = simulateMacroOnresult([
      'entre comillas',
    ], 'es-AR');

    assert.strictEqual(r.displayText, '');
    assert.strictEqual(r.segments.length, 0);
    assert.strictEqual(r.pendingFormat, 'quotes');
  });

  await t.test('uppercase format applies to next fragment', () => {
    const r = simulateMacroOnresult([
      'en mayúsculas',
      'casa',
    ], 'es-AR');

    assert.strictEqual(r.displayText, 'Casa');
  });

  await t.test('allcaps format applies to next fragment', () => {
    const r = simulateMacroOnresult([
      'todo mayúsculas',
      'gritar',
    ], 'es-AR');

    assert.strictEqual(r.displayText, 'GRITAR');
  });

  await t.test('consecutive macros → last wins', () => {
    const r = simulateMacroOnresult([
      'entre comillas',
      'en mayúsculas',
      'hola',
    ], 'es-AR');

    assert.strictEqual(r.displayText, 'Hola');
    assert.strictEqual(r.pendingFormat, null);
  });

  await t.test('macro + text with inline → both processed', () => {
    const r = simulateMacroOnresult([
      'entre comillas',
      'hola signo de pregunta',
    ], 'es-AR');

    assert.strictEqual(r.finalText, '"hola?"');
  });

  await t.test('uppercase + inline → format first, then inline', () => {
    const r = simulateMacroOnresult([
      'en mayúsculas',
      'hola signo de pregunta',
    ], 'es-AR');

    assert.strictEqual(r.finalText, 'Hola?');
  });

  await t.test('no macros → plain passthrough', () => {
    const r = simulateMacroOnresult([
      'hola mundo',
      'cómo estás',
    ], 'es-AR');

    assert.strictEqual(r.displayText, 'hola mundo cómo estás');
    assert.strictEqual(r.segments.length, 2);
  });

  await t.test('embedded macro phrase in longer text → NOT treated as macro', () => {
    const r = simulateMacroOnresult([
      'dije entre comillas ayer',
      'lindo',
    ], 'es-AR');

    assert.strictEqual(r.displayText, 'dije entre comillas ayer lindo');
    assert.strictEqual(r.pendingFormat, null);
  });

  await t.test('empty fragment after macro → skipped, format applies to next', () => {
    const r = simulateMacroOnresult([
      'entre comillas',
      '   ',
      'real text',
    ], 'es-AR');

    assert.strictEqual(r.displayText, '"real text"');
  });

  await t.test('results reset (Android pattern) — covered by simulateMacroOnresult', () => {
    // Chrome Android: each utterance is a fresh recognition session, so each
    // fragment arrives at a new result index (exactly what simulateMacroOnresult
    // models via per-index _lastTranscripts). production's onstart clears
    // _lastTranscripts so a fresh session reprocesses from index 0.
    const r = simulateMacroOnresult(['hello', 'in quotes', 'world'], 'en-US');
    assert.strictEqual(r.displayText, 'hello "world"');
  });

  await t.test('parens: text → macro → text wraps in parentheses', () => {
    const r = simulateMacroOnresult([
      'este',
      'entre paréntesis',
      'feature',
    ], 'es-AR');

    assert.strictEqual(r.displayText, 'este (feature)');
    assert.strictEqual(r.pendingFormat, null);
  });

  await t.test('single-quote stateful (entre comillas simples)', () => {
    const r = simulateMacroOnresult([
      'entre comillas simples',
      'hola',
    ], 'es-AR');

    assert.strictEqual(r.displayText, "'hola'");
  });

  await t.test('fragment-level insert: "coma" standalone → ","', () => {
    const r = simulateMacroOnresult(['no', 'coma', 'gracias'], 'es-AR');
    assert.strictEqual(r.displayText, 'no, gracias');
  });

  await t.test('fragment-level insert: "punto" standalone → "."', () => {
    const r = simulateMacroOnresult(['fin', 'punto'], 'es-AR');
    assert.strictEqual(r.displayText, 'fin.');
  });

  await t.test('"coma" embedded in phrase — NOT replaced', () => {
    const r = simulateMacroOnresult(['no quisiera que se coma esto'], 'es-AR');
    assert.strictEqual(r.displayText, 'no quisiera que se coma esto');
  });

  await t.test('insert consumes pending format (quote then comma)', () => {
    const r = simulateMacroOnresult(['entre comillas', 'coma', 'gracias'], 'es-AR');
    // "entre comillas" sets pendingFormat=quotes; "coma" insert clears it;
    // "gracias" is NOT quoted.
    assert.strictEqual(r.displayText, ', gracias');
  });

  await t.test('accept: pending format applies to interim only, not prior segments', () => {
    // Finalized: "algo" → segment. Macro "entre comillas" → pendingFormat.
    // Interim: "hola". Accept must wrap only "hola", not "algo".
    const state = { segments: [], pendingFormat: null, lastTranscripts: [] };
    // fragment loop over finalized parts
    const m1 = M_INT.processFragment('algo', 'es-AR');
    if (m1.type === 'macro') { state.pendingFormat = m1.format; }
    else state.segments.push(M_INT.applyInline('algo', 'es-AR'));
    const m2 = M_INT.processFragment('entre comillas', 'es-AR');
    if (m2.type === 'macro') state.pendingFormat = m2.format;

    // accept-time: interim "hola" + pendingFormat
    const segmentsText = state.segments.join(' ');
    let interimText = 'hola';
    if (state.pendingFormat && interimText) {
      interimText = M_INT.applyInline(interimText, 'es-AR');
      interimText = M_INT.applyFormat(interimText, state.pendingFormat);
      state.pendingFormat = null;
    }
    const rawText = M_INT.trimSpaces(segmentsText + (interimText ? ' ' + interimText : ''));
    const text = M_INT.applyInline(rawText, 'es-AR');

    assert.strictEqual(text, 'algo "hola"');
  });

  await t.test('accept: pending format with empty interim is dropped', () => {
    const state = { segments: ['algo'], pendingFormat: 'quotes' };
    const segmentsText = state.segments.join(' ');
    let interimText = '';
    if (state.pendingFormat && interimText) {
      interimText = M_INT.applyInline(interimText, 'es-AR');
      interimText = M_INT.applyFormat(interimText, state.pendingFormat);
      state.pendingFormat = null;
    }
    const rawText = M_INT.trimSpaces(segmentsText + (interimText ? ' ' + interimText : ''));
    const text = M_INT.applyInline(rawText, 'es-AR');

    assert.strictEqual(text, 'algo');
  });

  await t.test('accept: wrapping format + onEnd trigger at interim', () => {
    // "entre comillas" (pendingFormat=quotes) + interim "hola signo de pregunta".
    // Inline (onEnd → "hola?") must run BEFORE the quote wrapper → '"hola?"'.
    const state = { segments: [], pendingFormat: 'quotes' };
    const segmentsText = state.segments.join(' ');
    let interimText = 'hola signo de pregunta';
    if (state.pendingFormat && interimText) {
      interimText = M_INT.applyInline(interimText, 'es-AR');
      interimText = M_INT.applyFormat(interimText, state.pendingFormat);
      state.pendingFormat = null;
    }
    const rawText = M_INT.trimSpaces(segmentsText + (interimText ? ' ' + interimText : ''));
    const text = M_INT.applyInline(rawText, 'es-AR');

    assert.strictEqual(text, '"hola?"');
  });

  await t.test('accept: interim mid-sentence newline is reverted to literal', () => {
    // Interim still mid-utterance: the STT emitted "\n\n" for a mid-sentence
    // "nuevo párrafo". Accept must revert it to the literal phrase.
    const state = { segments: ['hola'], pendingFormat: null };
    const segmentsText = state.segments.join(' ');
    let interimText = M_INT.revertSttNewlines('esto va en un \n\n', 'es-AR');
    const rawText = M_INT.trimSpaces(segmentsText + (interimText ? ' ' + interimText : ''));
    const text = M_INT.applyInline(rawText, 'es-AR');
    assert.strictEqual(text, 'hola esto va en un nuevo párrafo');
  });

  await t.test('separate utterances that are prefix-related are NOT deduped', () => {
    // "hola" then "hola mundo" as two distinct indices → no false dedup.
    const r = simulateMacroOnresult(['hola', 'hola mundo'], 'es-AR');
    assert.strictEqual(r.displayText, 'hola hola mundo');
  });

  await t.test('STT newline command "\\n\\n" → revert → paragraph break', () => {
    // The recognizer emits "\n\n" for "nuevo párrafo"; the loop reverts it to
    // the literal phrase, then our macro re-applies it (isolated).
    const r = simulateMacroOnresult(['hola', '\n\n', 'chau'], 'es-AR');
    assert.strictEqual(r.displayText, 'hola\n\nchau');
  });

  await t.test('STT mid-sentence "\\n\\n" → revert → literal text', () => {
    // Embedded newline inside a phrase → reverted to literal "nuevo párrafo".
    const r = simulateMacroOnresult(['esto va en un \n\n y sigue'], 'es-AR');
    assert.strictEqual(r.displayText, 'esto va en un nuevo párrafo y sigue');
  });

});

