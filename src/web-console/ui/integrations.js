/**
 * Data-driven integration catalog and connection management.
 *
 * Provider presentation comes from the server catalog and visible integration
 * descriptors. Credential values are submitted directly from short-lived
 * modal fields and are never copied into module state or rendered back.
 */

import { del, get, post } from './api.js';
import { noConsoleRoute } from './console-meta.js';
import { createIntegrationDescriptorManager } from './integration-descriptors.js';
import { confirmDialog, escapeHtml, relAgo } from './ui-utils.js';

const DESCRIPTORS_PATH = '/me/integrations/descriptors';
const PROVIDER_ROUTE = '/me/integrations/:provider';
const MAX_DESCRIPTOR_PAGES = 50;

let host;
let notify = () => {};
let hasRoute = noConsoleRoute;
let descriptorManager;
let loadController;
let loadVersion = 0;
let globalListenersBound = false;

const state = {
  statuses: new Map(),
  descriptors: [],
  loading: true,
  catalogError: false,
  descriptorError: false,
  descriptorsTruncated: false,
  view: 'connections',
};

export async function init(panelEl, ctx = {}) {
  host = panelEl;
  notify = ctx.toast || notify;
  hasRoute = ctx.hasRoute || hasRoute;
  host.innerHTML = shell(canManageDescriptors());
  descriptorManager = createIntegrationDescriptorManager({
    host: host.querySelector('#int-descriptors'),
    notify,
    hasRoute,
    onChanged: load,
  });
  host.addEventListener('click', onHostClick);
  await load();
  bindGlobalListeners();
}

function bindGlobalListeners() {
  if (globalListenersBound) return;
  globalThis.addEventListener('dh:tab-activated', onTabActivated);
  globalListenersBound = true;
}

function onTabActivated(event) {
  if (event.detail?.name === 'integrations') void load();
}

async function load() {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  const version = ++loadVersion;
  state.loading = true;
  state.catalogError = false;
  renderConnections();

  const [catalogResponse, descriptorsResult] = await Promise.all([
    get('/me/integrations', { signal: controller.signal }).catch(() => null),
    canManageDescriptors()
      ? loadAllDescriptors(controller.signal)
      : Promise.resolve({ descriptors: [], error: false, truncated: false }),
  ]);
  if (controller.signal.aborted || version !== loadVersion) return;

  state.catalogError = catalogResponse?.status !== 200 || !Array.isArray(catalogResponse.body?.integrations);
  state.statuses = state.catalogError
    ? new Map()
    : new Map(catalogResponse.body.integrations.map(status => [status.provider, status]));
  state.descriptors = descriptorsResult.descriptors;
  state.descriptorError = descriptorsResult.error;
  state.descriptorsTruncated = descriptorsResult.truncated;

  await loadMissingProviderStatuses(controller, version);
  if (controller.signal.aborted || version !== loadVersion) return;

  state.loading = false;
  renderConnections();
  descriptorManager?.setDescriptors(state.descriptors, state.descriptorError, state.descriptorsTruncated);
}

async function loadAllDescriptors(signal) {
  const descriptors = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_DESCRIPTOR_PAGES; page += 1) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const response = await get(`${DESCRIPTORS_PATH}${query}`, { signal }).catch(() => null);
    if (response?.status !== 200 || !Array.isArray(response.body?.descriptors)) {
      return { descriptors, error: true, truncated: false };
    }
    descriptors.push(...response.body.descriptors);
    const nextCursor = typeof response.body.next_cursor === 'string' ? response.body.next_cursor : null;
    if (!nextCursor || seenCursors.has(nextCursor)) return { descriptors, error: false, truncated: false };
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  // Page cap reached: what we have is valid, there is simply more of it. Reporting this as a load
  // failure would be wrong, and reporting nothing would hide that the list is incomplete.
  return { descriptors, error: false, truncated: true };
}

async function loadMissingProviderStatuses(controller, version) {
  const missing = state.descriptors
    .map(descriptor => descriptor.provider)
    .filter(provider => !state.statuses.has(provider) && canUseProviderRoute('GET', provider));
  const responses = await Promise.all(missing.map(async provider => {
    const response = await get(providerPath(provider), { signal: controller.signal }).catch(() => null);
    return { provider, response };
  }));
  if (controller.signal.aborted || version !== loadVersion) return;
  for (const { provider, response } of responses) {
    if (response?.status === 200) state.statuses.set(provider, response.body);
  }
}

function shell(showDescriptorNav) {
  return `
    <div class="int-bar">
      <span class="int-title">Integrations</span>
      <button class="btn btn-ghost" id="int-refresh" type="button">&#x21bb; Refresh</button>
    </div>
    <p class="int-sub">Connect services for DollhouseMCP to use on your behalf. Credentials are stored encrypted and never shown.</p>
    ${showDescriptorNav ? `
      <div class="int-nav" role="tablist" aria-label="Integration views">
        <button class="int-nav-item is-active" data-int-view="connections" role="tab" aria-selected="true" type="button">Connections</button>
        <button class="int-nav-item" data-int-view="descriptors" role="tab" aria-selected="false" type="button">Custom integrations</button>
      </div>` : ''}
    <div id="int-connections"></div>
    <div id="int-descriptors" hidden></div>`;
}

function renderConnections() {
  const body = host?.querySelector('#int-connections');
  if (!body) return;
  if (state.loading) {
    body.innerHTML = '<div class="int-loading">Loading integrations…</div>';
    return;
  }
  const providers = providerCatalog();
  const catalogMarkup = providers.length === 0
    ? '<div class="int-empty"><strong>No integrations are available.</strong><span>This deployment has not advertised any providers.</span></div>'
    : `<div class="int-grid">${providers.map(providerCard).join('')}</div>`;
  body.innerHTML = `
    ${state.catalogError ? '<div class="int-notice int-notice--error">Some integration status information could not be loaded.</div>' : ''}
    ${catalogMarkup}`;
}

function providerCatalog() {
  const providers = new Map();
  for (const status of state.statuses.values()) {
    providers.set(status.provider, {
      id: status.provider,
      name: displayName(status.display_name, status.provider),
      category: displayName(status.category, 'Integration'),
      descriptor: null,
      status,
    });
  }
  for (const descriptor of state.descriptors) {
    const existing = providers.get(descriptor.provider);
    providers.set(descriptor.provider, {
      id: descriptor.provider,
      name: descriptor.display_name,
      category: descriptor.category,
      descriptor,
      status: existing?.status ?? disconnectedStatus(descriptor),
    });
  }
  return [...providers.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function providerCard(provider) {
  const status = provider.status;
  const connected = status?.status === 'connected';
  const errored = status?.status === 'error';
  const routes = providerRouteAvailability(provider.id);
  let cardBody;
  if (connected) cardBody = connectedBody(provider, status, routes);
  else if (errored) cardBody = erroredBody(provider, status, routes);
  else cardBody = disconnectedBody(provider, routes);
  return `
    <article class="int-card${connected ? ' int-card--connected' : ''}">
      <div class="int-card-head">
        <span class="int-icon" aria-hidden="true">${providerGlyph(provider)}</span>
        <div class="int-card-id">
          <div class="int-card-name">${escapeHtml(provider.name)}</div>
          <div class="int-card-cat">${escapeHtml(provider.category)}</div>
        </div>
        ${statusChip(status)}
      </div>
      <div class="int-card-body">${cardBody}</div>
    </article>`;
}

function providerRouteAvailability(providerId) {
  return {
    canConnect: canUseProviderRoute('POST', providerId, '/connect'),
    canDisconnect: canUseProviderRoute('DELETE', providerId),
  };
}

function statusChip(status) {
  if (status?.status === 'connected') return '<span class="int-chip int-chip--ok">Connected</span>';
  if (status?.status === 'error') return '<span class="int-chip int-chip--err">Error</span>';
  return '<span class="int-chip int-chip--off">Not connected</span>';
}

function connectedBody(provider, status, routes) {
  return `
    <div class="int-account">${status.account_label ? escapeHtml(status.account_label) : 'Connected'}</div>
    <div class="int-caps">${capabilityChips(status)}</div>
    <div class="int-meta">connected ${relAgo(status.connected_at)}${status.last_sync_at ? ` · last sync ${relAgo(status.last_sync_at)}` : ''}</div>
    <div class="int-actions">
      ${routes.canConnect ? `<button class="btn btn-ghost" data-connect="${escapeHtml(provider.id)}" type="button">Reconnect</button>` : ''}
      ${routes.canDisconnect ? `<button class="btn btn-ghost int-danger" data-disconnect="${escapeHtml(provider.id)}" type="button">Disconnect</button>` : ''}
    </div>`;
}

function erroredBody(provider, status, routes) {
  return `
    <div class="int-alert">Connection error${status.error_reason ? `: ${escapeHtml(formatReason(status.error_reason))}` : ''}</div>
    <div class="int-actions">
      ${routes.canConnect ? `<button class="btn btn-primary" data-connect="${escapeHtml(provider.id)}" type="button">Reconnect</button>` : ''}
      ${routes.canDisconnect ? `<button class="btn btn-ghost int-danger" data-disconnect="${escapeHtml(provider.id)}" type="button">Disconnect</button>` : ''}
    </div>`;
}

function disconnectedBody(provider, routes) {
  return `
    <div class="int-blurb">${providerDescription(provider)}</div>
    <div class="int-actions">
      ${routes.canConnect
        ? `<button class="btn btn-primary" data-connect="${escapeHtml(provider.id)}" type="button">Connect</button>`
        : '<span class="int-meta">Not available in this deployment.</span>'}
    </div>`;
}

function capabilityChips(status) {
  const chips = [];
  const directions = Array.isArray(status.sync_directions) ? status.sync_directions : [];
  if (directions.includes('push')) chips.push('Portfolio sync ↑↓');
  else if (directions.includes('pull')) chips.push('Portfolio sync ↓');
  if (status.repository_selection === 'selected') chips.push('Selected repositories');
  else if (status.repository_selection === 'all') chips.push('All repositories');
  if (Array.isArray(status.scopes)) chips.push(...status.scopes.slice(0, 4));
  if (chips.length === 0) chips.push('Connected');
  return chips.map(chip => `<span class="int-cap">${escapeHtml(chip)}</span>`).join('');
}

async function onHostClick(event) {
  const button = event.target.closest('button');
  if (!button || !host.contains(button)) return;
  if (button.id === 'int-refresh') await load();
  if (button.dataset.intView) selectView(button.dataset.intView);
  if (button.dataset.connect) await connect(button.dataset.connect);
  if (button.dataset.disconnect) await disconnect(button.dataset.disconnect);
}

function selectView(view) {
  state.view = view === 'descriptors' ? 'descriptors' : 'connections';
  const showingDescriptors = state.view === 'descriptors';
  host.querySelector('#int-connections').hidden = showingDescriptors;
  host.querySelector('#int-descriptors').hidden = !showingDescriptors;
  for (const button of host.querySelectorAll('[data-int-view]')) {
    const active = button.dataset.intView === state.view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  }
  if (showingDescriptors) descriptorManager?.show();
}

async function connect(providerId) {
  const provider = providerCatalog().find(item => item.id === providerId);
  if (!provider) return;
  let body = { return_to: '/me/integrations' };
  // GitHub alone needs the scope named at connect time so portfolio writes work once connected.
  // It is not a general connect parameter — do not extend it to other providers; a provider that
  // needs extra parameters should carry them on its descriptor instead.
  if (provider.id === 'github') body.contents_permission = 'write';
  if (provider.descriptor?.auth_strategy === 'static_api_key') {
    const credentials = await credentialDialog(provider);
    if (!credentials) return;
    body = credentials;
  }
  const response = await post(`${providerPath(providerId)}/connect`, { body }).catch(() => null);
  clearCredentialObject(body);
  if (!response || (response.status !== 200 && response.status !== 201)) {
    notify(problemDetail(response, 'The connection could not be started.'), 'error');
    return;
  }
  const authorizeUrl = httpsUrlOrNull(response.body?.authorize_url);
  if (authorizeUrl) {
    globalThis.location.href = authorizeUrl;
    return;
  }
  if (response.body?.authorize_url) {
    notify('The provider returned an unusable sign-in address.', 'error');
    return;
  }
  notify('Integration connected.', 'success');
  await load();
}

async function disconnect(providerId) {
  const provider = providerCatalog().find(item => item.id === providerId);
  if (!provider) return;
  const approved = await confirmDialog(
    `Disconnect ${provider.name}? Its stored access will be revoked.`,
    'Disconnect',
  );
  if (!approved) return;
  const response = await del(providerPath(providerId)).catch(() => null);
  if (!response || (response.status !== 200 && response.status !== 204)) {
    notify(problemDetail(response, 'The integration could not be disconnected.'), 'error');
    return;
  }
  notify('Disconnected.', 'success');
  await load();
}

function credentialDialog(provider) {
  return new Promise(resolve => {
    document.getElementById('int-credential-modal')?.remove();
    const basic = provider.descriptor?.static_api_key?.injection?.location === 'basic';
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.id = 'int-credential-modal';
    modal.innerHTML = `
      <div class="confirm-backdrop"></div>
      <form class="confirm-card int-credential-card" role="dialog" aria-modal="true" aria-labelledby="int-credential-title">
        <h2 id="int-credential-title">Connect ${escapeHtml(provider.name)}</h2>
        <p>${basic ? 'Enter the username and password for this service.' : 'Enter the API key issued by this service.'} The value is encrypted and will not be shown again.</p>
        ${basic
          ? `${credentialField('Username', 'username', 'username', 'username')}
             ${credentialField('Password', 'password', 'password', 'current-password')}`
          : credentialField('API key', 'api_key', 'password', 'off')}
        ${credentialField('Account label (optional)', 'account_label', 'text', 'off', false)}
        <div class="int-form-error" role="alert" data-credential-error></div>
        <div class="confirm-actions">
          <button class="btn btn-ghost" data-credential-cancel type="button">Cancel</button>
          <button class="btn btn-primary" type="submit">Connect</button>
        </div>
      </form>`;
    document.body.appendChild(modal);
    const form = modal.querySelector('form');
    const close = value => {
      clearCredentialFields(form);
      modal.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = event => {
      if (event.key === 'Escape') close(null);
    };
    modal.querySelector('.confirm-backdrop').addEventListener('click', () => close(null));
    modal.querySelector('[data-credential-cancel]').addEventListener('click', () => close(null));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const data = new FormData(form);
      const payload = basic
        ? {
          username: formValue(data, 'username'),
          password: rawFormValue(data, 'password'),
          account_label: formValue(data, 'account_label') || undefined,
        }
        : {
          api_key: rawFormValue(data, 'api_key'),
          account_label: formValue(data, 'account_label') || undefined,
        };
      const valid = basic ? payload.username && payload.password : payload.api_key;
      if (!valid) {
        form.querySelector('[data-credential-error]').textContent = 'Enter the required credential.';
        return;
      }
      close(payload);
    });
    document.addEventListener('keydown', onKey);
    form.querySelector('input').focus();
  });
}

function credentialField(label, name, type, autocomplete, required = true) {
  return `
    <label class="int-field">
      <span>${escapeHtml(label)}</span>
      <input type="${type}" name="${name}" autocomplete="${autocomplete}"${required ? ' required' : ''}>
    </label>`;
}

function canManageDescriptors() {
  return hasRoute('GET', DESCRIPTORS_PATH);
}

function canUseProviderRoute(method, providerId, suffix = '') {
  return hasRoute(method, `${providerPath(providerId)}${suffix}`)
    || hasRoute(method, `${PROVIDER_ROUTE}${suffix}`);
}

function providerPath(providerId) {
  return `/me/integrations/${encodeURIComponent(providerId)}`;
}

function disconnectedStatus(descriptor) {
  return {
    provider: descriptor.provider,
    display_name: descriptor.display_name,
    category: descriptor.category,
    status: 'disconnected',
  };
}

function displayName(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : titleCase(fallback);
}

function titleCase(value) {
  return String(value).replaceAll(/[-_]+/g, ' ').replaceAll(/\b\w/g, character => character.toUpperCase());
}

function providerGlyph(provider) {
  if (provider.id === 'github') return '\u{1F5C2}';
  if (provider.descriptor?.auth_strategy === 'oauth2_authorization_code') return '\u{1F517}';
  return '\u{1F511}';
}

function providerDescription(provider) {
  if (provider.id === 'github') return 'Sync your portfolio to and from a GitHub repository.';
  if (provider.descriptor?.auth_strategy === 'oauth2_authorization_code') {
    return 'Authorize DollhouseMCP through this service’s OAuth sign-in flow.';
  }
  if (provider.descriptor?.static_api_key?.injection?.location === 'basic') {
    return 'Connect with a username and password issued by this service.';
  }
  return 'Connect with an API key issued by this service.';
}

function formValue(data, name) {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function rawFormValue(data, name) {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

// Descriptors are stored server-side and only ever reached over HTTPS, but this is the one place a
// server-supplied string becomes a navigation, so the scheme is checked here too rather than trusted.
function httpsUrlOrNull(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

// Clears every field: this form only exists for the duration of one connect, so nothing here is
// worth preserving. The descriptor editor deliberately clears only password inputs — see the note
// on its own clearCredentialFields.
function clearCredentialFields(form) {
  for (const input of form?.querySelectorAll('input') ?? []) input.value = '';
}

function clearCredentialObject(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of ['api_key', 'username', 'password']) {
    if (typeof value[key] === 'string') value[key] = '';
  }
}

function problemDetail(response, fallback) {
  return typeof response?.body?.detail === 'string' ? response.body.detail : fallback;
}

function formatReason(reason) {
  return String(reason).replaceAll('_', ' ');
}
