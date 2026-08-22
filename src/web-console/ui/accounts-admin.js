/**
 * Account governance beyond the user list: sign-in allowlist, identity triage,
 * and bootstrap status.
 *
 * Two contract details shape this. An allowlist entry's kind and value are fixed
 * once created — only the note can be edited — so editing offers only the note
 * rather than a form that looks fully mutable. And the value the API returns is a
 * display projection, not necessarily what was stored, so it is shown but never
 * fed back into an update.
 */

import { del, get, patch, post } from './api.js';
import { createRequestOwner } from './polling.js';
import { confirmDialog } from './ui-utils.js';
import { createCursorPager, escapeHtml, formatTimestamp, responseDetail } from './operations-ui.js';

const ALLOWLIST_PATH = '/admin/accounts/allowlist';
const UNLINKED_PATH = '/admin/accounts/identities/unlinked';
const BOOTSTRAP_PATH = '/admin/accounts/bootstrap';
const CORRELATION_PATH = '/admin/accounts/correlations';
const PAGE_LIMIT = 50;

/**
 * FormData entries are `string | File`. Casting one with String() would quietly
 * produce "[object File]" instead of failing, so non-string entries read as empty.
 */
function formText(data, name) {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

const ALLOWLIST_KINDS = [
  ['email', 'Email address'],
  ['github_username', 'GitHub username'],
  ['github_id', 'GitHub numeric ID'],
];

export function createAllowlistView({ notify, canAdd, canEdit, canRemove }) {
  let container;
  let entries = [];
  let state = 'idle';
  let message = '';
  let busy = false;
  let editingId = null;
  // Held in state so a reload landing mid-edit restores the draft instead of
  // discarding it, the same reason the add form is never re-rendered.
  let editingNote = '';

  async function load() {
    state = state === 'ready' ? 'ready' : 'loading';
    repaint();
    const response = await get(ALLOWLIST_PATH).catch(() => null);
    if (response?.status !== 200 || !Array.isArray(response.body?.entries)) {
      state = 'error';
      message = responseDetail(response, 'The allowlist could not be loaded.');
      repaint();
      return;
    }
    entries = response.body.entries;
    state = 'ready';
    repaint();
  }

  async function runMutation(label, action) {
    if (busy) return;
    busy = true;
    message = '';
    repaint();
    const response = await action().catch(() => null);
    busy = false;
    if (response && [200, 201, 204].includes(response.status)) {
      notify(`${label} saved.`, 'success');
      await load();
      return;
    }
    message = responseDetail(response, `${label} did not save.`);
    repaint();
  }

  async function add(form) {
    const data = new FormData(form);
    const value = formText(data, 'value');
    if (!value) {
      message = 'Enter the address, username, or ID to allow.';
      repaint();
      return;
    }
    const note = formText(data, 'note');
    await runMutation('Allowlist entry', () => post(ALLOWLIST_PATH, {
      body: { kind: formText(data, 'kind'), value, ...(note ? { note } : {}) },
    }));
  }

  function beginEdit(id) {
    const entry = entries.find(item => item.id === id);
    if (!entry) return;
    editingId = id;
    editingNote = entry.note ?? '';
    repaint();
    container?.querySelector('[data-allow-note-input]')?.focus();
  }

  function cancelEdit() {
    editingId = null;
    editingNote = '';
    repaint();
  }

  async function saveNote(id) {
    const note = editingNote.trim();
    editingId = null;
    editingNote = '';
    // Only the note is mutable server-side, so that is all the request carries.
    await runMutation('Allowlist note', () =>
      patch(`${ALLOWLIST_PATH}/${encodeURIComponent(id)}`, { body: { note: note || null } }));
  }

  async function remove(id) {
    const entry = entries.find(item => item.id === id);
    if (!entry) return;
    const approved = await confirmDialog(
      `Remove ${entry.value} from the allowlist? Anyone relying on this entry will no longer be able to sign in.`,
      'Remove entry',
    );
    if (!approved) return;
    await runMutation('Allowlist removal', () => del(`${ALLOWLIST_PATH}/${encodeURIComponent(id)}`));
  }

  function onClick(event) {
    const button = event.target.closest('button[data-allow-action]');
    if (!button) return;
    const { allowAction: action, allowId: id } = button.dataset;
    if (action === 'refresh') void load();
    if (action === 'edit') beginEdit(id);
    if (action === 'cancel-edit') cancelEdit();
    if (action === 'save-edit') void saveNote(id);
    if (action === 'remove') void remove(id);
  }

  function onInput(event) {
    if (event.target.matches('[data-allow-note-input]')) editingNote = event.target.value;
  }

  function onSubmit(event) {
    if (event.target.id !== 'acct-allow-form') return;
    event.preventDefault();
    void add(event.target);
  }

  /**
   * The add form is rendered once and never replaced by a reload. Re-rendering it
   * would silently discard whatever the operator had already typed whenever a
   * refresh landed, so only the message and list regions are repainted.
   */
  function render() {
    if (!container) return;
    container.innerHTML = `
      <div class="acct-head">
        <p class="acct-sub">Only these identities may sign in. Removing an entry takes effect on the next sign-in attempt.</p>
        <button class="btn btn-ghost" data-allow-action="refresh" type="button">&#x21bb; Refresh</button>
      </div>
      <div data-allow-message></div>
      ${canAdd ? addFormMarkup() : ''}
      <div data-allow-list></div>`;
    renderMessage();
    renderList();
  }

  function renderMessage() {
    const region = container?.querySelector('[data-allow-message]');
    if (region) {
      region.innerHTML = message ? `<div class="acct-notice acct-notice--error">${escapeHtml(message)}</div>` : '';
    }
  }

  function renderList() {
    const region = container?.querySelector('[data-allow-list]');
    if (region) region.innerHTML = listMarkup();
    for (const control of container?.querySelectorAll('[data-allow-action], #acct-allow-form button') ?? []) {
      control.disabled = busy;
    }
  }

  function repaint() {
    renderMessage();
    renderList();
  }

  function listMarkup() {
    if (state === 'idle' || state === 'loading') return '<div class="acct-loading">Loading the allowlist…</div>';
    if (state === 'error') return `<div class="acct-notice acct-notice--error">${escapeHtml(message)}</div>`;
    if (entries.length === 0) {
      return '<div class="acct-empty">The allowlist is empty. Every sign-in will be refused until an entry is added.</div>';
    }
    return `
      <div class="acct-table" role="table">
        <div class="acct-row acct-row--head" role="row">
          <span role="columnheader">Identity</span>
          <span role="columnheader">Kind</span>
          <span role="columnheader">Note</span>
          <span role="columnheader">Added</span>
          <span role="columnheader"><span class="sr-only">Actions</span></span>
        </div>
        ${entries.map(entryRow).join('')}
      </div>`;
  }

  function entryRow(entry) {
    const editing = entry.id === editingId;
    return `
      <div class="acct-row" role="row">
        <span role="cell"><strong>${escapeHtml(entry.value)}</strong></span>
        <span role="cell">${escapeHtml(kindLabel(entry.kind))}</span>
        <span role="cell">${editing ? noteEditorMarkup(editingNote) : noteMarkup(entry.note)}</span>
        <span role="cell">${escapeHtml(formatTimestamp(entry.created_at))}</span>
        <span role="cell" class="acct-row-actions">${rowActions(entry, editing)}</span>
      </div>`;
  }

  function rowActions(entry, editing) {
    if (editing) {
      return allowActionButton('Save', 'save-edit', entry.id, busy)
        + allowActionButton('Cancel', 'cancel-edit', entry.id, busy);
    }
    return (canEdit ? allowActionButton('Note', 'edit', entry.id, busy) : '')
      + (canRemove ? allowActionButton('Remove', 'remove', entry.id, busy, ' acct-danger') : '');
  }

  return Object.freeze({
    mount(panel) {
      container = panel;
      container.addEventListener('click', onClick);
      container.addEventListener('submit', onSubmit);
      container.addEventListener('input', onInput);
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

function noteMarkup(note) {
  return note ? escapeHtml(note) : '—';
}

function noteEditorMarkup(value) {
  return `<input type="text" class="acct-note-input" data-allow-note-input maxlength="500" value="${escapeHtml(value)}" aria-label="Entry note">`;
}

function allowActionButton(label, action, id, busy, extraClass = '') {
  const disabled = busy ? ' disabled' : '';
  return `<button class="btn btn-ghost${extraClass}" data-allow-action="${action}" data-allow-id="${escapeHtml(id)}" type="button"${disabled}>${escapeHtml(label)}</button>`;
}

function addFormMarkup() {
  return `
    <form id="acct-allow-form" class="acct-form">
      <label class="acct-field">
        <span>Kind</span>
        <select name="kind">
          ${ALLOWLIST_KINDS.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}
        </select>
      </label>
      <label class="acct-field">
        <span>Identity</span>
        <input type="text" name="value" placeholder="person@example.com" autocomplete="off">
      </label>
      <label class="acct-field">
        <span>Note (optional)</span>
        <input type="text" name="note" maxlength="500" placeholder="Why this entry exists" autocomplete="off">
      </label>
      <button class="btn btn-primary" type="submit">Add entry</button>
    </form>`;
}

function kindLabel(kind) {
  return ALLOWLIST_KINDS.find(([value]) => value === kind)?.[1] ?? kind;
}

/* ── Identity triage ────────────────────────────────────────────────────── */

export function createIdentityTriageView({ canLookup }) {
  let container;
  let items = [];
  let state = 'idle';
  let message = '';
  let lookup = { state: 'idle', record: null, message: '' };
  const pager = createCursorPager();
  const listOwner = createRequestOwner();
  const lookupOwner = createRequestOwner();

  async function load() {
    const requestClaim = listOwner.claim();
    state = 'loading';
    repaint();
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    const cursor = pager.cursor();
    if (cursor) query.set('cursor', cursor);
    const response = await get(`${UNLINKED_PATH}?${query}`).catch(() => null);
    if (!listOwner.owns(requestClaim)) return;
    if (response?.status !== 200 || !Array.isArray(response.body?.items)) {
      state = 'error';
      message = responseDetail(response, 'Unlinked identities could not be loaded.');
      repaint();
      return;
    }
    items = response.body.items;
    pager.apply(response.body.page);
    state = 'ready';
    repaint();
  }

  async function resolve(form) {
    const id = formText(new FormData(form), 'correlation_id');
    if (!id) return;
    const requestClaim = lookupOwner.claim();
    lookup = { state: 'loading', record: null, message: '' };
    repaint();
    const response = await get(`${CORRELATION_PATH}/${encodeURIComponent(id)}`).catch(() => null);
    if (!lookupOwner.owns(requestClaim)) return;
    if (response?.status === 404) {
      lookup = { state: 'empty', record: null, message: 'No account matches that correlation ID.' };
      repaint();
      return;
    }
    if (response?.status !== 200 || !response.body) {
      lookup = { state: 'error', record: null, message: responseDetail(response, 'That correlation ID could not be resolved.') };
      repaint();
      return;
    }
    lookup = { state: 'ready', record: response.body, message: '' };
    repaint();
  }

  function onSubmit(event) {
    if (event.target.id !== 'acct-correlation-form') return;
    event.preventDefault();
    void resolve(event.target);
  }

  function onClick(event) {
    if (event.target.closest('[data-unlinked-refresh]')) void load();
    if (event.target.closest('[data-unlinked-next]') && pager.moveNext()) void load();
    if (event.target.closest('[data-unlinked-previous]') && pager.movePrevious()) void load();
  }

  /** Same reasoning as the allowlist form: the lookup input outlives a reload. */
  function render() {
    if (!container) return;
    container.innerHTML = `
      ${canLookup ? correlationMarkup() : ''}
      <div class="acct-head">
        <p class="acct-sub">Identities that authenticated but are not linked to any account.</p>
        <button class="btn btn-ghost" data-unlinked-refresh type="button">&#x21bb; Refresh</button>
      </div>
      <div data-unlinked-list></div>
      <div class="acct-pager">
        <button class="btn btn-ghost" data-unlinked-previous type="button"${pager.hasPrevious() ? '' : ' disabled'}>Previous</button>
        <button class="btn btn-ghost" data-unlinked-next type="button"${pager.nextCursor() ? '' : ' disabled'}>Next</button>
      </div>`;
    repaint();
  }

  function repaint() {
    const list = container?.querySelector('[data-unlinked-list]');
    if (list) list.innerHTML = unlinkedMarkup();
    const result = container?.querySelector('[data-correlation-result]');
    if (result) result.innerHTML = correlationResultMarkup(lookup);
    const refresh = container?.querySelector('[data-unlinked-refresh]');
    if (refresh) refresh.disabled = state === 'loading';
    const previous = container?.querySelector('[data-unlinked-previous]');
    if (previous) previous.disabled = state === 'loading' || !pager.hasPrevious();
    const next = container?.querySelector('[data-unlinked-next]');
    if (next) next.disabled = state === 'loading' || !pager.nextCursor();
  }

  function unlinkedMarkup() {
    if (state === 'idle' || state === 'loading') return '<div class="acct-loading">Loading unlinked identities…</div>';
    if (state === 'error') return `<div class="acct-notice acct-notice--error">${escapeHtml(message)}</div>`;
    if (items.length === 0) return '<div class="acct-empty">Every known identity is linked to an account.</div>';
    return `
      <div class="acct-table" role="table">
        <div class="acct-row acct-row--head acct-row--triage" role="row">
          <span role="columnheader">Provider</span>
          <span role="columnheader">Subject</span>
          <span role="columnheader">Seen</span>
        </div>
        ${items.map(identityRow).join('')}
      </div>`;
  }

  return Object.freeze({
    mount(panel) {
      container = panel;
      container.addEventListener('click', onClick);
      container.addEventListener('submit', onSubmit);
      render();
    },
    activate() {
      if (state === 'idle') void load();
    },
    destroy() {
      listOwner.invalidate();
      lookupOwner.invalidate();
      container = null;
    },
  });
}

function identityRow(item) {
  return `
    <div class="acct-row acct-row--triage" role="row">
      <span role="cell">${escapeHtml(item.provider ?? '—')}</span>
      <span role="cell">${escapeHtml(item.subject ?? item.identity_id ?? '—')}</span>
      <span role="cell">${escapeHtml(formatTimestamp(item.last_seen_at ?? item.created_at))}</span>
    </div>`;
}

function correlationMarkup() {
  return `
    <section class="acct-card">
      <h3>Resolve a correlation ID</h3>
      <p class="acct-sub">Audit and approval records identify accounts by correlation ID. Look one up to see which account it belongs to.</p>
      <form id="acct-correlation-form" class="acct-form">
        <label class="acct-field acct-field--wide">
          <span>Correlation ID</span>
          <input type="text" name="correlation_id" placeholder="account correlation ID" autocomplete="off">
        </label>
        <button class="btn btn-primary" type="submit">Resolve</button>
      </form>
      <div data-correlation-result></div>
    </section>`;
}

function correlationResultMarkup(lookup) {
  if (lookup.state === 'idle') return '';
  if (lookup.state === 'loading') return '<div class="acct-loading">Resolving…</div>';
  if (lookup.state === 'empty') return `<div class="acct-notice">${escapeHtml(lookup.message)}</div>`;
  if (lookup.state === 'error') return `<div class="acct-notice acct-notice--error">${escapeHtml(lookup.message)}</div>`;
  return `<dl class="acct-detail">${scalarRows(lookup.record)}</dl>`;
}

/** The server already projects this record; render its scalars rather than guessing a shape. */
function scalarRows(record) {
  return Object.entries(record ?? {})
    .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => `
      <div>
        <dt>${escapeHtml(key.replaceAll('_', ' '))}</dt>
        <dd>${value === null ? '—' : escapeHtml(String(value))}</dd>
      </div>`)
    .join('');
}

/* ── Bootstrap status ───────────────────────────────────────────────────── */

export function createBootstrapView() {
  let container;
  let status = null;
  let state = 'idle';
  let message = '';

  async function load() {
    state = 'loading';
    render();
    const response = await get(BOOTSTRAP_PATH).catch(() => null);
    if (response?.status !== 200 || !response.body) {
      state = 'error';
      message = responseDetail(response, 'Bootstrap status could not be loaded.');
      render();
      return;
    }
    status = response.body;
    state = 'ready';
    render();
  }

  function render() {
    if (!container) return;
    if (state === 'idle' || state === 'loading') {
      container.innerHTML = '<div class="acct-loading">Loading bootstrap status…</div>';
      return;
    }
    if (state === 'error') {
      container.innerHTML = `<div class="acct-notice acct-notice--error">${escapeHtml(message)}</div>`;
      return;
    }
    container.innerHTML = `
      <section class="acct-card">
        <h3>First-administrator bootstrap</h3>
        <p class="acct-sub">${status.completed
          ? 'Bootstrap is complete, so the one-time first-administrator path is closed.'
          : 'Bootstrap has not run. The one-time first-administrator path is still open.'}</p>
        <dl class="acct-detail">${scalarRows(status)}</dl>
      </section>`;
  }

  return Object.freeze({
    mount(panel) {
      container = panel;
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
