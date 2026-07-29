// ── Shared utilities for AirPrompt web UI ────────────────────────────
// Must load before client.js and notify.js.

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
