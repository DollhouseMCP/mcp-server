import { get, post } from './api.js';
import { DURABLE_INVITATION_ROUTE, INVITATION_TTL_HOURS, invitationTtlHours,
  invitationExpiryPresentation, invitationDeliveryPresentation } from './durable-invitation-ui.js';

export const ACCOUNT_INVITATION_ROUTE = '/admin/accounts/users/:user_id/invitation';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

/** Ephemeral selected-account dialog. No credentials survive close or enter storage. */
export function openInvitationLifecycle(userId, hasRoute) {
  if (!uuid(userId) || !hasRoute('GET', ACCOUNT_INVITATION_ROUTE) || document.getElementById('ua-inv-lifecycle')) return;
  const previousFocus = document.activeElement;
  const modal = document.createElement('div');
  modal.id = 'ua-inv-lifecycle'; modal.className = 'confirm-modal';
  modal.innerHTML = `<div class="confirm-backdrop"></div>
    <div class="confirm-card ua-invite-card" role="dialog" aria-modal="true" aria-labelledby="ua-il-title">
      <h3 id="ua-il-title">Account invitation</h3>
      <p id="ua-il-status" role="status" aria-live="polite" tabindex="-1">Loading invitation…</p>
      <div id="ua-il-details"></div><div id="ua-il-result"></div>
      <label class="ua-field"><span>New invitation lifetime (hours)</span>
        <input id="ua-il-ttl" type="number" inputmode="numeric" min="1" max="168" step="1" value="24"></label>
      <div id="ua-il-confirm" hidden><p id="ua-il-question"></p>
        <button class="btn btn-ghost" id="ua-il-back" type="button">Cancel action</button>
        <button class="btn btn-primary" id="ua-il-apply" type="button">Confirm</button></div>
      <div class="confirm-actions">
        <button class="btn btn-ghost" id="ua-il-close" type="button">Close</button>
        <button class="btn btn-ghost" id="ua-il-inspect" type="button">Inspect</button>
        <button class="btn btn-ghost" id="ua-il-revoke" type="button">Revoke invitation</button>
        <button class="btn btn-primary" id="ua-il-regenerate" type="button">Regenerate link</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const el = name => modal.querySelector(`#ua-il-${name}`);
  const ttl = el('ttl'); ttl.min = String(INVITATION_TTL_HOURS.minimum); ttl.max = String(INVITATION_TTL_HOURS.maximum); ttl.value = String(INVITATION_TTL_HOURS.default);
  let closed = false, pending = false, mutationPending = false, view = null, intent = null;
  const status = text => { el('status').textContent = text; el('status').focus(); };
  function controls() {
    for (const button of modal.querySelectorAll('button')) button.disabled = pending;
    el('close').disabled = mutationPending;
    for (const action of ['regenerate', 'revoke']) {
      const button = el(action); button.hidden = !hasRoute('POST', `${DURABLE_INVITATION_ROUTE}/:invitation_id/${action}`);
      button.disabled = pending || !!intent || !['pending', 'expired'].includes(view?.state);
    }
    ttl.disabled = pending || !!intent || !['pending', 'expired'].includes(view?.state);
    el('inspect').disabled = pending || !!intent;
    el('confirm').hidden = !intent;
  }
  function close(force = false) {
    if (closed || (mutationPending && !force)) return;
    closed = true; view = null; intent = null; userId = '';
    el('result').replaceChildren(); el('details').replaceChildren(); modal.remove();
    document.removeEventListener('keydown', onKey);
    globalThis.removeEventListener('pagehide', forceClose);
    globalThis.removeEventListener('dh:elevation-changed', elevation);
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  const forceClose = () => close(true);
  const elevation = event => { if (event.detail?.active === false) forceClose(); };
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
      .filter(control => !control.hidden && !control.closest('[hidden]'));
    if (!controls.length) return;
    const current = controls.indexOf(document.activeElement);
    const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (current + (event.shiftKey ? controls.length - 1 : 1)) % controls.length;
    event.preventDefault(); controls[next].focus();
  }
  function render(body) {
    const item = body?.invitation;
    if (!uuid(item?.id) || item.user_id !== userId || !['pending', 'accepted', 'revoked', 'expired'].includes(item.state) ||
        !Number.isSafeInteger(item.generation) || item.generation < 1 || !Array.isArray(item.intended_roles) ||
        typeof item.email !== 'string' || typeof item.username !== 'string') throw new Error('Invalid invitation metadata');
    const expiry = invitationExpiryPresentation(item.expires_at);
    view = { id: item.id, state: item.state };
    el('details').replaceChildren();
    for (const text of [`${item.username} · ${item.email}`, `Status: ${item.state}; generation ${item.generation}`,
      `Roles: ${item.intended_roles.join(', ') || 'No additional roles'}`, `Expires at ${expiry.exact} (${expiry.remaining}).`]) {
      const p = document.createElement('p'); p.textContent = text; el('details').appendChild(p);
    }
  }
  async function inspect() {
    if (pending || closed) return;
    pending = true; view = null; el('result').replaceChildren(); el('details').replaceChildren(); controls();
    status('Loading invitation…');
    const response = await get(`/admin/accounts/users/${encodeURIComponent(userId)}/invitation`).catch(() => null);
    if (closed) return;
    try {
      if (response?.status !== 200) throw new Error('Unavailable');
      render(response.body); status('Invitation details refreshed. Existing claim links cannot be retrieved.');
    } catch { status(response?.status === 404 ? 'No durable invitation is available for this account.' : 'Invitation unavailable. Check admin elevation and inspect again.'); }
    pending = false; controls();
  }
  function prepare(action) {
    if (pending || intent || !['pending', 'expired'].includes(view?.state)) return;
    try { intent = { action, id: view.id, body: action === 'regenerate' ? { ttl_hours: invitationTtlHours(ttl.value) } : {} }; }
    catch { status('Enter a whole-number lifetime between 1 and 168 hours.'); return; }
    el('question').textContent = action === 'regenerate'
      ? 'Regenerate this invitation? Its current link will stop working. Email submission may follow; it will not be retried automatically.'
      : 'Revoke this invitation? Its link and onboarding session will stop working.';
    controls(); el('back').focus();
  }
  async function apply() {
    if (pending || !intent || closed) return;
    const request = intent; intent = null; pending = true; mutationPending = true; view = null; el('result').replaceChildren(); controls();
    const response = await post(`${DURABLE_INVITATION_ROUTE}/${request.id}/${request.action}`, { body: request.body }).catch(() => null);
    if (closed) return;
    try {
      if (response?.status !== 200 || response.body?.invitation?.id !== request.id) throw new Error('Unavailable');
      render(response.body);
      if (request.action === 'revoke') {
        if (view.state !== 'revoked') throw new Error('Unavailable');
        status('Invitation revoked. Its link can no longer be used.');
      } else {
        status('Invitation regenerated. The earlier link is invalid.');
        const delivery = invitationDeliveryPresentation(response.body.delivery);
        const p = document.createElement('p'); p.textContent = `${delivery.label}. ${delivery.message}`; el('result').appendChild(p);
        const url = response.body.claim_url;
        if (typeof url !== 'string' || !url || url.length > 2048) throw new Error('Missing link');
        const field = document.createElement('input'); field.className = 'ua-invite-link'; field.readOnly = true; field.autocomplete = 'off';
        field.setAttribute('aria-label', 'Invitation claim link'); field.value = url;
        field.addEventListener('focus', () => field.select()); field.addEventListener('click', () => field.select());
        el('result').appendChild(field); field.focus();
      }
    } catch { view = null; el('result').replaceChildren(); status('Action outcome or claim link unavailable. Inspect before deciding what to do next; do not resend automatically.'); }
    pending = false; mutationPending = false; controls();
  }
  el('close').addEventListener('click', () => close()); modal.querySelector('.confirm-backdrop').addEventListener('click', () => close());
  el('inspect').addEventListener('click', inspect);
  for (const action of ['regenerate', 'revoke']) el(action).addEventListener('click', () => prepare(action));
  el('back').addEventListener('click', () => { intent = null; controls(); el('inspect').focus(); });
  el('apply').addEventListener('click', apply);
  document.addEventListener('keydown', onKey); globalThis.addEventListener('pagehide', forceClose);
  globalThis.addEventListener('dh:elevation-changed', elevation);
  controls(); void inspect();
}
