// ── Notification toasts for AirPrompt web UI ──────────────────────────
// Receives WS messages of type 'notification' broadcast by server.js.
// Renders swipe-to-dismiss toasts that stack. Tap navigates to source session.

const NOTIFY_EMOJIS = {
  idle_prompt:       '⏳',
  permission_prompt: '🔐',
  agent_needs_input: '📥',
  agent_completed:   '✅',
};
const NOTIFY_SUMMARIES = {
  idle_prompt:       'Done — ready for input',
  permission_prompt: 'Permission needed',
  agent_needs_input: 'Background agent needs input',
  agent_completed:   'Background agent finished',
};

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
  var esc = typeof escHtml === 'function' ? function (s) { return escHtml(String(s)); } : function (s) { return String(s); };
  var emoji = NOTIFY_EMOJIS[n.notification_type] || '📨';
  var summary = NOTIFY_SUMMARIES[n.notification_type] || ('Notification: ' + (n.notification_type || 'unknown'));

  // Build session label from available fields
  // Priority: matching active session's name → cwd basename → session_id prefix
  var sid = String(n.session_id || '');
  var label = '';
  if (sid && typeof sessions !== 'undefined') {
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

  var summaryEl = document.createElement('div');
  summaryEl.className = 'notify-summary';
  summaryEl.textContent = summary;

  toast.appendChild(metaEl);
  toast.appendChild(summaryEl);

  if (n.message && n.message !== 'null' && n.message !== 'Claude Code') {
    var msgEl = document.createElement('div');
    msgEl.className = 'notify-message';
    msgEl.textContent = n.message;
    toast.appendChild(msgEl);
  }

  // ── Tap to navigate to source session ──
  toast.addEventListener('click', function (e) {
    if (toast._swiped) return;
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
    toast.classList.remove('swiping');
  }
  function onMove(e) {
    if (e.touches && e.touches.length > 1) return;
    var t = e.touches ? e.touches[0] : e;
    var dx = t.clientX - startX;
    var dy = Math.abs(t.clientY - startY);
    if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > dy) {
      swiping = true;
      toast.classList.add('swiping');
    }
    if (!swiping) return;
    e.preventDefault();
    deltaX = dx;
    toast.style.transform = 'translateX(' + dx + 'px)';
    toast.style.opacity = Math.max(0, 1 - Math.abs(dx) / 200);
  }
  function onEnd() {
    if (toast._swiped) return;  // Synthetic mouse event after touch
    toast.classList.remove('swiping');
    if (Math.abs(deltaX) > 60) {
      toast._swiped = true;
      // Clear inline transform/opacity so CSS class animation takes over
      toast.style.transform = '';
      toast.style.opacity = '';
      if (deltaX < 0) toast.classList.add('dismiss-left');
      else toast.classList.add('dismiss-right');
      setTimeout(function () { dismissToast(toast); }, 250);
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

  getNotifyContainer().appendChild(toast);

  // Auto-dismiss after 6 seconds
  toast._dismissTimer = setTimeout(function () {
    if (!toast._swiped && toast.parentNode) {
      dismissToast(toast);
    }
  }, 6000);
}

function dismissToast(toast) {
  if (toast._dismissing) return;
  toast._dismissing = true;
  if (toast._dismissTimer) clearTimeout(toast._dismissTimer);
  if (toast.parentNode) {
    toast.classList.add('dismissed');
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }
}
