// A verbatim transcription of the heartbeat watchdog as it shipped before the
// Phase 4A browser extraction, recovered mechanically from
// `packages/adapter-canvas/src/client.ts` at commit e26a030 — the merge base of
// this branch and `main`, and the last commit in which `CLIENT_HEARTBEAT_JS`
// existed.
//
// It exists so `src/browser/heartbeat.differential.test.ts` can drive the
// deleted payload and the compiled replacement through identical fakes and
// compare what each one actually did: the requests issued, the abort
// accounting, the reload calls, the overlay transition and the timers left
// pending.
//
// The Phase 3 compatibility oracle used to pin this behavior with a SHA-256
// digest of this exact source string. Phase 4A necessarily retires that digest,
// because the payload is rewritten by design — but a digest that can no longer
// match must be replaced by evidence, not by a justification. This fixture is
// that evidence, and it is the same technique already used for the
// `graphs-planning` write arms in `legacy-graph-planning-arms.ts`.
//
// Never edit this string to make a test pass. It is a historical record, not a
// supported surface: if the migrated entry disagrees with it, either the
// migration changed behavior or the change is deliberate and belongs in the
// documented divergence cases.
export const LEGACY_HEARTBEAT_JS = `
// ─── Client Heartbeat / Auto-reconnect ───────────────────────────────────────
// Each canvas instance is backed by a local HTTP server that may be suspended or
// killed after the extension goes idle. Ping it periodically; if it stops
// responding, show a reconnecting overlay and, once the server is back (it now
// rebinds the same stable port), reload once to restore a live page.
(function() {
  var overlay = document.getElementById('radius-reconnect-overlay');
  var down = false;
  var misses = 0;
  function ping() {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function() { ctrl.abort(); }, 4000) : null;
    fetch('/api/ping', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function(r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('bad status');
        if (down) {
          // Server is back after an outage — reload to get fresh state.
          window.location.reload();
          return;
        }
        misses = 0;
      })
      .catch(function() {
        if (timer) clearTimeout(timer);
        misses++;
        // Require two consecutive misses before declaring an outage to avoid
        // flapping on a single slow/dropped request.
        if (misses >= 2 && !down) {
          down = true;
          if (overlay) overlay.style.display = 'flex';
        }
      });
  }
  setInterval(ping, 5000);
  // Also probe immediately when the tab/panel regains focus after idle.
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') ping();
  });
  window.addEventListener('focus', ping);
})();
`;
