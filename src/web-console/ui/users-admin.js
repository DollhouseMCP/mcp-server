/**
 * User Admin tab — manage every configured account on the system.
 *
 * This surface only renders while the session is elevated with
 * `console:admin:accounts` (app.js gates the tab; the backend re-checks every
 * route). It lifts the Atelier look from the rest of the console: a list of
 * users, and a detail drawer with panels for identity/linked logins, roles,
 * MFA, sessions, and account lifecycle.
 *
 * Identity model surfaced here (the source of the login↔MCP confusion): a
 * person's IDENTITY is the OAuth subject, and one account can have several
 * linked logins (providers) — all sharing one user row. The "Linked logins"
 * panel makes that explicit; the per-connection app label an MCP client sends
 * (Claude Code, Gemini…) is shown on the Sessions panel, not as identity.
 *
 * Phase 1 wires the routes that already exist (list, roles grant/revoke,
 * enable/disable, invite, revoke-all credentials, list/disconnect sessions).
 *
 * Phase 2 adds the sensitive actions: resetting a user's authenticator (so a
 * lost/compromised device can be re-enrolled), hard-deleting an account, and
 * manually linking/unlinking provider logins. "Pending enrollment" — an admin
 * role held by an account with no authenticator — is a DERIVED status, not a
 * stored flag: the elevation gate already refuses a step-up without TOTP, so
 * the surface only has to make that state visible.
 */

import { get, post, del } from './api.js';
import { confirmDialog, escapeHtml, relAgo } from './ui-utils.js';
import { createAllowlistView, createIdentityTriageView, createBootstrapView } from './accounts-admin.js';

const DRAWER_ROOT_SELECTOR = '#ua-drawer-root';
const USER_ROUTES = {
  invite: ['POST', '/admin/accounts/users/invite'],
  grantRole: ['POST', '/admin/accounts/users/:user_id/roles/grant'],
  revokeRole: ['POST', '/admin/accounts/users/:user_id/roles/revoke'],
  resetTotp: ['POST', '/admin/security/users/:user_id/factors/totp/reset'],
  enable: ['POST', '/admin/accounts/users/:user_id/enable'],
  disable: ['POST', '/admin/accounts/users/:user_id/disable'],
  revokeAllCredentials: ['POST', '/admin/accounts/users/:user_id/credentials/revoke-all'],
  delete: ['DELETE', '/admin/accounts/users/:user_id'],
  listIdentities: ['GET', '/admin/accounts/users/:user_id/identities'],
  linkIdentity: ['POST', '/admin/accounts/users/:user_id/identities/link'],
  unlinkIdentity: ['POST', '/admin/accounts/users/:user_id/identities/unlink'],
  listSessions: ['GET', '/admin/accounts/users/:user_id/sessions'],
  disconnectSession: ['DELETE', '/admin/accounts/users/:user_id/sessions/:session_id'],
};

let host;
let notify = () => {};
const state = {
  users: [], loading: true, error: false, selectedId: null, actorCaps: [],
  roleCatalog: { roles: [], grants: {} }, hasRoute: () => false,
};
let globalListenersBound = false;
let governanceSections = [];

export async function init(panelEl, ctx = {}) {
  host = panelEl;
  notify = ctx.toast || notify;
  state.roleCatalog = normalizeRoleCatalog(ctx.roleCatalog);
  state.hasRoute = ctx.hasRoute || state.hasRoute;
  state.selectedId = null;
  governanceSections = governanceDefinitions();
  host.innerHTML = shell();
  for (const section of governanceSections) {
    section.view.mount(host.querySelector(`[data-ua-panel="${section.id}"]`));
  }
  host.querySelector('#ua-nav')?.addEventListener('click', event => {
    const button = event.target.closest('[data-ua-nav]');
    if (button) selectUaSection(button.dataset.uaNav);
  });
  host.querySelector('#ua-refresh').addEventListener('click', load);
  host.querySelector('#ua-invite')?.addEventListener('click', openInvite);
  bindGlobalListeners();
  await load();
}

function bindGlobalListeners() {
  if (globalListenersBound) return;
  // Re-fetch when re-entering the tab; accounts drift as other admins act.
  globalThis.addEventListener('dh:tab-activated', onTabActivated);
  // Never retain privileged drawer content after elevation ends.
  globalThis.addEventListener('dh:elevation-changed', onElevationChanged);
  globalListenersBound = true;
}

function onTabActivated(event) {
  if (event.detail?.name === 'users') load();
}

function onElevationChanged(event) {
  if (event.detail?.active === false) closeDrawer();
}

/* ── Data ───────────────────────────────────────────────────────────────── */

async function load() {
  state.loading = true;
  state.error = false;
  renderList();
  const [usersRes, me] = await Promise.all([
    get('/admin/accounts/users?limit=200').catch(() => null),
    get('/auth/me').catch(() => null),
  ]);
  state.actorCaps = me?.status === 200 && Array.isArray(me.body?.available_admin_capabilities)
    ? me.body.available_admin_capabilities : [];
  if (usersRes?.status === 200 && Array.isArray(usersRes.body?.items)) {
    state.users = usersRes.body.items;
    state.error = false;
  } else {
    state.users = [];
    // A 401 step_up_required is handled by the shell; show a soft message here.
    state.error = usersRes?.status !== 200;
  }
  state.loading = false;
  renderList();
}

function canManageRole(role) {
  const capabilities = roleCapabilities(role);
  return Object.hasOwn(state.roleCatalog.grants, role)
    && capabilities.every(cap => state.actorCaps.includes(cap));
}

function hasUserRoute(name) {
  const route = USER_ROUTES[name];
  return !!route && state.hasRoute(route[0], route[1]);
}

function normalizeRoleCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.roles) || !catalog.grants || typeof catalog.grants !== 'object') {
    return { roles: [], grants: {} };
  }
  return { roles: catalog.roles, grants: catalog.grants };
}

function roleCapabilities(role) {
  const capabilities = state.roleCatalog.grants[role];
  return Array.isArray(capabilities) ? capabilities : [];
}

function roleLabel(role) {
  return String(role).split('_').map(word => word ? word[0].toUpperCase() + word.slice(1) : '').join(' ');
}

// Resetting a factor is a security operation — gated on console:admin:security
// (the same capability the security-admin reset route requires), not on the
// broader console:admin:accounts that opens this tab.
function canResetFactor() {
  return state.actorCaps.includes('console:admin:security');
}

// "Pending enrollment": the account holds an admin role but has no active
// authenticator, so it cannot elevate yet. Derived, not stored.
function isPendingEnrollment(u) {
  return !u.admin_factor_enrolled && (u.roles || []).length > 0;
}

function mfaCell(u) {
  if (u.admin_factor_enrolled) return '<span class="ua-mfa ua-mfa--on">&#x2713; TOTP</span>';
  if (isPendingEnrollment(u)) {
    return '<span class="ua-mfa ua-mfa--pending" title="Admin role granted; authenticator not yet enrolled">&#x26a0; Pending</span>';
  }
  return '<span class="ua-mfa ua-mfa--off">—</span>';
}

function findUser(id) {
  return state.users.find(u => u.user_id === id) || null;
}

/* ── List ───────────────────────────────────────────────────────────────── */

function shell() {
  return `
  <div class="ua-bar">
    <span class="ua-title">Users</span>
    <div class="ua-bar-actions">
      <button class="btn btn-ghost" id="ua-refresh" type="button">&#x21bb; Refresh</button>
      ${hasUserRoute('invite') ? '<button class="btn btn-primary" id="ua-invite" type="button">+ Invite user</button>' : ''}
    </div>
  </div>
  ${navMarkup()}
  <div data-ua-panel="accounts">
    <div id="ua-list"></div>
    <div id="ua-drawer-root"></div>
  </div>
  ${governancePanelsMarkup()}`;
}

/**
 * The account list keeps its own markup untouched; the governance surfaces are
 * separate panels beside it so this tab gains sections without the list changing.
 */
function governancePanelsMarkup() {
  return governanceSections.map(section => `<div data-ua-panel="${section.id}" hidden></div>`).join('');
}

function navMarkup() {
  if (governanceSections.length === 0) return '';
  const items = [
    navItemMarkup('accounts', 'Accounts', true),
    ...governanceSections.map(section => navItemMarkup(section.id, section.label, false)),
  ];
  return `
    <div class="ua-nav" id="ua-nav" role="tablist" aria-label="Account administration views">
      ${items.join('')}
    </div>`;
}

function navItemMarkup(id, label, active) {
  return `<button class="ua-nav-item${active ? ' is-active' : ''}" data-ua-nav="${id}" role="tab" aria-selected="${active}" type="button">${escapeHtml(label)}</button>`;
}

function governanceDefinitions() {
  const definitions = [];
  if (state.hasRoute('GET', '/admin/accounts/allowlist')) {
    definitions.push({
      id: 'allowlist',
      label: 'Allowlist',
      view: createAllowlistView({
        notify: (text, tone) => notify(text, tone),
        canAdd: state.hasRoute('POST', '/admin/accounts/allowlist'),
        canEdit: state.hasRoute('PATCH', '/admin/accounts/allowlist/:id'),
        canRemove: state.hasRoute('DELETE', '/admin/accounts/allowlist/:id'),
      }),
    });
  }
  if (state.hasRoute('GET', '/admin/accounts/identities/unlinked')) {
    definitions.push({
      id: 'triage',
      label: 'Identity triage',
      view: createIdentityTriageView({
        canLookup: state.hasRoute('GET', '/admin/accounts/correlations/:account_correlation_id'),
      }),
    });
  }
  if (state.hasRoute('GET', '/admin/accounts/bootstrap')) {
    definitions.push({ id: 'bootstrap', label: 'Bootstrap', view: createBootstrapView() });
  }
  return definitions;
}

function selectUaSection(id) {
  const panels = [{ id: 'accounts' }, ...governanceSections];
  for (const section of panels) {
    const active = section.id === id;
    const button = host.querySelector(`[data-ua-nav="${section.id}"]`);
    const panel = host.querySelector(`[data-ua-panel="${section.id}"]`);
    button?.classList.toggle('is-active', active);
    button?.setAttribute('aria-selected', String(active));
    if (panel) panel.hidden = !active;
    if (active) section.view?.activate();
  }
}

function renderList() {
  const root = host.querySelector('#ua-list');
  if (!root) return;
  if (state.loading) { root.innerHTML = '<div class="panel-placeholder">Loading users…</div>'; return; }
  if (state.error) { root.innerHTML = '<div class="panel-placeholder">Couldn\'t load users. Admin elevation may have lapsed — re-elevate and retry.</div>'; return; }
  if (state.users.length === 0) { root.innerHTML = '<div class="panel-placeholder">No users configured.</div>'; return; }

  root.innerHTML = `
    <p class="ua-count">${state.users.length} account${state.users.length === 1 ? '' : 's'}</p>
    <div class="ua-table" role="table">
      <div class="ua-row ua-row--head" role="row">
        <span role="columnheader">User</span>
        <span role="columnheader">Roles</span>
        <span role="columnheader">Logins</span>
        <span role="columnheader">MFA</span>
        <span role="columnheader">Last login</span>
        <span role="columnheader">Status</span>
      </div>
      ${state.users.map(userRow).join('')}
    </div>`;

  root.querySelectorAll('[data-user-row]').forEach(el =>
    el.addEventListener('click', () => openDrawer(el.dataset.userRow)));
}

function userRow(u) {
  const name = escapeHtml(u.display_name || u.username);
  const disabled = !!u.disabled_at;
  return `
    <div class="ua-row${disabled ? ' ua-row--disabled' : ''}" role="row" data-user-row="${escapeHtml(u.user_id)}" tabindex="0">
      <span class="ua-cell-user">
        <span class="ua-name">${name}</span>
        <span class="ua-sub">${escapeHtml(u.email || u.username)}</span>
      </span>
      <span class="ua-cell-roles">${rolesChips(u.roles)}</span>
      <span class="ua-cell-logins">${(u.auth_methods || []).map(providerChip).join('') || '<span class="ua-muted">—</span>'}</span>
      <span class="ua-cell-mfa">${mfaCell(u)}</span>
      <span class="ua-cell-last ua-muted">${escapeHtml(relAgo(u.last_login_at))}</span>
      <span class="ua-cell-status">${disabled ? '<span class="ua-status ua-status--off">Disabled</span>' : '<span class="ua-status ua-status--on">Active</span>'}</span>
    </div>`;
}

function rolesChips(roles) {
  if (!roles || roles.length === 0) return '<span class="ua-muted">user</span>';
  return roles.map(r => `<span class="ua-role-chip" data-role="${escapeHtml(r)}">${escapeHtml(roleLabel(r))}</span>`).join('');
}

function providerChip(p) {
  return `<span class="ua-provider-chip">${escapeHtml(p)}</span>`;
}

/* ── Detail drawer ──────────────────────────────────────────────────────── */

function openDrawer(userId) {
  state.selectedId = userId;
  renderDrawer();
}

function closeDrawer() {
  state.selectedId = null;
  const root = host.querySelector(DRAWER_ROOT_SELECTOR);
  if (root) root.innerHTML = '';
}

function renderDrawer() {
  const u = findUser(state.selectedId);
  const root = host.querySelector(DRAWER_ROOT_SELECTOR);
  if (!root || !u) return;
  const disabled = !!u.disabled_at;

  root.innerHTML = `
    <div class="ua-drawer-backdrop" id="ua-drawer-backdrop"></div>
    <aside class="ua-drawer" role="dialog" aria-modal="true" aria-label="User detail">
      <header class="ua-drawer-head">
        <div>
          <h2 class="ua-drawer-name">${escapeHtml(u.display_name || u.username)}</h2>
          <p class="ua-drawer-sub">${escapeHtml(u.email || u.username)}${disabled ? ' · <span class="ua-status ua-status--off">Disabled</span>' : ''}</p>
        </div>
        <button class="ua-drawer-close" id="ua-drawer-close" type="button" aria-label="Close">&#x2715;</button>
      </header>
      <div class="ua-drawer-body">
        ${panelIdentity(u)}
        ${panelRoles(u)}
        ${panelMfa(u)}
        ${panelSessions(u)}
        ${panelLifecycle(u)}
      </div>
    </aside>`;

  root.querySelector('#ua-drawer-close').addEventListener('click', closeDrawer);
  root.querySelector('#ua-drawer-backdrop').addEventListener('click', closeDrawer);
  wireRoleToggles(u);
  wireMfa(u);
  wireIdentity(u);
  wireLifecycle(u);
  if (hasUserRoute('listIdentities')) loadUserIdentities(u.user_id);
  if (hasUserRoute('listSessions')) loadUserSessions(u.user_id);
}

function panelSection(title, inner, note) {
  return `<section class="ua-panel">
    <h3 class="ua-panel-title">${escapeHtml(title)}</h3>
    ${note ? `<p class="ua-panel-note">${escapeHtml(note)}</p>` : ''}
    ${inner}
  </section>`;
}

// Identity & linked logins — the heart of the login↔MCP question. One account,
// possibly many linked provider logins, all sharing this identity.
function panelIdentity(u) {
  const emailUnverifiedSuffix = u.email ? ' (unverified)' : '';
  const emailSuffix = u.email && u.email_verified ? ' (verified)' : emailUnverifiedSuffix;
  const rows = [
    ['Account ID', u.user_id],
    ['Username', u.username],
    ['Primary subject', u.primary_sub || '—'],
    ['Email', `${u.email || '—'}${emailSuffix}`],
    ['Created', relAgo(u.created_at)],
  ].map(([k, v]) => `<div class="ua-kv"><span class="ua-kv-k">${escapeHtml(k)}</span><span class="ua-kv-v">${escapeHtml(String(v))}</span></div>`).join('');
  const linkedLogins = hasUserRoute('listIdentities') ? `
     <div class="ua-identities-head">Linked logins</div>
     <div id="ua-identities-${escapeHtml(u.user_id)}" class="ua-identities"><span class="ua-muted">Loading…</span></div>
     ${identityLinkForm(u)}` : '';
  return panelSection('Identity & linked logins',
    `${rows}${linkedLogins}`,
    'All logins below resolve to this one account. Linking attaches another provider login; unlinking detaches one (the only login can’t be removed).');
}

function identityLinkForm(u) {
  if (!hasUserRoute('linkIdentity')) return '';
  const userId = escapeHtml(u.user_id);
  return `<div class="ua-link-row">
    <input type="text" class="ua-link-input" id="ua-link-sub-${userId}"
           placeholder="provider_subject (e.g. github_12345)" maxlength="320" autocomplete="off">
    <button class="btn btn-ghost" data-link-add="${userId}" type="button">Link login</button>
  </div>`;
}

function panelRoles(u) {
  const checks = state.roleCatalog.roles.map(role => {
    const on = (u.roles || []).includes(role);
    const mutationRoute = on ? 'revokeRole' : 'grantRole';
    const manageable = canManageRole(role) && hasUserRoute(mutationRoute);
    return `<label class="ua-role-opt${manageable ? '' : ' ua-role-opt--locked'}">
      <input type="checkbox" data-role-toggle="${role}" ${on ? 'checked' : ''} ${manageable ? '' : 'disabled'}>
      <span class="ua-role-opt-label">${escapeHtml(roleLabel(role))}</span>
      <span class="ua-role-opt-caps">${roleCapabilities(role).map(c => c.replace('console:', '')).join(' · ')}</span>
    </label>`;
  }).join('');
  return panelSection('Roles',
    `<div class="ua-roles-grid">${checks}</div>`,
    'You can only assign roles whose powers you hold. Granting an admin role requires the user to enroll TOTP before they can elevate.');
}

function panelMfa(u) {
  const enrolled = u.admin_factor_enrolled;
  const pending = isPendingEnrollment(u);
  const unenrolledStatus = pending
    ? '<span class="ua-mfa ua-mfa--pending">&#x26a0; Pending enrollment</span>'
    : '<span class="ua-mfa ua-mfa--off">Not enrolled</span>';
  const status = enrolled
    ? '<span class="ua-mfa ua-mfa--on">&#x2713; Authenticator enrolled</span>'
    : unenrolledStatus;
  // Reset is the industry-standard "require re-registration": disable the
  // current factor so the user must enroll a new one. Only meaningful when a
  // factor exists; only offered to actors holding the security capability.
  const resetAvailable = hasUserRoute('resetTotp');
  const canReset = canResetFactor();
  const resetDisabledAttr = canReset ? '' : ' disabled title="Requires security-admin elevation"';
  const resetRow = enrolled && resetAvailable
    ? `<div class="ua-actions-row">
         <button class="btn btn-ghost session-danger" data-mfa="reset" type="button"${resetDisabledAttr}>Reset authenticator</button>
       </div>`
    : '';
  const unenrolledNote = pending
    ? 'This account holds an admin role but cannot elevate until an authenticator is enrolled. When the user attempts to elevate they are routed into enrollment.'
    : 'Admin elevation requires an enrolled authenticator. Regular (non-admin) accounts do not need one.';
  const note = enrolled
    ? 'Required for admin elevation. Reset forces the user to enroll a new device and ends any active elevation.'
    : unenrolledNote;
  return panelSection('Multi-factor (TOTP)',
    `<div class="ua-mfa-status">${status}</div>${resetRow}`,
    note);
}

function panelSessions(u) {
  if (!hasUserRoute('listSessions')) return '';
  return panelSection('Active sessions',
    `<div id="ua-user-sessions-${escapeHtml(u.user_id)}" class="ua-sessions"><span class="ua-muted">Loading…</span></div>`,
    'Runtime (MCP) sessions for this account, across all their machines.');
}

function panelLifecycle(u) {
  const disabled = !!u.disabled_at;
  const actions = [];
  if (disabled && hasUserRoute('enable')) {
    actions.push('<button class="btn btn-primary" data-lc="enable" type="button">Enable account</button>');
  } else if (!disabled && hasUserRoute('disable')) {
    actions.push('<button class="btn btn-ghost session-danger" data-lc="disable" type="button">Disable account</button>');
  }
  if (hasUserRoute('revokeAllCredentials')) {
    actions.push('<button class="btn btn-ghost session-danger" data-lc="revoke-all" type="button">Revoke all credentials</button>');
  }
  if (hasUserRoute('delete')) {
    actions.push('<button class="btn btn-ghost session-danger" data-lc="delete" type="button">Delete user</button>');
  }
  if (actions.length === 0) return '';
  return panelSection('Account lifecycle',
    `<div class="ua-actions-row">${actions.join('')}</div>`,
    disabled ? 'This account is disabled; the user cannot sign in. Delete removes it permanently.'
             : 'Disable blocks sign-in and ends sessions. Revoke-all ends every session and OAuth grant without disabling. Delete removes the account permanently.');
}

/* ── Actions ────────────────────────────────────────────────────────────── */

function wireRoleToggles(u) {
  host.querySelectorAll('[data-role-toggle]').forEach(input => {
    input.addEventListener('change', async () => {
      const role = input.dataset.roleToggle;
      const grant = input.checked;
      input.disabled = true;
      const verb = grant ? 'grant' : 'revoke';
      const res = await post(`/admin/accounts/users/${encodeURIComponent(u.user_id)}/roles/${verb}`, { body: { role } })
        .catch(() => null);
      if (res && (res.status === 200 || res.status === 204)) {
        const updated = res.body?.roles;
        if (Array.isArray(updated)) u.roles = updated;
        else if (grant) u.roles = [...new Set([...(u.roles || []), role])];
        else u.roles = (u.roles || []).filter(r => r !== role);
        notify(`${grant ? 'Granted' : 'Revoked'} ${roleLabel(role)}.`, 'success');
        renderList();
      } else {
        input.checked = !grant; // revert
        notify(`Could not ${verb} ${roleLabel(role)}.`, 'error');
      }
      input.disabled = false;
    });
  });
}

function wireMfa(u) {
  const root = host.querySelector(DRAWER_ROOT_SELECTOR);
  root.querySelector('[data-mfa="reset"]')?.addEventListener('click', () => resetFactor(u));
}

async function resetFactor(u) {
  const ok = await confirmDialog(
    'Reset this user’s authenticator? Their current device stops working, any active admin elevation ends, and they must enroll a new authenticator before they can elevate again.',
    'Reset authenticator');
  if (!ok) return;
  const res = await post(`/admin/security/users/${encodeURIComponent(u.user_id)}/factors/totp/reset`).catch(() => null);
  if (res?.status !== 200) {
    const denied = res?.status === 401 || res?.status === 403;
    notify(denied ? 'Reset needs security-admin elevation.' : 'Could not reset the authenticator.', 'error');
    return;
  }
  notify(res.body?.factor_disabled
    ? 'Authenticator reset — the user must re-enroll.'
    : 'No active authenticator to reset.', 'info');
  await load();
  renderDrawer();
}

function wireLifecycle(u) {
  const root = host.querySelector(DRAWER_ROOT_SELECTOR);
  root.querySelector('[data-lc="enable"]')?.addEventListener('click', () => lifecycle(u, 'enable'));
  root.querySelector('[data-lc="disable"]')?.addEventListener('click', () => lifecycle(u, 'disable'));
  root.querySelector('[data-lc="revoke-all"]')?.addEventListener('click', () => lifecycle(u, 'revoke-all'));
  root.querySelector('[data-lc="delete"]')?.addEventListener('click', () => deleteUserAccount(u));
}

async function deleteUserAccount(u) {
  const name = u.display_name || u.username;
  const ok = await confirmDialog(
    `Delete ${name}? This removes their logins, authenticators, roles, sessions and grants — the account can never sign in again. Where audit history requires it, a scrubbed, non-identifying record is kept as an audit anchor. This cannot be undone.`,
    'Delete user');
  if (!ok) return;
  const res = await del(`/admin/accounts/users/${encodeURIComponent(u.user_id)}`).catch(() => null);
  if (!res || (res.status !== 200 && res.status !== 202)) {
    const detail = res?.body?.detail
      || (res?.status === 422 ? 'That account can’t be deleted right now.' : 'Could not delete the account.');
    notify(detail, 'error');
    return;
  }
  notify(res.body?.outcome === 'anonymized'
    ? 'Account removed — a scrubbed audit record was retained.'
    : 'Account deleted.', 'success');
  closeDrawer();
  await load();
}

async function lifecycle(u, action) {
  const prompts = {
    disable: ['Disable this account? They\'ll be signed out and blocked from signing in.', 'Disable'],
    enable: ['Re-enable this account so the user can sign in again?', 'Enable'],
    'revoke-all': ['Revoke ALL of this user\'s sessions and OAuth grants? They stay enabled but must reconnect.', 'Revoke all'],
  };
  const [msg, label] = prompts[action];
  if (!(await confirmDialog(msg, label))) return;
  const path = action === 'revoke-all'
    ? `/admin/accounts/users/${encodeURIComponent(u.user_id)}/credentials/revoke-all`
    : `/admin/accounts/users/${encodeURIComponent(u.user_id)}/${action}`;
  const res = await post(path).catch(() => null);
  if (!res || (res.status !== 200 && res.status !== 202 && res.status !== 204)) {
    notify('That action failed. Admin elevation may have lapsed.', 'error');
    return;
  }
  notify(action === 'revoke-all' ? 'Credentials revoked.' : `Account ${action}d.`, 'success');
  await load();
  if (action === 'revoke-all') loadUserSessions(u.user_id); else renderDrawer();
}

function wireIdentity(u) {
  const root = host.querySelector(DRAWER_ROOT_SELECTOR);
  root.querySelector(`[data-link-add="${CSS.escape(u.user_id)}"]`)
    ?.addEventListener('click', () => linkLogin(u.user_id));
}

async function loadUserIdentities(userId) {
  const box = host.querySelector(`#ua-identities-${CSS.escape(userId)}`);
  if (!box) return;
  const res = await get(`/admin/accounts/users/${encodeURIComponent(userId)}/identities`).catch(() => null);
  const identities = res?.status === 200 && Array.isArray(res.body?.identities) ? res.body.identities : [];
  if (!box.isConnected) return;
  if (identities.length === 0) { box.innerHTML = '<span class="ua-muted">No linked logins.</span>'; return; }
  const onlyOne = identities.length <= 1;
  box.innerHTML = identities.map(id => `
    <div class="ua-identity">
      <span class="ua-identity-main">
        <span class="ua-provider-chip">${escapeHtml(id.provider)}</span>
        <span class="ua-identity-sub" title="${escapeHtml(id.sub)}">${escapeHtml(id.external_sub || id.sub)}</span>
        ${id.email ? `<span class="ua-muted">${escapeHtml(id.email)}</span>` : ''}
      </span>
      ${identityUnlinkAction(id.sub, onlyOne)}
    </div>`).join('');
  box.querySelectorAll('[data-unlink-sub]').forEach(b =>
    b.addEventListener('click', () => unlinkLogin(userId, b.dataset.unlinkSub)));
}

function identityUnlinkAction(sub, onlyOne) {
  if (!hasUserRoute('unlinkIdentity')) return '';
  const disabled = onlyOne ? ' disabled title="The only login can’t be unlinked"' : '';
  return `<button class="btn btn-ghost session-danger ua-identity-unlink" data-unlink-sub="${escapeHtml(sub)}" type="button"${disabled}>Unlink</button>`;
}

async function linkLogin(userId) {
  const input = host.querySelector(`#ua-link-sub-${CSS.escape(userId)}`);
  const sub = (input?.value || '').trim();
  if (!sub) { notify('Enter the login subject to link.', 'warn'); return; }
  const res = await post(`/admin/accounts/users/${encodeURIComponent(userId)}/identities/link`, { body: { sub } }).catch(() => null);
  if (res?.status !== 200) {
    notify(res?.body?.detail || 'Could not link that login.', 'error');
    return;
  }
  if (input) input.value = '';
  notify('Login linked.', 'success');
  loadUserIdentities(userId);
  await load();
}

async function unlinkLogin(userId, sub) {
  if (!(await confirmDialog('Unlink this login from the account? The account can no longer be signed into with it.', 'Unlink'))) return;
  const res = await post(`/admin/accounts/users/${encodeURIComponent(userId)}/identities/unlink`, { body: { sub } }).catch(() => null);
  if (res?.status !== 200) {
    notify(res?.body?.detail || 'Could not unlink that login.', 'error');
    return;
  }
  notify('Login unlinked.', 'info');
  loadUserIdentities(userId);
  await load();
}

async function loadUserSessions(userId) {
  const box = host.querySelector(`#ua-user-sessions-${CSS.escape(userId)}`);
  if (!box) return;
  const res = await get(`/admin/accounts/users/${encodeURIComponent(userId)}/sessions`).catch(() => null);
  if (!box.isConnected) return;
  if (res?.status !== 200 || !Array.isArray(res.body?.sessions)) {
    box.innerHTML = '<span class="ua-muted">Couldn\'t load active sessions.</span>';
    return;
  }
  const sessions = res.body.sessions;
  if (sessions.length === 0) { box.innerHTML = '<span class="ua-muted">No active sessions.</span>'; return; }
  box.innerHTML = sessions.map(s => `
    <div class="ua-session">
      <span class="ua-session-id" title="${escapeHtml(s.session_id)}">${escapeHtml(shortId(s.session_id))}</span>
      <span class="ua-muted">active ${escapeHtml(relAgo(s.last_active_at))}</span>
      ${hasUserRoute('disconnectSession') ? `<button class="btn btn-ghost session-danger ua-session-kill" data-kill="${escapeHtml(s.session_id)}" type="button">Disconnect</button>` : ''}
    </div>`).join('');
  box.querySelectorAll('[data-kill]').forEach(b =>
    b.addEventListener('click', () => disconnectUserSession(userId, b.dataset.kill)));
}

async function disconnectUserSession(userId, sessionId) {
  if (!(await confirmDialog('Disconnect this session?', 'Disconnect'))) return;
  const res = await del(`/admin/accounts/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`).catch(() => null);
  if (!res || (res.status !== 202 && res.status !== 200 && res.status !== 204)) {
    notify('Could not disconnect that session.', 'error');
    return;
  }
  notify('Disconnect requested.', 'info');
  setTimeout(() => loadUserSessions(userId), 900);
}

/* ── Invite ─────────────────────────────────────────────────────────────── */

function openInvite() {
  const roleOpts = state.roleCatalog.roles.filter(canManageRole).map(role =>
    `<label class="ua-role-opt"><input type="checkbox" data-invite-role="${role}"><span class="ua-role-opt-label">${escapeHtml(roleLabel(role))}</span></label>`).join('');
  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.id = 'ua-invite-modal';
  modal.innerHTML = `
    <div class="confirm-backdrop"></div>
    <div class="confirm-card ua-invite-card" role="dialog" aria-modal="true" aria-label="Invite user">
      <h3 class="ua-invite-title">Invite a new user</h3>
      <label class="ua-field"><span>Username</span><input id="ua-inv-username" type="text" autocomplete="off" placeholder="alice" maxlength="64"></label>
      <label class="ua-field"><span>Email</span><input id="ua-inv-email" type="email" autocomplete="off" placeholder="alice@example.com"></label>
      <fieldset class="ua-field"><legend>Roles (optional)</legend><div class="ua-roles-grid">${roleOpts || '<span class="ua-muted">No roles you can assign.</span>'}</div></fieldset>
      <div id="ua-inv-result" class="ua-invite-result" hidden></div>
      <div class="confirm-actions">
        <button class="btn btn-ghost" id="ua-inv-cancel" type="button">Cancel</button>
        <button class="btn btn-primary" id="ua-inv-send" type="button">Create invite</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.confirm-backdrop').addEventListener('click', close);
  modal.querySelector('#ua-inv-cancel').addEventListener('click', close);
  modal.querySelector('#ua-inv-send').addEventListener('click', () => submitInvite(modal));
}

async function submitInvite(modal) {
  const username = modal.querySelector('#ua-inv-username').value.trim();
  const email = modal.querySelector('#ua-inv-email').value.trim();
  const roles = [...modal.querySelectorAll('[data-invite-role]:checked')].map(c => c.dataset.inviteRole);
  if (!username || !email) { notify('Username and email are required.', 'warn'); return; }
  const sendBtn = modal.querySelector('#ua-inv-send');
  sendBtn.disabled = true;
  const body = { username, email, ...(roles.length ? { roles } : {}) };
  const res = await post('/admin/accounts/users/invite', { body }).catch(() => null);
  sendBtn.disabled = false;
  if (res?.status !== 201) {
    const detail = res?.body?.detail || (res?.status === 409 ? 'That username or email already exists.' : 'Invite failed.');
    notify(detail, 'error');
    return;
  }
  const result = modal.querySelector('#ua-inv-result');
  const url = res.body?.invite_url || '';
  result.hidden = false;
  result.innerHTML = `
    <p class="ua-invite-ok">Invite created. Send this link to the user (expires ${escapeHtml(relAgo(res.body?.expires_at) === 'unknown' ? '' : 'soon')}):</p>
    <button class="ua-invite-link" id="ua-inv-copy" type="button" title="Click to copy">${escapeHtml(url)}</button>`;
  result.querySelector('#ua-inv-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(url).then(() => notify('Invite link copied.', 'success')).catch(() => {});
  });
  notify('Invite created.', 'success');
  load();
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function shortId(id) {
  return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : (id || '');
}
