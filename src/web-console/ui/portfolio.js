/**
 * Portfolio tab module.
 *
 * Faithful port of the legacy console's collection/portfolio browser look:
 * the same card template, the singular-type → --family colour lanes, the
 * source toggle (All / Collection / Portfolio), search, type filters, sort,
 * Cards/List, pagination. Data comes from the new /api/v1/me/portfolio*.
 *
 * Collection is deferred — the toggle is present but disabled until the new
 * backend grows a collection surface; today everything is local portfolio.
 * Rich card fields (description/author/category) populate once the list DTO is
 * enriched; the template omits whatever's absent, exactly like the legacy.
 */

import { get } from './api.js';
import { renderElementDetail } from './portfolio-detail.js';

// Plural API type → singular CSS/display type (drives the --family colour lanes
// in styles.css: .element-card[data-type="persona"], etc.).
const TYPE_META = {
  personas:  { singular: 'persona',  label: 'Personas' },
  skills:    { singular: 'skill',    label: 'Skills' },
  templates: { singular: 'template', label: 'Templates' },
  agents:    { singular: 'agent',    label: 'Agents' },
  memories:  { singular: 'memory',   label: 'Memories' },
  ensembles: { singular: 'ensemble', label: 'Ensembles' },
};
const TYPES = Object.keys(TYPE_META);
const PAGE_SIZE = 24;

const state = {
  elements: [],
  counts: {},
  type: 'all',       // plural API type, or 'all'
  source: 'all',     // all | collection | portfolio (collection deferred)
  search: '',
  sort: 'date-desc',
  view: 'grid',
  page: 1,
};

let host;
let notify = () => {};

export async function init(panelEl, ctx = {}) {
  host = panelEl;
  notify = ctx.toast || notify;
  host.innerHTML = template();
  wireControls();
  await load();
}

/* ── Markup ─────────────────────────────────────────────────────────────── */

function template() {
  return `
  <div class="browse-controls">
    <div class="search-wrapper">
      <label for="pf-search" class="sr-only">Search elements</label>
      <input type="search" id="pf-search" class="search-input"
        placeholder="Search by name, description, author, or tag…  (press / to focus)"
        autocomplete="off" spellcheck="false">
    </div>
    <div class="type-filter-row">
      <fieldset class="type-filters" id="pf-type-filters"><legend class="sr-only">Filter by element type</legend></fieldset>
    </div>
  </div>

  <div class="results-bar">
    <span class="results-count" id="pf-count" aria-live="polite"></span>
    <output class="sr-only" id="pf-announcer" aria-live="polite" aria-atomic="true"></output>
    <fieldset class="source-toggle" id="pf-source">
      <legend class="sr-only">Filter by source</legend>
      <button class="source-btn active" data-source="all" aria-pressed="true">All</button>
      <button class="source-btn" data-source="collection" aria-pressed="false" disabled title="Collection browsing is coming soon">Collection</button>
      <button class="source-btn" data-source="portfolio" aria-pressed="false">Portfolio</button>
    </fieldset>
    <label for="pf-sort" class="sr-only">Sort by</label>
    <select id="pf-sort" class="sort-select" aria-label="Sort elements">
      <option value="name-asc">Name A–Z</option>
      <option value="name-desc">Name Z–A</option>
      <option value="date-desc" selected>Newest first</option>
      <option value="date-asc">Oldest first</option>
      <option value="type-asc">By type</option>
    </select>
    <fieldset class="view-toggle" id="pf-view">
      <legend class="sr-only">View mode</legend>
      <button class="view-btn active" data-view="grid" aria-pressed="true">Cards</button>
      <button class="view-btn" data-view="list" aria-pressed="false">List</button>
      <button class="view-btn" data-view="detail" aria-pressed="false">Detail</button>
    </fieldset>
  </div>

  <ul class="elements-grid" id="pf-grid"></ul>

  <nav class="pagination" id="pf-pagination" hidden aria-label="Page navigation">
    <button class="pagination-btn" id="pf-prev" type="button">&#8249; Prev</button>
    <span class="pagination-info" id="pf-pageinfo"></span>
    <button class="pagination-btn" id="pf-next" type="button">Next &#8250;</button>
  </nav>`;
}

/* ── Data ───────────────────────────────────────────────────────────────── */

async function load() {
  const grid = host.querySelector('#pf-grid');
  grid.innerHTML = '<li class="panel-placeholder">Loading portfolio…</li>';
  const [summary, list] = await Promise.all([get('/me/portfolio'), get('/me/portfolio/elements')]);
  if (list.status !== 200) {
    grid.innerHTML = `<li class="panel-placeholder">Couldn't load your portfolio (status ${list.status}).</li>`;
    return;
  }
  // Local portfolio elements are flagged so the LOCAL badge + Portfolio source filter work.
  state.elements = (list.body?.elements ?? []).filter(Boolean).map(el => ({ ...el, _local: true }));
  state.counts = summary.status === 200 ? (summary.body?.counts_by_type ?? {}) : {};
  renderTypeFilters();
  render();
  // The list DTO is lean; hydrate the rich card fields (description/author/
  // category) from each element's full detail — the legacy did the same. No
  // backend change: GET /me/portfolio/elements/:type/:name returns metadata.
  hydrateDetails();
}

const HYDRATE_CONCURRENCY = 8;

async function hydrateDetails() {
  const queue = state.elements.filter(el => el.name && el.type && el._hydrated === undefined);
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const el = queue[next++];
      el._hydrated = false;
      try {
        const res = await get(`/me/portfolio/elements/${encodeURIComponent(el.type)}/${encodeURIComponent(el.name)}`);
        if (res.status === 200 && res.body) {
          const m = res.body.metadata ?? {};
          el.metadata = m;                 // keep the full stored frontmatter
          el.content = res.body.content;   // for the detail view (next increment)
          el.description = str(m.description);
          el.author = str(m.author);
          el.category = str(m.category);
          el._hydrated = true;
        }
      } catch { /* leave the card with its summary fields */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, queue.length) }, worker));
  render(); // re-render once with the enriched fields filled in
}

function str(v) { return typeof v === 'string' && v.trim() ? v : undefined; }

/* ── Rendering ──────────────────────────────────────────────────────────── */

function renderTypeFilters() {
  const total = state.elements.length;
  const chip = (key, label, singular, count) =>
    `<button class="type-filter${state.type === key ? ' active' : ''}" data-key="${key}"
       ${singular ? `data-type="${singular}"` : ''} aria-pressed="${state.type === key}">
       ${label} <span class="filter-count">${count}</span>
     </button>`;
  const chips = [chip('all', 'All', '', total)];
  for (const t of TYPES) chips.push(chip(t, TYPE_META[t].label, TYPE_META[t].singular, state.counts[t] ?? 0));
  host.querySelector('#pf-type-filters').innerHTML =
    '<legend class="sr-only">Filter by element type</legend>' + chips.join('');
}

function visibleElements() {
  const q = state.search.trim().toLowerCase();
  let items = state.elements.filter(el => state.type === 'all' || el.type === state.type);
  if (state.source === 'collection') items = []; // deferred
  // (source 'portfolio' and 'all' are identical today — everything is local)
  if (q) {
    items = items.filter(el =>
      (el.name || '').toLowerCase().includes(q) ||
      (el.display_name || '').toLowerCase().includes(q) ||
      (el.description || '').toLowerCase().includes(q) ||
      (el.author || '').toLowerCase().includes(q) ||
      (el.tags || []).some(tag => tag.toLowerCase().includes(q)));
  }
  const cmp = {
    'name-asc': (a, b) => title(a).localeCompare(title(b)),
    'name-desc': (a, b) => title(b).localeCompare(title(a)),
    'date-desc': (a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''),
    'date-asc': (a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''),
    'type-asc': (a, b) => (a.type || '').localeCompare(b.type || '') || title(a).localeCompare(title(b)),
  }[state.sort];
  return items.sort(cmp);
}

function render() {
  const grid = host.querySelector('#pf-grid');
  grid.dataset.view = state.view; // the ported CSS styles .elements-grid[data-view="list"|"grid"]
  const items = visibleElements();
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  if (state.source === 'collection') {
    grid.innerHTML = '<li class="panel-placeholder">Collection browsing is coming soon — the new backend doesn’t expose the community collection yet.</li>';
  } else if (items.length === 0) {
    grid.innerHTML = '<li class="panel-placeholder">No elements yet. Create one to get started.</li>';
  } else {
    grid.innerHTML = pageItems.map(card).join('');
  }

  const countText = `${items.length} element${items.length === 1 ? '' : 's'}${state.type !== 'all' ? ` · ${TYPE_META[state.type]?.label ?? ''}` : ''}`;
  host.querySelector('#pf-count').textContent = countText;
  host.querySelector('#pf-announcer').textContent = `${countText}, page ${state.page} of ${pages}`;

  const pag = host.querySelector('#pf-pagination');
  pag.hidden = pages <= 1 || state.source === 'collection';
  host.querySelector('#pf-pageinfo').textContent = `Page ${state.page} of ${pages}`;
  host.querySelector('#pf-prev').disabled = state.page <= 1;
  host.querySelector('#pf-next').disabled = state.page >= pages;
}

// Faithful port of the legacy card template (fields degrade gracefully).
function card(el) {
  const singular = TYPE_META[el.type]?.singular ?? el.type;
  const label = capitalize(TYPE_META[el.type]?.singular ?? el.type);
  const stale = el.validation_status && el.validation_status !== 'valid';
  return `
  <article class="element-card" data-type="${escapeAttr(singular)}" data-key="${escapeAttr(el.type)}" data-name="${escapeAttr(el.name)}"
    role="listitem" tabindex="0" aria-label="View ${escapeHtml(title(el))}">
    <div class="card-header">
      <h3 class="card-title">${escapeHtml(title(el))}</h3>
      <div class="card-badges">
        <span class="type-badge" data-type="${escapeAttr(singular)}">${escapeHtml(label)}</span>
        ${el._local ? '<span class="source-badge">LOCAL</span>' : ''}
        ${stale ? `<span class="unavailable-badge">${escapeHtml(el.validation_status)}</span>` : ''}
      </div>
      <span class="card-expand-icon" aria-hidden="true">&#9662;</span>
    </div>
    ${el.description ? `<p class="card-description">${escapeHtml(el.description)}</p>` : ''}
    ${renderComponentSummary(el)}
    <footer class="card-footer">
      <div class="card-meta">
        ${el.author ? `<span class="meta-author">${escapeHtml(el.author)}</span>` : ''}
        ${typeof el.version === 'number' ? `<span class="meta-version">v${el.version}</span>` : ''}
        ${el.category ? `<span class="meta-category">${escapeHtml(el.category)}</span>` : ''}
        ${el.updated_at ? `<span class="meta-date">${formatDate(el.updated_at)}</span>` : ''}
      </div>
      <div class="card-actions">
        <button class="card-download-btn" data-action="download" aria-label="Download ${escapeHtml(title(el))}" title="Download">&#10515;</button>
      </div>
      ${el.tags?.length
        ? `<ul class="card-tags" aria-label="Tags">${el.tags.slice(0, 5).map(t => `<li class="tag">${escapeHtml(t)}</li>`).join('')}</ul>`
        : ''}
    </footer>
    <div class="card-inline-detail"></div>
  </article>`;
}

function renderComponentSummary(el) {
  if (el.type !== 'ensembles') return '';
  const counts = ['personas', 'skills', 'templates', 'agents', 'memories']
    .filter(k => Array.isArray(el[k]) && el[k].length)
    .map(k => `${el[k].length} ${k}`);
  return counts.length ? `<p class="card-components">${escapeHtml(counts.join(' · '))}</p>` : '';
}

/* ── Controls ───────────────────────────────────────────────────────────── */

function wireControls() {
  host.querySelector('#pf-search').addEventListener('input', (e) => { state.search = e.target.value; state.page = 1; render(); });
  host.querySelector('#pf-sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  host.querySelector('#pf-view').addEventListener('click', (e) => toggleGroup(e, '.view-btn', '#pf-view', v => { state.view = v; }));
  host.querySelector('#pf-source').addEventListener('click', (e) => toggleGroup(e, '.source-btn', '#pf-source', v => { state.source = v; state.page = 1; }));
  host.querySelector('#pf-type-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.type-filter'); if (!btn) return;
    state.type = btn.dataset.key; state.page = 1;
    renderTypeFilters(); render();
  });
  host.querySelector('#pf-prev').addEventListener('click', () => { state.page--; render(); });
  host.querySelector('#pf-next').addEventListener('click', () => { state.page++; render(); });
  host.querySelector('#pf-grid').addEventListener('click', (e) => {
    const cardEl = e.target.closest('.element-card'); if (!cardEl) return;
    const list = visibleElements();
    const idx = list.findIndex(el => el.type === cardEl.dataset.key && el.name === cardEl.dataset.name);
    if (idx < 0) return;
    const dlBtn = e.target.closest('[data-action="download"]');
    if (dlBtn) { e.stopPropagation(); downloadCard(list[idx], dlBtn); return; }   // download without opening
    openModal(list, idx);
  });
}

/* ── Detail modal (lifted from the legacy element viewer) ───────────────── */

let modalShowRaw = false;

function ensureModal() {
  if (document.getElementById('pf-modal')) return;
  const dlg = document.createElement('dialog');
  dlg.id = 'pf-modal';
  dlg.className = 'modal';
  dlg.innerHTML = `
    <div class="modal-dialog">
      <header class="modal-header">
        <div class="modal-heading">
          <h2 class="modal-title" id="pf-modal-title">Loading…</h2>
          <span class="modal-type" id="pf-modal-type"></span>
        </div>
        <div class="modal-meta">
          <span class="modal-author" id="pf-modal-author"></span>
          <span class="modal-version" id="pf-modal-version"></span>
          <span class="modal-date" id="pf-modal-date"></span>
        </div>
        <button class="modal-close" id="pf-modal-close" aria-label="Close">&#x2715;</button>
      </header>
      <div class="modal-toolbar">
        <button class="modal-action-btn" data-act="render">&#8644; Raw</button>
        <button class="modal-action-btn" data-act="copy">&#9112; Copy</button>
        <button class="modal-action-btn" data-act="download">&#10515; Download</button>
        <div class="modal-nav">
          <button class="modal-nav-btn" data-act="prev" aria-label="Previous">&#8249;</button>
          <span class="modal-nav-count" id="pf-modal-count"></span>
          <button class="modal-nav-btn" data-act="next" aria-label="Next">&#8250;</button>
        </div>
      </div>
      <div class="modal-body" id="pf-modal-body" tabindex="-1"></div>
    </div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });        // backdrop click
  dlg.querySelector('#pf-modal-close').addEventListener('click', close);
  dlg.querySelector('.modal-toolbar').addEventListener('click', onToolbar);
  function close() { dlg.close(); document.body.classList.remove('modal-open'); }
}

let modalList = [];
let modalIdx = -1;
let modalEl = null;
let modalContent = '';

async function openModal(list, idx) {
  ensureModal();
  modalList = list; modalIdx = idx; modalEl = list[idx];
  const dlg = document.getElementById('pf-modal');
  const body = dlg.querySelector('#pf-modal-body');
  setHeader(modalEl);
  dlg.querySelector('#pf-modal-count').textContent = `${idx + 1} / ${list.length}`;
  body.innerHTML = '<p class="loading">Loading content…</p>';
  if (!dlg.open) { dlg.showModal(); document.body.classList.add('modal-open'); }
  body.focus();

  // Fetch the full element (metadata + content) — the legacy did the same on open.
  const res = await get(`/me/portfolio/elements/${encodeURIComponent(modalEl.type)}/${encodeURIComponent(modalEl.name)}`);
  if (res.status !== 200 || !res.body) {
    body.innerHTML = `<p class="panel-placeholder">Couldn't load this element (status ${res.status}).</p>`;
    return;
  }
  modalEl = { ...modalEl, ...res.body, metadata: res.body.metadata ?? {} };
  modalContent = typeof res.body.content === 'string' ? res.body.content : '';
  setHeader(modalEl);
  renderModalBody();
}

function setHeader(el) {
  const dlg = document.getElementById('pf-modal');
  const label = capitalize(TYPE_META[el.type]?.singular ?? el.type);
  dlg.querySelector('.modal-dialog').setAttribute('data-type', TYPE_META[el.type]?.singular ?? el.type);
  dlg.querySelector('#pf-modal-title').textContent = title(el);
  dlg.querySelector('#pf-modal-type').textContent = label;
  dlg.querySelector('#pf-modal-author').textContent = el.author || el.metadata?.author ? `by ${el.author || el.metadata.author}` : '';
  dlg.querySelector('#pf-modal-version').textContent = typeof el.version === 'number' ? `v${el.version}` : '';
  dlg.querySelector('#pf-modal-date').textContent = el.updated_at ? formatDate(el.updated_at) : '';
}

function renderModalBody() {
  const body = document.getElementById('pf-modal-body');
  const banner = validationBanner(modalEl);
  if (modalShowRaw) {
    body.innerHTML = banner + `<pre class="element-source"><code class="element-code">${escapeHtml(rawSource(modalEl))}</code></pre>`;
  } else {
    body.innerHTML = banner + renderElementDetail({ metadata: modalEl.metadata, content: modalContent, type: modalEl.type });
  }
}

// Surface a non-valid validation status (lifted from the legacy detail view's
// security-scan warning). The list/detail DTO carries `validation_status`.
function validationBanner(el) {
  const status = el?.validation_status ?? el?.validationStatus;
  if (!status || status === 'valid') return '';
  const reason = el?.validation_reason ?? el?.metadata?.validation_reason;
  const text = status === 'warn'
    ? `Security scan: ${escapeHtml(reason || 'warning')}`
    : `This element ${escapeHtml(status)} validation${reason ? ` — ${escapeHtml(reason)}` : ''}.`;
  return `<div class="detail-validation-warn">${text}</div>`;
}

// Reconstruct the element's on-disk source from the detail response. The backend
// folds the body into metadata.instructions and leaves `content` as a short
// description stub, so the full source = frontmatter (everything except
// instructions) + the instructions body. Falls back to `content` when there's
// no instructions (e.g. element types that keep their body in content).
function rawSource(el) {
  // Memories are pure YAML (no frontmatter); the BFF already serves the full
  // memory document as content — hand it back verbatim.
  if (el?.type === 'memories') return (el.content || '').replace(/^\n+/, '');
  const meta = { ...(el?.metadata || {}) };
  const hasInstructions = typeof meta.instructions === 'string' && meta.instructions.trim();
  const body = (hasInstructions ? meta.instructions : el?.content || '').replace(/^\n+/, '');
  delete meta.instructions;
  let frontmatter = '';
  try {
    frontmatter = globalThis.jsyaml ? jsyaml.dump(meta, { lineWidth: -1, noRefs: true, sortKeys: false }) : '';
  } catch { frontmatter = ''; }
  return frontmatter ? `---\n${frontmatter}---\n\n${body}` : body;
}

function downloadElement(el) {
  const blob = new Blob([rawSource(el)], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${el.name}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Ensure the element's full detail (metadata incl. instructions + content) is
// loaded before reconstructing its source — a card may be downloaded before the
// background hydration reaches it.
async function ensureLoaded(el) {
  if (el.metadata && (typeof el.metadata.instructions === 'string' || el._hydrated)) return el;
  const res = await get(`/me/portfolio/elements/${encodeURIComponent(el.type)}/${encodeURIComponent(el.name)}`);
  if (res.status === 200 && res.body) {
    el.metadata = res.body.metadata ?? {};
    el.content = typeof res.body.content === 'string' ? res.body.content : '';
  }
  return el;
}

async function downloadCard(el, btn) {
  const prev = btn.innerHTML;
  btn.innerHTML = '…';
  try {
    await ensureLoaded(el);
    downloadElement(el);
    btn.innerHTML = prev;
  } catch {
    btn.innerHTML = '✗';
    setTimeout(() => { btn.innerHTML = prev; }, 1500);
  }
}

function onToolbar(e) {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'render') {
    modalShowRaw = !modalShowRaw;
    btn.innerHTML = modalShowRaw ? '&#8644; Rendered' : '&#8644; Raw';
    renderModalBody();
  } else if (act === 'copy') {
    navigator.clipboard?.writeText(rawSource(modalEl)).then(() => notify('Copied to clipboard.', 'success'));
  } else if (act === 'download') {
    downloadElement(modalEl);
  } else if (act === 'prev' && modalIdx > 0) {
    openModal(modalList, modalIdx - 1);
  } else if (act === 'next' && modalIdx < modalList.length - 1) {
    openModal(modalList, modalIdx + 1);
  }
}

function toggleGroup(e, btnSel, groupSel, apply) {
  const btn = e.target.closest(btnSel); if (!btn || btn.disabled) return;
  const value = btn.dataset.view || btn.dataset.source;
  host.querySelectorAll(`${groupSel} ${btnSel}`).forEach(b => {
    const on = b === btn; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
  });
  apply(value);
  render();
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function title(el) { return el.display_name || el.name || '(unnamed)'; }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function escapeHtml(s) {
  return String(s ?? '').replaceAll(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
