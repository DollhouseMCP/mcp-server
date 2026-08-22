/**
 * Owner-scoped custom integration descriptor authoring.
 *
 * Secrets are write-only: this module never copies a client secret into state
 * and clears/removes every credential field as soon as a request completes.
 */

import { del, get, patch, post, put } from './api.js';
import { confirmDialog, escapeHtml } from './ui-utils.js';
import { assertTextWithinByteLimit, parseBrowserYaml } from './yaml-safety.js';

const DESCRIPTORS_PATH = '/me/integrations/descriptors';
const OPENAPI_SPEC_MAX_BYTES = 1024 * 1024;

export function createIntegrationDescriptorManager(options) {
  const manager = {
    host: options.host,
    notify: options.notify,
    hasRoute: options.hasRoute,
    onChanged: options.onChanged,
    descriptors: [],
    loading: false,
    error: false,
    truncated: false,
    mode: 'list',
    editing: null,
    spec: null,
    operations: [],
    specVersion: 0,
  };

  manager.host.addEventListener('click', event => onClick(manager, event));
  manager.host.addEventListener('submit', event => onSubmit(manager, event));
  manager.host.addEventListener('change', event => onChange(manager, event));

  return {
    setDescriptors(descriptors, error = false, truncated = false) {
      manager.descriptors = descriptors;
      manager.error = error;
      manager.truncated = truncated;
      if (manager.mode === 'list') render(manager);
    },
    show() {
      manager.mode = 'list';
      manager.editing = null;
      manager.specVersion += 1;
      render(manager);
    },
  };
}

function render(manager) {
  if (manager.mode === 'edit') {
    renderEditor(manager);
    return;
  }
  if (manager.mode === 'spec') {
    renderSpec(manager);
    return;
  }
  renderList(manager);
}

function renderList(manager) {
  const canCreate = manager.hasRoute('POST', DESCRIPTORS_PATH);
  manager.host.innerHTML = `
    <div class="int-section-head">
      <div>
        <h2>Custom integrations</h2>
        <p>Define an API once, then connect your account from the Connections view.</p>
      </div>
      ${canCreate ? '<button class="btn btn-primary" data-descriptor-create type="button">Add integration</button>' : ''}
    </div>
    ${manager.error ? '<div class="int-notice int-notice--error">Custom integrations could not be loaded.</div>' : ''}
    ${manager.truncated ? '<div class="int-notice">This list is too long to show in full. Some custom integrations are not shown.</div>' : ''}
    ${descriptorList(manager)}`;
}

function descriptorList(manager) {
  if (manager.descriptors.length === 0) {
    return '<div class="int-empty"><strong>No custom integrations yet.</strong><span>Add an OAuth or API-key service to get started.</span></div>';
  }
  return `<div class="int-descriptor-list">${manager.descriptors.map(descriptorCard).join('')}</div>`;
}

function descriptorCard(descriptor) {
  const editable = descriptor.ownership === 'byo';
  const strategy = descriptor.auth_strategy === 'static_api_key'
    ? staticStrategyLabel(descriptor)
    : 'OAuth 2.0';
  return `
    <article class="int-descriptor-card">
      <div class="int-descriptor-main">
        <div class="int-card-name">${escapeHtml(descriptor.display_name)}</div>
        <div class="int-provider-id">${escapeHtml(descriptor.provider)}</div>
        <div class="int-caps">
          <span class="int-cap">${escapeHtml(descriptor.category)}</span>
          <span class="int-cap">${escapeHtml(strategy)}</span>
          <span class="int-cap">${editable ? 'Custom' : 'Curated'}</span>
        </div>
        <div class="int-meta">${escapeHtml(descriptor.api_hosts.join(', '))}</div>
      </div>
      <div class="int-actions int-actions--compact">
        ${editable ? descriptorActions(descriptor) : '<span class="int-meta">Managed by this deployment</span>'}
      </div>
    </article>`;
}

function descriptorActions(descriptor) {
  const id = escapeHtml(descriptor.id);
  return `
    <button class="btn btn-ghost" data-descriptor-spec="${id}" type="button">API definition</button>
    <button class="btn btn-ghost" data-descriptor-edit="${id}" type="button">Edit</button>
    <button class="btn btn-ghost int-danger" data-descriptor-delete="${id}" type="button">Delete</button>`;
}

function renderEditor(manager) {
  const descriptor = manager.editing;
  const editing = Boolean(descriptor);
  const strategy = descriptor?.auth_strategy ?? 'oauth2_authorization_code';
  const oauth = descriptor?.oauth ?? {};
  const injection = descriptor?.static_api_key?.injection ?? {};
  const remoteMcp = asObject(descriptor?.operation_promotion).remoteMcp ?? {};
  manager.host.innerHTML = `
    <div class="int-editor">
      <div class="int-section-head">
        <div>
          <button class="int-back" data-descriptor-back type="button">← Custom integrations</button>
          <h2>${editing ? 'Edit integration' : 'Add integration'}</h2>
          <p>Describe the service and how DollhouseMCP should authenticate with it.</p>
        </div>
      </div>
      <form id="int-descriptor-form" class="int-form">
        <section class="int-form-section">
          <h3>Identity</h3>
          <div class="int-form-grid">
            ${field('Display name', 'display_name', descriptor?.display_name ?? '', 'Example: Acme Tasks', true)}
            ${field('Provider ID', 'provider', descriptor?.provider ?? '', 'lowercase-name', true, editing)}
            ${field('Category', 'category', descriptor?.category ?? '', 'Example: Project management', true)}
            ${field('Allowed API hosts', 'api_hosts', descriptor?.api_hosts?.join(', ') ?? '', 'api.example.com, uploads.example.com', true)}
          </div>
          <p class="int-field-help">Provider IDs use lowercase letters, numbers, and hyphens. Hosts must be exact API hostnames; URLs and paths are not accepted. Saved hosts are shown as lowercase ASCII, with international domains displayed as punycode.</p>
        </section>
        <section class="int-form-section">
          <h3>Authentication</h3>
          <label class="int-field">
            <span>Method</span>
            <select name="auth_strategy">
              <option value="oauth2_authorization_code" ${strategy === 'oauth2_authorization_code' ? 'selected' : ''}>OAuth 2.0 authorization code</option>
              <option value="static_api_key" ${strategy === 'static_api_key' ? 'selected' : ''}>API key or Basic authentication</option>
            </select>
            <small>Users provide their own account credential when they click Connect.</small>
          </label>
          <div data-auth-fields>${strategyFields(strategy, oauth, injection, descriptor?.has_client_secret)}</div>
        </section>
        <details class="int-advanced"${asObject(remoteMcp).serverUrl ? ' open' : ''}>
          <summary>Connect a remote MCP server</summary>
          <p class="int-field-help">
            Most integrations leave this empty. Use it only when this service publishes its own MCP
            server, and you want its tools available alongside the API operations imported below.
          </p>
          <div class="int-form-grid">
            ${field('MCP server URL', 'remote_mcp_url', asObject(remoteMcp).serverUrl ?? '', 'https://api.example.com/mcp', false, false, 'url')}
            ${field('Tools to expose', 'remote_mcp_tools', joinList(asObject(remoteMcp).tools), 'search, create_task')}
          </div>
          <p class="int-field-help">
            The URL must use HTTPS, and its hostname must also be listed in Allowed API hosts above.
            Only the tools you name here are exposed; the rest of the server stays unavailable.
          </p>
        </details>
        <div class="int-form-error" role="alert" data-form-error></div>
        <div class="int-form-actions">
          <button class="btn btn-ghost" data-descriptor-back type="button">Cancel</button>
          <button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Create integration'}</button>
        </div>
      </form>
    </div>`;
}

function strategyFields(strategy, oauth, injection, hasClientSecret = false) {
  if (strategy === 'static_api_key') return staticFields(injection);
  return `
    <div class="int-form-grid int-auth-fields">
      ${field('OAuth client ID', 'oauth_client_id', oauth.client_id ?? '', 'Client ID from the provider', true)}
      ${secretField('OAuth client secret', 'oauth_client_secret', hasClientSecret)}
      ${field('Authorization URL', 'oauth_authorization_url', oauth.authorization_url ?? '', 'https://provider.example/oauth/authorize', true, false, 'url')}
      ${field('Token URL', 'oauth_token_url', oauth.token_url ?? '', 'https://provider.example/oauth/token', true, false, 'url')}
      ${field('Scopes', 'oauth_scopes', Array.isArray(oauth.scopes) ? oauth.scopes.join(' ') : '', 'read write profile')}
      ${selectField('PKCE support', 'oauth_pkce', [
        ['required', 'Required'],
        ['supported', 'Supported'],
        ['unsupported', 'Not supported'],
      ], oauth.pkce ?? 'required')}
      ${selectField('Refresh tokens', 'oauth_refresh', [
        ['none', 'None'],
        ['static', 'Static'],
        ['rotating', 'Rotating'],
      ], oauth.refresh ?? 'none')}
    </div>
    <p class="int-field-help">The client secret is write-only. Leave it blank while editing to keep the currently stored secret.</p>
    <details class="int-advanced int-auth-advanced">
      <summary>Provider-specific OAuth settings</summary>
      <p class="int-field-help">
        Standard OAuth 2.0 providers need none of these. Fill them in only when the provider's own
        setup guide asks for something below.
      </p>
      <div class="int-form-grid">
        ${field('Token revocation URL', 'oauth_revocation_url', readText(oauth.token_exchange, 'revocationUrl'), 'https://provider.example/oauth/revoke', false, false, 'url')}
        ${selectField('Client authentication', 'oauth_client_auth', [
          ['body', 'Send client ID and secret in the request body'],
          ['basic', 'Send them as an HTTP Basic header'],
          ['none', 'Send neither (public client)'],
        ], readText(oauth.token_exchange, 'clientAuth') || 'body')}
        ${field('Account name field', 'oauth_account_field', accountLabelField(oauth.account_label), 'email')}
      </div>
      <p class="int-field-help">
        Account name field: which value from the provider's token response to show as the connected
        account, for example <code>email</code> or <code>login</code>. Leave blank to show no name.
      </p>
      <label class="int-field">
        <span>Extra authorization parameters</span>
        <textarea name="oauth_authorization_params" rows="3" spellcheck="false" placeholder="audience=https://api.example.com&#10;prompt=consent">${escapeHtml(paramLines(oauth.token_exchange))}</textarea>
        <small>One <code>name=value</code> per line, added to the authorization URL. Some providers require an audience, tenant, or prompt value here.</small>
      </label>
    </details>`;
}

function staticFields(injection) {
  const location = injection.location ?? 'header';
  return `
    <div class="int-form-grid int-auth-fields">
      ${selectField('Credential type', 'static_location', [
        ['header', 'API key in a header'],
        ['query', 'API key in a query parameter'],
        ['basic', 'Username and password (Basic)'],
      ], location)}
      ${field('Header or parameter name', 'static_name', location === 'basic' ? 'Authorization' : (injection.name ?? 'Authorization'), 'Authorization', true, location === 'basic')}
      ${field('Value prefix', 'static_prefix', injection.value_prefix ?? '', 'Example: Bearer ')}
    </div>
    <p class="int-field-help">This defines where a user’s credential is placed in API requests. The credential itself is collected later when they connect.</p>`;
}

function field(label, name, value, placeholder, required = false, disabled = false, type = 'text') {
  return `
    <label class="int-field">
      <span>${escapeHtml(label)}</span>
      <input type="${type}" name="${name}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"${required ? ' required' : ''}${disabled ? ' disabled' : ''}>
    </label>`;
}

function secretField(label, name, hasSecret) {
  return `
    <label class="int-field">
      <span>${escapeHtml(label)}</span>
      <input type="password" name="${name}" value="" autocomplete="new-password" placeholder="${hasSecret ? 'Stored — leave blank to keep' : 'Client secret from the provider'}">
    </label>`;
}

function selectField(label, name, choices, selected) {
  return `
    <label class="int-field">
      <span>${escapeHtml(label)}</span>
      <select name="${name}">
        ${choices.map(([value, text]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}
      </select>
    </label>`;
}

function renderSpec(manager) {
  const descriptor = manager.editing;
  manager.host.innerHTML = `
    <div class="int-editor">
      <div class="int-section-head">
        <div>
          <button class="int-back" data-descriptor-back type="button">← Custom integrations</button>
          <h2>${escapeHtml(descriptor.display_name)} API definition</h2>
          <p>Import an OpenAPI document to discover the operations this integration can use.</p>
        </div>
      </div>
      ${specSummary(manager)}
      <form id="int-spec-form" class="int-form">
        <section class="int-form-section">
          <h3>Import OpenAPI</h3>
          <label class="int-field">
            <span>Choose a JSON or YAML file</span>
            <input type="file" name="spec_file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml">
          </label>
          <label class="int-field">
            <span>Or paste JSON or YAML</span>
            <textarea name="spec_text" rows="11" spellcheck="false" placeholder="openapi: 3.0.3&#10;info:&#10;  title: Example API&#10;  version: 1.0.0"></textarea>
          </label>
          ${field('Source URL (optional)', 'source_url', manager.spec?.source_url ?? '', 'https://docs.example.com/openapi.yaml', false, false, 'url')}
          <p class="int-field-help">The server validates size, structure, hosts, and supported operations before storing the definition.</p>
        </section>
        <div class="int-form-error" role="alert" data-form-error></div>
        <div class="int-form-actions">
          <button class="btn btn-ghost" data-descriptor-back type="button">Done</button>
          <button class="btn btn-primary" type="submit">Import definition</button>
        </div>
      </form>
      ${operationList(manager)}
    </div>`;
  manager.host.querySelector('[name="spec_file"]')?.addEventListener('change', event => {
    void readSelectedSpec(manager, event.currentTarget);
  });
}

function specSummary(manager) {
  if (manager.loading) return '<div class="int-notice">Loading the current API definition…</div>';
  if (!manager.spec) return '<div class="int-notice">No API definition has been imported yet.</div>';
  return `
    <div class="int-spec-summary">
      <strong>${discoveredSummary(manager.spec.operation_count)}</strong>
      <span>${formatBytes(manager.spec.spec_bytes)} · hash ${escapeHtml(manager.spec.spec_hash.slice(0, 12))}</span>
    </div>`;
}

function operationList(manager) {
  if (manager.operations.length === 0) return '';
  const promoted = promotedOperationIds(manager.editing);
  return `
    <form id="int-promotion-form" class="int-operations">
      <h3>Discovered operations</h3>
      <p class="int-field-help">
        Tick an operation to give it its own named tool, so an assistant can call it directly.
        Everything imported stays usable either way — unticked operations are still reachable
        through this integration's general-purpose request tool.
      </p>
      <div class="int-operation-list">
        ${manager.operations.map(operation => `
          <label class="int-operation">
            <input type="checkbox" name="promoted" value="${escapeHtml(operation.operation_id)}"${promoted.has(operation.operation_id) ? ' checked' : ''}>
            <span class="int-method int-method--${escapeHtml(operation.read_write_class)}">${escapeHtml(operation.method)}</span>
            <div>
              <strong>${escapeHtml(operation.operation_id)}</strong>
              <code>${escapeHtml(operation.path)}</code>
              ${operation.summary ? `<p>${escapeHtml(operation.summary)}</p>` : ''}
            </div>
          </label>`).join('')}
      </div>
      <div class="int-form-error" role="alert" data-form-error></div>
      <div class="int-form-actions">
        <button class="btn btn-primary" type="submit">Save selected tools</button>
      </div>
    </form>`;
}

async function onClick(manager, event) {
  const button = event.target.closest('button');
  if (!button || !manager.host.contains(button)) return;
  if (button.dataset.descriptorBack !== undefined) {
    manager.mode = 'list';
    manager.editing = null;
    manager.spec = null;
    manager.operations = [];
    manager.specVersion += 1;
    render(manager);
    return;
  }
  if (button.dataset.descriptorCreate !== undefined) {
    manager.editing = null;
    manager.mode = 'edit';
    render(manager);
    return;
  }
  if (button.dataset.descriptorEdit) {
    manager.editing = findDescriptor(manager, button.dataset.descriptorEdit);
    manager.mode = 'edit';
    render(manager);
    return;
  }
  if (button.dataset.descriptorDelete) await removeDescriptor(manager, button.dataset.descriptorDelete);
  if (button.dataset.descriptorSpec) await openSpec(manager, button.dataset.descriptorSpec);
}

function onChange(manager, event) {
  if (event.target.name === 'auth_strategy') {
    const fields = manager.host.querySelector('[data-auth-fields]');
    if (fields) fields.innerHTML = strategyFields(event.target.value, {}, {});
  }
  if (event.target.name === 'static_location') {
    const form = event.target.form;
    const name = form?.elements.namedItem('static_name');
    if (name instanceof HTMLInputElement) {
      name.disabled = event.target.value === 'basic';
      if (name.disabled) name.value = 'Authorization';
    }
  }
}

async function onSubmit(manager, event) {
  if (event.target.id === 'int-descriptor-form') {
    event.preventDefault();
    await saveDescriptor(manager, event.target);
  }
  if (event.target.id === 'int-spec-form') {
    event.preventDefault();
    await saveSpec(manager, event.target);
  }
  if (event.target.id === 'int-promotion-form') {
    event.preventDefault();
    await savePromotedOperations(manager, event.target);
  }
}

// Promoting operations is a partial edit of operation_promotion, but the API replaces the whole
// object when the key is sent — so the remote MCP configuration has to be carried through here.
async function savePromotedOperations(manager, form) {
  const error = form.querySelector('[data-form-error]');
  const submit = form.querySelector('[type="submit"]');
  setBusy(submit, true);
  clearError(error);
  try {
    const promotion = { ...asObject(manager.editing?.operation_promotion) };
    const operations = new FormData(form).getAll('promoted').map(String);
    if (operations.length > 0) promotion.operations = operations;
    else delete promotion.operations;
    const response = await patch(`${DESCRIPTORS_PATH}/${encodeURIComponent(manager.editing.id)}`, {
      body: { operation_promotion: promotion },
    });
    if (response.status !== 200) {
      throw new Error(problemDetail(response, 'The selected tools could not be saved.'));
    }
    manager.editing = response.body ?? manager.editing;
    manager.notify(promotionSummary(operations.length), 'success');
    await manager.onChanged();
  } catch (error_) {
    showError(error, error_);
  } finally {
    setBusy(submit, false);
  }
}

async function saveDescriptor(manager, form) {
  const error = form.querySelector('[data-form-error]');
  const submit = form.querySelector('[type="submit"]');
  setBusy(submit, true);
  clearError(error);
  try {
    const payload = descriptorPayload(new FormData(form), manager.editing);
    const path = manager.editing ? `${DESCRIPTORS_PATH}/${encodeURIComponent(manager.editing.id)}` : DESCRIPTORS_PATH;
    const response = manager.editing
      ? await patch(path, { body: payload })
      : await post(path, { body: payload });
    if (response.status !== (manager.editing ? 200 : 201)) {
      throw new Error(problemDetail(response, 'The integration could not be saved.'));
    }
    clearCredentialFields(form);
    manager.notify(manager.editing ? 'Integration updated.' : 'Integration created.', 'success');
    manager.mode = 'list';
    manager.editing = null;
    await manager.onChanged();
  } catch (error_) {
    showError(error, error_);
  } finally {
    clearCredentialFields(form);
    setBusy(submit, false);
  }
}

function descriptorPayload(data, existing) {
  const strategy = String(data.get('auth_strategy') ?? '');
  const payload = {
    display_name: requiredValue(data, 'display_name'),
    category: requiredValue(data, 'category'),
    auth_strategy: strategy,
    api_hosts: splitValues(data.get('api_hosts'), /[\s,]+/),
    operation_promotion: promotionPayload(data, existing),
  };
  if (!existing) payload.provider = requiredValue(data, 'provider');
  if (strategy === 'oauth2_authorization_code') {
    payload.oauth = oauthPayload(data);
    payload.static_api_key = null;
  } else {
    payload.oauth = null;
    payload.static_api_key = staticPayload(data);
  }
  return payload;
}

function oauthPayload(data) {
  const oauth = {
    client_id: requiredValue(data, 'oauth_client_id'),
    authorization_url: requiredValue(data, 'oauth_authorization_url'),
    token_url: requiredValue(data, 'oauth_token_url'),
    scopes: splitValues(data.get('oauth_scopes'), /[\s,]+/),
    pkce: requiredValue(data, 'oauth_pkce'),
    refresh: requiredValue(data, 'oauth_refresh'),
    token_exchange: tokenExchangePayload(data),
    account_label: accountLabelPayload(data),
  };
  const secret = stringValue(data.get('oauth_client_secret'));
  if (secret) oauth.client_secret = secret;
  return oauth;
}

function staticPayload(data) {
  const location = requiredValue(data, 'static_location');
  return {
    injection: {
      location,
      name: location === 'basic' ? 'Authorization' : requiredValue(data, 'static_name'),
      value_prefix: stringValue(data.get('static_prefix')) || null,
    },
  };
}

// The editor form no longer edits which operations are promoted — that moved to the API definition
// screen, where the operation IDs actually exist — so carry the existing selection through unchanged.
function promotionPayload(data, existing) {
  const promotion = {};
  const operations = asObject(existing?.operation_promotion).operations;
  if (Array.isArray(operations) && operations.length > 0) promotion.operations = operations;
  const serverUrl = stringValue(data.get('remote_mcp_url'));
  if (serverUrl) promotion.remoteMcp = { serverUrl, tools: splitValues(data.get('remote_mcp_tools'), /[\s,]+/) };
  return promotion;
}

function tokenExchangePayload(data) {
  const exchange = {};
  const revocationUrl = stringValue(data.get('oauth_revocation_url'));
  if (revocationUrl) exchange.revocationUrl = revocationUrl;
  const clientAuth = stringValue(data.get('oauth_client_auth'));
  if (clientAuth && clientAuth !== 'body') exchange.clientAuth = clientAuth;
  const params = parseParamLines(data.get('oauth_authorization_params'));
  if (Object.keys(params).length > 0) exchange.authorizationParams = params;
  return exchange;
}

function accountLabelPayload(data) {
  const field = stringValue(data.get('oauth_account_field'));
  return field ? { field } : {};
}

function parseParamLines(value) {
  const params = {};
  for (const line of String(value ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) {
      throw new Error(`Extra authorization parameters need one name=value per line. "${trimmed}" is missing a name or "=".`);
    }
    params[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return params;
}

function paramLines(tokenExchange) {
  const params = asObject(asObject(tokenExchange).authorizationParams);
  return Object.entries(params).map(([name, value]) => `${name}=${value}`).join('\n');
}

function readText(record, key) {
  const value = asObject(record)[key];
  return typeof value === 'string' ? value : '';
}

function accountLabelField(accountLabel) {
  return readText(accountLabel, 'field') || readText(accountLabel, 'tokenResponseField');
}

function promotedOperationIds(descriptor) {
  const operations = asObject(descriptor?.operation_promotion).operations;
  return new Set(Array.isArray(operations) ? operations.filter(entry => typeof entry === 'string') : []);
}

function discoveredSummary(count) {
  const plural = count === 1 ? '' : 's';
  return `${count} operation${plural} discovered`;
}

function promotionSummary(count) {
  if (count === 0) return 'No operations are exposed as their own tools.';
  const plural = count === 1 ? '' : 's';
  return `${count} operation${plural} exposed as tools.`;
}

function joinList(value) {
  return Array.isArray(value) ? value.join(', ') : '';
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function removeDescriptor(manager, id) {
  const descriptor = findDescriptor(manager, id);
  if (!descriptor) return;
  const approved = await confirmDialog(
    `Delete ${descriptor.display_name}? Its API definition and any saved connection will no longer be available.`,
    'Delete integration',
  );
  if (!approved) return;
  const response = await del(`${DESCRIPTORS_PATH}/${encodeURIComponent(id)}`).catch(() => null);
  if (!response || (response.status !== 200 && response.status !== 204)) {
    manager.notify('The integration could not be deleted.', 'error');
    return;
  }
  manager.notify('Integration deleted.', 'success');
  await manager.onChanged();
}

async function openSpec(manager, id) {
  const descriptor = findDescriptor(manager, id);
  if (!descriptor) return;
  manager.editing = descriptor;
  manager.mode = 'spec';
  manager.loading = true;
  manager.spec = null;
  manager.operations = [];
  // Leaving and re-entering this screen leaves the previous fetches in flight; without a
  // generation check a late response would overwrite whatever is on screen by then.
  const version = ++manager.specVersion;
  render(manager);
  const path = `${DESCRIPTORS_PATH}/${encodeURIComponent(id)}/spec`;
  const [specResponse, operationsResponse] = await Promise.all([
    get(path).catch(() => null),
    get(`${path}/operations`).catch(() => null),
  ]);
  if (version !== manager.specVersion) return;
  manager.spec = specResponse?.status === 200 ? specResponse.body : null;
  manager.operations = operationsResponse?.status === 200 && Array.isArray(operationsResponse.body?.operations)
    ? operationsResponse.body.operations
    : [];
  manager.loading = false;
  render(manager);
}

async function readSelectedSpec(manager, input) {
  const file = input.files?.[0];
  if (!file) return;
  const textarea = manager.host.querySelector('[name="spec_text"]');
  const error = manager.host.querySelector('[data-form-error]');
  try {
    textarea.value = await file.text();
    clearError(error);
  } catch {
    showError(error, new Error('The selected file could not be read.'));
  }
}

async function saveSpec(manager, form) {
  const error = form.querySelector('[data-form-error]');
  const submit = form.querySelector('[type="submit"]');
  setBusy(submit, true);
  clearError(error);
  try {
    const data = new FormData(form);
    const spec = parseSpec(stringValue(data.get('spec_text')));
    const sourceUrl = stringValue(data.get('source_url'));
    const id = encodeURIComponent(manager.editing.id);
    const response = await put(`${DESCRIPTORS_PATH}/${id}/spec`, {
      body: { spec, source_url: sourceUrl || null },
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(problemDetail(response, 'The API definition could not be imported.'));
    }
    manager.notify('API definition imported.', 'success');
    await openSpec(manager, manager.editing.id);
  } catch (error_) {
    showError(error, error_);
  } finally {
    setBusy(submit, false);
  }
}

function parseSpec(text) {
  if (!text) throw new Error('Choose a file or paste an OpenAPI definition.');
  assertTextWithinByteLimit(text, OPENAPI_SPEC_MAX_BYTES);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = parseBrowserYaml(text, { maxBytes: OPENAPI_SPEC_MAX_BYTES, schema: 'json' });
    } catch {
      throw new Error('The API definition is not valid JSON or YAML.');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The API definition must contain an object.');
  }
  return value;
}

function findDescriptor(manager, id) {
  return manager.descriptors.find(item => item.id === id) ?? null;
}

function requiredValue(data, name) {
  const value = stringValue(data.get(name));
  if (!value) throw new Error(`${humanize(name)} is required.`);
  return value;
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function splitValues(value, separator) {
  return stringValue(value).split(separator).map(item => item.trim()).filter(Boolean);
}

function problemDetail(response, fallback) {
  return typeof response?.body?.detail === 'string' ? response.body.detail : fallback;
}

function humanize(value) {
  return value.replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
}

function staticStrategyLabel(descriptor) {
  return descriptor.static_api_key?.injection?.location === 'basic' ? 'Basic authentication' : 'API key';
}

// Deliberately narrower than the connect modal's same-named helper: this form survives a failed
// save so the operator can correct it, and wiping every input would discard their whole descriptor.
// Only the secrets are cleared.
function clearCredentialFields(form) {
  for (const input of form?.querySelectorAll('input[type="password"]') ?? []) input.value = '';
}

function clearError(element) {
  if (element) element.textContent = '';
}

function showError(element, caught) {
  if (element) element.textContent = caught instanceof Error ? caught.message : 'Something went wrong.';
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes || 0)} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
