/** Definition-driven operator configuration editor. */

import { get, put } from './api.js';
import { isAbortError } from './polling.js';
import { escapeAttr, escapeHtml, responseDetail } from './operations-ui.js';

export function createOperatorConfigView(ctx = {}) {
  let container;
  let items = [];
  let requestController;
  let requestVersion = 0;

  return Object.freeze({
    mount(panel) {
      container = panel;
      container.innerHTML = '<div class="operations-state">Loading operator configuration…</div>';
      container.addEventListener('submit', onSubmit);
      container.addEventListener('click', onClick);
    },
    async load(signal) {
      const version = ++requestVersion;
      const response = await get('/admin/operate/config', { signal });
      if (version !== requestVersion) return;
      if (response.status !== 200 || !Array.isArray(response.body?.items)) {
        showLoadProblem(responseDetail(response, 'Operator configuration could not be loaded.'));
        return;
      }
      items = response.body.items;
      render();
    },
    showError(message) {
      const grid = container?.querySelector('.operations-config-grid');
      if (!grid) {
        renderState(message, 'warn');
        return;
      }
      container.querySelector('[data-config-refresh-warning]')?.remove();
      grid.insertAdjacentHTML(
        'beforebegin',
        `<p class="operations-inline-message operations-inline-message--warn" data-config-refresh-warning>${escapeHtml(message)}</p>`,
      );
    },
    setVisible(nextVisible) {
      if (!nextVisible) abortRequest();
    },
  });

  async function onSubmit(event) {
    const form = event.target.closest('[data-config-form]');
    if (!form) return;
    event.preventDefault();
    const key = form.dataset.configForm;
    const item = items.find(candidate => candidate.key === key);
    if (!item) return;
    const parsed = readValue(form, item);
    if (parsed.problem) {
      showFormMessage(form, parsed.problem, 'error');
      return;
    }
    if (!item.etag) {
      showFormMessage(form, 'This setting has no ETag, so editing remains blocked.', 'error');
      return;
    }
    setBusy(form, true);
    try {
      const response = await put(`/admin/operate/config/${encodeURIComponent(key)}`, {
        body: { value: parsed.value },
        ifMatch: item.etag,
      });
      if (response.status === 412) {
        showFormMessage(form, 'This setting changed elsewhere. Your value was not saved. Reload the latest setting before trying again.', 'error', true);
        return;
      }
      if (response.status !== 200 || !response.body) {
        showFormMessage(form, responseDetail(response, 'The setting could not be saved.'), 'error');
        return;
      }
      replaceItem(response.body);
      renderCard(key);
      ctx.toast?.(`Saved ${key}.`, 'success');
    } catch {
      showFormMessage(form, 'The setting could not reach the server.', 'error');
    } finally {
      setBusy(form, false);
    }
  }

  function onClick(event) {
    const reload = event.target.closest('[data-config-reload]');
    if (reload) reloadSetting(reload.dataset.configReload);
  }

  async function reloadSetting(key) {
    const form = container.querySelector(`[data-config-form="${CSS.escape(key)}"]`);
    if (form) setBusy(form, true);
    abortRequest();
    const controller = new AbortController();
    requestController = controller;
    const version = ++requestVersion;
    try {
      const response = await get(`/admin/operate/config/${encodeURIComponent(key)}`, { signal: controller.signal });
      if (version !== requestVersion) return;
      if (response.status !== 200 || !response.body) {
        if (form) showFormMessage(form, responseDetail(response, 'The latest setting could not be loaded.'), 'error', true);
        return;
      }
      const etag = response.etag || response.body.etag;
      if (!etag) {
        if (form) showFormMessage(form, 'The latest setting did not include an ETag, so editing remains blocked.', 'error', true);
        return;
      }
      replaceItem({ ...response.body, etag });
      renderCard(key);
    } catch (error) {
      if (isAbortError(error)) return;
      if (form) showFormMessage(form, 'The latest setting could not reach the server.', 'error', true);
    } finally {
      if (requestController === controller) requestController = undefined;
      if (form?.isConnected) setBusy(form, false);
    }
  }

  function replaceItem(next) {
    const index = items.findIndex(item => item.key === next.key);
    if (index >= 0) items[index] = next;
  }

  function render() {
    if (items.length === 0) {
      renderState('No operator configuration keys are available.');
      return;
    }
    container.innerHTML = `<div class="operations-section-heading"><div><h3>Configuration</h3><p>Only schema-registered settings are exposed. Secret values are write-only.</p></div></div>
      <div class="operations-config-grid">${items.map(item => configCard(item, canWrite(ctx))).join('')}</div>`;
  }

  function renderCard(key) {
    const item = items.find(candidate => candidate.key === key);
    const form = container.querySelector(`[data-config-form="${CSS.escape(key)}"]`);
    if (!item || !form) return;
    form.outerHTML = configCard(item, canWrite(ctx));
  }

  function renderState(message, kind = 'neutral') {
    container.innerHTML = `<div class="operations-state operations-state--${kind}">${escapeHtml(message)}</div>`;
  }

  function showLoadProblem(message) {
    if (items.length > 0) {
      const grid = container.querySelector('.operations-config-grid');
      container.querySelector('[data-config-refresh-warning]')?.remove();
      grid?.insertAdjacentHTML(
        'beforebegin',
        `<p class="operations-inline-message operations-inline-message--warn" data-config-refresh-warning>${escapeHtml(message)} Showing the last successful snapshot.</p>`,
      );
    } else {
      renderState(message, 'error');
    }
  }

  function abortRequest() {
    requestController?.abort();
    requestController = undefined;
    requestVersion += 1;
  }
}

function configCard(item, writeAvailable) {
  const readOnly = item.mutability === 'read_only';
  const missingEtag = typeof item.etag !== 'string' || !item.etag;
  const disabled = readOnly || missingEtag || !writeAvailable;
  const sensitivity = item.sensitivity === 'secret_write_only' ? 'Write-only secret' : 'Operator visible';
  let restart = mutabilityBadge(item.mutability);
  if (item.pending_restart) restart = '<span class="operations-badge operations-badge--warn">Restart pending</span>';
  if (!writeAvailable) restart = '<span class="operations-badge">Not writable in this deployment</span>';
  const configuredLabel = item.configured ? 'Configured' : 'Not configured';
  const configured = item.sensitivity === 'secret_write_only'
    ? `<span class="operations-config-state">${configuredLabel}</span>`
    : '';
  return `<form class="operations-card operations-config-card" data-config-form="${escapeAttr(item.key)}" data-locked="${disabled}">
    <header><div><h3><code>${escapeHtml(item.key)}</code></h3><p>${escapeHtml(sensitivity)}</p></div>${restart}</header>
    ${configControl(item, disabled)}
    <div class="operations-config-meta">Schema v${Number(item.schema_version || 0)} · ${escapeHtml(effectiveLabel(item))}</div>
    <div class="operations-inline-feedback" data-config-feedback aria-live="polite"></div>
    <footer>${configured}<span></span><button class="btn btn-ghost" data-config-reload="${escapeAttr(item.key)}" type="button" hidden>Reload latest</button><button class="btn btn-primary" type="submit" ${disabled ? 'disabled' : ''}>Save</button></footer>
  </form>`;
}

function configControl(item, disabled) {
  const schema = item.value_schema || {};
  const disabledAttribute = disabled ? 'disabled' : '';
  if (schema.type === 'boolean') return booleanControl(item, disabledAttribute);
  if (schema.type === 'object') return objectControl(item, disabledAttribute);
  return scalarControl(item, schema, disabledAttribute);
}

function booleanControl(item, disabledAttribute) {
  const secret = item.sensitivity === 'secret_write_only';
  const secretPlaceholder = secret
    ? '<option value="" selected disabled>Choose a replacement value</option>'
    : '';
  const trueSelected = !secret && item.value === true ? ' selected' : '';
  const falseSelected = !secret && item.value === false ? ' selected' : '';
  return `<label class="operations-field"><span>Value</span><select name="value" ${disabledAttribute}>${secretPlaceholder}<option value="true"${trueSelected}>Enabled</option><option value="false"${falseSelected}>Disabled</option></select></label>`;
}

function objectControl(item, disabledAttribute) {
  const secret = item.sensitivity === 'secret_write_only';
  const value = secret ? '' : JSON.stringify(item.value ?? {}, null, 2);
  const placeholder = secret && item.configured ? 'Enter a replacement JSON value' : '';
  return `<label class="operations-field"><span>JSON value</span><textarea name="value" rows="6" spellcheck="false" placeholder="${escapeAttr(placeholder)}" ${disabledAttribute}>${escapeHtml(value)}</textarea></label>`;
}

function scalarControl(item, schema, disabledAttribute) {
  const inputType = item.sensitivity === 'secret_write_only' ? 'password' : 'text';
  const numeric = schema.type === 'integer' || schema.type === 'number';
  const type = numeric ? 'number' : inputType;
  const step = schema.type === 'integer' ? ' step="1"' : '';
  const minimum = typeof schema.minimum === 'number' ? ` min="${schema.minimum}"` : '';
  const maximum = typeof schema.maximum === 'number' ? ` max="${schema.maximum}"` : '';
  const value = item.sensitivity === 'secret_write_only' ? '' : item.value ?? '';
  const placeholder = item.sensitivity === 'secret_write_only' && item.configured ? 'Enter a replacement value' : '';
  return `<label class="operations-field"><span>Value</span><input name="value" type="${type}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}"${step}${minimum}${maximum} ${disabledAttribute}></label>`;
}

function readValue(form, item) {
  const raw = form.elements.value.value;
  const type = item.value_schema?.type;
  if (item.sensitivity === 'secret_write_only' && !raw) return { problem: 'Enter a new secret value before saving.' };
  if (type === 'boolean') return { value: raw === 'true' };
  if (type === 'integer') {
    const value = Number(raw);
    return Number.isSafeInteger(value) ? { value } : { problem: 'Value must be an integer.' };
  }
  if (type === 'number') {
    const value = Number(raw);
    return Number.isFinite(value) ? { value } : { problem: 'Value must be a finite number.' };
  }
  if (type === 'object') {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { value }
        : { problem: 'Value must be a JSON object.' };
    } catch {
      return { problem: 'Value must be valid JSON.' };
    }
  }
  return { value: raw };
}

function mutabilityBadge(mutability) {
  if (mutability === 'restart_required') return '<span class="operations-badge">Restart required</span>';
  if (mutability === 'read_only') return '<span class="operations-badge">Read only</span>';
  return '<span class="operations-badge operations-badge--ok">Dynamic</span>';
}

function canWrite(ctx) {
  return ctx.hasRoute?.('PUT', '/admin/operate/config/:key') === true;
}

function effectiveLabel(item) {
  if (item.pending_restart) return 'not effective until restart';
  if (!item.effective_at) return 'effective state unavailable';
  const date = new Date(item.effective_at);
  return Number.isNaN(date.getTime()) ? 'effective state unavailable' : `effective ${date.toLocaleString()}`;
}

function setBusy(form, busy) {
  form.setAttribute('aria-busy', String(busy));
  const locked = form.dataset.locked === 'true';
  form.querySelectorAll('input, select, textarea, button').forEach(control => {
    if (control.matches('[data-config-reload]')) control.disabled = busy;
    else control.disabled = busy || locked;
  });
}

function showFormMessage(form, message, kind, showReload = false) {
  const feedback = form.querySelector('[data-config-feedback]');
  feedback.innerHTML = `<p class="operations-inline-message operations-inline-message--${kind}">${escapeHtml(message)}</p>`;
  form.querySelector('[data-config-reload]').hidden = !showReload;
}
