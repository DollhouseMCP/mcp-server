/**
 * Capability-gated audit workspace: admin actions, approval decisions, and
 * authentication events.
 *
 * Two backend properties drive the shape of this UI. The list routes accept only
 * `limit` and `cursor` — there are no filter parameters — so this surface offers
 * paging and nothing that would 400. And the detail routes sit behind a stricter
 * elevation tier than the lists, so opening a record can require a step-up even
 * though the list around it loaded normally.
 */

import { get, openStream } from './api.js';
import { createCursorPager, escapeHtml, formatTimestamp, responseDetail } from './operations-ui.js';

const PAGE_LIMIT = 50;
/**
 * The export is a finite stream, but "finite" is the server's word for it. This
 * cap keeps a pathological run from growing the tab's memory without bound, and
 * the UI says plainly when it stops early rather than presenting a partial file
 * as a complete export.
 */
const EXPORT_RECORD_CAP = 10_000;

let host;
let sections = [];

export function init(panelEl, ctx = {}) {
  host = panelEl;
  const hasRoute = ctx.hasRoute || (() => false);
  sections = sectionDefinitions(hasRoute);
  host.innerHTML = shell(sections);

  if (sections.length === 0) {
    host.querySelector('#audit-content').innerHTML =
      '<div class="panel-placeholder">No audit records are available in this deployment.</div>';
    return;
  }

  host.querySelector('#audit-nav').addEventListener('click', onNavClick);
  for (const section of sections) {
    section.view.mount(host.querySelector(`[data-audit-panel="${section.id}"]`));
  }
  selectSection(sections[0].id);
}

export function destroy() {
  for (const section of sections) section.view.destroy();
  sections = [];
}

function sectionDefinitions(hasRoute) {
  const definitions = [];
  if (hasRoute('GET', '/admin/audit/admin')) {
    definitions.push({
      id: 'admin',
      label: 'Admin actions',
      view: createAuditListView({
        path: '/admin/audit/admin',
        detailPath: id => `/admin/audit/admin/${encodeURIComponent(id)}`,
        exportPath: hasRoute('GET', '/admin/audit/admin/export') ? '/admin/audit/admin/export' : null,
        empty: 'No administrative actions have been recorded.',
        columns: ADMIN_COLUMNS,
        renderDetail: renderAdminDetail,
      }),
    });
  }
  if (hasRoute('GET', '/admin/audit/approvals')) {
    definitions.push({
      id: 'approvals',
      label: 'Approvals',
      view: createAuditListView({
        path: '/admin/audit/approvals',
        detailPath: id => `/admin/audit/approvals/${encodeURIComponent(id)}`,
        empty: 'No approval decisions have been recorded.',
        columns: APPROVAL_COLUMNS,
        renderDetail: renderApprovalDetail,
      }),
    });
  }
  if (hasRoute('GET', '/admin/audit/authentication')) {
    definitions.push({
      id: 'authentication',
      label: 'Authentication',
      view: createAuditListView({
        path: '/admin/audit/authentication',
        detailPath: null,
        empty: 'No authentication events have been recorded.',
        columns: AUTHENTICATION_COLUMNS,
        renderDetail: null,
      }),
    });
  }
  return definitions;
}

function shell(definitions) {
  return `
    <div class="audit-bar">
      <span class="audit-title">Audit</span>
    </div>
    <p class="audit-sub">Recorded administrative activity. Records are read-only and cannot be edited or removed from here.</p>
    <div class="audit-nav" id="audit-nav" role="tablist" aria-label="Audit views">
      ${definitions.map((definition, index) => `
        <button class="audit-nav-item${index === 0 ? ' is-active' : ''}" data-audit-nav="${definition.id}" role="tab" aria-selected="${index === 0}" type="button">${escapeHtml(definition.label)}</button>`).join('')}
    </div>
    <div id="audit-content">
      ${definitions.map(definition => `<div data-audit-panel="${definition.id}" hidden></div>`).join('')}
    </div>`;
}

function onNavClick(event) {
  const button = event.target.closest('[data-audit-nav]');
  if (button) selectSection(button.dataset.auditNav);
}

function selectSection(id) {
  for (const section of sections) {
    const active = section.id === id;
    const button = host.querySelector(`[data-audit-nav="${section.id}"]`);
    const panel = host.querySelector(`[data-audit-panel="${section.id}"]`);
    button?.classList.toggle('is-active', active);
    button?.setAttribute('aria-selected', String(active));
    if (panel) panel.hidden = !active;
    if (active) section.view.activate();
  }
}

function createAuditListView({ path, detailPath, exportPath = null, empty, columns, renderDetail }) {
  let container;
  let items = [];
  let state = 'idle';
  let message = '';
  let detail = null;
  let detailState = 'idle';
  let detailMessage = '';
  let controller;
  // Separate counters: opening a record and reloading the list are independent
  // operations, and a shared counter let one silently strand the other mid-load.
  let listVersion = 0;
  let detailVersion = 0;
  const pager = createCursorPager();
  const exportRun = { state: 'idle', count: 0, message: '', href: null, capped: false };
  let exportStream = null;

  function resetExportDownload() {
    if (exportRun.href) URL.revokeObjectURL(exportRun.href);
    exportRun.href = null;
  }

  function finishExport(records, { capped = false } = {}) {
    exportStream = null;
    resetExportDownload();
    exportRun.capped = capped;
    exportRun.state = 'ready';
    exportRun.href = URL.createObjectURL(
      new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }),
    );
    render();
  }

  /**
   * A finite export, not a subscription: records accumulate until the server
   * sends `end`, and the stream is never reopened on its own.
   */
  function startExport() {
    if (!exportPath || exportStream) return;
    const records = [];
    resetExportDownload();
    exportRun.state = 'running';
    exportRun.count = 0;
    exportRun.message = '';
    exportRun.capped = false;
    render();

    exportStream = openStream(exportPath, {
      onEvent(frame) {
        if (frame.event === 'end') {
          finishExport(records);
          return;
        }
        if (frame.event !== 'update') return;
        try {
          records.push(JSON.parse(frame.data));
        } catch {
          return;
        }
        exportRun.count = records.length;
        if (records.length >= EXPORT_RECORD_CAP) {
          // Stopping from inside the stream's own callback is safe: stop() only
          // aborts the controller, and openStream suppresses onError once the
          // signal is aborted, so nothing re-enters this handler.
          exportStream?.stop();
          finishExport(records, { capped: true });
          return;
        }
        renderExportStatus();
      },
      onError(error) {
        exportStream = null;
        exportRun.state = 'error';
        exportRun.message = /\b401\b/.test(String(error?.message))
          ? 'The export needs a more recent sign-in. Confirm your identity, then try again.'
          : 'The export stopped before it finished. No file was produced.';
        render();
      },
    });
  }

  function cancelExport() {
    if (!exportStream) return;
    exportStream.stop();
    exportStream = null;
    exportRun.state = 'cancelled';
    render();
  }

  /** Progress ticks every record; repainting the whole panel would fight the DOM. */
  function renderExportStatus() {
    const status = container?.querySelector('[data-audit-export-status]');
    if (status) status.textContent = exportProgressText();
  }

  function exportProgressText() {
    if (exportRun.state === 'running') return `Exporting… ${exportRun.count} records`;
    if (exportRun.state === 'cancelled') return `Cancelled after ${exportRun.count} records.`;
    if (exportRun.state === 'ready') {
      return exportRun.capped
        ? `Stopped at the ${EXPORT_RECORD_CAP.toLocaleString()} record limit. This file is incomplete.`
        : `${exportRun.count.toLocaleString()} records ready to download.`;
    }
    return exportRun.message;
  }

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const current = ++listVersion;
    state = 'loading';
    render();
    const cursor = pager.cursor();
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    const response = await get(`${path}?${query}`, { signal: controller.signal }).catch(() => null);
    if (current !== listVersion) return;
    if (response?.status !== 200 || !Array.isArray(response.body?.items)) {
      state = 'error';
      message = elevationHint(response) ?? responseDetail(response, 'These records could not be loaded.');
      render();
      return;
    }
    items = response.body.items;
    pager.apply(response.body.page);
    state = 'ready';
    render();
  }

  async function openDetail(id) {
    if (!detailPath) return;
    const current = ++detailVersion;
    detailState = 'loading';
    detail = null;
    render();
    const response = await get(detailPath(id)).catch(() => null);
    if (current !== detailVersion) return;
    if (response?.status !== 200 || !response.body) {
      detailState = 'error';
      detailMessage = elevationHint(response) ?? responseDetail(response, 'This record could not be opened.');
      render();
      return;
    }
    detail = response.body;
    detailState = 'ready';
    render();
  }

  function onClick(event) {
    const openButton = event.target.closest('[data-audit-open]');
    if (openButton) {
      void openDetail(openButton.dataset.auditOpen);
      return;
    }
    if (event.target.closest('[data-audit-close]')) {
      detail = null;
      detailState = 'idle';
      render();
      return;
    }
    if (event.target.closest('[data-audit-export]')) {
      startExport();
      return;
    }
    if (event.target.closest('[data-audit-export-cancel]')) {
      cancelExport();
      return;
    }
    if (event.target.closest('[data-audit-next]') && pager.moveNext()) void load();
    if (event.target.closest('[data-audit-previous]') && pager.movePrevious()) void load();
    if (event.target.closest('[data-audit-refresh]')) void load();
  }

  function render() {
    if (!container) return;
    container.innerHTML = `
      ${detailState === 'idle' ? '' : detailMarkup()}
      <div class="audit-list-head">
        ${exportMarkup()}
        <button class="btn btn-ghost" data-audit-refresh type="button">&#x21bb; Refresh</button>
      </div>
      ${listMarkup()}
      <div class="audit-pager">
        <button class="btn btn-ghost" data-audit-previous type="button"${pager.hasPrevious() ? '' : ' disabled'}>Previous</button>
        <button class="btn btn-ghost" data-audit-next type="button"${pager.nextCursor() ? '' : ' disabled'}>Next</button>
      </div>`;
  }

  function exportMarkup() {
    if (!exportPath) return '';
    const running = exportRun.state === 'running';
    const status = exportProgressText();
    return `
      <div class="audit-export">
        ${running
          ? '<button class="btn btn-ghost" data-audit-export-cancel type="button">Cancel export</button>'
          : '<button class="btn btn-ghost" data-audit-export type="button">Export records</button>'}
        ${exportRun.href
          ? `<a class="btn btn-primary" href="${exportRun.href}" download="admin-audit-export.json">Download</a>`
          : ''}
        <span class="audit-export-status${exportRun.state === 'error' ? ' audit-export-status--error' : ''}" data-audit-export-status role="status">${escapeHtml(status)}</span>
      </div>`;
  }

  function listMarkup() {
    // 'idle' must not fall through to the empty state: a section that has not been
    // opened yet has not asked the server, so it cannot claim there is nothing.
    if (state === 'idle' || state === 'loading') return '<div class="audit-loading">Loading records…</div>';
    if (state === 'error') return `<div class="audit-notice audit-notice--error">${escapeHtml(message)}</div>`;
    if (items.length === 0) return `<div class="audit-empty">${escapeHtml(empty)}</div>`;
    return `
      <div class="audit-table" role="table">
        <div class="audit-row audit-row--head" role="row">
          ${columns.map(column => `<span role="columnheader">${escapeHtml(column.label)}</span>`).join('')}
          ${detailPath ? '<span role="columnheader"><span class="sr-only">Actions</span></span>' : ''}
        </div>
        ${items.map(item => `
          <div class="audit-row" role="row">
            ${columns.map(column => `<span role="cell">${column.render(item)}</span>`).join('')}
            ${detailPath ? `<span role="cell"><button class="btn btn-ghost" data-audit-open="${escapeHtml(item.id)}" type="button">Open</button></span>` : ''}
          </div>`).join('')}
      </div>`;
  }

  function detailMarkup() {
    if (detailState === 'loading') return '<div class="audit-detail"><div class="audit-loading">Loading record…</div></div>';
    if (detailState === 'error') {
      return `
        <div class="audit-detail">
          <div class="audit-notice audit-notice--error">${escapeHtml(detailMessage)}</div>
          <button class="btn btn-ghost" data-audit-close type="button">Close</button>
        </div>`;
    }
    return `
      <div class="audit-detail">
        <div class="audit-detail-head">
          <h3>Record detail</h3>
          <button class="btn btn-ghost" data-audit-close type="button">Close</button>
        </div>
        ${renderDetail(detail)}
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
      listVersion += 1;
      detailVersion += 1;
      controller?.abort();
      exportStream?.stop();
      exportStream = null;
      resetExportDownload();
      container = null;
    },
  });
}

/**
 * The list and detail routes sit on different elevation tiers, so a step-up
 * failure here is expected rather than exceptional. The shell drives the actual
 * re-authentication; this only explains why the record did not open.
 */
function elevationHint(response) {
  const code = response?.body?.code ?? response?.body?.type;
  if (response?.status === 401 && typeof code === 'string' && code.includes('step_up')) {
    return 'This record needs a more recent sign-in. Confirm your identity, then try again.';
  }
  return null;
}

function integrityChip(integrity) {
  const status = integrity?.status ?? 'unknown';
  const label = status === 'not_available' ? 'not recorded' : status;
  // escapeHtml already prevents breaking out of the attribute; this additionally
  // stops an unexpected value from injecting extra class names via whitespace.
  return `<span class="audit-chip audit-chip--${cssToken(status)}">${escapeHtml(label)}</span>`;
}

/** Reduce a server-supplied value to something safe to use as a class suffix. */
function cssToken(value) {
  return String(value ?? '').replaceAll(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
}

function textCell(value, fallback = '—') {
  const text = value === null || value === undefined || value === '' ? fallback : value;
  return escapeHtml(text);
}

const ADMIN_COLUMNS = [
  { label: 'When', render: item => escapeHtml(formatTimestamp(item.occurred_at)) },
  { label: 'Actor', render: item => textCell(item.actor_sub ?? item.actor_user_id) },
  { label: 'Operation', render: item => textCell(item.operation) },
  { label: 'Capability', render: item => textCell(item.capability) },
  { label: 'Result', render: item => textCell(item.result) },
  { label: 'Integrity', render: item => integrityChip(item.integrity) },
];

const APPROVAL_COLUMNS = [
  { label: 'When', render: item => escapeHtml(formatTimestamp(item.occurred_at)) },
  { label: 'Tool', render: item => textCell(item.tool_name) },
  { label: 'Operation', render: item => textCell(item.operation) },
  { label: 'Result', render: item => textCell(item.result) },
  { label: 'Decided by', render: item => textCell(item.decision_source) },
  { label: 'Integrity', render: item => integrityChip(item.integrity) },
];

const AUTHENTICATION_COLUMNS = [
  { label: 'When', render: item => escapeHtml(formatTimestamp(item.occurred_at)) },
  { label: 'Event', render: item => textCell(item.event) },
  { label: 'Actor', render: item => textCell(item.actor_sub ?? item.actor_user_id) },
  { label: 'Result', render: item => textCell(item.result) },
  { label: 'Error', render: item => textCell(item.error_code) },
  { label: 'Client', render: item => textCell(item.client_ip) },
];

function definitionList(rows) {
  return `
    <dl class="audit-detail-grid">
      ${rows.map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${value}</dd>
        </div>`).join('')}
    </dl>`;
}

function renderAdminDetail(record) {
  return `
    ${definitionList([
      ['Occurred', escapeHtml(formatTimestamp(record.occurred_at))],
      ['Actor', textCell(record.actor_sub ?? record.actor_user_id)],
      ['Actor role', textCell(record.actor_capability_role ?? record.actor_role)],
      ['Capability', textCell(record.capability)],
      ['Operation', textCell(record.operation)],
      ['Endpoint', textCell(record.endpoint)],
      ['Result', textCell(record.result)],
      ['Error', textCell(record.error_code)],
      ['Target user', textCell(record.target_user_id)],
      ['Resource', textCell(record.resource_kind ? `${record.resource_kind} ${record.resource_id ?? ''}`.trim() : null)],
      ['Correlation', textCell(record.correlation_id)],
      ['Client', textCell(record.client_ip)],
      ['Integrity', integrityChip(record.integrity)],
    ])}
    ${record.integrity?.reason ? `<p class="audit-detail-note">${escapeHtml(record.integrity.reason)}</p>` : ''}
    ${redactedBlock('Arguments', record.args_redacted)}
    ${redactedBlock('Result detail', record.result_detail_redacted)}`;
}

function renderApprovalDetail(record) {
  return `
    ${definitionList([
      ['Occurred', escapeHtml(formatTimestamp(record.occurred_at))],
      ['Session', textCell(record.session_id)],
      ['Tool', textCell(record.tool_name)],
      ['Operation', textCell(record.operation)],
      ['Result', textCell(record.result)],
      ['Decided by', textCell(record.decision_source)],
      ['Correlation', textCell(record.correlation_id)],
      ['Integrity', integrityChip(record.integrity)],
    ])}
    ${record.integrity?.status === 'not_available'
      ? '<p class="audit-detail-note">This record predates chained integrity, so it cannot be verified.</p>'
      : ''}`;
}

/** Redacted payloads are already server-side projections; render them as inert text. */
function redactedBlock(label, payload) {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) return '';
  return `
    <section class="audit-payload">
      <h4>${escapeHtml(label)}</h4>
      <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
    </section>`;
}
