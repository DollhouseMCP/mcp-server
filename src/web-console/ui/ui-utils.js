/**
 * Shared, dependency-free helpers for web-console feature modules.
 *
 * Keep display escaping and confirmation behavior centralized so every module
 * uses the same XSS boundary and modal cleanup semantics.
 */

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replaceAll(/[&<>"']/g, character => HTML_ESCAPES[character]);
}

export function relAgo(timestamp, now = Date.now()) {
  if (!timestamp) return 'unknown';
  const age = now - new Date(timestamp).getTime();
  if (Number.isNaN(age)) return 'unknown';
  if (age < 0 || age < 60_000) return 'just now';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function confirmDialog(message, confirmLabel) {
  return new Promise((resolve) => {
    document.getElementById('confirm-modal')?.remove();
    const previousFocus = document.activeElement;
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.id = 'confirm-modal';
    modal.innerHTML = `
      <div class="confirm-backdrop"></div>
      <div class="confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-message">
        <p class="confirm-msg" id="confirm-modal-message">${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="btn btn-ghost" data-confirm="0" type="button">Cancel</button>
          <button class="btn btn-primary" data-confirm="1" type="button">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const buttons = [...modal.querySelectorAll('button')];

    const done = (value) => {
      modal.remove();
      document.removeEventListener('keydown', onKey);
      if (typeof previousFocus?.focus === 'function') previousFocus.focus();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') done(false);
      if (event.key !== 'Tab' || buttons.length === 0) return;
      const current = buttons.indexOf(document.activeElement);
      const next = focusTargetIndex(current, buttons.length, event.shiftKey);
      event.preventDefault();
      buttons[next].focus();
    };
    modal.querySelector('.confirm-backdrop').addEventListener('click', () => done(false));
    modal.querySelector('[data-confirm="0"]').addEventListener('click', () => done(false));
    modal.querySelector('[data-confirm="1"]').addEventListener('click', () => done(true));
    document.addEventListener('keydown', onKey);
    modal.querySelector('[data-confirm="1"]').focus();
  });
}

function focusTargetIndex(current, length, reverse) {
  if (!reverse) return (current + 1) % length;
  if (current <= 0) return length - 1;
  return current - 1;
}
