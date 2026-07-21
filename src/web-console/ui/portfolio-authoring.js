/** Portfolio create/edit/delete and GitHub sync controls. */

import { del, get, patch, post } from './api.js';

const TYPES = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
const TERMINAL_SYNC_STATES = new Set(['succeeded', 'failed']);
const SYNC_POLL_INTERVAL_MS = 1_000;
const SYNC_POLL_LIMIT = 60;

export function createPortfolioAuthoring({ hasRoute, notify, refresh }) {
  const capabilities = Object.freeze({
    create: hasRoute('POST', '/me/portfolio/elements/:type'),
    edit: hasRoute('PATCH', '/me/portfolio/elements/:type/:name'),
    delete: hasRoute('DELETE', '/me/portfolio/elements/:type/:name'),
    validate: hasRoute('POST', '/me/portfolio/elements/:type/:name/validate'),
    render: hasRoute('POST', '/me/portfolio/elements/:type/:name/render'),
    sync: hasRoute('POST', '/me/portfolio/sync') && hasRoute('GET', '/me/portfolio/sync/:job_id'),
  });

  return Object.freeze({
    capabilities,
    openCreate: () => openEditor({ mode: 'create', capabilities, notify, refresh }),
    openEdit: element => openEditor({ mode: 'edit', element, capabilities, notify, refresh }),
    deleteElement: element => deleteElement(element, { notify, refresh }),
    openSync: () => openSync({ notify, refresh }),
  });
}

async function openEditor(context) {
  const previousFocus = document.activeElement;
  const dialog = editorDialog(context);
  document.body.appendChild(dialog);
  document.body.classList.add('modal-open');
  dialog.showModal();
  focusElement(dialog.querySelector('[name="type"]'));

  const close = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
    document.body.classList.remove('modal-open');
    restoreFocus(previousFocus);
  };
  dialog.querySelector('[data-editor-close]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });

  const form = dialog.querySelector('form');
  form.addEventListener('submit', event => {
    event.preventDefault();
    saveEditor(form, dialog, context, close);
  });
  dialog.querySelector('[data-editor-validate]')?.addEventListener('click', () => validateEditor(form, dialog));
  dialog.querySelector('[data-editor-render]')?.addEventListener('click', () => renderEditor(form, dialog));
  dialog.querySelector('[data-editor-reload]')?.addEventListener('click', () => reloadEditor(form, dialog, context));
}

function editorDialog({ mode, element, capabilities }) {
  const isEdit = mode === 'edit';
  const dialog = document.createElement('dialog');
  dialog.className = 'portfolio-editor';
  dialog.setAttribute('aria-labelledby', 'portfolio-editor-title');
  dialog.innerHTML = `
    <form method="dialog" class="portfolio-editor-card" novalidate>
      <header class="portfolio-editor-head">
        <div>
          <h2 id="portfolio-editor-title">${isEdit ? 'Edit element' : 'Create element'}</h2>
          <p>${isEdit ? 'Changes use the element ETag, so a newer version cannot be overwritten.' : 'Create a validated element in your portfolio.'}</p>
        </div>
        <button class="security-close" data-editor-close type="button" aria-label="Close">&#x2715;</button>
      </header>
      <div class="portfolio-editor-body">
        <div class="portfolio-form-grid">
          <label class="portfolio-field"><span>Type</span>
            <select name="type" ${isEdit ? 'disabled' : ''}>${typeOptions(element?.type)}</select>
          </label>
          <label class="portfolio-field"><span>Name</span>
            <input name="name" required maxlength="200" value="${escapeAttr(element?.name ?? '')}" ${isEdit ? 'readonly' : ''}>
          </label>
          <label class="portfolio-field portfolio-field--wide"><span>Tags <small>(comma separated)</small></span>
            <input name="tags" value="${escapeAttr((element?.tags ?? []).join(', '))}">
          </label>
          <label class="portfolio-field portfolio-field--wide"><span>Metadata <small>(JSON object)</small></span>
            <textarea name="metadata" rows="7" spellcheck="false">${escapeHtml(JSON.stringify(element?.metadata ?? {}, null, 2))}</textarea>
          </label>
          <label class="portfolio-field portfolio-field--wide"><span>Content</span>
            <textarea name="content" rows="14" required spellcheck="false">${escapeHtml(element?.content ?? '')}</textarea>
          </label>
        </div>
        <div class="portfolio-editor-feedback" data-editor-feedback aria-live="polite"></div>
        <section class="portfolio-preview" data-editor-preview hidden aria-label="Rendered preview"></section>
      </div>
      <footer class="portfolio-editor-actions">
        ${capabilities.validate ? '<button class="btn btn-ghost" data-editor-validate type="button">Validate</button>' : ''}
        ${isEdit && capabilities.render ? '<button class="btn btn-ghost" data-editor-render type="button">Preview</button>' : ''}
        <button class="btn btn-ghost" data-editor-reload type="button" hidden>Reload latest</button>
        <span class="portfolio-editor-spacer"></span>
        <button class="btn btn-ghost" data-editor-close type="button">Cancel</button>
        <button class="btn btn-primary" type="submit">${isEdit ? 'Save changes' : 'Create element'}</button>
      </footer>
    </form>`;
  return dialog;
}

function typeOptions(selected) {
  return TYPES.map(type => `<option value="${type}"${type === selected ? ' selected' : ''}>${capitalize(type)}</option>`).join('');
}

function editorPayload(form, includeName) {
  const metadataText = form.elements.metadata.value.trim();
  let metadata;
  try {
    metadata = metadataText ? JSON.parse(metadataText) : {};
  } catch {
    return { problem: 'Metadata must be valid JSON.' };
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { problem: 'Metadata must be a JSON object.' };
  }
  const payload = {
    tags: form.elements.tags.value.split(',').map(tag => tag.trim()).filter(Boolean),
    metadata,
    content: form.elements.content.value,
  };
  if (includeName) payload.name = form.elements.name.value.trim();
  return { payload };
}

function editorPath(form, suffix = '') {
  const type = encodeURIComponent(form.elements.type.value);
  const name = encodeURIComponent(form.elements.name.value.trim());
  return `/me/portfolio/elements/${type}/${name}${suffix}`;
}

async function validateEditor(form, dialog) {
  if (!form.elements.name.value.trim()) {
    showEditorMessage(dialog, 'Name is required.', 'error');
    return false;
  }
  const parsed = editorPayload(form, false);
  if (parsed.problem) return showEditorMessage(dialog, parsed.problem, 'error');
  setEditorBusy(dialog, true);
  try {
    const response = await post(editorPath(form, '/validate'), { body: parsed.payload });
    showValidation(dialog, response);
    return response.status === 200 && response.body?.valid === true;
  } catch {
    showEditorMessage(dialog, 'Validation could not reach the server.', 'error');
    return false;
  } finally {
    setEditorBusy(dialog, false);
  }
}

function showValidation(dialog, response) {
  if (response.status !== 200) {
    showEditorMessage(dialog, responseDetail(response, 'Validation failed.'), 'error');
    return;
  }
  const issues = Array.isArray(response.body?.issues) ? response.body.issues : [];
  if (response.body?.valid) {
    showEditorMessage(dialog, 'Validation passed.', 'success');
    return;
  }
  const list = issues.map(issue => `<li><strong>${escapeHtml(issue.path || 'element')}</strong>: ${escapeHtml(issue.message || issue.code || 'Invalid value')}</li>`).join('');
  dialog.querySelector('[data-editor-feedback]').innerHTML = `<div class="portfolio-message portfolio-message--error"><p>Fix these validation issues:</p><ul>${list}</ul></div>`;
}

async function renderEditor(form, dialog) {
  const parsed = editorPayload(form, false);
  if (parsed.problem) return showEditorMessage(dialog, parsed.problem, 'error');
  setEditorBusy(dialog, true);
  try {
    const response = await post(editorPath(form, '/render'), { body: parsed.payload });
    if (response.status !== 200 || typeof response.body?.preview !== 'string') {
      showEditorMessage(dialog, responseDetail(response, 'Preview failed.'), 'error');
      return;
    }
    const preview = dialog.querySelector('[data-editor-preview]');
    preview.hidden = false;
    preview.innerHTML = `<h3>Server preview</h3><pre>${escapeHtml(response.body.preview)}</pre>`;
    showEditorMessage(dialog, 'Preview refreshed from the server.', 'success');
  } catch {
    showEditorMessage(dialog, 'Preview could not reach the server.', 'error');
  } finally {
    setEditorBusy(dialog, false);
  }
}

async function saveEditor(form, dialog, context, close) {
  const includeName = context.mode === 'create';
  const parsed = editorPayload(form, includeName);
  if (parsed.problem) return showEditorMessage(dialog, parsed.problem, 'error');
  if (!form.elements.name.value.trim()) return showEditorMessage(dialog, 'Name is required.', 'error');
  setEditorBusy(dialog, true);
  try {
    if (context.capabilities.validate) {
      const valid = await validateDraft(form, dialog, parsed.payload);
      if (!valid) return;
    }
    const response = includeName
      ? await post(`/me/portfolio/elements/${encodeURIComponent(form.elements.type.value)}`, { body: parsed.payload })
      : await patch(editorPath(form), { body: parsed.payload, ifMatch: context.element?._etag });
    if (response.status === 412) {
      showConflict(dialog);
      return;
    }
    const expectedStatus = includeName ? 201 : 200;
    if (response.status !== expectedStatus) {
      showEditorMessage(dialog, responseDetail(response, 'The element could not be saved.'), 'error');
      return;
    }
    context.notify(`${includeName ? 'Created' : 'Updated'} “${response.body?.display_name || response.body?.name || 'element'}”.`, 'success');
    await context.refresh();
    close();
  } catch {
    showEditorMessage(dialog, 'The element could not be saved because the server is unreachable.', 'error');
  } finally {
    setEditorBusy(dialog, false);
  }
}

async function validateDraft(form, dialog, payload) {
  const response = await post(editorPath(form, '/validate'), { body: payload });
  showValidation(dialog, response);
  return response.status === 200 && response.body?.valid === true;
}

function showConflict(dialog) {
  showEditorMessage(dialog, 'This element changed after you opened it. Your draft was not saved. Review or copy it, then reload the latest version before editing again.', 'error');
  dialog.querySelector('[data-editor-reload]').hidden = false;
}

async function reloadEditor(form, dialog, context) {
  setEditorBusy(dialog, true);
  try {
    const response = await get(editorPath(form));
    if (response.status !== 200 || !response.body) {
      showEditorMessage(dialog, responseDetail(response, 'The latest version could not be loaded.'), 'error');
      return;
    }
    if (typeof response.etag !== 'string' || !response.etag) {
      showEditorMessage(dialog, 'The latest version did not include an ETag, so editing remains blocked.', 'error');
      return;
    }
    context.element = { ...response.body, _etag: response.etag };
    form.elements.tags.value = Array.isArray(response.body.tags) ? response.body.tags.join(', ') : '';
    form.elements.metadata.value = JSON.stringify(response.body.metadata ?? {}, null, 2);
    form.elements.content.value = typeof response.body.content === 'string' ? response.body.content : '';
    dialog.querySelector('[data-editor-reload]').hidden = true;
    showEditorMessage(dialog, 'Latest version loaded. The previous draft was replaced only after your confirmation.', 'success');
  } finally {
    setEditorBusy(dialog, false);
  }
}

async function deleteElement(element, { notify, refresh }) {
  const confirmed = await confirmDelete(element);
  if (!confirmed) return;
  try {
    const response = await del(elementPath(element), { ifMatch: element._etag });
    if (response.status === 412) {
      notify('Delete stopped because this element changed. Reload it and review the latest version first.', 'warn');
      await refresh();
      return;
    }
    if (response.status !== 200) {
      notify(responseDetail(response, 'The element could not be deleted.'), 'error');
      return;
    }
    notify(`Deleted “${element.display_name || element.name}” permanently.`, 'success');
    await refresh();
  } catch {
    notify('The element could not be deleted because the server is unreachable.', 'error');
  }
}

function confirmDelete(element) {
  const name = element.display_name || element.name;
  return confirmDialog(`Permanently delete “${name}”? This cannot be undone.`, 'Delete permanently');
}

async function openSync({ notify, refresh }) {
  const previousFocus = document.activeElement;
  const dialog = syncDialog();
  const controller = new AbortController();
  document.body.appendChild(dialog);
  document.body.classList.add('modal-open');
  dialog.showModal();
  focusElement(dialog.querySelector('[name="direction"]'));
  const close = () => {
    controller.abort();
    if (dialog.open) dialog.close();
    dialog.remove();
    document.body.classList.remove('modal-open');
    restoreFocus(previousFocus);
  };
  dialog.querySelectorAll('[data-sync-close]').forEach(button => button.addEventListener('click', close));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    startSync(dialog, { notify, refresh, signal: controller.signal });
  });
}

function syncDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'portfolio-sync';
  dialog.setAttribute('aria-labelledby', 'portfolio-sync-title');
  dialog.innerHTML = `
    <form method="dialog" class="portfolio-sync-card">
      <header class="portfolio-editor-head">
        <div><h2 id="portfolio-sync-title">Sync portfolio with GitHub</h2><p>Choose the direction and how conflicts should be handled.</p></div>
        <button class="security-close" data-sync-close type="button" aria-label="Close">&#x2715;</button>
      </header>
      <div class="portfolio-editor-body portfolio-sync-fields">
        <label class="portfolio-field"><span>Direction</span><select name="direction">
          <option value="pull">Pull from GitHub</option><option value="push">Push to GitHub</option><option value="bidirectional">Bidirectional</option>
        </select></label>
        <label class="portfolio-field"><span>Conflict policy</span><select name="conflict_policy">
          <option value="fail">Stop on conflict</option><option value="prefer_local">Prefer local</option><option value="prefer_remote">Prefer GitHub</option>
        </select></label>
        <div class="portfolio-sync-status" data-sync-status aria-live="polite">Ready to start.</div>
      </div>
      <footer class="portfolio-editor-actions"><button class="btn btn-ghost" data-sync-close type="button">Close</button><button class="btn btn-primary" type="submit">Start sync</button></footer>
    </form>`;
  return dialog;
}

async function startSync(dialog, context) {
  const form = dialog.querySelector('form');
  setSyncBusy(dialog, true);
  try {
    const response = await post('/me/portfolio/sync', { body: {
      provider: 'github',
      direction: form.elements.direction.value,
      conflict_policy: form.elements.conflict_policy.value,
    }, signal: context.signal });
    if (response.status !== 202 || !response.body?.job_id) {
      renderSyncStatus(dialog, response.body, responseDetail(response, 'Sync could not start.'));
      setSyncBusy(dialog, false);
      return;
    }
    renderSyncStatus(dialog, response.body, 'Sync queued.');
    const result = await pollSync(dialog, response.body.job_id, context.signal);
    if (result?.status === 'succeeded') {
      context.notify('Portfolio sync completed.', 'success');
      await context.refresh();
    } else if (result?.status === 'failed') {
      const errorSuffix = result.error_code ? ` (${result.error_code})` : '';
      context.notify(`Portfolio sync failed${errorSuffix}.`, 'error');
    }
  } catch (error) {
    if (error?.name !== 'AbortError') renderSyncStatus(dialog, null, 'Sync status could not reach the server.');
  } finally {
    setSyncBusy(dialog, false);
  }
}

async function pollSync(dialog, jobId, signal) {
  for (let attempt = 0; attempt < SYNC_POLL_LIMIT; attempt += 1) {
    await delay(SYNC_POLL_INTERVAL_MS, signal);
    const response = await get(`/me/portfolio/sync/${encodeURIComponent(jobId)}`, { signal });
    if (response.status !== 200 || !response.body) {
      renderSyncStatus(dialog, null, responseDetail(response, 'Could not read sync status.'));
      return null;
    }
    renderSyncStatus(dialog, response.body);
    if (TERMINAL_SYNC_STATES.has(response.body.status)) return response.body;
  }
  renderSyncStatus(dialog, null, 'Sync is still running. Close this dialog and check again later.');
  return null;
}

function renderSyncStatus(dialog, job, fallback) {
  const status = dialog.querySelector('[data-sync-status]');
  if (!job) {
    status.innerHTML = `<p class="portfolio-message portfolio-message--error">${escapeHtml(fallback)}</p>`;
    return;
  }
  const summary = job.result_summary ? `<pre>${escapeHtml(JSON.stringify(job.result_summary, null, 2))}</pre>` : '';
  const error = job.error_code ? `<p>Error: <code>${escapeHtml(job.error_code)}</code></p>` : '';
  status.innerHTML = `<p><strong>${escapeHtml(capitalize(job.status || fallback || 'updated'))}</strong> · ${escapeHtml(job.direction || '')} · ${escapeHtml(job.conflict_policy || '')}</p>${error}${summary}`;
}

function setEditorBusy(dialog, busy) {
  dialog.querySelectorAll('button').forEach(button => { button.disabled = busy; });
}

function setSyncBusy(dialog, busy) {
  dialog.querySelectorAll('select, button[type="submit"]').forEach(control => { control.disabled = busy; });
}

function showEditorMessage(dialog, message, kind) {
  dialog.querySelector('[data-editor-feedback]').innerHTML = `<p class="portfolio-message portfolio-message--${kind}">${escapeHtml(message)}</p>`;
}

function responseDetail(response, fallback) {
  return typeof response.body?.detail === 'string' ? response.body.detail : fallback;
}

function elementPath(element) {
  return `/me/portfolio/elements/${encodeURIComponent(element.type)}/${encodeURIComponent(element.name)}`;
}

function confirmDialog(message, confirmLabel) {
  return new Promise(resolve => {
    document.getElementById('portfolio-confirm')?.remove();
    const previousFocus = document.activeElement;
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.id = 'portfolio-confirm';
    modal.innerHTML = `<div class="confirm-backdrop"></div><div class="confirm-card" role="dialog" aria-modal="true" aria-label="Confirm deletion"><p class="confirm-msg">${escapeHtml(message)}</p><div class="confirm-actions"><button class="btn btn-ghost" data-confirm="0" type="button">Cancel</button><button class="btn btn-primary portfolio-danger" data-confirm="1" type="button">${escapeHtml(confirmLabel)}</button></div></div>`;
    document.body.appendChild(modal);
    const buttons = [...modal.querySelectorAll('button')];
    const done = value => {
      modal.remove();
      document.removeEventListener('keydown', onKey);
      restoreFocus(previousFocus);
      resolve(value);
    };
    const onKey = event => {
      if (event.key === 'Escape') done(false);
      if (event.key !== 'Tab') return;
      event.preventDefault();
      const active = document.activeElement;
      const current = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
      const offset = event.shiftKey ? -1 : 1;
      buttons[(current + offset + buttons.length) % buttons.length].focus();
    };
    modal.querySelector('.confirm-backdrop').addEventListener('click', () => done(false));
    modal.querySelector('[data-confirm="0"]').addEventListener('click', () => done(false));
    modal.querySelector('[data-confirm="1"]').addEventListener('click', () => done(true));
    document.addEventListener('keydown', onKey);
    buttons[1].focus();
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal.removeEventListener('abort', aborted);
      resolve();
    };
    const aborted = () => {
      globalThis.clearTimeout(timer);
      const error = new Error('Sync polling aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = globalThis.setTimeout(done, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function restoreFocus(element) {
  if (element instanceof HTMLElement && element.isConnected) element.focus();
}

function focusElement(element) {
  if (element instanceof HTMLElement) element.focus();
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}
