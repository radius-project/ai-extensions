// Canvas adapter — inline browser script driving the shared confirmation dialog
// for destructive actions on the Environments page.

export const ENVIRONMENT_CONFIRM_CLIENT_JS = `// ======================== Confirm dialog =========================
var pendingConfirm = null;

// opts: { title, message, usageLabel, usage, confirmLabel, cancelLabel,
// confirmVariant, onConfirm }. Every caller-supplied string reaches the DOM
// through textContent, so profile and environment names are never parsed as
// markup. confirmVariant is 'danger' unless the caller says otherwise: the
// dialog also explains blocked actions, where the way out is navigation rather
// than destruction and a red button would misdescribe it.
function showConfirmDialog(opts) {
    pendingConfirm = opts.onConfirm || null;
    document.getElementById('env-confirm-title').textContent = opts.title || 'Are you sure?';
    document.getElementById('env-confirm-message').textContent = opts.message || '';
    var okBtn = document.getElementById('env-confirm-ok');
    okBtn.textContent = opts.confirmLabel || 'Delete';
    okBtn.className = 'rad-btn ' + (opts.confirmVariant === 'primary' ? 'rad-btn--primary' : 'rad-btn--danger-outline');
    document.getElementById('env-confirm-cancel').textContent = opts.cancelLabel || 'Cancel';
    var usage = opts.usage || [];
    var usageBlock = document.getElementById('env-confirm-usage');
    var usageList = document.getElementById('env-confirm-usage-list');
    usageList.textContent = '';
    if (usage.length > 0) {
        document.getElementById('env-confirm-usage-label').textContent = opts.usageLabel || '';
        usage.forEach(function(item) {
            var li = document.createElement('li');
            li.textContent = item;
            usageList.appendChild(li);
        });
        usageBlock.style.display = '';
    } else {
        usageBlock.style.display = 'none';
    }
    document.getElementById('env-confirm-modal').style.display = 'flex';
    // Focus lands on Cancel: the destructive button must never be the target of
    // a stray Enter press.
    document.getElementById('env-confirm-cancel').focus();
}

function closeConfirmDialog() {
    document.getElementById('env-confirm-modal').style.display = 'none';
    pendingConfirm = null;
}

document.getElementById('env-confirm-cancel').addEventListener('click', closeConfirmDialog);
document.getElementById('env-confirm-ok').addEventListener('click', function() {
    var run = pendingConfirm;
    closeConfirmDialog();
    if (run) run();
});
document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (document.getElementById('env-confirm-modal').style.display === 'none') return;
    closeConfirmDialog();
});
`;
