// ── Notification toasts for AirPrompt web UI ──────────────────────────
// Receives WS messages of type 'notification' broadcast by server.js.
// Renders swipe-to-dismiss toasts that stack. Tap navigates to source session.

const NOTIFY_EMOJIS = {
  idle_prompt:       '⏳',
  permission_prompt: '✋',
  agent_needs_input: '📥',
  agent_completed:   '✅',
};
const NOTIFY_SUMMARIES = {
  idle_prompt:       'Done — ready for input',
  permission_prompt: 'User action needed',
  agent_needs_input: 'Background agent needs input',
  agent_completed:   'Background agent finished',
};

// ── Timing & gesture constants ─────────────────────────────────────────
const AUTO_DISMISS_MS          = 6000;   // auto-dismiss delay when auto_dismiss is true
const SWIPE_DEAD_ZONE_PX       = 10;     // min horizontal movement before swipe activates
const SWIPE_OPACITY_DIST_PX    = 200;    // distance over which opacity fades from 1→0
const SWIPE_THRESHOLD_PX       = 60;     // min swipe distance to trigger dismiss
const SWIPE_DISMISS_ANIM_MS    = 250;    // CSS animation duration after swipe dismiss
const DISMISS_ANIM_MS          = 300;    // fade-out animation duration

let notifyContainer = null;
function getNotifyContainer() {
  if (!notifyContainer) {
    notifyContainer = document.getElementById('notify-container');
    if (!notifyContainer) {
      notifyContainer = document.createElement('div');
      notifyContainer.id = 'notify-container';
      document.body.appendChild(notifyContainer);
    }
  }
  return notifyContainer;
}

function showNotification(n) {
  if (!n) return;
  // Suppress toast when notification is for the session currently being viewed
  if (typeof activeSessionId !== 'undefined' && activeSessionId && String(n.session_id) === String(activeSessionId)) return;
  var esc = typeof escHtml === 'function' ? function (s) { return escHtml(String(s)); } : function (s) { return String(s); };
  var emoji = NOTIFY_EMOJIS[n.notification_type] || '📨';
  var summary = NOTIFY_SUMMARIES[n.notification_type] || ('Notification: ' + (n.notification_type || 'unknown'));

  // Build session label from available fields
  // Priority: notify.sh enriched label → session name → cwd basename → session_id prefix
  var sid = String(n.session_id || '');
  var label = n.session_label || '';
  if (!label && sid && typeof sessions !== 'undefined' && sessions) {
    var match = sessions.find(function (s) { return s.id === sid; });
    if (match) {
      label = match.name || (match.cwd ? String(match.cwd).split('/').pop() : '');
    }
  }
  if (!label) {
    var cwd = (n.cwd != null && n.cwd !== 'null' && typeof n.cwd === 'string') ? n.cwd.split('/').pop() : '';
    label = cwd || (sid ? sid.slice(0, 8) : '');
  }

  var metaHtml = emoji + (label ? ' [' + esc(label) + ']' : '');
  if (n.permission_mode && n.permission_mode !== 'null' && typeof n.permission_mode === 'string') metaHtml += ' · ' + esc(n.permission_mode);
  if (n.effort && n.effort.level && n.effort.level !== 'null' && typeof n.effort.level === 'string') metaHtml += ' · ' + esc(n.effort.level);

  var toast = document.createElement('div');
  toast.className = 'notify-toast';
  toast.setAttribute('data-session-id', sid || '');

  var metaEl = document.createElement('div');
  metaEl.className = 'notify-meta';
  metaEl.innerHTML = metaHtml;

  if (n.turn_info) summary += '  (' + n.turn_info + ')';

  var summaryEl = document.createElement('div');
  summaryEl.className = 'notify-summary';
  summaryEl.textContent = summary;

  toast.appendChild(metaEl);
  toast.appendChild(summaryEl);

  // Filter out default/empty IDE status messages
  if (n.message && n.message !== 'null' && n.message !== 'Claude Code' && n.message !== 'Codex' && n.message !== 'Cursor') {
    var msgEl = document.createElement('div');
    msgEl.className = 'notify-message';
    msgEl.textContent = n.message;
    toast.appendChild(msgEl);
  }

  if (n.subtitle) {
    var subEl = document.createElement('div');
    subEl.className = 'notify-subtitle';
    subEl.textContent = n.subtitle;
    toast.appendChild(subEl);
  }

  // ── Tap to navigate to source session ──
  toast.addEventListener('click', function (e) {
    if (toast._swiped || toast._dragged) return;
    var targetSessionId = toast.getAttribute('data-session-id');
    // sessions / selectSession are globals from client.js
    if (targetSessionId && typeof sessions !== 'undefined' && typeof selectSession === 'function') {
      if (sessions.some(function (s) { return s.id === targetSessionId; })) {
        selectSession(targetSessionId);
      }
    }
    dismissToast(toast);
  });

  // ── Swipe left/right to dismiss ──
  var startX = 0, startY = 0, deltaX = 0, swiping = false;
  function onStart(e) {
    var t = e.touches ? e.touches[0] : e;
    startX = t.clientX;
    startY = t.clientY;
    deltaX = 0;
    swiping = false;
    toast._dragged = false;
    toast.classList.remove('swiping');
  }
  function onMove(e) {
    if (e.touches && e.touches.length > 1) return;
    var t = e.touches ? e.touches[0] : e;
    var dx = t.clientX - startX;
    var dy = Math.abs(t.clientY - startY);
    toast._dragged = true;  // any movement → skip click-to-navigate
    if (!swiping && Math.abs(dx) > SWIPE_DEAD_ZONE_PX && Math.abs(dx) > dy) {
      swiping = true;
      toast.classList.add('swiping');
    }
    if (!swiping) return;
    e.preventDefault();
    deltaX = dx;
    toast.style.transform = 'translateX(' + dx + 'px)';
    toast.style.opacity = Math.max(0, 1 - Math.abs(dx) / SWIPE_OPACITY_DIST_PX);
  }
  function onEnd() {
    if (toast._swiped) return;  // Synthetic mouse event after touch
    toast.classList.remove('swiping');
    if (Math.abs(deltaX) > SWIPE_THRESHOLD_PX) {
      toast._swiped = true;
      // Clear inline transform/opacity so CSS class animation takes over
      toast.style.transform = '';
      toast.style.opacity = '';
      if (deltaX < 0) toast.classList.add('dismiss-left');
      else toast.classList.add('dismiss-right');
      setTimeout(function () { dismissToast(toast); }, SWIPE_DISMISS_ANIM_MS);
    } else {
      toast.style.transform = '';
      toast.style.opacity = '';
    }
  }
  toast.addEventListener('touchstart', onStart, { passive: false });
  toast.addEventListener('touchmove', onMove, { passive: false });
  toast.addEventListener('touchend', onEnd);
  // Mouse fallback for desktop testing
  toast.addEventListener('mousedown', onStart);
  toast.addEventListener('mousemove', function (e) {
    if (e.buttons !== 1) return;
    onMove(e);
  });
  toast.addEventListener('mouseup', onEnd);
  toast.addEventListener('mouseleave', function () {
    if (swiping) onEnd();
  });

  // Cap toast stack at 5 — dismiss oldest when exceeded
  var container = getNotifyContainer();
  var toasts = container.querySelectorAll('.notify-toast');
  if (toasts.length >= 5) dismissToast(toasts[0]);

  container.appendChild(toast);

  // Auto-dismiss only when server says so
  if (n.auto_dismiss) {
    toast._dismissTimer = setTimeout(function () {
      if (!toast._swiped && toast.parentNode) {
        dismissToast(toast);
      }
    }, AUTO_DISMISS_MS);
  }
}

function dismissToast(toast) {
  if (toast._dismissing) return;
  toast._dismissing = true;
  if (toast._dismissTimer) clearTimeout(toast._dismissTimer);
  if (toast.parentNode) {
    toast.classList.add('dismissed');
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, DISMISS_ANIM_MS);
  }
}
