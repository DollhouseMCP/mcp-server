/**
 * Capability-gated security administration: signing-key lifecycle and the
 * authentication policy.
 *
 * Reads here sit on the ordinary admin elevation, but every mutation requires a
 * *fresh* one, so an operator can browse this tab and still be refused when they
 * act. That is reported as its own state rather than a generic failure.
 *
 * Key deletion has several distinct server-side refusals — still active, never
 * retired, or still inside the hard-delete grace. The grace window is not
 * recomputed here: the delete is attempted, and only if the server reports the
 * grace conflict is an explicit override offered.
 */

import { del, get, post, put } from './api.js';
import { confirmDialog } from './ui-utils.js';
import { escapeHtml, formatTimestamp, responseDetail } from './operations-ui.js';

const KEYS_PATH = '/admin/security/signing-keys';
const POLICY_PATH = '/admin/security/auth-policy';

let host;
let sections = [];

export function init(panelEl, ctx = {}) {
  host = panelEl;
  const hasRoute = ctx.hasRoute || (() => false);
  const notify = ctx.toast || (() => {});
  sections = sectionDefinitions(hasRoute, notify);
  host.innerHTML = shell(sections);

  if (sections.length === 0) {
    host.querySelector('#secadmin-content').innerHTML =
      '<div class="panel-placeholder">No security administration features are available in this deployment.</div>';
    return;
  }
  host.querySelector('#secadmin-nav').addEventListener('click', onNavClick);
  for (const section of sections) {
    section.view.mount(host.querySelector(`[data-secadmin-panel="${section.id}"]`));
  }
  selectSection(sections[0].id);
}

export function destroy() {
  for (const section of sections) section.view.destroy();
  sections = [];
}

function sectionDefinitions(hasRoute, notify) {
  const definitions = [];
  if (hasRoute('GET', KEYS_PATH)) {
    definitions.push({
      id: 'keys',
      label: 'Signing keys',
      view: createSigningKeysView({
        notify,
        canRotate: hasRoute('POST', `${KEYS_PATH}/:kind/rotate`),
        canRetire: hasRoute('POST', `${KEYS_PATH}/:kind/:kid/retire`),
        canDelete: hasRoute('DELETE', `${KEYS_PATH}/:kind/:kid`),
      }),
    });
  }
  if (hasRoute('GET', POLICY_PATH)) {
    definitions.push({
      id: 'policy',
      label: 'Authentication policy',
      view: createAuthPolicyView({ notify, canEdit: hasRoute('PUT', POLICY_PATH) }),
    });
  }
  return definitions;
}

function shell(definitions) {
  return `
    <div class="secadmin-bar"><span class="secadmin-title">Security</span></div>
    <p class="secadmin-sub">Signing-key lifecycle and authentication policy. Changes here need a recent sign-in and are recorded in the audit log.</p>
    <div class="secadmin-nav" id="secadmin-nav" role="tablist" aria-label="Security views">
      ${definitions.map((definition, index) => `
        <button class="secadmin-nav-item${index === 0 ? ' is-active' : ''}" data-secadmin-nav="${definition.id}" role="tab" aria-selected="${index === 0}" type="button">${escapeHtml(definition.label)}</button>`).join('')}
    </div>
    <div id="secadmin-content">
      ${definitions.map(definition => `<div data-secadmin-panel="${definition.id}" hidden></div>`).join('')}
    </div>`;
}

function onNavClick(event) {
  const button = event.target.closest('[data-secadmin-nav]');
  if (button) selectSection(button.dataset.secadminNav);
}

function selectSection(id) {
  for (const section of sections) {
    const active = section.id === id;
    const button = host.querySelector(`[data-secadmin-nav="${section.id}"]`);
    const panel = host.querySelector(`[data-secadmin-panel="${section.id}"]`);
    button?.classList.toggle('is-active', active);
    button?.setAttribute('aria-selected', String(active));
    if (panel) panel.hidden = !active;
    if (active) section.view.activate();
  }
}

/* ── Signing keys ───────────────────────────────────────────────────────── */

function createSigningKeysView({ notify, canRotate, canRetire, canDelete }) {
  let container;
  let kinds = [];
  let state = 'idle';
  let message = '';
  let receipt = null;
  let actionMessage = '';
  let busy = false;

  async function load() {
    state = state === 'ready' ? 'ready' : 'loading';
    render();
    const response = await get(KEYS_PATH).catch(() => null);
    if (response?.status !== 200 || !Array.isArray(response.body?.kinds)) {
      state = 'error';
      message = elevationHint(response) ?? responseDetail(response, 'Signing keys could not be loaded.');
      render();
      return;
    }
    kinds = response.body.kinds;
    state = 'ready';
    render();
  }

  /**
   * A refused key operation has to stay on screen. The shell already raises its
   * own toast for a step-up refusal, so this neither duplicates that toast nor
   * relies on one: the reason is written into the panel until the next attempt.
   */
  async function runMutation(label, action) {
    if (busy) return;
    busy = true;
    actionMessage = '';
    render();
    const response = await action().catch(() => null);
    busy = false;
    if (response && (response.status === 200 || response.status === 201)) {
      receipt = response.body ?? null;
      actionMessage = '';
      notify(`${label} completed.`, 'success');
      await load();
      return response;
    }
    receipt = null;
    const elevation = elevationHint(response);
    actionMessage = elevation ?? responseDetail(response, `${label} did not complete.`);
    if (!elevation) notify(actionMessage, 'error');
    render();
    return response;
  }

  async function rotate(kind) {
    const approved = await confirmDialog(
      `Rotate the ${kind} signing key? A new key becomes active immediately and the current one moves to verifying, so tokens already issued keep working.`,
      'Rotate key',
    );
    if (!approved) return;
    await runMutation('Key rotation', () => post(`${KEYS_PATH}/${encodeURIComponent(kind)}/rotate`, { body: {} }));
  }

  async function retire(kind, kid) {
    const approved = await confirmDialog(
      `Retire key ${kid}? It stops verifying tokens. It can be deleted once its hard-delete grace has passed.`,
      'Retire key',
    );
    if (!approved) return;
    await runMutation('Key retirement', () =>
      post(`${KEYS_PATH}/${encodeURIComponent(kind)}/${encodeURIComponent(kid)}/retire`, { body: {} }));
  }

  /**
   * Deletion is attempted without force first. The server owns the grace window,
   * so an override is only offered once it has actually refused on that basis —
   * never pre-emptively from a clock in the browser.
   */
  async function remove(kind, kid) {
    const approved = await confirmDialog(
      `Permanently delete key ${kid}? This cannot be undone, and only the audit record of the key will remain.`,
      'Delete key',
    );
    if (!approved) return;
    const path = `${KEYS_PATH}/${encodeURIComponent(kind)}/${encodeURIComponent(kid)}`;
    const response = await runMutation('Key deletion', () => del(path, { body: {} }));
    if (response?.status !== 409 || !isGraceConflict(response)) return;

    const forced = await confirmDialog(
      `Key ${kid} is still inside its hard-delete grace, which exists so anything signed by it can still be verified. Deleting now can break verification for those tokens. Delete it anyway?`,
      'Delete during grace',
    );
    if (!forced) return;
    await runMutation('Forced key deletion', () => del(path, { body: { force: true } }));
  }

  function onClick(event) {
    const button = event.target.closest('button[data-key-action]');
    if (!button) return;
    const { keyAction: action, keyKind: kind, keyKid: kid } = button.dataset;
    if (action === 'rotate') void rotate(kind);
    if (action === 'retire') void retire(kind, kid);
    if (action === 'delete') void remove(kind, kid);
    if (action === 'refresh') void load();
  }

  function render() {
    if (!container) return;
    container.innerHTML = `
      <div class="secadmin-head">
        <button class="btn btn-ghost" data-key-action="refresh" type="button"${busy ? ' disabled' : ''}>&#x21bb; Refresh</button>
      </div>
      ${actionMessage ? `<div class="secadmin-notice secadmin-notice--error">${escapeHtml(actionMessage)}</div>` : ''}
      ${receiptMarkup(receipt)}
      ${bodyMarkup()}`;
  }

  function bodyMarkup() {
    if (state === 'loading' || state === 'idle') return '<div class="secadmin-loading">Loading signing keys…</div>';
    if (state === 'error') return `<div class="secadmin-notice secadmin-notice--error">${escapeHtml(message)}</div>`;
    if (kinds.length === 0) return '<div class="secadmin-empty">No signing keys are configured.</div>';
    return kinds.map(kindCard).join('');
  }

  function kindCard(entry) {
    return `
      <section class="secadmin-card">
        <div class="secadmin-card-head">
          <div>
            <h3>${escapeHtml(entry.kind)}</h3>
            <span class="secadmin-card-sub">Active key: ${entry.active_kid ? escapeHtml(entry.active_kid) : 'none'}</span>
          </div>
          ${canRotate ? keyActionButton({ label: 'Rotate', action: 'rotate', kind: entry.kind, variant: 'btn-primary', disabled: busy }) : ''}
        </div>
        ${(entry.keys ?? []).length === 0
          ? '<p class="secadmin-empty">No keys recorded for this kind.</p>'
          : `<div class="secadmin-key-list">${entry.keys.map(key => keyRow(entry.kind, key)).join('')}</div>`}
      </section>`;
  }

  function keyRow(kind, key) {
    const retired = key.state === 'retired';
    return `
      <div class="secadmin-key">
        <div class="secadmin-key-id">
          <strong>${escapeHtml(key.kid)}</strong>
          <span class="secadmin-chip secadmin-chip--${cssToken(key.state)}">${escapeHtml(key.state)}</span>
        </div>
        <dl class="secadmin-key-meta">
          <div><dt>Created</dt><dd>${escapeHtml(formatTimestamp(key.created_at))}</dd></div>
          ${key.retired_at ? `<div><dt>Retired</dt><dd>${escapeHtml(formatTimestamp(key.retired_at))}</dd></div>` : ''}
          ${key.verification_grace_ends_at ? `<div><dt>Verifies until</dt><dd>${escapeHtml(formatTimestamp(key.verification_grace_ends_at))}</dd></div>` : ''}
        </dl>
        <div class="secadmin-key-actions">
          ${canRetire && key.state !== 'retired' && key.state !== 'deleted'
            ? keyActionButton({ label: 'Retire', action: 'retire', kind, kid: key.kid, disabled: busy })
            : ''}
          ${canDelete && retired
            ? keyActionButton({ label: 'Delete', action: 'delete', kind, kid: key.kid, extraClass: ' secadmin-danger', disabled: busy })
            : ''}
        </div>
      </div>`;
  }

  return Object.freeze({
    mount(panel) {
      container = panel;
      container.addEventListener('click', onClick);
      render();
    },
    activate() {
      if (state === 'idle') void load();
    },
    destroy() {
      container = null;
    },
  });
}

function keyActionButton({ label, action, kind, kid = null, variant = 'btn-ghost', extraClass = '', disabled }) {
  const kidAttr = kid === null ? '' : ` data-key-kid="${escapeHtml(kid)}"`;
  const disabledAttr = disabled ? ' disabled' : '';
  return `<button class="btn ${variant}${extraClass}" data-key-action="${action}" data-key-kind="${escapeHtml(kind)}"${kidAttr} type="button"${disabledAttr}>${escapeHtml(label)}</button>`;
}

/** These operations are synchronous, so the receipt is the outcome, not a job to poll. */
function receiptMarkup(receipt) {
  if (!receipt) return '';
  const failed = receipt.status === 'failed';
  return `
    <div class="secadmin-receipt${failed ? ' secadmin-receipt--failed' : ''}">
      <strong>${escapeHtml(receipt.action)} ${escapeHtml(receipt.status)}</strong>
      <span>${escapeHtml(formatTimestamp(receipt.completed_at))}</span>
      ${receipt.result_kid ? `<span>New key: ${escapeHtml(receipt.result_kid)}</span>` : ''}
      ${receipt.target_kid ? `<span>Key: ${escapeHtml(receipt.target_kid)}</span>` : ''}
      ${receipt.error_code ? `<span>${escapeHtml(receipt.error_code)}</span>` : ''}
    </div>`;
}

/** Reduce a server-supplied value to something safe to use as a class suffix. */
function cssToken(value) {
  return String(value ?? '').replaceAll(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
}

/**
 * The three delete refusals — still active, never retired, still inside the
 * grace — all return the same `conflict` code, so the message is the only thing
 * distinguishing them. Only the grace case can be forced, and offering the
 * override for the other two would be a dead end, so they have to be told apart.
 * A distinct server-side code would make this robust.
 */
function isGraceConflict(response) {
  return /grace/i.test(String(response?.body?.detail ?? ''));
}

/* ── Authentication policy ──────────────────────────────────────────────── */

const INVARIANT_LABELS = [
  ['require_admin_totp', 'Administrators must complete TOTP'],
  ['csrf_protection', 'CSRF protection'],
  ['bff_session_security', 'BFF session security'],
  ['step_up_required', 'Step-up required for admin actions'],
  ['privacy_boundaries_enforced', 'Privacy boundaries enforced'],
];

/**
 * An unmodified policy carries the epoch as its updated_at. Formatting that
 * literally reads as a 1969 edit, so say plainly that it has never changed.
 */
function policyUpdatedText(updatedAt) {
  const time = new Date(updatedAt ?? '').getTime();
  if (!Number.isFinite(time) || time <= 0) return 'Never changed from the deployment default.';
  return `Updated ${formatTimestamp(updatedAt)}`;
}

function saveButtonMarkup(saving) {
  if (saving) return '<button class="btn btn-primary" type="submit" disabled>Saving…</button>';
  return '<button class="btn btn-primary" type="submit">Save</button>';
}

function createAuthPolicyView({ notify, canEdit }) {
  let container;
  let policy = null;
  let state = 'idle';
  let message = '';
  let saving = false;

  async function load() {
    state = 'loading';
    render();
    const response = await get(POLICY_PATH).catch(() => null);
    if (response?.status !== 200 || !response.body) {
      state = 'error';
      message = elevationHint(response) ?? responseDetail(response, 'The authentication policy could not be loaded.');
      render();
      return;
    }
    policy = response.body;
    state = 'ready';
    render();
  }

  async function save(form) {
    if (saving || !policy) return;
    const seconds = Number(new FormData(form).get('max_admin_elevation_seconds'));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      message = 'Enter the maximum elevation length in whole seconds.';
      render();
      return;
    }
    saving = true;
    message = '';
    render();
    const response = await put(POLICY_PATH, {
      body: { max_admin_elevation_seconds: seconds },
      ifMatch: policy.etag,
    }).catch(() => null);
    saving = false;

    if (response?.status === 412) {
      message = 'The policy changed elsewhere, so nothing was saved. Reload it and try again.';
      render();
      return;
    }
    if (response?.status !== 200 || !response.body) {
      message = elevationHint(response) ?? responseDetail(response, 'The policy could not be saved.');
      render();
      return;
    }
    policy = response.body;
    notify('Authentication policy updated.', 'success');
    render();
  }

  function onSubmit(event) {
    if (event.target.id !== 'secadmin-policy-form') return;
    event.preventDefault();
    void save(event.target);
  }

  function onClick(event) {
    if (event.target.closest('[data-policy-reload]')) void load();
  }

  function render() {
    if (!container) return;
    if (state === 'loading' || state === 'idle') {
      container.innerHTML = '<div class="secadmin-loading">Loading the authentication policy…</div>';
      return;
    }
    if (state === 'error') {
      container.innerHTML = `
        <div class="secadmin-notice secadmin-notice--error">${escapeHtml(message)}</div>
        <button class="btn btn-ghost" data-policy-reload type="button">Try again</button>`;
      return;
    }
    container.innerHTML = `
      <section class="secadmin-card">
        <h3>Enforced protections</h3>
        <p class="secadmin-card-sub">These are built into the console and cannot be turned off.</p>
        <ul class="secadmin-invariants">
          ${INVARIANT_LABELS.map(([key, label]) => `
            <li><span class="secadmin-chip secadmin-chip--active">on</span>${escapeHtml(label)}${policy[key] === true ? '' : ' (reported off)'}</li>`).join('')}
        </ul>
      </section>
      <section class="secadmin-card">
        <h3>Administrator elevation</h3>
        <form id="secadmin-policy-form" class="secadmin-policy-form">
          <label class="secadmin-field">
            <span>Maximum elevation length (seconds)</span>
            <input type="number" name="max_admin_elevation_seconds" min="1" step="1" value="${escapeHtml(policy.max_admin_elevation_seconds)}"${canEdit ? '' : ' disabled'}>
            <small>How long an administrator stays elevated before signing in again.</small>
          </label>
          ${message ? `<div class="secadmin-notice secadmin-notice--error">${escapeHtml(message)}</div>` : ''}
          <div class="secadmin-form-actions">
            <span class="secadmin-card-sub">${escapeHtml(policyUpdatedText(policy.updated_at))}</span>
            ${canEdit ? saveButtonMarkup(saving) : '<span class="secadmin-card-sub">Not editable in this deployment.</span>'}
          </div>
        </form>
      </section>`;
  }

  return Object.freeze({
    mount(panel) {
      container = panel;
      container.addEventListener('submit', onSubmit);
      container.addEventListener('click', onClick);
      render();
    },
    activate() {
      if (state === 'idle') void load();
    },
    destroy() {
      container = null;
    },
  });
}

/**
 * Mutations here need a fresher elevation than the reads that got the operator
 * into this tab, so a refusal is expected rather than exceptional.
 */
function elevationHint(response) {
  const code = response?.body?.code ?? response?.body?.type;
  if (response?.status === 401 && typeof code === 'string' && code.includes('step_up')) {
    return 'This change needs a more recent sign-in. Confirm your identity, then try again.';
  }
  return null;
}
