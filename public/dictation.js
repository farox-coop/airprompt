// public/dictation.js — Voice dictation with i18n, extracted from client.js.
// Exports window.Dictation with init/toggle/tr/updateAllLabels/getOverlayHeight.

(function() {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null;
  var isListening = false;
  var isPaused = false;          // Long-tap while recording → pause
  var _stopPending = false;     // Guard: ignore taps while stop is in-flight
  var _onendGen = 0;            // Prevents stale onend from pauseDictation() restarting
  var dictationAccumulator = '';   // Persists across recognition restarts (Chrome Android)

  // ── Dependencies (injected by client.js init) ─────────────────────────
  var _send, _log, _blurInput, _sessionLabel;

  // ── Dictation overlay DOM ────────────────────────────────────────────
  var dictateBtn      = document.getElementById('dictate-btn');
  var dictateIcon     = document.getElementById('dictate-icon');
  var dictateLabel    = document.getElementById('dictate-label');
  var dictateOverlay  = document.getElementById('dictate-overlay');
  var dictateText     = document.getElementById('dictate-text');
  var dictateAccept   = document.getElementById('dictate-accept');
  var dictateAcceptSend = document.getElementById('dictate-accept-send');
  var dictateCancel   = document.getElementById('dictate-cancel');
  var micError        = document.getElementById('mic-error');

  // ── i18n: labels change with selected language ────────────────────────
  var T = {
    'en-US': {
      dictate: 'Dictate', recording: 'Recording', paused: 'Paused',
      cancel: 'Cancel', accept: 'Accept', send: 'Send',
      listening: 'Listening…', speaking: '● Speaking…',
      noSession: 'No session selected', noActive: 'No active sessions',
      activeSessions: 'Active Sessions', close: 'Close', refresh: 'Refresh',
      micHttps: 'Voice needs HTTPS or localhost. Chrome blocks mic on HTTP LAN IP. Use keyboard below.',
      langFallback: 'Language not supported. Falling back to English.',
      disconnected: '⚠️ DISCONNECTED — Tap to dismiss',
    },
    'es-AR': {
      dictate: 'Dictar', recording: 'Grabando', paused: 'Pausado',
      cancel: 'Cancelar', accept: 'Aceptar', send: 'Enviar',
      listening: 'Escuchando…', speaking: '● Hablando…',
      noSession: 'Sin sesión', noActive: 'Sin sesiones activas',
      activeSessions: 'Sesiones Activas', close: 'Cerrar', refresh: 'Recargar',
      micHttps: 'El micrófono requiere HTTPS o localhost. Chrome bloquea el mic en IPs LAN HTTP.',
      langFallback: 'Idioma no soportado. Cambiando a inglés.',
      disconnected: '⚠️ DESCONECTADO — Tocar para cerrar',
    },
  };

  var currentLang = normalizeLang(
    (function() { try { return localStorage.getItem('airprompt-lang'); } catch (_) {} return ''; })()
    || navigator.language || 'en-US'
  );

  function tr(key) {
    return (T[currentLang] && T[currentLang][key]) || T['en-US'][key] || key;
  }

  function updateAllLabels() {
    // Dictate button (stopped state)
    if (!isListening && !isPaused) {
      dictateLabel.textContent = tr('dictate');
    } else if (isPaused) {
      dictateLabel.textContent = tr('paused');
    } else {
      dictateLabel.textContent = tr('recording');
    }
    // Overlay buttons
    dictateCancel.textContent = tr('cancel');
    dictateAccept.textContent = tr('accept');
    dictateAcceptSend.textContent = tr('send');
    if (langCancel) langCancel.textContent = tr('cancel');
    // CSS pseudo-elements via custom properties
    dictateText.style.setProperty('--listen-text', '"' + tr('listening') + '"');
    dictateText.style.setProperty('--speak-text', '"' + tr('speaking') + '"');
    // Modal
    var modalTitle = document.querySelector('#session-modal-content h3');
    if (modalTitle) modalTitle.textContent = tr('activeSessions');
    var modalClose = document.getElementById('modal-close');
    if (modalClose) modalClose.textContent = tr('close');
    // Refresh button title
    var refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.title = tr('refresh');
    // Session label (if no session)
    if (_sessionLabel && _sessionLabel.classList.contains('no-session')) {
      _sessionLabel.textContent = tr('noSession');
    }
    // Dictation disabled label
    if (!SpeechRecognition) {
      dictateLabel.textContent = tr('dictate');
    }
  }

  // Update CSS placeholder texts via custom properties
  var _i18nStyle = document.createElement('style');
  _i18nStyle.textContent = '\n' +
    '#dictate-text:empty::after { content: var(--listen-text, "Listening\\2026"); }\n' +
    '#dictate-overlay.speaking #dictate-text:empty::after { content: var(--speak-text, "\\25cf Speaking\\2026"); }\n';
  document.head.appendChild(_i18nStyle);

  // ── Language management ──────────────────────────────────────────────
  var BASE_LANGS = [
    { code: 'en-US', name: 'English (US)' },
    { code: 'es-AR', name: 'Español (AR)' },
  ];

  var dictateFlag   = document.getElementById('dictate-flag');
  var langDropdown  = document.getElementById('lang-dropdown');
  var langList      = document.getElementById('lang-list');
  var langCancel    = document.getElementById('lang-cancel');

  function langToFlag(code) {
    var parts = code.split('-');
    var region = parts[parts.length - 1].toUpperCase();
    if (!region || region.length !== 2) return code.toUpperCase();
    try {
      return String.fromCodePoint(
        0x1F1E6 + region.charCodeAt(0) - 65,
        0x1F1E6 + region.charCodeAt(1) - 65
      );
    } catch (_) {
      return code.toUpperCase();
    }
  }

  function normalizeLang(code) {
    if (!code || !code.includes('-')) {
      var map = { en: 'en-US', es: 'es-AR', fr: 'fr-FR', de: 'de-DE',
                  pt: 'pt-BR', it: 'it-IT', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR' };
      code = map[code] || (code || 'en-US');
    }
    return code;
  }

  function resolveLanguageList() {
    var langs = BASE_LANGS.slice();
    var addIfMissing = function(code) {
      if (!langs.some(function(l) { return l.code === code; })) {
        langs.unshift({ code: code, name: code + ' (browser)' });
      }
    };
    var browserLang = navigator.language;
    if (browserLang) addIfMissing(normalizeLang(browserLang));
    if (currentLang && !langs.some(function(l) { return l.code === currentLang; })) {
      langs.unshift({ code: currentLang, name: currentLang + ' (saved)' });
    }
    return langs;
  }

  function buildLangList() {
    var langs = resolveLanguageList();
    langList.innerHTML = '';
    langs.forEach(function(lang) {
      var el = document.createElement('div');
      el.className = 'lang-option' + (lang.code === currentLang ? ' active' : '');
      el.innerHTML = '<span class="lang-flag">' + langToFlag(lang.code) +
                     '</span> ' + lang.name;
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        setLang(lang.code);
        hideLangDropdown();
      });
      langList.appendChild(el);
    });
  }

  function updateFlag() {
    if (dictateFlag) dictateFlag.textContent = langToFlag(currentLang);
  }

  var _langSwitchGen = 0;

  function setLang(code) {
    currentLang = code;
    try { localStorage.setItem('airprompt-lang', code); } catch (_) {}
    var wasListening = isListening;
    var gen = ++_langSwitchGen;
    if (wasListening) {
      isListening = false;
      recognition.stop();
    }
    recognition.lang = code;
    updateFlag();
    buildLangList();
    updateAllLabels();
    // Always schedule restart — gen check below ensures only the last
    // call's restart fires, even across rapid switches where intermediate
    // calls see isListening already false.
    setTimeout(function() {
      if (gen !== _langSwitchGen) return;
      if (!wasListening) return;  // only restart if recording before switch
      isListening = true;
      _safeRecognitionStart();
      dictateBtn.classList.add('recording');
      dictateIcon.textContent = '🔴';
      dictateLabel.textContent = tr('recording');
    }, 200);
  }

  function showLangDropdown() {
    buildLangList();
    langDropdown.classList.remove('dropdown-hidden');
  }

  function hideLangDropdown() {
    langDropdown.classList.add('dropdown-hidden');
  }

  // ── Safe recognition start — guards against InvalidStateError ─────────
  function _safeRecognitionStart() {
    try { recognition.start(); return true; }
    catch (e) {
      isListening = false;
      isPaused = false;
      dictateBtn.classList.remove('recording', 'paused');
      dictateIcon.textContent = '🎤';
      dictateLabel.textContent = tr('dictate');
      if (_log) _log('warn', 'recognition.start() failed', { error: e.message });
      return false;
    }
  }

  // ── Recognition setup ───────────────────────────────────────────────
  function _setupRecognition() {
    if (!SpeechRecognition) {
      dictateIcon.textContent = '🚫';
      dictateLabel.textContent = tr('dictate');
      dictateBtn.disabled = true;
      updateAllLabels();
      return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = currentLang;
    recognition.interimResults = true;
    recognition.continuous = true;

    recognition.onresult = function(event) {
      var running = '';
      var latestInterim = '';

      for (var i = 0; i < event.results.length; i++) {
        var result = event.results[i];
        var transcript = result[0].transcript;

        if (result.isFinal) {
          if (result[0].confidence === 0) continue;
          if (running && transcript.length >= running.length &&
              transcript.slice(0, running.length).localeCompare(running, undefined, { sensitivity: 'base' }) === 0) {
            running = transcript;
          } else {
            running += transcript;
          }
        } else {
          latestInterim = transcript;
        }
      }

      if (running) {
        if (dictationAccumulator && running.length >= dictationAccumulator.length &&
            running.slice(0, dictationAccumulator.length).localeCompare(dictationAccumulator, undefined, { sensitivity: 'base' }) === 0) {
          dictationAccumulator = running;
        } else if (dictationAccumulator) {
          var lower = running.charAt(0).toLowerCase() + running.slice(1);
          dictationAccumulator = (dictationAccumulator + ', ' + lower).trim();
        } else {
          dictationAccumulator = running;
        }
      }

      if (dictateOverlay.classList.contains('dictate-hidden')) return;

      var displayText = latestInterim || dictationAccumulator;
      if (displayText) {
        dictateText.textContent = displayText;
        dictateText.style.height = 'auto';
        var h = dictateText.scrollHeight;
        dictateText.style.height = Math.min(h, window.innerHeight * 0.3) + 'px';
        dictateText.scrollTop = dictateText.scrollHeight;
      }
    };

    recognition.onspeechstart = function() {
      dictateOverlay.classList.add('speaking');
    };
    recognition.onspeechend = function() {
      dictateOverlay.classList.remove('speaking');
    };

    recognition.onstart = function() {
      if (isListening && !dictateBtn.classList.contains('recording')) {
        isPaused = false;
        dictateBtn.classList.remove('paused');
        dictateBtn.classList.add('recording');
        dictateIcon.textContent = '🔴';
        dictateLabel.textContent = tr('recording');
      }
    };

    recognition.onerror = function(e) {
      if (e.error === 'not-allowed') {
        isListening = false;
        _stopPending = false;
        dismissOverlay();
        dictateBtn.classList.remove('recording');
        dictateBtn.disabled = true;
        dictateIcon.textContent = '🔇';
        dictateLabel.textContent = tr('dictate');
        micError.style.display = 'block';
        micError.textContent = tr('micHttps');
      } else if (e.error === 'language-not-supported') {
        setLang('en-US');
        micError.style.display = 'block';
        micError.textContent = tr('langFallback');
        setTimeout(function() { micError.style.display = 'none'; }, 3000);
      }
      // Transient errors — onend will restart
    };

    var onendExpectedGen = _onendGen;
    recognition.onend = function() {
      dictateOverlay.classList.remove('speaking');
      if (isListening && onendExpectedGen === _onendGen && !_stopPending) _safeRecognitionStart();
    };

    updateFlag();
    buildLangList();
    updateAllLabels();

    // Wire event listeners for dictation buttons
    _wireListeners();
  }

  // ── Core dictation actions ──────────────────────────────────────────

  function toggleDictation(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!recognition) return;
    hideLangDropdown();

    if (isListening) {
      isListening = false;
      _stopPending = true;
      recognition.stop();
      dictateBtn.classList.remove('recording');
      dictateIcon.textContent = '🎤';
      dictateLabel.textContent = tr('dictate');
      setTimeout(function() { _stopPending = false; acceptDictation(); }, 150);
    } else if (_stopPending) {
      return; // Ignore taps during stop → accept transition
    } else {
      if (_blurInput) _blurInput();
      isListening = true;
      dictationAccumulator = '';
      dictateOverlay.classList.remove('dictate-hidden');
      dictateText.textContent = '';
      dictateText.style.height = '';
      _safeRecognitionStart();
      dictateBtn.classList.add('recording');
      dictateIcon.textContent = '🔴';
      dictateLabel.textContent = tr('recording');
    }
  }

  function acceptDictation() {
    _stopPending = false;
    var text = dictateText.textContent.trim();
    if (isListening) {
      isListening = false;
      recognition.abort();
      dictateBtn.classList.remove('recording');
      dictateIcon.textContent = '🎤';
      dictateLabel.textContent = tr('dictate');
    }
    if (text) {
      _send({ type: 'input', data: text });
    }
    dictationAccumulator = '';
    dismissOverlay();
  }

  function cancelDictation() {
    _stopPending = false;
    if (isListening) {
      isListening = false;
      recognition.abort();
      dictateBtn.classList.remove('recording');
      dictateIcon.textContent = '🎤';
      dictateLabel.textContent = tr('dictate');
    }
    dictationAccumulator = '';
    dismissOverlay();
  }

  function dismissOverlay() {
    isPaused = false;
    dictateBtn.classList.remove('paused');
    dictateOverlay.classList.add('dictate-hidden');
    dictateText.textContent = '';
    dictateText.style.height = '';
  }

  function acceptAndSend() {
    _stopPending = false;
    var text = dictateText.textContent.trim();
    if (isListening) {
      isListening = false;
      recognition.abort();
      dictateBtn.classList.remove('recording');
      dictateIcon.textContent = '🎤';
      dictateLabel.textContent = tr('dictate');
    }
    if (text) {
      _send({ type: 'input', data: text });
      setTimeout(function() {
        _send({ type: 'input', data: '\r' });
      }, 50);
    }
    dictationAccumulator = '';
    dismissOverlay();
  }

  // ── Pause / Resume ────────────────────────────────────────────────────

  function pauseDictation() {
    if (!isListening) return;
    isListening = false;
    isPaused = true;
    _onendGen++;
    recognition.stop();
    dictateBtn.classList.remove('recording');
    dictateBtn.classList.add('paused');
    dictateIcon.textContent = '⏸';
    dictateLabel.textContent = tr('paused');
  }

  function resumeDictation() {
    if (!isPaused) return;
    isPaused = false;
    isListening = true;
    _onendGen++;
    _safeRecognitionStart();
    dictateBtn.classList.remove('paused');
    dictateBtn.classList.add('recording');
    dictateIcon.textContent = '🔴';
    dictateLabel.textContent = tr('recording');
  }

  // ── Event listeners ─────────────────────────────────────────────────

  var longTapTimer = null;
  var longTapFired = false;

  function onLongTap() {
    longTapFired = true;
    if (_stopPending) {
      // stop in-flight → ignore
    } else if (isListening) {
      pauseDictation();
    } else if (isPaused) {
      resumeDictation();
    } else {
      showLangDropdown();
    }
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function onShortTap(e) {
    if (isPaused) {
      resumeDictation();
    } else {
      toggleDictation(e);
    }
  }

  function _wireListeners() {
    dictateAccept.addEventListener('click', function(e) {
      e.stopPropagation();
      acceptDictation();
    });

    dictateAcceptSend.addEventListener('click', function(e) {
      e.stopPropagation();
      acceptAndSend();
    });

    dictateCancel.addEventListener('click', function(e) {
      e.stopPropagation();
      cancelDictation();
    });

    // Block click from bubbling to session-bar (would open modal)
    dictateBtn.addEventListener('click', function(e) { e.stopPropagation(); });

    var _useTouch = false;
    try { _useTouch = window.matchMedia('(pointer: coarse)').matches; } catch (_) {}

    if (_useTouch) {
      var _touchStartT = 0;
      dictateBtn.addEventListener('touchstart', function(e) {
        e.stopPropagation();
        longTapFired = false;
        _touchStartT = Date.now();
        clearTimeout(longTapTimer);
        longTapTimer = setTimeout(onLongTap, 500);
      });

      dictateBtn.addEventListener('touchend', function(e) {
        e.stopPropagation();
        if (longTapFired) return;
        clearTimeout(longTapTimer);
        onShortTap(e);
      });

      dictateBtn.addEventListener('touchcancel', function() {
        if (!longTapFired && Date.now() - _touchStartT < 500) {
          clearTimeout(longTapTimer);
        }
      });

      dictateBtn.addEventListener('contextmenu', function(e) {
        e.preventDefault();
      });
    } else {
      dictateBtn.addEventListener('pointerdown', function(e) {
        e.stopPropagation();
        longTapFired = false;
        clearTimeout(longTapTimer);
        longTapTimer = setTimeout(onLongTap, 500);
      });

      dictateBtn.addEventListener('pointerup', function(e) {
        e.stopPropagation();
        if (longTapFired) return;
        clearTimeout(longTapTimer);
        onShortTap(e);
      });

      dictateBtn.addEventListener('pointerleave', function() {
        clearTimeout(longTapTimer);
      });
      dictateBtn.addEventListener('pointercancel', function() {
        clearTimeout(longTapTimer);
      });
    }

    // Close dropdown on outside click
    document.addEventListener('click', function(e) {
      if (!langDropdown.classList.contains('dropdown-hidden') &&
          !dictateBtn.contains(e.target) &&
          !langDropdown.contains(e.target)) {
        hideLangDropdown();
      }
    });

    if (langCancel) {
      langCancel.addEventListener('click', function(e) {
        e.stopPropagation();
        hideLangDropdown();
      });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  window.Dictation = {
    init: function(deps) {
      _send = deps.send;
      _log = deps.log;
      _blurInput = deps.blurInput || null;
      _sessionLabel = deps.sessionLabel || null;
      _setupRecognition();
    },
    toggle: toggleDictation,
    tr: tr,
    updateAllLabels: updateAllLabels,
    getOverlayHeight: function() {
      return dictateOverlay.classList.contains('dictate-hidden') ? 0 : dictateOverlay.offsetHeight;
    },
  };

})();
