/**
 * Self-service security management (account-menu panel).
 *
 * The deliberate "adjust / change / remove your authenticator" surface — distinct
 * from elevation itself. Reads factor status from /me/security/factors and hands
 * off the credential ceremonies (enroll / replace / disable) to the AS-hosted
 * pages, which are GET→302 navigations (same pattern as login/step-up).
 *
 * NOTE: binding hardening (fresh re-auth to enroll/replace) is a tracked backend
 * follow-up (S1 in AUTH-MFA-ENROLLMENT-DESIGN.md). Disabling is already
 * proof-gated server-side (requires a TOTP or backup code).
 */

import { get } from './api.js';

const ENROLL_URL = '/api/v1/me/security/factors/enroll/totp';
const DISABLE_URL = '/api/v1/me/security/factors/disable/totp';

let toast = () => {};

/** Current TOTP factor status, or null if unavailable. */
export async function fetchFactorStatus() {
  try {
    const res = await get('/me/security/factors');
    return res.status === 200 ? res.body : null;
  } catch {
    return null;
  }
}

/** Navigate into the AS-hosted enrollment ceremony. */
export function startEnrollment() {
  window.location.href = ENROLL_URL;
}

export async function openSecurityPanel(ctx = {}) {
  toast = ctx.toast || toast;
  const status = await fetchFactorStatus();
  renderModal(status);
}

function renderModal(status) {
  document.getElementById('security-modal')?.remove();
  const totp = status?.totp ?? { enrolled: false };
  const modal = document.createElement('div');
  modal.className = 'security-modal';
  modal.id = 'security-modal';
  modal.innerHTML = `
    <div class="security-backdrop" data-close></div>
    <div class="security-card" role="dialog" aria-modal="true" aria-labelledby="security-title">
      <div class="security-card-header">
        <span class="security-card-title" id="security-title">Security</span>
        <button class="security-close" data-close aria-label="Close">&#x2715;</button>
      </div>
      <div class="security-card-body">
        <section class="security-section">
          <h3 class="security-section-title">Authenticator app (TOTP)</h3>
          ${status ? renderTotp(totp) : '<p class="security-muted">Couldn\'t load factor status.</p>'}
        </section>
        <p class="security-foot">Two-factor is required to elevate to admin access. It isn't needed for regular use.</p>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
  modal.querySelector('#sec-enroll')?.addEventListener('click', startEnrollment);
  modal.querySelector('#sec-replace')?.addEventListener('click', startEnrollment);
  modal.querySelector('#sec-disable')?.addEventListener('click', () => { window.location.href = DISABLE_URL; });
  document.addEventListener('keydown', onEsc);
}

function renderTotp(totp) {
  if (!totp.enrolled) {
    return `
      <p class="security-status security-status--off"><span class="security-dot"></span>Not set up</p>
      <p class="security-muted">Set up an authenticator app (Google Authenticator, 1Password, etc.) to enable admin elevation.</p>
      <div class="security-actions">
        <button class="btn btn-primary" id="sec-enroll" type="button">Set up authenticator</button>
      </div>`;
  }
  const enrolled = totp.enrolled_at ? new Date(totp.enrolled_at).toLocaleDateString() : null;
  const lastUsed = totp.last_used_at ? new Date(totp.last_used_at).toLocaleString() : 'never';
  const codes = typeof totp.backup_codes_remaining === 'number' ? totp.backup_codes_remaining : null;
  return `
    <p class="security-status security-status--on"><span class="security-dot"></span>Enrolled${enrolled ? ` · since ${enrolled}` : ''}</p>
    <dl class="security-meta">
      <div><dt>Last used</dt><dd>${escapeHtml(lastUsed)}</dd></div>
      ${codes !== null ? `<div><dt>Backup codes left</dt><dd>${codes}</dd></div>` : ''}
    </dl>
    <div class="security-actions">
      <button class="btn btn-ghost" id="sec-replace" type="button">Replace device</button>
      <button class="btn btn-ghost security-danger" id="sec-disable" type="button">Disable</button>
    </div>`;
}

function close() {
  document.getElementById('security-modal')?.remove();
  document.removeEventListener('keydown', onEsc);
}

function onEsc(e) {
  if (e.key === 'Escape') close();
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
