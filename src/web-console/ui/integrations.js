/**
 * Integrations tab — a catalog of third-party service connections the console
 * acts with on the user's behalf (today: GitHub portfolio sync). Each provider
 * holds encrypted OAuth credentials server-side; the tokens never reach the
 * browser — this surface only shows status + what each connection can do, and
 * drives connect / manage / disconnect (= grant / re-grant / revoke).
 *
 * Slice A: provider presentation metadata lives here (GitHub only) and is merged
 * with live status from GET /me/integrations; actions use the existing GitHub
 * routes. Slice B will serve the catalog (name/category/capabilities) and generic
 * /:provider routes from the backend registry — at which point PROVIDERS and
 * ROUTES below collapse into what the API returns. See
 * /dollhouse/docs/web-console/INTEGRATIONS-DESIGN.md.
 */

import { get, post, del } from './api.js';

// UI-side provider catalog (Slice A). One entry per known provider.
const PROVIDERS = [
  {
    id: 'github',
    name: 'GitHub',
    category: 'Source control',
    icon: '\u{1F5C2}', // card index dividers — neutral repo glyph (CSP: text only)
    blurb: 'Sync your portfolio to and from a GitHub repository.',
  },
];

// Per-provider action routes (Slice A hardcodes GitHub's; Slice B → /:provider/*).
const ROUTES = {
  github: {
    connect: '/me/integrations/github/connect',
    disconnect: '/me/integrations/github',
  },
};

let host;
let notify = () => {};

const state = { byProvider: new Map(), loading: true, error: false };

export async function init(panelEl, ctx = {}) {
  host = panelEl;
  notify = ctx.toast || notify;
  host.innerHTML = shell();
  host.querySelector('#int-refresh').addEventListener('click', () => load());
  await load();
  globalThis.addEventListener('dh:tab-activated', (e) => { if (e.detail?.name === 'integrations') load(); });
}

async function load() {
  state.loading = true;
  state.error = false;
  renderBody();
  const res = await get('/me/integrations').catch(() => null);
  if (!res || res.status !== 200 || !Array.isArray(res.body?.integrations)) {
    state.error = true;
    state.loading = false;
    renderBody();
    return;
  }
  state.byProvider = new Map(res.body.integrations.map(i => [i.provider, i]));
  state.loading = false;
  state.error = false;
  renderBody();
}

/* ── Markup ─────────────────────────────────────────────────────────────── */

function shell() {
  return `
  <div class="int-bar">
    <span class="int-title">Integrations</span>
    <button class="btn btn-ghost" id="int-refresh" type="button">&#x21bb; Refresh</button>
  </div>
  <p class="int-sub">Connect third-party services for DollhouseMCP to use on your behalf. Credentials are stored encrypted and never shown.</p>
  <div id="int-body"></div>`;
}

function renderBody() {
  const body = host?.querySelector('#int-body');
  if (!body) return;
  if (state.loading) { body.innerHTML = '<div class="int-loading">Loading integrations…</div>'; return; }
  if (state.error) { body.innerHTML = '<div class="int-loading">Couldn\'t load your integrations.</div>'; return; }

  body.innerHTML = `<div class="int-grid">${PROVIDERS.map(p => providerCard(p, state.byProvider.get(p.id))).join('')}</div>`;

  body.querySelectorAll('[data-connect]').forEach(b => b.addEventListener('click', () => connect(b.dataset.connect)));
  body.querySelectorAll('[data-disconnect]').forEach(b => b.addEventListener('click', () => disconnect(b.dataset.disconnect)));
}

function providerCard(provider, status) {
  const connected = status && status.status === 'connected';
  const errored = status && status.status === 'error';
  return `
    <div class="int-card${connected ? ' int-card--connected' : ''}">
      <div class="int-card-head">
        <span class="int-icon" aria-hidden="true">${provider.icon}</span>
        <div class="int-card-id">
          <div class="int-card-name">${escapeHtml(provider.name)}</div>
          <div class="int-card-cat">${escapeHtml(provider.category)}</div>
        </div>
        ${statusChip(status)}
      </div>
      <div class="int-card-body">
        ${connected ? connectedBody(provider, status) : errored ? erroredBody(provider, status) : disconnectedBody(provider)}
      </div>
    </div>`;
}

function statusChip(status) {
  const s = status?.status;
  if (s === 'connected') return '<span class="int-chip int-chip--ok">Connected</span>';
  if (s === 'error') return '<span class="int-chip int-chip--err">Error</span>';
  return '<span class="int-chip int-chip--off">Not connected</span>';
}

function connectedBody(provider, status) {
  return `
    <div class="int-account">${status.account_label ? escapeHtml(status.account_label) : 'Connected'}</div>
    <div class="int-caps">${capabilityChips(status)}</div>
    <div class="int-meta">connected ${relAgo(status.connected_at)}${status.last_sync_at ? ` · last sync ${relAgo(status.last_sync_at)}` : ''}</div>
    <div class="int-actions">
      <button class="btn btn-ghost" data-connect="${provider.id}" type="button">Reconnect</button>
      <button class="btn btn-ghost int-danger" data-disconnect="${provider.id}" type="button">Disconnect</button>
    </div>`;
}

function erroredBody(provider, status) {
  return `
    <div class="int-alert">Connection error${status.error_reason ? `: ${escapeHtml(formatReason(status.error_reason))}` : ''}</div>
    <div class="int-actions">
      <button class="btn btn-primary" data-connect="${provider.id}" type="button">Reconnect</button>
      <button class="btn btn-ghost int-danger" data-disconnect="${provider.id}" type="button">Disconnect</button>
    </div>`;
}

function disconnectedBody(provider) {
  return `
    <div class="int-blurb">${escapeHtml(provider.blurb)}</div>
    <div class="int-actions">
      <button class="btn btn-primary" data-connect="${provider.id}" type="button">Connect</button>
    </div>`;
}

// Capability chips derived from the provider status (GitHub: sync directions + repo scope).
function capabilityChips(status) {
  const chips = [];
  const dirs = Array.isArray(status.sync_directions) ? status.sync_directions : [];
  if (dirs.includes('push')) chips.push('Portfolio sync ↑↓');
  else if (dirs.includes('pull')) chips.push('Portfolio sync ↓ (read-only)');
  if (status.repository_selection === 'selected') chips.push('Selected repositories');
  else if (status.repository_selection === 'all') chips.push('All repositories');
  if (chips.length === 0) chips.push('Connected');
  return chips.map(c => `<span class="int-cap">${escapeHtml(c)}</span>`).join('');
}

/* ── Actions ────────────────────────────────────────────────────────────── */

async function connect(providerId) {
  const route = ROUTES[providerId];
  if (!route) { notify('That integration isn\'t available yet.', 'warn'); return; }
  // Request full read/write so portfolio sync works both directions.
  const res = await post(route.connect, { body: { contents_permission: 'write' } }).catch(() => null);
  const url = res?.status === 200 ? res.body?.authorize_url : null;
  if (!url) { notify('Couldn\'t start the connection. Try again.', 'error'); return; }
  // Hand off to the provider's authorization page; it returns to /me/integrations.
  globalThis.location.href = url;
}

async function disconnect(providerId) {
  const route = ROUTES[providerId];
  if (!route) return;
  const provider = PROVIDERS.find(p => p.id === providerId);
  const ok = await confirmDialog(`Disconnect ${provider ? provider.name : 'this integration'}? Its stored access will be revoked.`, 'Disconnect');
  if (!ok) return;
  const res = await del(route.disconnect).catch(() => null);
  if (!res || (res.status !== 200 && res.status !== 204)) { notify('Could not disconnect. Try again.', 'error'); return; }
  notify('Disconnected.', 'success');
  await load();
}

/* ── Confirm dialog (Atelier-styled) ─────────────────────────────────────── */

function confirmDialog(message, confirmLabel) {
  return new Promise((resolve) => {
    document.getElementById('confirm-modal')?.remove();
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.id = 'confirm-modal';
    modal.innerHTML = `
      <div class="confirm-backdrop"></div>
      <div class="confirm-card" role="dialog" aria-modal="true">
        <p class="confirm-msg">${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="btn btn-ghost" data-confirm="0" type="button">Cancel</button>
          <button class="btn btn-primary" data-confirm="1" type="button">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const done = (val) => { modal.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    modal.querySelector('.confirm-backdrop').addEventListener('click', () => done(false));
    modal.querySelector('[data-confirm="0"]').addEventListener('click', () => done(false));
    modal.querySelector('[data-confirm="1"]').addEventListener('click', () => done(true));
    document.addEventListener('keydown', onKey);
  });
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function formatReason(reason) {
  return String(reason).replaceAll('_', ' ');
}

function relAgo(ts) {
  if (!ts) return 'unknown';
  const age = Date.now() - new Date(ts).getTime();
  if (age < 0 || age < 60_000) return 'just now';
  const m = Math.floor(age / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
