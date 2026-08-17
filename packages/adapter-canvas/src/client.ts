// Compatibility facade for browser behavior during the Phase 4 stack.
//
// Repository and graph behavior forwards to the compiled TypeScript entries.
// Operation-chip and delete-dialog behavior remains legacy source until 4C.

export const CLIENT_OPCHIP_JS = `
// ─── Operation status chip ───────────────────────────────────────────────────
// The ambient tier of the notification model. Environment creation takes
// minutes, and the panel that narrates it lives on one page — so a user who
// goes to look at the app graph while it runs has, until now, had no way of
// knowing it finished. That is the failure the non-blocking panel would
// otherwise introduce: we would have traded trapping the user for losing them.
//
// This chip is deliberately the quietest thing that closes that gap. It never
// takes focus, never navigates on its own, and never moves the page. It appears
// in the corner of the nav bar, says what is happening in three or four words,
// and links back to the environments page. Auto-focusing the panel on
// completion was considered and rejected: it re-creates the modal's sin with
// worse timing, yanking the user out of whatever they moved on to.
(function() {
  var chip = document.getElementById('rad-opchip');
  if (!chip) return;
  var labelEl = document.getElementById('rad-opchip-label');
  var ACK_KEY = 'radiusOpChipAck';
  var POLL_MS = 5000;

  // A terminal chip is dismissed once, per operation, for the life of the
  // canvas session. Records are retained server-side for an hour so a returning
  // user can still find out what happened; without this the chip would nag for
  // that whole hour.
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
    // The inline panel is the better surface whenever it is on screen, and two
    // widgets narrating the same operation is noise, not redundancy.
    var panel = document.getElementById('env-progress-panel');
    if (panel && panel.style.display !== 'none' && panel.offsetParent !== null) { hide(); return; }
    if (!op || !op.state) { hide(); return; }
    var text = shortLabel(op);
    if (!text) { hide(); return; }
    var terminal = op.state !== 'running';
    if (terminal && acked(op.operationId)) { hide(); return; }
    chip.className = 'rad-opchip ' + toneClass(op.state);
    if (labelEl) labelEl.textContent = text;
    // The full sentence goes in the tooltip and the accessible name, so the
    // three-word chip is never the only thing on offer.
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
      // A dropped poll means the server is idle or restarting, which the
      // heartbeat already handles. Leaving the chip as it was is more honest
      // than inventing a failure state for it.
      .catch(function() {});
  }
  poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') poll();
  });
})();
`;

export const CLIENT_DELETE_DIALOG_JS = `
function radiusCreateDeleteDeploymentDialog(options) {
  var opts = options || {};
  // Self-contained escaping: this dialog is injected as its own <script> block,
  // so it must not depend on another block having already defined a helper.
  var esc = function(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
  var modal = document.getElementById(opts.modalId || 'deploy-delete-modal');
  var body = document.getElementById(opts.bodyId || 'deploy-delete-body');
  var appEl = document.getElementById(opts.appId || 'deploy-delete-app');
  var envEl = document.getElementById(opts.envId || 'deploy-delete-env');
  var closeEl = document.getElementById(opts.closeId || 'deploy-delete-close');
  if (!modal || !body) return null;
  var pending = null;
  var step = 1;

  function close() {
    modal.style.display = 'none';
    pending = null;
    step = 1;
    body.innerHTML = '';
  }

  function confirmNow() {
    if (!pending) return;
    var target = pending;
    close();
    if (typeof opts.onConfirm === 'function') opts.onConfirm(target.app, target.environment);
  }

  // Steps escalate the confirmation:
  //   1) intent, 2) acknowledge the irreversible effects, 3) type "app/env".
  function renderStep() {
    if (!pending) return;
    var app = pending.app, env = pending.environment;
    if (step === 1) {
      body.innerHTML =
        '<p class="rad-ddlg__text">Deleting this deployment will tear down running containers and resources. To proceed, please confirm your intention.</p>' +
        '<button type="button" class="rad-ddlg__btn" id="del-step1-btn">I want to delete this deployment</button>';
      document.getElementById('del-step1-btn').addEventListener('click', function() { step = 2; renderStep(); });
    } else if (step === 2) {
      body.innerHTML =
        '<div class="rad-ddlg__warn"><span aria-hidden="true">⚠</span><span>This action cannot be undone. Please read carefully!</span></div>' +
        '<div class="rad-ddlg__bullet"><span>This will permanently delete the deployment of <strong>' + esc(app) + '</strong> from environment <strong>' + esc(env) + '</strong>, including all associated resources.</span></div>' +
        '<button type="button" class="rad-ddlg__btn" id="del-step2-btn">I have read and understand these effects</button>';
      document.getElementById('del-step2-btn').addEventListener('click', function() { step = 3; renderStep(); });
    } else {
      var token = app + '/' + env;
      body.innerHTML =
        '<p class="rad-ddlg__confirm-label">To confirm, type "' + esc(token) + '" in the box below</p>' +
        '<input type="text" class="rad-ddlg__input" id="del-confirm-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + esc(token) + '">' +
        '<button type="button" class="rad-ddlg__delete" id="del-confirm-btn" disabled>Delete this deployment</button>';
      var input = document.getElementById('del-confirm-input');
      var btn = document.getElementById('del-confirm-btn');
      var matches = function() { return input.value.trim() === token; };
      input.addEventListener('input', function() { btn.disabled = !matches(); });
      input.addEventListener('keydown', function(e) { if (e.key === 'Enter' && matches()) confirmNow(); });
      btn.addEventListener('click', function() { if (matches()) confirmNow(); });
      input.focus();
    }
  }

  function open(app, env) {
    pending = { app: app, environment: env };
    step = 1;
    if (appEl) appEl.textContent = app;
    if (envEl) envEl.textContent = env;
    renderStep();
    modal.style.display = 'flex';
  }

  if (closeEl) closeEl.addEventListener('click', close);
  modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && modal.style.display === 'flex') close();
  });

  return { open: open, close: close };
}
`;
