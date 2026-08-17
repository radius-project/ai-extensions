// A verbatim transcription of the operation chip as it shipped before the
// Phase 4C browser extraction, recovered mechanically from
// `packages/adapter-canvas/src/client.ts` at commit ed1a531 — the merge base of
// this branch and its base, and the last commit in which `CLIENT_OPCHIP_JS`
// existed.
//
// It exists so `src/browser/operation-chip.differential.test.ts` can drive the
// deleted payload and the compiled replacement through identical fakes and
// compare what each one actually did: the requests issued, the chip's rendered
// class, label, attributes and dataset, the acknowledgement written to session
// storage, and the timers left pending.
//
// The chip renders on every canvas page, so a silent behavior change here is a
// silent behavior change everywhere. Phase 4C replaces its inline payload by
// design, which retires the compatibility oracle's byte digest of this source;
// a digest that can no longer match must be replaced by evidence, not by a
// justification. This fixture is that evidence, following the technique already
// used by `legacy-heartbeat-entry.ts`.
//
// Never edit this string to make a test pass. It is a historical record, not a
// supported surface: if the migrated entry disagrees with it, either the
// migration changed behavior or the change is deliberate and belongs in the
// documented divergence cases.
export const LEGACY_OPERATION_CHIP_JS = `
(function() {
  var chip = document.getElementById('rad-opchip');
  if (!chip) return;
  var labelEl = document.getElementById('rad-opchip-label');
  var ACK_KEY = 'radiusOpChipAck';
  var POLL_MS = 5000;

  function ack(id) {
    if (!id) return;
    try { window.sessionStorage.setItem(ACK_KEY, id); } catch (e) {}
  }
  function acked(id) {
    if (!id) return false;
    try { return window.sessionStorage.getItem(ACK_KEY) === id; } catch (e) { return false; }
  }

  function shortLabel(op) {
    var env = op.environment || 'environment';
    switch (op.state) {
      case 'running': return 'Setting up ' + env + '…';
      case 'succeeded': return env + ' ready';
      case 'succeeded_with_warnings': return env + ' ready · warnings';
      case 'action_required': return env + ' needs you';
      case 'failed': return env + ' setup failed';
      case 'failed_partial': return env + ' setup failed';
      case 'cancelled': return env + ' setup stopped';
      default: return '';
    }
  }

  function toneClass(state) {
    if (state === 'running') return 'rad-opchip--running';
    if (state === 'succeeded') return 'rad-opchip--done';
    if (state === 'succeeded_with_warnings' || state === 'action_required') return 'rad-opchip--warn';
    if (state === 'failed' || state === 'failed_partial') return 'rad-opchip--failed';
    return '';
  }

  function hide() { chip.hidden = true; }

  function render(op) {
    var panel = document.getElementById('env-progress-panel');
    if (panel && panel.style.display !== 'none' && panel.offsetParent !== null) { hide(); return; }
    if (!op || !op.state) { hide(); return; }
    var text = shortLabel(op);
    if (!text) { hide(); return; }
    var terminal = op.state !== 'running';
    if (terminal && acked(op.operationId)) { hide(); return; }
    chip.className = 'rad-opchip ' + toneClass(op.state);
    if (labelEl) labelEl.textContent = text;
    chip.setAttribute('title', op.summary || text);
    chip.setAttribute('aria-label', op.summary || text);
    chip.hidden = false;
    chip.dataset.operationId = op.operationId || '';
    chip.dataset.state = op.state;
  }

  chip.addEventListener('click', function() { ack(chip.dataset.operationId); });

  function poll() {
    fetch('/api/operations', { cache: 'no-store' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { render(d && d.operation); })
      .catch(function() {});
  }
  poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') poll();
  });
})();
`;
