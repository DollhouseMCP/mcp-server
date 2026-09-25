/** Guided setup for connecting remote MCP clients to this deployment. */

import { get } from './api.js';
import { escapeHtml, relAgo } from './ui-utils.js';
import { connectionArtifacts, DEFAULT_CONNECTION_NAME, validateConnectionName, validateHostedMcpEndpoint } from './connect-config.js';

const METADATA_PATH = '/.well-known/oauth-protected-resource';

export { connectionArtifacts, validateHostedMcpEndpoint } from './connect-config.js';

let host;
let notify = () => {};
let sessionsTabAvailable = false;

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
      <div class="connect-client-tabs" role="group" aria-label="Choose an AI client">
        ${clientTab('claude-code', 'Claude Code', true)}${clientTab('codex', 'Codex')}${clientTab('claude', 'Claude web / Desktop')}${clientTab('cursor', 'Cursor')}${clientTab('vscode', 'VS Code / GitHub Copilot')}
      </div>
      <div id="connect-client-panel"></div>
      <section class="connect-status" aria-labelledby="connect-status-title">
        <div class="connect-status-head"><h3 id="connect-status-title">Connected apps</h3><button class="btn btn-ghost" id="connect-refresh" type="button">Refresh</button></div>
        <div id="connect-session-state" aria-live="polite">Checking your connections…</div>
        ${sessionsTabAvailable ? '<button class="btn btn-ghost" id="connect-open-sessions" type="button">Open Sessions</button>' : ''}
      </section>
    </div>`;
}

function clientTab(id, label, active = false) {
  return `<button class="connect-client-tab${active ? ' is-active' : ''}" aria-pressed="${active}" data-client="${id}" type="button">${label}</button>`;
}

function bindStaticActions() {
  host.querySelectorAll('[data-client]').forEach(button => button.addEventListener('click', () => selectClient(button.dataset.client)));
  host.querySelector('#connect-name').addEventListener('input', () => selectClient(
    host.querySelector('[data-client][aria-pressed="true"]').dataset.client,
  ));
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
    selectClient(host.querySelector('[data-client][aria-pressed="true"]')?.dataset.client || 'claude-code');
  } catch {
    host.dataset.endpoint = '';
    host.querySelector('#connect-endpoint').innerHTML = '<div class="connect-state connect-state--error"><strong>Connection setup is unavailable.</strong><span>The server did not provide a safe MCP endpoint. Try again later.</span></div>';
    host.querySelector('#connect-client-panel').innerHTML = '<div class="connect-state">Setup instructions will appear when endpoint discovery is available.</div>';
  }
}

function selectClient(client) {
  host.querySelectorAll('[data-client]').forEach(button => {
    const active = button.dataset.client === client;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
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
  target.replaceChildren(renderClientPanel(client, connectionArtifacts(endpoint, globalThis.location.origin, connectionName)));
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
    panel.append(instructions(`In Claude web or Desktop, open Customize → Connectors → + → Add custom connector. Use the name “${artifacts.profile.connectionName},” paste this URL, then choose Connect and finish authorization in the browser.`), valueBlock(artifacts.endpoint, 'Copy connector URL'), oauthNote());
  } else if (client === 'cursor') {
    panel.append(
      instructions('Open Cursor from your browser, review the server configuration, then finish setup and OAuth in Cursor.'),
      nativeInstallLink('Cursor', artifacts.cursorLink),
      instructions('If Cursor is not installed, does not open, or you cancel, install or open Cursor and retry, or add this entry under mcpServers in Cursor Settings → MCP. Preserve your other entries.'),
      valueBlock(artifacts.cursorConfig, 'Copy manual JSON'), oauthNote(),
    );
  } else if (client === 'vscode') {
    panel.append(
      instructions('Open the installed VS Code desktop app from your browser. Review the server URL and name, choose where to save it, then start the server and complete OAuth when prompted.'),
      nativeInstallLink('VS Code', artifacts.vscodeLink),
      instructions('If VS Code is not installed, does not open, or you cancel, install or open VS Code and retry, or run “MCP: Add Server” in its Command Palette, choose HTTP, and use the endpoint and connection name above. For manual configuration, merge this entry into your mcp.json without replacing other servers.'),
      valueBlock(artifacts.vscodeConfig, 'Copy manual JSON'),
      instructions('To remove this connection, remove its named entry from your MCP configuration. You can manage saved authentication separately in VS Code’s Accounts menu.'),
      oauthNote(),
    );
  }
  return panel;
}

function nativeInstallLink(clientName, href) {
  const link = document.createElement('a');
  link.className = 'btn btn-primary';
  link.href = href;
  link.textContent = `Open in ${clientName}`;
  link.addEventListener('click', () => notify(`Finish setup and OAuth in ${clientName}, then refresh connected apps.`, 'info'));
  return link;
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
