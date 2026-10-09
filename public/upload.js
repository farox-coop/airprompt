// public/upload.js — Attach a file and get its host path into the session.
//
// The browser can never hand the host a phone-side path, so the bytes travel: a
// one-time token is minted over the authenticated WS, the file is POSTed to
// /api/upload, and the daemon answers with an absolute path on the host. That
// path — what the CLI needs in order to read the image — is then typed into the
// session as keystrokes, exactly how dictation injects text. Never through
// #mobile-input: that is an invisible IME-capture element, and on a desktop
// (fine-pointer) device its diff listener is not even registered.

(function () {
  'use strict';

  const attachBtn = document.getElementById('attach-btn');
  const clipBtn = document.getElementById('clipboard-btn');
  const fileInput = document.getElementById('upload-input');
  const progressEl = document.getElementById('upload-progress');
  const progressFill = document.getElementById('upload-progress-fill');
  const errorEl = document.getElementById('upload-error');

  if (!attachBtn || !fileInput || !progressEl || !errorEl) return;

  const RESIZE_PREF_KEY = 'airprompt-upload-resize';
  const TOKEN_TIMEOUT_MS = 5000;
  const UPLOAD_TIMEOUT_MS = 120000;
  const ERROR_MS = 4000;

  // Single place for every user-facing string.
  const MSG = {
    noSession: 'No active session',
    offline: 'Not connected — try again in a moment',
    failed: 'Upload failed',
    blocked: 'Waiting for the upload to finish…',
    switched: 'Uploaded, but the active session changed — path not inserted',
    clipEmpty: 'No image on the clipboard',
    clipBlocked: 'Clipboard unavailable — use the attach button',
  };

  let _busy = false;
  let _errorTimer = null;

  function showError(text) {
    errorEl.textContent = text;
    errorEl.classList.add('visible');
    clearTimeout(_errorTimer);
    _errorTimer = setTimeout(function () {
      errorEl.classList.remove('visible');
    }, ERROR_MS);
  }

  function setProgress(fraction) {
    progressFill.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
  }

  function setBusy(busy) {
    _busy = busy;
    attachBtn.disabled = busy;
    if (clipBtn) clipBtn.disabled = busy;
    if (busy) {
      setProgress(0);
      progressEl.classList.add('visible');
    } else {
      progressEl.classList.remove('visible');
    }
  }

  function activeSession() {
    const fn = window._airpromptActiveSession;
    return typeof fn === 'function' ? fn() : null;
  }

  function injectPath(text) {
    if (typeof window._airpromptSend === 'function')
      window._airpromptSend({ type: 'input', data: text });
  }

  function resizeEnabled() {
    try {
      const raw = localStorage.getItem(RESIZE_PREF_KEY);
      return raw === null ? true : JSON.parse(raw) !== false;
    } catch (_) {
      return true;
    }
  }

  function prepare(file) {
    const fallback = { blob: file, name: file.name, mime: file.type || '' };
    const R = window.UploadResize;
    if (!R || !resizeEnabled()) return Promise.resolve(fallback);
    return R.prepare(file).catch(function () {
      return fallback;
    });
  }

  // The token is minted over the authenticated WS — the LAN upload POST has no
  // other credential.
  function requestToken(sessionId) {
    if (typeof window._airpromptRequest !== 'function') return Promise.resolve(null);
    return window
      ._airpromptRequest(
        { type: 'upload_token', sessionId: sessionId },
        ['upload_token', 'upload_token_error'],
        TOKEN_TIMEOUT_MS
      )
      .then(function (reply) {
        return reply && reply.token ? reply.token : null;
      });
  }

  // XHR (not fetch) because only XHR reports upload progress.
  function post(token, item) {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open(
        'POST',
        '/api/upload?name=' +
          encodeURIComponent(item.name) +
          '&mime=' +
          encodeURIComponent(item.mime)
      );
      xhr.setRequestHeader('X-AirPrompt-Upload-Token', token);
      // Must match express.raw's configured type on the server, otherwise the
      // route sees an empty body and rejects the upload.
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.timeout = UPLOAD_TIMEOUT_MS;

      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) setProgress(e.loaded / e.total);
      };
      xhr.onload = function () {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch (_) {
          /* non-JSON body — Express's own error page (e.g. an old daemon that
             predates this route answers 404 with HTML) */
        }
        // Include the status when the server said nothing useful: "Upload failed
        // (404)" points straight at a stale daemon instead of a mystery.
        if (xhr.status === 200 && body.path) resolve(body);
        else reject(new Error(body.error || MSG.failed + ' (' + xhr.status + ')'));
      };
      xhr.onerror = function () {
        reject(new Error(MSG.offline));
      };
      xhr.ontimeout = function () {
        reject(new Error(MSG.failed));
      };
      xhr.send(item.blob);
    });
  }

  function uploadOne(file, sessionId) {
    return prepare(file)
      .then(function (item) {
        return requestToken(sessionId).then(function (token) {
          if (!token) throw new Error(MSG.offline);
          return post(token, item);
        });
      })
      .then(function (res) {
        // The file is in the session it was uploaded for; only insert the path if
        // the user is still looking at that session.
        if (activeSession() !== sessionId) {
          showError(MSG.switched);
          return;
        }
        // Backticks + a space either side: the path is boxed as a code span, so
        // it reads as one unit and lands already separated from whatever text it
        // is inserted into.
        injectPath(' `' + res.path + '` ');
      });
  }

  function handleFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (!files.length || _busy) return;
    const sessionId = activeSession();
    if (!sessionId) {
      showError(MSG.noSession);
      return;
    }
    setBusy(true);
    files
      .reduce(function (chain, file) {
        return chain.then(function () {
          return uploadOne(file, sessionId);
        });
      }, Promise.resolve())
      .catch(function (e) {
        showError((e && e.message) || MSG.failed);
      })
      .then(function () {
        setBusy(false);
      });
  }

  function imageFiles(list) {
    return Array.prototype.slice.call(list || []).filter(function (f) {
      return f && f.type && f.type.indexOf('image/') === 0;
    });
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  // Both bar buttons stop propagation — #session-bar itself opens the session
  // modal on click, so without this an attach tap would pop the modal open.
  attachBtn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!_busy) fileInput.click();
  });
  fileInput.addEventListener('change', function () {
    handleFiles(fileInput.files);
    fileInput.value = ''; // re-selecting the same file must still fire
  });

  // Desktop paste (Ctrl+V of a copied image). The image item is never assumed to
  // be items[0] — a copied web image also carries text/html.
  document.addEventListener('paste', function (e) {
    const dt = e.clipboardData;
    if (!dt || _busy) return;
    const files = [];
    for (const item of dt.items || []) {
      if (item.kind === 'file' && item.type && item.type.indexOf('image/') === 0) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) {
      e.preventDefault();
      handleFiles(files);
    }
  });

  // Drag & drop onto the terminal — capture phase, so xterm cannot swallow it.
  const dropTarget = document.getElementById('terminal-container') || document.body;
  dropTarget.addEventListener(
    'dragover',
    function (e) {
      e.preventDefault();
    },
    true
  );
  dropTarget.addEventListener(
    'drop',
    function (e) {
      e.preventDefault();
      const files = imageFiles(e.dataTransfer && e.dataTransfer.files);
      if (files.length) handleFiles(files);
    },
    true
  );

  // Clipboard read button. Solid on desktop Chrome; on Android a gallery-copied
  // image often never reaches the clipboard at all, so the failure is expected
  // and has to say what to do instead.
  if (clipBtn && navigator.clipboard && navigator.clipboard.read) {
    clipBtn.classList.remove('upload-hidden');
    clipBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (_busy) return;
      navigator.clipboard
        .read()
        .then(function (items) {
          const files = [];
          const reads = [];
          for (const item of items) {
            const type = (item.types || []).find(function (t) {
              return t.indexOf('image/') === 0;
            });
            if (!type) continue;
            reads.push(
              item.getType(type).then(function (blob) {
                files.push(new File([blob], 'clipboard.' + type.split('/')[1], { type: type }));
              })
            );
          }
          return Promise.all(reads).then(function () {
            if (files.length) handleFiles(files);
            else showError(MSG.clipEmpty);
          });
        })
        .catch(function () {
          showError(MSG.clipBlocked);
        });
    });
  }

  // Resize preference: markup lives in the preferences modal, storage here.
  const resizePref = document.getElementById('pref-upload-resize');
  if (resizePref) {
    resizePref.checked = resizeEnabled();
    resizePref.addEventListener('change', function () {
      try {
        localStorage.setItem(RESIZE_PREF_KEY, JSON.stringify(!!resizePref.checked));
      } catch (_) {
        /* private mode — the default (on) applies next load */
      }
    });
  }

  // client.js refuses a submit while an upload is in flight, so a Send tap
  // cannot beat the path into the terminal.
  window._airpromptUpload = {
    busy: function () {
      return _busy;
    },
    notifyBlocked: function () {
      showError(MSG.blocked);
    },
  };
})();
