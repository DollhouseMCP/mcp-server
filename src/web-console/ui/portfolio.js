/**
 * Portfolio tab module.
 *
 * Faithful port of the legacy console's collection/portfolio browser look:
 * the same card template, the singular-type → --family colour lanes, the
 * source toggle (All / Collection / Portfolio), search, type filters, sort,
 * Cards/List, pagination. Portfolio data comes from /api/v1/me/portfolio*;
 * Collection data from /api/v1/collection/* (browse) with install writing to
 * /api/v1/me/portfolio/from-collection.
 *
 * Collection is lazy-loaded the first time its source tab is opened. The source
 * control is absent when the route manifest omits collection browsing; a
 * degraded upstream shows the source's own message rather than a misleading
 * "empty collection".
 */

import { get, post } from './api.js';
import { noConsoleRoute } from './console-meta.js';
import { createPortfolioAuthoring } from './portfolio-authoring.js';
import { renderElementDetail } from './portfolio-detail.js';
import { createRequestOwner } from './polling.js';
import { escapeHtml } from './ui-utils.js';

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
  type: 'all',       // plural API type, or 'all'
  source: 'all',     // all | collection | portfolio
  search: '',
  sort: 'date-desc',
  view: 'grid',
  page: 1,
  // Collection browse cache (lazy-loaded on first switch to the Collection tab).
  // status: idle | loading | ok | degraded | unavailable | error
  // installEnabled mirrors the list DTO's install_enabled: browse-only servers
  // don't register the install route, so no Install affordances should render.
  collection: { status: 'idle', detail: '', elements: [], installEnabled: true },
  // Catalog paths installed this session, so their cards can flip to "Installed".
  installed: new Set(),
  summary: null,
};

let host;
let notify = () => {};
let hasRoute = noConsoleRoute;
let authoring;

export async function init(panelEl, ctx = {}) {
  host = panelEl;
  notify = ctx.toast || notify;
  hasRoute = ctx.hasRoute || hasRoute;
  authoring = createPortfolioAuthoring({
    host,
    hasRoute,
    notify,
    refresh: refreshPortfolio,
    requestMaxBytes: ctx.limits?.portfolioRequestMaxBytes,
  });
  state.collection.installEnabled = hasRoute('POST', '/me/portfolio/from-collection');
  host.innerHTML = template();
  const collectionAvailable = hasRoute('GET', '/collection/elements');
  host.querySelector('#pf-source').hidden = !collectionAvailable;
  if (!collectionAvailable) state.source = 'portfolio';
  wireControls();
  await Promise.all([
    load(),
    collectionAvailable ? loadCollection() : Promise.resolve(),
  ]);
}

/* ── Markup ─────────────────────────────────────────────────────────────── */

function template() {
  return `
  <div data-portfolio-browser>
  <div class="portfolio-command-bar">
    <span class="portfolio-summary" id="pf-summary" aria-live="polite">Portfolio</span>
    <div class="portfolio-command-actions">
      ${authoring.capabilities.sync ? '<button class="btn btn-ghost" id="pf-sync" type="button">Sync with GitHub</button>' : ''}
      ${authoring.capabilities.create ? `
        <button class="portfolio-start-action" id="pf-create" type="button">
          <strong>Create new</strong><span>Build an element with guided fields</span>
        </button>
        <button class="portfolio-start-action" id="pf-import" type="button">
          <strong>Import file</strong><span>Review and add a local element file</span>
        </button>` : ''}
    </div>
  </div>
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
      <button class="source-btn" data-source="collection" aria-pressed="false" title="Browse the community collection">Collection</button>
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
  </nav>
  </div>
  <section class="portfolio-workspace" data-portfolio-authoring hidden aria-label="Portfolio authoring"></section>`;
}

/* ── Data ───────────────────────────────────────────────────────────────── */

async function load() {
  const grid = host.querySelector('#pf-grid');
  grid.innerHTML = '<li class="panel-placeholder">Loading portfolio…</li>';
  const [list, summary] = await Promise.all([
    get('/me/portfolio/elements'),
    hasRoute('GET', '/me/portfolio') ? get('/me/portfolio') : Promise.resolve(null),
  ]);
  if (list.status !== 200) {
    grid.innerHTML = `<li class="panel-placeholder">Couldn't load your portfolio (status ${list.status}).</li>`;
    return;
  }
  // Local portfolio elements are flagged so the LOCAL badge + Portfolio source filter work.
  state.elements = (list.body?.elements ?? []).filter(Boolean).map(el => ({ ...el, _local: true }));
  state.summary = summary?.status === 200 ? summary.body : null;
  paint();
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
          el._etag = res.etag;
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

/* ── Collection browse ──────────────────────────────────────────────────── */

const COLLECTION_PAGE_SIZE = 100; // server cap; the catalog is small
const COLLECTION_MAX_PAGES = 20;  // safety bound on the page walk

// Lazy-load the whole catalog once, then filter/sort/search client-side like the
// portfolio does. Re-entrancy guarded by the 'loading' status.
async function loadCollection() {
  if (state.collection.status === 'loading') return;
  state.collection.status = 'loading';
  paint();

  const elements = [];
  let installEnabled = hasRoute('POST', '/me/portfolio/from-collection');
  let page = 1;
  try {
    for (; page <= COLLECTION_MAX_PAGES; page++) {
      const res = await get(`/collection/elements?page=${page}&page_size=${COLLECTION_PAGE_SIZE}`);
      if (res.status === 404) { state.collection.status = 'unavailable'; paint(); return; }
      if (res.status !== 200 || !res.body) { state.collection.status = 'error'; paint(); return; }
      const body = res.body;
      installEnabled = resolveInstallAvailability(installEnabled, body.install_enabled);
      for (const el of (body.elements ?? []).filter(Boolean)) elements.push(mapCollectionElement(el));
      if (body.source_status === 'degraded') {
        state.collection = { status: 'degraded', detail: str(body.source_detail) ?? '', elements, installEnabled };
        paint();
        return;
      }
      if (!body.has_more) break;
      if (page === COLLECTION_MAX_PAGES) {
        state.collection = {
          status: 'degraded',
          detail: `Only the first ${elements.length} collection elements could be loaded.`,
          elements,
          installEnabled,
        };
        paint();
        return;
      }
    }
    state.collection = { status: 'ok', detail: '', elements, installEnabled };
  } catch {
    state.collection.status = 'error';
  }
  paint();
}

function resolveInstallAvailability(routeAvailable, advertisedAvailability) {
  // install_enabled is deployment-wide and should match on every page. Retain
  // a false value defensively if an inconsistent response is ever observed.
  return routeAvailable && advertisedAvailability !== false;
}

// Map a collection list DTO to the shared card shape. Collection elements are
// keyed by `path` (the install input) and carry source:'collection' so the card
// renders a COLLECTION badge + Install action instead of LOCAL + download.
function mapCollectionElement(el) {
  return {
    type: el.type,
    name: el.name,
    display_name: str(el.display_name),
    description: str(el.description),
    author: str(el.author),
    version: str(el.version),
    tags: Array.isArray(el.tags) ? el.tags : [],
    path: el.path,
    source: 'collection',
  };
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

// Repaint both the type-filter counts and the grid (use when the source or the
// underlying element set changed; plain render() suffices for search/sort/view).
function paint() { renderSummary(); renderTypeFilters(); render(); }

function renderSummary() {
  const summary = host.querySelector('#pf-summary');
  if (!summary) return;
  if (state.source === 'portfolio') {
    const total = state.summary?.total_elements;
    summary.textContent = Number.isSafeInteger(total)
      ? elementCount(total, 'portfolio')
      : 'Your portfolio';
    return;
  }
  if (state.source === 'collection') {
    summary.textContent = collectionSummary();
    return;
  }
  summary.textContent = allSourcesSummary();
}

function elementCount(total, qualifier = '') {
  const prefix = qualifier ? `${qualifier} ` : '';
  return `${total} ${prefix}element${total === 1 ? '' : 's'}`;
}

function collectionSummary() {
  const { status, elements, detail } = state.collection;
  if (status === 'idle' || status === 'loading') return 'Loading collection…';
  if (status === 'error' || status === 'unavailable') return 'Collection unavailable';
  if (status === 'degraded') {
    return `${elementCount(elements.length, 'available collection')} · ${detail || 'Collection may be incomplete'}`;
  }
  return elementCount(elements.length, 'collection');
}

function allSourcesSummary() {
  const { status, detail } = state.collection;
  if (status === 'idle' || status === 'loading') {
    return `${elementCount(state.elements.length, 'portfolio')} · Loading collection…`;
  }
  if (status === 'error' || status === 'unavailable') {
    return `${elementCount(state.elements.length, 'portfolio')} · Collection unavailable`;
  }
  const total = sourceElements().length;
  if (status === 'degraded') {
    return `${elementCount(total, 'available')} · ${detail || 'Collection may be incomplete'}`;
  }
  return elementCount(total, 'total');
}

function renderTypeFilters() {
  // Counts follow the active source. All combines the complete catalog and the
  // user's portfolio rather than acting as a second Portfolio filter.
  const items = sourceElements();
  const counts = {};
  for (const el of items) counts[el.type] = (counts[el.type] ?? 0) + 1;
  const chip = (key, label, singular, count) =>
    `<button class="type-filter${state.type === key ? ' active' : ''}" data-key="${key}"
       ${singular ? `data-type="${singular}"` : ''} aria-pressed="${state.type === key}">
       ${label} <span class="filter-count">${count}</span>
     </button>`;
  const chips = [chip('all', 'All', '', items.length)];
  for (const t of TYPES) chips.push(chip(t, TYPE_META[t].label, TYPE_META[t].singular, counts[t] ?? 0));
  host.querySelector('#pf-type-filters').innerHTML =
    '<legend class="sr-only">Filter by element type</legend>' + chips.join('');
}

function sourceElements() {
  if (state.source === 'collection') return state.collection.elements;
  if (state.source === 'portfolio') return state.elements;
  return [...state.collection.elements, ...state.elements];
}

function visibleElements() {
  const q = state.search.trim().toLowerCase();
  let items = [...sourceElements()].filter(el => state.type === 'all' || el.type === state.type);
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

  const collectionPlaceholder = state.source === 'collection' ? collectionStatusPlaceholder() : null;
  if (collectionPlaceholder) {
    grid.innerHTML = collectionPlaceholder;
  } else if (items.length === 0) {
    grid.innerHTML = state.source === 'collection'
      ? '<li class="panel-placeholder">No collection elements match your filters.</li>'
      : '<li class="panel-placeholder">No elements yet. Create one to get started.</li>';
  } else {
    grid.innerHTML = pageItems.map(card).join('');
  }

  const typeSuffix = state.type === 'all' ? '' : ` · ${TYPE_META[state.type]?.label ?? ''}`;
  const countText = `${items.length} element${items.length === 1 ? '' : 's'}${typeSuffix}`;
  host.querySelector('#pf-count').textContent = countText;
  host.querySelector('#pf-announcer').textContent = `${countText}, page ${state.page} of ${pages}`;

  const pag = host.querySelector('#pf-pagination');
  pag.hidden = pages <= 1 || Boolean(collectionPlaceholder);
  host.querySelector('#pf-pageinfo').textContent = `Page ${state.page} of ${pages}`;
  host.querySelector('#pf-prev').disabled = state.page <= 1;
  host.querySelector('#pf-next').disabled = state.page >= pages;
}

// Faithful port of the legacy card template (fields degrade gracefully).
function card(el) {
  const singular = TYPE_META[el.type]?.singular ?? el.type;
  const label = capitalize(TYPE_META[el.type]?.singular ?? el.type);
  const stale = el.validation_status && el.validation_status !== 'valid';
  const tagItems = (el.tags || []).slice(0, 5).map(t => `<li class="tag">${escapeHtml(t)}</li>`).join('');
  const isCollection = el.source === 'collection';
  const actions = isCollection ? installAction(el) : portfolioCardActions(el);
  return `
  <article class="element-card" data-type="${escapeAttr(singular)}" data-key="${escapeAttr(el.type)}" data-name="${escapeAttr(el.name)}"
    ${isCollection && el.path ? `data-path="${escapeAttr(el.path)}"` : ''}
    role="listitem" tabindex="0" aria-label="View ${escapeHtml(title(el))}">
    <div class="card-header">
      <h3 class="card-title">${escapeHtml(title(el))}</h3>
      <div class="card-badges">
        <span class="type-badge" data-type="${escapeAttr(singular)}">${escapeHtml(label)}</span>
        ${el._local ? '<span class="source-badge">LOCAL</span>' : ''}
        ${isCollection ? '<span class="source-badge source-badge-collection">COLLECTION</span>' : ''}
        ${stale ? `<span class="unavailable-badge">${escapeHtml(el.validation_status)}</span>` : ''}
      </div>
      <span class="card-expand-icon" aria-hidden="true">&#9662;</span>
    </div>
    ${el.description ? `<p class="card-description">${escapeHtml(el.description)}</p>` : ''}
    ${renderComponentSummary(el)}
    <footer class="card-footer">
      <div class="card-meta">
        ${el.author ? `<span class="meta-author">${escapeHtml(el.author)}</span>` : ''}
        ${versionMeta(el.version)}
        ${el.category ? `<span class="meta-category">${escapeHtml(el.category)}</span>` : ''}
        ${el.updated_at ? `<span class="meta-date">${formatDate(el.updated_at)}</span>` : ''}
      </div>
      ${actions}
      ${el.tags?.length
        ? `<ul class="card-tags" aria-label="Tags">${tagItems}</ul>`
        : ''}
    </footer>
    <div class="card-inline-detail"></div>
  </article>`;
}

function portfolioCardActions(el) {
  const edit = authoring.capabilities.edit
    ? `<button class="card-download-btn" data-action="edit" aria-label="Edit ${escapeHtml(title(el))}" title="Edit">Edit</button>`
    : '';
  return `<div class="card-actions portfolio-card-edit">${edit}<button class="card-download-btn" data-action="download" aria-label="Download ${escapeHtml(title(el))}" title="Download">&#10515;</button></div>`;
}

// Version label for both the portfolio's numeric version and the collection's
// string version (e.g. "1.2.0"); empty when there's no usable version.
function versionText(version) {
  if (typeof version === 'number') return `v${version}`;
  if (typeof version === 'string' && version.trim()) return `v${version}`;
  return '';
}

function versionMeta(version) {
  const text = versionText(version);
  return text ? `<span class="meta-version">${escapeHtml(text)}</span>` : '';
}

// Install action for collection cards. Always visible (unlike the list-only
// download action) since installing is the primary collection interaction —
// except on browse-only servers, where the install route doesn't exist.
function installAction(el) {
  if (!state.collection.installEnabled) return '';
  if (state.installed.has(el.path)) {
    return '<div class="card-install-wrap"><button class="card-install-btn" data-action="install" disabled aria-disabled="true">Installed ✓</button></div>';
  }
  return `<div class="card-install-wrap"><button class="card-install-btn" data-action="install" aria-label="Install ${escapeHtml(title(el))} into your portfolio">Install</button></div>`;
}

// A non-card placeholder for the Collection tab when there are no browsable
// cards to show: loading, server-disabled, upstream-degraded, or error. Returns
// null when cards should render normally.
function collectionStatusPlaceholder() {
  const { status, detail } = state.collection;
  if (status === 'loading') return '<li class="panel-placeholder">Loading the community collection…</li>';
  if (status === 'unavailable') return '<li class="panel-placeholder">Collection browsing isn’t enabled on this server.</li>';
  if (status === 'error') return '<li class="panel-placeholder">Couldn’t reach the community collection. Try again in a moment.</li>';
  if (status === 'degraded' && state.collection.elements.length === 0) {
    return `<li class="panel-placeholder">${escapeHtml(detail || 'The community collection is temporarily unavailable.')}</li>`;
  }
  return null;
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
  host.querySelector('#pf-create')?.addEventListener('click', () => authoring.openCreate());
  host.querySelector('#pf-import')?.addEventListener('click', () => authoring.openImport());
  host.querySelector('#pf-sync')?.addEventListener('click', () => authoring.openSync());
  host.querySelector('#pf-search').addEventListener('input', (e) => { state.search = e.target.value; state.page = 1; render(); });
  host.querySelector('#pf-sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  host.querySelector('#pf-view').addEventListener('click', (e) => toggleGroup(e, '.view-btn', '#pf-view', v => { state.view = v; }));
  host.querySelector('#pf-source').addEventListener('click', (e) => toggleGroup(e, '.source-btn', '#pf-source', v => {
    state.source = v; state.page = 1;
    renderSummary();
    renderTypeFilters(); // counts follow the active source
    // Lazy-load the catalog the first time the Collection tab is opened, and
    // re-try when the last attempt failed or came back empty-degraded —
    // otherwise a transient blip would brick the tab for the whole session.
    const cst = state.collection.status;
    if ((v === 'all' || v === 'collection') && (cst === 'idle' || cst === 'error' ||
        (cst === 'degraded' && state.collection.elements.length === 0))) loadCollection();
  }));
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
    // Collection cards resolve by catalog path — the only key unique across
    // categorized catalogs (names are file stems, unique per directory only).
    const idx = cardEl.dataset.path
      ? list.findIndex(el => el.path === cardEl.dataset.path)
      : list.findIndex(el => el.type === cardEl.dataset.key && el.name === cardEl.dataset.name);
    if (idx < 0) return;
    const installBtn = e.target.closest('[data-action="install"]');
    if (installBtn) { e.stopPropagation(); installCard(list[idx], installBtn); return; }   // install without opening
    const dlBtn = e.target.closest('[data-action="download"]');
    if (dlBtn) { e.stopPropagation(); downloadCard(list[idx], dlBtn); return; }   // download without opening
    const editBtn = e.target.closest('[data-action="edit"]');
    if (editBtn) { e.stopPropagation(); editCard(list[idx], editBtn); return; }
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
        <button class="modal-action-btn modal-install-btn" data-act="install" hidden>&#8681; Install</button>
        <button class="modal-action-btn modal-edit-btn" data-act="edit" hidden>Edit</button>
        <button class="modal-action-btn modal-delete-btn portfolio-danger" data-act="delete" hidden>Delete</button>
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
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDetailModal(); });        // backdrop click
  dlg.querySelector('#pf-modal-close').addEventListener('click', closeDetailModal);
  dlg.querySelector('.modal-toolbar').addEventListener('click', onToolbar);
}

let modalList = [];
let modalIdx = -1;
let modalEl = null;
let modalContent = '';
let modalPreviousFocus = null;
const modalLoadOwner = createRequestOwner();

async function openModal(list, idx) {
  ensureModal();
  const requestedElement = list[idx];
  const requestClaim = modalLoadOwner.claim();
  modalList = list; modalIdx = idx; modalEl = requestedElement;
  modalContent = '';
  modalPreviousFocus = document.activeElement;
  const dlg = document.getElementById('pf-modal');
  const body = dlg.querySelector('#pf-modal-body');
  setHeader(modalEl);
  dlg.querySelector('#pf-modal-count').textContent = `${idx + 1} / ${list.length}`;
  body.innerHTML = '<p class="loading">Loading content…</p>';
  if (!dlg.open) { dlg.showModal(); document.body.classList.add('modal-open'); }
  body.focus();

  // Fetch the full element (metadata + content) — the legacy did the same on open.
  // Collection elements come from the catalog endpoint; portfolio from /me.
  let res;
  try {
    res = await get(detailPath(requestedElement));
  } catch {
    if (modalLoadOwner.owns(requestClaim) && dlg.open) {
      body.innerHTML = '<p class="panel-placeholder">Couldn\'t reach the server for this element.</p>';
    }
    return;
  }
  if (!modalLoadOwner.owns(requestClaim) || !dlg.open) return;
  if (res.status !== 200 || !res.body) {
    body.innerHTML = `<p class="panel-placeholder">Couldn't load this element (status ${res.status}).</p>`;
    return;
  }
  modalEl = { ...requestedElement, ...res.body, metadata: res.body.metadata ?? {}, _etag: res.etag };
  modalContent = typeof res.body.content === 'string' ? res.body.content : '';
  setHeader(modalEl);
  renderModalBody();
}

function setHeader(el) {
  const dlg = document.getElementById('pf-modal');
  const label = capitalize(TYPE_META[el.type]?.singular ?? el.type);
  dlg.querySelector('.modal-dialog').dataset.type = TYPE_META[el.type]?.singular ?? el.type;
  dlg.querySelector('#pf-modal-title').textContent = title(el);
  dlg.querySelector('#pf-modal-type').textContent = label;
  dlg.querySelector('#pf-modal-author').textContent = el.author || el.metadata?.author ? `by ${el.author || el.metadata.author}` : '';
  dlg.querySelector('#pf-modal-version').textContent = versionText(el.version);
  dlg.querySelector('#pf-modal-date').textContent = el.updated_at ? formatDate(el.updated_at) : '';

  // The Install action shows only for collection elements, and reflects whether
  // this session has already installed it.
  const installBtn = dlg.querySelector('.modal-install-btn');
  const isCollection = el.source === 'collection' && state.collection.installEnabled;
  installBtn.hidden = !isCollection;
  if (isCollection) {
    const done = state.installed.has(el.path);
    installBtn.disabled = done;
    installBtn.textContent = done ? 'Installed ✓' : '⭳ Install';
  }
  const local = el.source !== 'collection';
  const safelyLoaded = Boolean(el._etag);
  dlg.querySelector('.modal-edit-btn').hidden = !local || !safelyLoaded || !authoring.capabilities.edit;
  dlg.querySelector('.modal-delete-btn').hidden = !local || !safelyLoaded || !authoring.capabilities.delete;
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
  const reasonSuffix = reason ? ` — ${escapeHtml(reason)}` : '';
  const text = status === 'warn'
    ? `Security scan: ${escapeHtml(reason || 'warning')}`
    : `This element ${escapeHtml(status)} validation${reasonSuffix}.`;
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
  const meta = { ...(el?.metadata) };
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
  const isMemory = el.type === 'memories';
  const blob = new Blob([rawSource(el)], { type: isMemory ? 'application/yaml' : 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${el.name}${isMemory ? '.yaml' : '.md'}`;
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
    el._etag = res.etag;
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

/* ── Install (collection → portfolio) ───────────────────────────────────── */

// Core install: POST /me/portfolio/from-collection (api.js attaches CSRF +
// Idempotency-Key). A 201 (created) or 409 (already present) both leave the user
// with the element, so both count as "installed"; on either, refresh the
// portfolio in the background so the Portfolio tab reflects it. Returns true when
// the element is now in the portfolio.
async function performInstall(el) {
  let res;
  try {
    res = await post('/me/portfolio/from-collection', { body: { path: el.path } });
  } catch {
    // fetch() rejects on network-level failures (drop, restart mid-request) —
    // the slowest console call must not strand the button at "Installing…".
    notify(`Couldn't install “${title(el)}” — network error. Try again.`, 'error');
    return false;
  }
  if (res.status === 201 || res.status === 409) {
    state.installed.add(el.path);
    notify(res.status === 409
      ? `“${title(el)}” is already in your portfolio.`
      : `Installed “${title(el)}” into your portfolio.`, 'success');
    refreshPortfolio();
    return true;
  }
  const detail = res.body && typeof res.body.detail === 'string' ? res.body.detail : `status ${res.status}`;
  notify(`Couldn't install “${title(el)}” — ${detail}`, 'error');
  return false;
}

// Install from a collection card's button.
async function installCard(el, btn) {
  if (btn.disabled) return;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  const ok = await performInstall(el);
  if (ok) {
    btn.textContent = 'Installed ✓';
    btn.setAttribute('aria-disabled', 'true');
  } else {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// Install from the detail modal's toolbar button; also flips the underlying
// card (which is still in the grid behind the modal).
async function installFromModal(btn) {
  if (btn.disabled || !modalEl?.path) return;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  const ok = await performInstall(modalEl);
  if (ok) {
    btn.textContent = 'Installed ✓';
    if (state.source === 'collection') render();
  } else {
    btn.disabled = false;
    btn.textContent = '⭳ Install';
  }
}

// Quiet background refresh of the portfolio after an install, so switching to
// the Portfolio tab shows the new element without a jarring full "Loading…".
async function refreshPortfolio() {
  try {
    const [list, summary] = await Promise.all([
      get('/me/portfolio/elements'),
      hasRoute('GET', '/me/portfolio') ? get('/me/portfolio') : Promise.resolve(null),
    ]);
    if (list.status !== 200) return;
    state.elements = (list.body?.elements ?? []).filter(Boolean).map(el => ({ ...el, _local: true }));
    state.summary = summary?.status === 200 ? summary.body : state.summary;
    renderSummary();
    if (state.source !== 'collection') paint();
    hydrateDetails();
  } catch { /* leave the current portfolio view; the next full load will catch up */ }
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
  } else if (act === 'install') {
    installFromModal(btn);
  } else if (act === 'edit') {
    const element = modalEl;
    closeDetailModal();
    authoring.openEdit(element);
  } else if (act === 'delete') {
    const element = modalEl;
    closeDetailModal();
    authoring.deleteElement(element);
  } else if (act === 'prev' && modalIdx > 0) {
    openModal(modalList, modalIdx - 1);
  } else if (act === 'next' && modalIdx < modalList.length - 1) {
    openModal(modalList, modalIdx + 1);
  }
}

async function editCard(element, button) {
  const prior = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    await ensureLoaded(element);
    if (!element._etag) {
      notify('This element could not be opened for safe editing.', 'error');
      return;
    }
    authoring.openEdit(element);
  } finally {
    button.disabled = false;
    button.textContent = prior;
  }
}

function closeDetailModal() {
  modalLoadOwner.invalidate();
  const dialog = document.getElementById('pf-modal');
  if (dialog?.open) dialog.close();
  document.body.classList.remove('modal-open');
  if (modalPreviousFocus instanceof HTMLElement && modalPreviousFocus.isConnected) modalPreviousFocus.focus();
  modalPreviousFocus = null;
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
// Detail endpoint for an element — the public catalog for collection elements,
// the user's portfolio otherwise.
function detailPath(el) {
  const type = encodeURIComponent(el.type);
  const name = encodeURIComponent(el.name);
  return el.source === 'collection'
    ? `/collection/elements/${type}/${name}`
    : `/me/portfolio/elements/${type}/${name}`;
}
function escapeAttr(s) { return escapeHtml(s); }
function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
