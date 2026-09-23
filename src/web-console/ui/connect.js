/** Guided setup for connecting remote MCP clients to this deployment. */

import { get } from './api.js';
import { escapeHtml, relAgo } from './ui-utils.js';

const METADATA_PATH = '/.well-known/oauth-protected-resource';
const CONNECTION_NAME = 'dollhouse-beta';

let host;
let notify = () => {};

export function validateHostedMcpEndpoint(value, pageOrigin) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Connection metadata did not include an MCP endpoint.');
  if (unsafeEndpointText(value)) {
    throw new Error('Connection metadata did not provide a safe endpoint for this deployment.');
  }
  let endpoint;
  let origin;
  try {
    endpoint = new URL(value);
    origin = new URL(pageOrigin);
  } catch {
    throw new Error('Connection metadata included an invalid MCP endpoint.');
  }
  if (unsafeEndpointText(endpoint.href)) {
    throw new Error('Connection metadata did not provide a safe endpoint for this deployment.');
  }
  const loopbackHttp = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !loopbackHttp)
      || endpoint.origin !== origin.origin
      || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) {
    throw new Error('Connection metadata did not provide a safe endpoint for this deployment.');
  }
  return endpoint.href;
}

function unsafeEndpointText(value) {
  return value.includes("'") || value.includes('\\') || [...value].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 32 || codePoint === 127;
  });
}

function base64Utf8(value) {
  // Endpoint validation and URL canonicalization constrain this JSON to ASCII.
  return btoa(value);
}

export function connectionArtifacts(endpoint, pageOrigin) {
  const safeEndpoint = validateHostedMcpEndpoint(endpoint, pageOrigin);
  const cursorLinkConfig = JSON.stringify({ url: safeEndpoint });
  const cursorConfig = JSON.stringify({ mcpServers: { [CONNECTION_NAME]: { url: safeEndpoint } } }, null, 2);
  return Object.freeze({
    endpoint: safeEndpoint,
    claudeAdd: `claude mcp add --transport http --scope user ${CONNECTION_NAME} '${safeEndpoint}'`,
    claudeLogin: `claude mcp login ${CONNECTION_NAME}`,
    codexAdd: `codex mcp add ${CONNECTION_NAME} --url '${safeEndpoint}'`,
    codexLogin: `codex mcp login ${CONNECTION_NAME}`,
    cursorLink: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(CONNECTION_NAME)}&config=${encodeURIComponent(base64Utf8(cursorLinkConfig))}`,
    cursorConfig,
  });
}

export function connectedAppsMarkup(sessions, failed = false) {
  if (failed) return '<div class="connect-state connect-state--error"><strong>Could not check connected apps.</strong><span>Open Sessions to retry and inspect connections.</span></div>';
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
  notify = ctx.toast || notify;
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
      <div class="connect-client-tabs" role="group" aria-label="Choose an AI client">
        ${clientTab('claude-code', 'Claude Code', true)}${clientTab('codex', 'Codex')}${clientTab('claude', 'Claude web / Desktop')}${clientTab('cursor', 'Cursor')}
      </div>
      <div id="connect-client-panel"></div>
      <section class="connect-status" aria-labelledby="connect-status-title">
        <div class="connect-status-head"><h3 id="connect-status-title">Connected apps</h3><button class="btn btn-ghost" id="connect-refresh" type="button">Refresh</button></div>
        <div id="connect-session-state" aria-live="polite">Checking your connections…</div>
        <button class="btn btn-ghost" id="connect-open-sessions" type="button">Open Sessions</button>
      </section>
    </div>`;
}

function clientTab(id, label, active = false) {
  return `<button class="connect-client-tab${active ? ' is-active' : ''}" aria-pressed="${active}" data-client="${id}" type="button">${label}</button>`;
}

function bindStaticActions() {
  host.querySelectorAll('[data-client]').forEach(button => button.addEventListener('click', () => selectClient(button.dataset.client)));
  host.querySelector('#connect-refresh').addEventListener('click', refreshSessions);
  host.querySelector('#connect-open-sessions').addEventListener('click', () => {
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
    selectClient('claude-code');
  } catch {
    host.dataset.endpoint = '';
    host.querySelector('#connect-endpoint').innerHTML = '<div class="connect-state connect-state--error"><strong>Connection setup is unavailable.</strong><span>The server did not provide a safe MCP endpoint. Try again later.</span></div>';
    host.querySelector('#connect-client-panel').innerHTML = '<div class="connect-state">Setup instructions will appear when endpoint discovery is available.</div>';
  }
}

function selectClient(client) {
  const endpoint = host.dataset.endpoint;
  if (!endpoint) return;
  host.querySelectorAll('[data-client]').forEach(button => {
    const active = button.dataset.client === client;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  host.querySelector('#connect-client-panel').replaceChildren(
    renderClientPanel(client, connectionArtifacts(endpoint, globalThis.location.origin)),
  );
}

function renderClientPanel(client, artifacts) {
  const panel = document.createElement('section');
  panel.className = 'connect-client-panel';
  if (client === 'claude-code') {
    panel.append(step('1', 'Add the hosted server', artifacts.claudeAdd), step('2', 'Authorize if prompted', artifacts.claudeLogin), oauthNote());
  } else if (client === 'codex') {
    panel.append(
      step('1', 'Add the hosted server', artifacts.codexAdd),
      step('2', 'Authorize with OAuth', artifacts.codexLogin),
      instructions('Prefer the Codex app? Open Settings → MCP servers → Add server, choose Streamable HTTP, paste the endpoint shown above, then Save, restart, and Authenticate.'),
      oauthNote(),
    );
  } else if (client === 'claude') {
    panel.append(instructions('In Claude web or Desktop, open Customize → Connectors → + → Add custom connector. Enter a readable name such as “Dollhouse Beta,” paste this URL, then choose Connect and finish authorization in the browser.'), valueBlock(artifacts.endpoint, 'Copy connector URL'), oauthNote());
  } else {
    const link = document.createElement('a');
    link.className = 'btn btn-primary';
    link.href = artifacts.cursorLink;
    link.textContent = 'Open in Cursor';
    link.addEventListener('click', () => notify('Finish setup and OAuth in Cursor, then refresh connected apps.', 'info'));
    panel.append(instructions('Use the install link, or open Cursor Settings → MCP and add the manual JSON below.'), link, valueBlock(artifacts.cursorConfig, 'Copy manual JSON'), oauthNote());
  }
  return panel;
}

function instructions(text) {
  const p = document.createElement('p'); p.textContent = text; return p;
}

function step(number, title, value) {
  const wrap = document.createElement('div'); wrap.className = 'connect-step';
  const heading = document.createElement('h3'); heading.textContent = `${number}. ${title}`;
  wrap.append(heading, valueBlock(value, 'Copy command'));
  return wrap;
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
