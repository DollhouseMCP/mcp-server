/** Guided setup for connecting remote MCP clients to this deployment. */

import { get } from './api.js';
import { escapeHtml, relAgo } from './ui-utils.js';
import { connectionArtifacts, DEFAULT_CONNECTION_NAME, validateConnectionName, validateHostedMcpEndpoint } from './connect-config.js';
import { coreConnectionClients } from './connect-catalog.js';

const METADATA_PATH = '/.well-known/oauth-protected-resource';

export { connectionArtifacts, validateHostedMcpEndpoint } from './connect-config.js';

let host;
let notify = () => {};
let sessionsTabAvailable = false;
let selectedClient = 'claude-code';
let selectedRoute = '';

export function connectedAppsMarkup(sessions, failed = false) {
  if (failed) return '<div class="connect-state connect-state--error"><strong>Could not check connected apps.</strong><span>Use Refresh to try again.</span></div>';
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return '<div class="connect-state"><strong>No connected apps yet.</strong><span>Complete setup and OAuth in your client, then refresh this check.</span></div>';
  }
  const apps = sessions.map(session => {
    const name = session?.client_info?.name || 'MCP client';
    const version = session?.client_info?.version ? ` ${session.client_info.version}` : '';
    const activity = session?.last_active_at ? ` · last active ${relAgo(session.last_active_at)}` : '';
    const escapedSessionLabel = escapeHtml(`${name}${version}${activity}`);
    return `<li>${escapedSessionLabel}</li>`;
  }).join('');
  const appLabel = sessions.length === 1 ? 'app' : 'apps';
  return `<div class="connect-state connect-state--ok"><strong>${sessions.length} connected ${appLabel}</strong><ul>${apps}</ul></div>`;
}

export async function init(panelEl, ctx = {}) {
  host = panelEl;
  selectedClient = 'claude-code';
  selectedRoute = '';
  notify = ctx.toast || notify;
  sessionsTabAvailable = ctx.hasRoute?.('GET', '/me/sessions') === true
    && ctx.hasRoute?.('GET', '/me/security/sessions') === true;
  host.innerHTML = pageShell();
  bindStaticActions();
  await Promise.all([loadEndpoint(), refreshSessions()]);
}

function pageShell() {
  return `
    <div class="connect-page">
      <header class="connect-hero">
        <div><span class="connect-kicker">Hosted connection</span><h2>Connect your AI client</h2></div>
        <p>Choose a client, add this hosted DollhouseMCP endpoint, then authorize in the browser when your client asks.</p>
      </header>
      <div class="connect-notice"><strong>No local server is required for basic hosted access.</strong> Local permission hooks and host audit need separate local support and are not enabled by this setup.</div>
      <div id="connect-endpoint" class="connect-endpoint" aria-live="polite">Loading the secure endpoint…</div>
      <div class="connect-name">
        <label for="connect-name">Connection name</label>
        <input id="connect-name" value="${DEFAULT_CONNECTION_NAME}" maxlength="64" autocomplete="off" spellcheck="false" aria-describedby="connect-name-help connect-name-error">
        <p id="connect-name-help">Use a name that is free in your client to preserve existing connections. This page cannot check your client's saved names.</p>
        <p id="connect-name-error" role="status"></p>
      </div>
      <div class="connect-setup-layout"><div class="connect-picker">
        <label for="connect-search">Find your AI client</label>
        <input id="connect-search" type="search" autocomplete="off" placeholder="Search clients" aria-controls="connect-client-list">
        <div id="connect-client-list" class="connect-client-list" role="group" aria-label="Choose an AI client"></div>
        <p id="connect-search-empty" class="connect-search-empty" hidden>No matching clients. Try another name.</p>
      </div>
      <div id="connect-client-panel"></div></div>
      <section class="connect-status" aria-labelledby="connect-status-title">
        <div class="connect-status-head"><h3 id="connect-status-title">Connected apps</h3><button class="btn btn-ghost" id="connect-refresh" type="button">Refresh</button></div>
        <div id="connect-session-state" aria-live="polite">Checking your connections…</div>
        <p class="connect-status-note">This lists current-user sessions. To confirm tool access, ask your client to use a Dollhouse tool. Local permission hooks require separate setup.</p>
        ${sessionsTabAvailable ? '<button class="btn btn-ghost" id="connect-open-sessions" type="button">Open Sessions</button>' : ''}
      </section>
    </div>`;
}

function bindStaticActions() {
  renderClientList(coreConnectionClients({
    endpoint: '', profile: { connectionName: DEFAULT_CONNECTION_NAME },
    claudeAdd: '', claudeLogin: '', codexAdd: '', codexLogin: '',
    cursorLink: 'cursor://anysphere.cursor-deeplink/mcp/install?',
    vscodeLink: 'vscode:mcp/install?', cursorConfig: '', vscodeConfig: '',
  }));
  host.querySelector('#connect-search').addEventListener('input', filterClients);
  host.querySelector('#connect-name').addEventListener('input', renderSetup);
  host.querySelector('#connect-refresh').addEventListener('click', refreshSessions);
  host.querySelector('#connect-open-sessions')?.addEventListener('click', () => {
    document.querySelector('.console-tab[data-tab="sessions"]')?.click();
  });
}

async function loadEndpoint() {
  try {
    const response = await fetch(METADATA_PATH, {
      headers: { accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) throw new Error('metadata unavailable');
    const metadata = await response.json();
    const endpoint = validateHostedMcpEndpoint(metadata?.resource, globalThis.location.origin);
    host.dataset.endpoint = endpoint;
    const target = host.querySelector('#connect-endpoint');
    target.replaceChildren();
    const label = document.createElement('span');
    label.textContent = 'MCP endpoint';
    const code = document.createElement('code');
    code.textContent = endpoint;
    target.append(label, code, copyButton(endpoint, 'Copy endpoint'));
    renderSetup();
  } catch {
    host.dataset.endpoint = '';
    host.querySelector('#connect-endpoint').innerHTML = '<div class="connect-state connect-state--error"><strong>Connection setup is unavailable.</strong><span>The server did not provide a safe MCP endpoint. Try again later.</span></div>';
    host.querySelector('#connect-client-panel').innerHTML = '<div class="connect-state">Setup instructions will appear when endpoint discovery is available.</div>';
  }
}

function selectClient(client) {
  selectedClient = client;
  selectedRoute = '';
  host.querySelectorAll('[data-client]').forEach(button => {
    const active = button.dataset.client === client;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderSetup();
}

function renderSetup() {
  const endpoint = host.dataset.endpoint;
  if (!endpoint) return;
  const nameInput = host.querySelector('#connect-name');
  const nameError = host.querySelector('#connect-name-error');
  const target = host.querySelector('#connect-client-panel');
  let connectionName;
  try {
    connectionName = validateConnectionName(nameInput.value);
  } catch (error) {
    nameInput.setAttribute('aria-invalid', 'true');
    nameError.textContent = error.message;
    target.replaceChildren(instructions('Choose a valid connection name to show setup actions.'));
    return;
  }
  nameInput.removeAttribute('aria-invalid');
  nameError.textContent = '';
  const clients = coreConnectionClients(connectionArtifacts(endpoint, globalThis.location.origin, connectionName));
  const client = clients.find(item => item.id === selectedClient) || clients[0];
  target.replaceChildren(renderClientPanel(client));
}

function renderClientList(clients) {
  const list = host.querySelector('#connect-client-list');
  list.replaceChildren();
  for (const group of [...new Set(clients.map(client => client.group))]) {
    const section = document.createElement('div'); section.className = 'connect-client-group';
    const title = document.createElement('h3'); title.textContent = group;
    section.append(title);
    for (const client of clients.filter(item => item.group === group)) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'connect-client-tab'; button.dataset.client = client.id;
      button.setAttribute('aria-pressed', String(client.id === selectedClient));
      button.classList.toggle('is-active', client.id === selectedClient);
      const label = document.createElement('strong'); label.textContent = client.label;
      const summary = document.createElement('span'); summary.textContent = client.summary;
      button.append(label, summary);
      button.addEventListener('click', () => selectClient(client.id));
      section.append(button);
    }
    list.append(section);
  }
  filterClients();
}

function filterClients() {
  const query = host.querySelector('#connect-search').value.trim().toLocaleLowerCase();
  let matches = 0;
  host.querySelectorAll('.connect-client-group').forEach(group => {
    let groupMatches = 0;
    group.querySelectorAll('[data-client]').forEach(button => {
      const visible = button.textContent.toLocaleLowerCase().includes(query);
      button.hidden = !visible;
      if (visible) groupMatches++;
    });
    group.hidden = groupMatches === 0;
    matches += groupMatches;
  });
  host.querySelector('#connect-search-empty').hidden = matches > 0;
}

function renderClientPanel(client) {
  const panel = document.createElement('section');
  panel.className = 'connect-client-panel';
  const head = document.createElement('div'); head.className = 'connect-client-heading';
  const heading = document.createElement('h3'); heading.textContent = client.label;
  const docs = safeLink(client.docsUrl, 'Client setup docs');
  head.append(heading, docs); panel.append(head);
  if (client.availability) panel.append(instructions(client.availability));
  const routes = document.createElement('div'); routes.className = 'connect-route-tabs';
  routes.setAttribute('role', 'group'); routes.setAttribute('aria-label', `Setup route for ${client.label}`);
  const activeRoute = client.routes.find(route => route.id === selectedRoute) || client.routes[0];
  for (const route of client.routes) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'connect-route-tab'; button.dataset.route = route.id;
    button.textContent = route.label;
    button.setAttribute('aria-pressed', String(route.id === activeRoute.id));
    button.classList.toggle('is-active', route.id === activeRoute.id);
    button.addEventListener('click', () => {
      selectedRoute = route.id;
      renderSetup();
      host.querySelector(`[data-route="${route.id}"]`)?.focus();
    });
    routes.append(button);
  }
  panel.append(routes);
  const steps = document.createElement('ol'); steps.className = 'connect-steps';
  for (const item of activeRoute.steps) {
    const li = document.createElement('li'); li.className = 'connect-step';
    const title = document.createElement('h4'); title.textContent = item.title;
    li.append(title, instructions(item.text));
    if (item.value) li.append(valueBlock(item.value, item.copyLabel || 'Copy'));
    if (item.href) {
      const link = safeLink(item.href, item.linkLabel || 'Open setup');
      if (item.href.startsWith('cursor:') || item.href.startsWith('vscode:')) {
        link.className = 'btn btn-primary';
        link.addEventListener('click', () => notify(`Finish setup and OAuth in ${item.linkLabel?.replace('Open in ', '') || client.label}, then refresh connected apps.`, 'info'));
      }
      li.append(link);
    }
    steps.append(li);
  }
  panel.append(steps);
  panel.append(oauthNote());
  return panel;
}

function safeLink(href, label) {
  const allowed = /^https:\/\/(?:code\.claude\.com|claude\.ai|support\.claude\.com|developers\.openai\.com|code\.visualstudio\.com|cursor\.com)\//.test(href)
    || href.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?')
    || href.startsWith('vscode:mcp/install?');
  if (!allowed) throw new Error('Unsafe setup link');
  const link = document.createElement('a');
  link.href = href;
  if (href.startsWith('https:')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${label} ↗`;
    link.setAttribute('aria-label', `${label} (opens in a new tab)`);
  } else {
    link.textContent = label;
  }
  return link;
}

function instructions(text) {
  const p = document.createElement('p'); p.textContent = text; return p;
}

function valueBlock(value, label) {
  const wrap = document.createElement('div'); wrap.className = 'connect-value';
  const code = document.createElement('code'); code.textContent = value;
  wrap.append(code, copyButton(value, label)); return wrap;
}

function copyButton(value, label) {
  const button = document.createElement('button'); button.className = 'btn btn-ghost'; button.type = 'button'; button.textContent = label;
  button.addEventListener('click', () => copyText(value, button)); return button;
}

async function copyText(value, button) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(value);
    notify('Copied.', 'success');
  } catch {
    const selection = document.createElement('textarea');
    selection.value = value; selection.readOnly = true; selection.className = 'connect-copy-fallback';
    button.after(selection); selection.select();
    notify('Copy failed. The text is selected so you can copy it manually.', 'warn');
  }
}

function oauthNote() {
  const note = document.createElement('p'); note.className = 'connect-oauth-note';
  note.textContent = 'OAuth opens in your browser. Sign in with this account and approve the MCP connection. Copying or opening setup does not mean the client is connected.';
  return note;
}

async function refreshSessions() {
  const target = host.querySelector('#connect-session-state');
  target.textContent = 'Checking your connections…';
  try {
    const response = await get('/me/sessions');
    if (response.status !== 200 || !Array.isArray(response.body?.sessions)) throw new Error('sessions unavailable');
    target.innerHTML = connectedAppsMarkup(response.body.sessions);
  } catch {
    target.innerHTML = connectedAppsMarkup([], true);
  }
}
