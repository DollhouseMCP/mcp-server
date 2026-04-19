/**
 * DollhouseMCP Collection Browser
 *
 * Functionality-first client-side app. No framework, no build step.
 * Fetches collection-index.json at runtime, renders dynamically.
 * All presentation is delegated to styles.css.
 *
 * Design hooks: class names follow BEM-ish conventions.
 * JS hooks: data-* attributes. Never use JS-hook classes for styling.
 */

/**
 * Client-side YAML parser wrapper with safety hardening.
 *
 * SECURITY NOTE: This runs in the browser, not the server. SecureYamlParser
 * is a Node.js module and cannot be used in browser context. Instead we
 * harden js-yaml's load() with:
 * - Explicit CORE_SCHEMA (safe schema — standard types only, no custom
 *   types, no binary, no merge keys. Matches SecureYamlParser behavior)
 * - Size limit to prevent YAML bomb / amplification attacks
 * - Error swallowing (malformed YAML returns null, never throws)
 *
 * The data being parsed is served from our own localhost server or fetched
 * from the GitHub collection API — both trusted sources.
 */
const YAML_MAX_SIZE = 1024 * 512; // 512KB — generous but bounded
function safeParseYaml(content) {
  if (!globalThis.jsyaml) return null;
  if (typeof content !== 'string' || content.length > YAML_MAX_SIZE) return null;
  try {
    return globalThis.jsyaml.load(content, { schema: globalThis.jsyaml.CORE_SCHEMA }) || null;
  } catch {
    return null;
  }
}

globalThis.DollhouseConsoleUI = globalThis.DollhouseConsoleUI || {};

/**
 * Show or update a visible error banner within a tab panel.
 *
 * Creates the banner lazily on first use, then reuses it for later updates.
 *
 * @param {string} targetId - DOM id of the tab panel or container that owns the banner
 * @param {string} bannerId - Stable DOM id for the banner element
 * @param {string} message - User-visible message to render inside the banner
 */
globalThis.DollhouseConsoleUI.showBanner = function(targetId, bannerId, message) {
  const target = document.getElementById(targetId);
  if (!target) return;
  let banner = document.getElementById(bannerId);
  if (!banner) {
    banner = document.createElement('div');
    banner.id = bannerId;
    banner.className = 'tab-error-banner';
    target.prepend(banner);
  }
  banner.textContent = message;
  banner.hidden = false;
};

/**
 * Hide an existing tab-level error banner without removing its DOM node.
 *
 * @param {string} bannerId - Stable DOM id for the banner element
 */
globalThis.DollhouseConsoleUI.clearBanner = function(bannerId) {
  const banner = document.getElementById(bannerId);
  if (banner) banner.hidden = true;
};

(() => {
  const REPO    = 'DollhouseMCP/collection';
  const BRANCH  = 'main';
  // Portfolio web UI always fetches collection content from GitHub
  const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
  const GITHUB_BASE = `https://github.com/${REPO}/blob/${BRANCH}`;

  // ── Constants ──────────────────────────────────────────────────────────────
  const BRANCH_CHECK_CONCURRENCY = 8;   // max parallel HEAD requests
  const SEARCH_DEBOUNCE_MS       = 150; // ms delay before search fires
  const PORTFOLIO_MAX_DEPTH      = 3;   // max directory recursion depth
  const FILE_READ_CONCURRENCY    = 20;  // parallel file reads for portfolio loading
  const PAGE_SIZE                = 50;  // cards per page

  // ── State ──────────────────────────────────────────────────────────────────

  let collectionElements = []; // from collection-index.json
  let localElements = [];      // loaded from local portfolio (~/.dollhouse/portfolio/)
  let allElements = [];        // collectionElements + localElements
  let filteredElements = [];   // currently displayed after search + type filter
  let currentPage = 1;         // pagination — reset on every filter/search change
  let activeTypes = new Set(); // empty = show all; multi-select
  let openElementIndex = -1;   // index of currently open modal element in filteredElements
  let modalShowRaw = false;    // sticky raw/rendered toggle — persists across prev/next navigation
  let activeTopic = 'all';
  let highlightedCardIndex = -1; // keyboard-highlighted card in the grid

  // Normalize plural index keys → singular CSS/display type names
  const SINGULAR_TYPE = {
    agents: 'agent', personas: 'persona', skills: 'skill',
    templates: 'template', memories: 'memory', ensembles: 'ensemble',
    prompts: 'prompt', tools: 'tool',
  };
  let activeSort = 'date-desc';
  let activeSource = 'all'; // 'all' | 'collection' | 'portfolio'
  let searchQuery = '';
  const DOLLHOUSE_SERVER_VERSION = document.querySelector('meta[name="dollhouse-server-version"]')?.content || '';
  const DOLLHOUSE_SESSION_ID = document.querySelector('meta[name="dollhouse-session-id"]')?.content || '';
  const DOLLHOUSE_RUNTIME_SESSION_ID = document.querySelector('meta[name="dollhouse-runtime-session-id"]')?.content || '';

  function escHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function normalizeInlineMetaText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function renderHeaderStatsMarkup(primaryMarkup) {
    const sessionTitle = DOLLHOUSE_RUNTIME_SESSION_ID && DOLLHOUSE_RUNTIME_SESSION_ID !== DOLLHOUSE_SESSION_ID
      ? `Stable session ${DOLLHOUSE_SESSION_ID}; runtime ${DOLLHOUSE_RUNTIME_SESSION_ID}`
      : `Stable session ${DOLLHOUSE_SESSION_ID}`;
    const sessionMarkup = DOLLHOUSE_SESSION_ID
      ? `
      <span class="stat stat--session" title="${escHtml(sessionTitle)}">
        <strong>${escHtml(DOLLHOUSE_SESSION_ID)}</strong> session
      </span>`
      : '';
    return `${primaryMarkup}${sessionMarkup}`;
  }

  function updateFooterVersion() {
    // Keep the running build visible in the fixed footer so operators can
    // quickly confirm which console version a given tab or machine is serving.
    const footerVersion = document.getElementById('footer-version');
    if (!footerVersion) return;
    footerVersion.textContent = `Version: ${DOLLHOUSE_SERVER_VERSION || 'unknown'}`;
  }

  function wireThemeToggle() {
    const themeToggleBtn  = document.getElementById('theme-toggle');
    const themeToggleIcon = document.getElementById('theme-toggle-icon');
    const themeToggleLbl  = document.getElementById('theme-toggle-label');
    const html = document.documentElement;

    function applyTheme(theme) {
      html.dataset.theme = theme;
      const isDark = theme === 'dark';
      if (themeToggleIcon) themeToggleIcon.textContent = isDark ? '☀' : '☾';
      if (themeToggleLbl) themeToggleLbl.textContent = isDark ? 'Switch to light mode' : 'Switch to dark mode';
      if (themeToggleBtn) themeToggleBtn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
      const hljsLight = document.getElementById('hljs-theme-light');
      const hljsDark = document.getElementById('hljs-theme-dark');
      if (hljsLight) hljsLight.disabled = isDark;
      if (hljsDark) hljsDark.disabled = !isDark;
      try { localStorage.setItem('color-scheme', theme); } catch {}
    }

    const saved = (() => { try { return localStorage.getItem('color-scheme'); } catch {} })();
    const preferred = saved || (globalThis.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(preferred);

    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        applyTheme(html.dataset.theme === 'dark' ? 'light' : 'dark');
      });
    }
  }

  function wireViewToggle() {
    const viewToggle = document.getElementById('view-toggle');
    const elemGrid = document.getElementById('elements-grid');
    let activeView = (() => { try { return localStorage.getItem('collection-view') || 'grid'; } catch { return 'grid'; } })();

    function applyView(view) {
      activeView = view;
      if (elemGrid) elemGrid.dataset.view = view;
      viewToggle?.querySelectorAll('.view-btn').forEach(btn => {
        const on = btn.dataset.view === view;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on);
      });
      try { localStorage.setItem('collection-view', view); } catch {}
    }

    applyView(activeView);

    viewToggle?.addEventListener('click', e => {
      const btn = e.target.closest('[data-view]');
      if (btn) applyView(btn.dataset.view);
    });
  }

  function wireSortControls() {
    const sortSelect = document.getElementById('sort-select');
    if (!sortSelect) return;
    sortSelect.value = activeSort;
    sortSelect.addEventListener('change', e => {
      activeSort = e.target.value;
      applyFilters();
    });
  }

  function wireSourceToggle() {
    const sourceToggle = document.getElementById('source-toggle');
    if (!sourceToggle) return;
    sourceToggle.addEventListener('click', e => {
      const btn = e.target.closest('[data-source]');
      if (!btn) return;
      activeSource = btn.dataset.source;
      sourceToggle.querySelectorAll('[data-source]').forEach(b => {
        const on = b.dataset.source === activeSource;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on);
      });
      renderTypeFilters();
      renderTopicFilters();
      applyFilters();
    });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  function mergeCollectionData(data) {
    globalThis.DollhouseConsoleUI?.clearBanner?.('collection-error-banner');
    const CANONICAL_TYPES = new Set(['agents','personas','skills','templates','memories','ensembles']);
    collectionElements = Object.entries(data.index)
      .filter(([type]) => CANONICAL_TYPES.has(type))
      .flatMap(([type, elements]) =>
        elements.map(el => ({ ...el, type: SINGULAR_TYPE[type] || type }))
      );
    allElements = [...localElements, ...collectionElements];
    renderTypeFilters();
    renderTopicFilters();
    applyFilters();
    const statsEl = document.getElementById('stats');
    if (statsEl) statsEl.innerHTML = renderHeaderStatsMarkup(`
      <span class="stat"><strong>${localElements.length}</strong> portfolio</span>
      <span class="stat"><strong>${collectionElements.length}</strong> collection</span>
    `);
  }

  async function init() {
    try {
      showGridMessage('loading', 'Loading portfolio…');

      // Load portfolio from local API
      const portfolioRes = await DollhouseAuth.apiFetch('/api/elements');
      if (!portfolioRes.ok) throw new Error(`HTTP ${portfolioRes.status} fetching portfolio`);
      const portfolioData = await portfolioRes.json();

      localElements = Object.entries(portfolioData.elements).flatMap(([type, elements]) =>
        elements.map(el => ({
          ...el,
          type: SINGULAR_TYPE[type] || type,
          _local: true,
          path: `${type}/${el.filename || el.name}`,
        }))
      );

      allElements = [...localElements];
      renderStats({ total_elements: portfolioData.totalCount, index: portfolioData.elements });
      renderTypeFilters();
      renderTopicFilters();
      applyFilters();

      // Load community collection (non-blocking — portfolio shows immediately)
      DollhouseAuth.apiFetch('/api/collection')
        .then(r => r.ok ? r.json() : Promise.reject(new Error('collection request failed')))
        .then(mergeCollectionData)
        .catch((err) => {
          console.warn('[App] Collection fetch unavailable:', err);
          globalThis.DollhouseConsoleUI?.showBanner?.(
            'tab-portfolio',
            'collection-error-banner',
            'Community collection unavailable — showing local portfolio only.'
          );
        });

      const updated = document.getElementById('footer-updated');
      if (updated) {
        updated.textContent = `Portfolio: ${localElements.length} elements`;
      }

    } catch (err) {
      showGridMessage('error', `Could not load portfolio: ${err.message}`);
      console.error('[DollhouseMCP]', {
        error: err.message,
        context: 'portfolioLoad',
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── Branch availability check ──────────────────────────────────────────────

  async function checkBranchAvailability() {
    // Probe each element's path; mark unavailable ones so the grid can show them dimmed.
    // Uses HEAD requests in parallel, capped at 8 concurrent to avoid rate limits.
    const CONCURRENCY = BRANCH_CHECK_CONCURRENCY;
    const queue = allElements.filter(el => !el._local);
    let dirty = false;

    async function probe(el) {
      try {
        const res = await fetch(`${RAW_BASE}/${el.path}`, { method: 'HEAD' });
        if (!res.ok) { el._unavailable = true; dirty = true; }
      } catch { el._unavailable = true; dirty = true; }
    }

    while (queue.length) {
      await Promise.all(queue.splice(0, CONCURRENCY).map(probe));
    }

    if (dirty) renderResults(); // re-render with unavailable badges applied
  }

  // ── Stats bar ──────────────────────────────────────────────────────────────

  function renderStats(data) {
    const el = document.getElementById('stats');
    if (!el) return;
    const types = Object.keys(data.index).length;
    el.innerHTML = renderHeaderStatsMarkup(`
      <span class="stat"><strong>${data.total_elements}</strong> elements</span>
      <span class="stat"><strong>${types}</strong> types</span>
    `);
  }

  // ── Type filter chips ──────────────────────────────────────────────────────

  /** Elements filtered by source toggle only (no type/topic/search). */
  function getSourceFilteredElements() {
    if (activeSource === 'collection') return allElements.filter(el => !el._local);
    if (activeSource === 'portfolio') return allElements.filter(el => el._local);
    return allElements;
  }

  function renderTypeFilters() {
    const container = document.getElementById('type-filters');
    if (!container) return;

    const sourceFiltered = getSourceFilteredElements();
    const typeCounts = sourceFiltered.reduce((acc, el) => {
      acc[el.type] = (acc[el.type] || 0) + 1;
      return acc;
    }, {});

    const types = ['all', ...Object.keys(typeCounts).sort((a, b) => a.localeCompare(b))];

    const isAllActive = activeTypes.size === 0;
    container.innerHTML = types.map(type => {
      const count = type === 'all' ? sourceFiltered.length : typeCounts[type];
      const isActive = type === 'all' ? isAllActive : activeTypes.has(type);
      return `<button
        class="type-filter${isActive ? ' active' : ''}"
        data-type="${escapeAttr(type)}"
        aria-pressed="${isActive}"
      >${capitalize(type)} <span class="filter-count">${count}</span></button>`;
    }).join('');

    // Replace listener (clone node removes old listeners)
    const fresh = container.cloneNode(true);
    container.parentNode.replaceChild(fresh, container);
    fresh.addEventListener('click', e => {
      const btn = e.target.closest('[data-type]');
      if (!btn) return;
      const t = btn.dataset.type;
      if (t === 'all') {
        activeTypes.clear();
      } else if (activeTypes.has(t)) {
        activeTypes.delete(t);
      } else {
        activeTypes.add(t);
      }
      fresh.querySelectorAll('.type-filter').forEach(b => {
        const isAll = b.dataset.type === 'all';
        const active = isAll ? activeTypes.size === 0 : activeTypes.has(b.dataset.type);
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', active);
      });
      applyFilters();
    });
  }

  // ── Topic filter chips ─────────────────────────────────────────────────────

  // Map raw tags → normalized topic buckets
  const TOPIC_MAP = {
    'professional': 'Professional',
    'business': 'Business', 'strategy': 'Business', 'consulting': 'Business', 'finance': 'Business',
    'development': 'Development', 'programming': 'Development', 'code': 'Development',
      'software-engineering': 'Development', 'code-review': 'Development', 'code-quality': 'Development',
    'security': 'Security', 'vulnerability': 'Security', 'compliance': 'Security',
      'code-security': 'Security', 'codeql': 'Security', 'security-analysis': 'Security',
    'writing': 'Writing', 'creative-writing': 'Writing', 'storytelling': 'Writing',
      'content': 'Writing', 'copywriting': 'Writing', 'narrative': 'Writing',
    'research': 'Research', 'academic': 'Research', 'analysis': 'Research',
      'literature-review': 'Research', 'data-analysis': 'Research',
    'productivity': 'Productivity', 'task-management': 'Productivity', 'organization': 'Productivity',
      'workflow': 'Productivity', 'efficiency': 'Productivity',
    'education': 'Education', 'learning': 'Education', 'teaching': 'Education', 'tutorial': 'Education',
    'creative': 'Creative', 'design': 'Creative', 'art': 'Creative',
    'personal': 'Personal',
  };

  function getTopicForElement(el) {
    if (!el.tags?.length) return el.category ? capitalize(el.category) : null;
    for (const tag of el.tags) {
      const t = tag.toLowerCase();
      if (TOPIC_MAP[t]) return TOPIC_MAP[t];
    }
    return null;
  }

  function renderTopicFilters() {
    const container = document.getElementById('topic-filters');
    if (!container) return;

    const sourceFiltered = getSourceFilteredElements();
    const topicCounts = {};
    sourceFiltered.forEach(el => {
      const topic = getTopicForElement(el);
      if (topic) topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    });

    const topics = ['all', ...Object.keys(topicCounts).sort((a, b) => a.localeCompare(b))];
    if (topics.length <= 2) { container.hidden = true; return; } // not enough to be useful

    container.hidden = false;
    container.innerHTML = topics.map(topic => {
      const count = topic === 'all' ? sourceFiltered.length : topicCounts[topic];
      const isActive = topic === activeTopic;
      return `<button
        class="topic-filter${isActive ? ' active' : ''}"
        data-topic="${escapeAttr(topic)}"
        aria-pressed="${isActive}"
      >${escapeHtml(topic === 'all' ? 'All topics' : topic)} <span class="filter-count">${count}</span></button>`;
    }).join('');

    container.addEventListener('click', e => {
      const btn = e.target.closest('[data-topic]');
      if (!btn) return;
      activeTopic = btn.dataset.topic;
      container.querySelectorAll('.topic-filter').forEach(b => {
        const active = b.dataset.topic === activeTopic;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', active);
      });
      applyFilters();
    });
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  let searchTimer;
  function onSearch(e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value.trim().toLowerCase();
      applyFilters();
    }, SEARCH_DEBOUNCE_MS);
  }

  // ── Filter + render pipeline ───────────────────────────────────────────────

  function applyFilters() {
    currentPage = 1;
    filteredElements = allElements.filter(el => {
      if (activeTypes.size > 0 && !activeTypes.has(el.type)) return false;
      if (activeTopic !== 'all' && getTopicForElement(el) !== activeTopic) return false;
      if (activeSource === 'collection' && el._local) return false;
      if (activeSource === 'portfolio' && !el._local) return false;
      if (!searchQuery) return true;
      const searchable = [
        el.name, el.description, el.author, el.category,
        ...(Array.isArray(el.tags) ? el.tags : []),
        ...(Array.isArray(el.keywords) ? el.keywords : []),
      ].filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(searchQuery);
    });
    renderResults();
  }

  // ── Card grid ──────────────────────────────────────────────────────────────

  function sortElements(elements) {
    const sorted = [...elements];
    switch (activeSort) {
      case 'name-asc':  return sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      case 'name-desc': return sorted.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
      case 'date-asc':  return sorted.sort((a, b) => {
        const da = a.created ? new Date(a.created).getTime() : 0;
        const db = b.created ? new Date(b.created).getTime() : 0;
        return da - db;
      });
      case 'date-desc': return sorted.sort((a, b) => {
        const da = a.created ? new Date(a.created).getTime() : 0;
        const db = b.created ? new Date(b.created).getTime() : 0;
        return db - da;
      });
      case 'type-asc':  return sorted.sort((a, b) => (a.type || '').localeCompare(b.type || '') || (a.name || '').localeCompare(b.name || ''));
      default:          return sorted;
    }
  }

  function renderResults() {
    const grid = document.getElementById('elements-grid');
    const countEl = document.getElementById('results-count');
    const announcer = document.getElementById('results-announcer');
    if (!grid) return;

    filteredElements = sortElements(filteredElements);
    highlightedCardIndex = -1; // reset grid keyboard selection on re-render

    const total = filteredElements.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const pageStart = (currentPage - 1) * PAGE_SIZE;
    const pageEnd   = Math.min(pageStart + PAGE_SIZE, total);
    const pageItems = filteredElements.slice(pageStart, pageEnd);

    if (countEl) {
      const sourceTotal = getSourceFilteredElements().length;
      const base = total === sourceTotal
        ? `${sourceTotal} elements`
        : `${total} of ${sourceTotal} elements`;
      const pageNote = totalPages > 1 ? ` · page ${currentPage} of ${totalPages}` : '';
      countEl.textContent = base + pageNote;
    }

    if (announcer) {
      announcer.textContent = total === allElements.length
        ? `Showing all ${allElements.length} elements`
        : `Found ${total} of ${allElements.length} elements`;
    }

    if (total === 0) {
      showGridMessage('empty-state', searchQuery
        ? `No elements match "${searchQuery}".`
        : 'No elements found.');
      renderPagination(0, 1);
      return;
    }

    grid.innerHTML = pageItems.map((el, i) => {
      const idx = pageStart + i; // absolute index into filteredElements
      const unavailable = el._unavailable;
      const compSummary = renderComponentSummary(el);
      const author = normalizeInlineMetaText(el.author);
      return `
      <article
        class="element-card"
        data-index="${idx}"
        data-type="${escapeAttr(el.type)}"
        ${unavailable ? 'data-unavailable=""' : ''}
        role="listitem button"
        tabindex="0"
        aria-label="${unavailable ? 'Unavailable: ' : 'View '}${escapeHtml(el.name)}"
      >
        <div class="card-header">
          <h3 class="card-title">${escapeHtml(el.name)}</h3>
          <div class="card-badges">
            <span class="type-badge" data-type="${escapeAttr(el.type)}">${capitalize(el.type)}</span>
            ${el._local ? '<span class="source-badge">LOCAL</span>' : ''}
            ${unavailable ? '<span class="unavailable-badge">unavailable</span>' : ''}
          </div>
          <span class="card-expand-icon" aria-hidden="true">▾</span>
        </div>
        ${el.description
          ? `<p class="card-description">${escapeHtml(el.description)}</p>`
          : ''}
        ${compSummary}
        <footer class="card-footer">
          <div class="card-meta">
            ${author      ? `<span class="meta-author">by ${escapeHtml(author)}</span>` : ''}
            ${el.version  ? `<span class="meta-version">v${escapeHtml(el.version)}</span>` : ''}
            ${el.category ? `<span class="meta-category">${escapeHtml(el.category)}</span>` : ''}
            ${el.created  ? `<span class="meta-date">${formatDate(el.created)}</span>` : ''}
          </div>
          <div class="card-actions">
            <button class="card-download-btn" data-action="download" aria-label="Download ${escapeHtml(el.name)}">⤓</button>
          </div>
          ${el.tags?.length
            ? `<ul class="card-tags" aria-label="Tags">${
                el.tags.slice(0, 5).map(t =>
                  `<li class="tag">${escapeHtml(t)}</li>`
                ).join('')
              }</ul>`
            : ''}
        </footer>
        <div class="card-inline-detail"></div>
      </article>
    `}).join('');

    // Single delegated listener for the grid
    grid.onclick = handleCardClick;
    grid.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleCardClick(e);
      }
    };

    renderPagination(total, totalPages);
  }

  function renderPagination(total, totalPages) {
    const nav = document.getElementById('pagination');
    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    const info    = document.getElementById('page-info');
    if (!nav) return;

    if (totalPages <= 1) { nav.hidden = true; return; }

    nav.hidden = false;
    if (prevBtn) {
      prevBtn.disabled = currentPage <= 1;
      prevBtn.onclick = () => { currentPage--; renderResults(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    }
    if (nextBtn) {
      nextBtn.disabled = currentPage >= totalPages;
      nextBtn.onclick = () => { currentPage++; renderResults(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    }
    if (info) {
      const pageStart = (currentPage - 1) * PAGE_SIZE + 1;
      const pageEnd   = Math.min(currentPage * PAGE_SIZE, total);
      info.textContent = `${pageStart}–${pageEnd} of ${total}`;
    }
  }

  function showGridMessage(cls, text) {
    const grid = document.getElementById('elements-grid');
    if (grid) grid.innerHTML = `<p class="${escapeAttr(cls)}">${escapeHtml(text)}</p>`;
  }

  // ── Modal ──────────────────────────────────────────────────────────────────

  function handleCardClick(e) {
    // Download button — fetch and save without opening modal/expand
    if (e.target.closest('[data-action="download"]')) {
      e.stopPropagation();
      const card = e.target.closest('[data-index]');
      if (!card) return;
      const el = filteredElements[Number.parseInt(card.dataset.index, 10)];
      const btn = e.target.closest('[data-action="download"]');
      const prev = btn.textContent;
      if (el._local && el._content) {
        downloadFile(el.name, el._content);
      } else {
        btn.textContent = '…';
        fetch(`${RAW_BASE}/${el.path}`)
          .then(r => r.ok ? r.text() : Promise.reject(r.status))
          .then(content => { downloadFile(el.name, content); btn.textContent = prev; })
          .catch(() => { btn.textContent = '✗'; setTimeout(() => { btn.textContent = prev; }, 1500); });
      }
      return;
    }

    const card = e.target.closest('[data-index]');
    if (!card) return;
    const idx = Number.parseInt(card.dataset.index, 10);
    const el = filteredElements[idx];
    const grid = document.getElementById('elements-grid');
    const isListView = grid?.dataset.view === 'list';

    if (isListView) {
      // Don't collapse when clicking inside expanded content
      if (e.target.closest('.card-inline-detail')) return;
      toggleInlineExpand(card, el);
    } else if (!card.dataset.unavailable) {
      openModal(el, idx);
    }
  }

  async function toggleInlineExpand(card, el) {
    const detail = card.querySelector('.card-inline-detail');
    if (!detail) return;

    if (card.dataset.expanded !== undefined) {
      delete card.dataset.expanded;
      detail.innerHTML = '';
      return;
    }

    card.dataset.expanded = '';
    if (!el._local) {
      detail.innerHTML = '<p class="loading" style="font-size:0.8rem;padding:0.4rem 0">Loading…</p>';
    }

    try {
      let content;
      if (el._content) {
        content = el._content;
      } else if (el._local) {
        const res = await DollhouseAuth.apiFetch(`/api/elements/${el.path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        content = await res.text();
      } else {
        const res = await fetch(`https://raw.githubusercontent.com/DollhouseMCP/collection/main/${el.path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        content = await res.text();
      }
      detail.innerHTML = '';

      // Action bar at TOP of expanded content
      const actions = document.createElement('div');
      actions.className = 'inline-detail-actions';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'modal-action-btn';
      copyBtn.textContent = '⎘ Copy';
      copyBtn.onclick = e => { e.stopPropagation(); copyToClipboard(content, copyBtn); };

      const dlBtn = document.createElement('button');
      dlBtn.className = 'modal-action-btn';
      dlBtn.textContent = '⤓ Download';
      dlBtn.onclick = e => { e.stopPropagation(); downloadFile(el.name, content); };

      actions.appendChild(copyBtn);
      actions.appendChild(dlBtn);

      if (el._local) {
        const submitBtn2 = document.createElement('button');
        submitBtn2.className = 'modal-action-btn modal-action-btn--submit';
        submitBtn2.type = 'button';
        submitBtn2.textContent = '↑ Submit';
        submitBtn2.onclick = e => { e.stopPropagation(); openSubmitIssue(el.name, el.type, content); };
        actions.appendChild(submitBtn2);
      } else {
        const ghLink = document.createElement('a');
        ghLink.className = 'modal-action-btn';
        ghLink.href = `${GITHUB_BASE}/${el.path}`;
        ghLink.target = '_blank';
        ghLink.rel = 'noopener noreferrer';
        ghLink.textContent = '↗ GitHub';
        actions.appendChild(ghLink);
      }
      detail.appendChild(actions);

      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = renderDetailView(content, el.type);
      contentDiv.querySelectorAll('pre code').forEach(block => {
        if (globalThis.hljs) hljs.highlightElement(block);
      });
      detail.appendChild(contentDiv);

    } catch (err) {
      detail.innerHTML = `<p class="error" style="font-size:0.8rem">Could not load: ${escapeHtml(err.message)}</p>`;
    }
  }

  function setupModalNav(index) {
    const prevElBtn = document.getElementById('btn-prev-element');
    const nextElBtn = document.getElementById('btn-next-element');
    const navCount  = document.getElementById('modal-nav-count');
    if (prevElBtn) {
      prevElBtn.disabled = index <= 0;
      prevElBtn.onclick = () => {
        if (openElementIndex > 0) openModal(filteredElements[openElementIndex - 1], openElementIndex - 1);
      };
    }
    if (nextElBtn) {
      nextElBtn.disabled = index < 0 || index >= filteredElements.length - 1;
      nextElBtn.onclick = () => {
        if (openElementIndex < filteredElements.length - 1) openModal(filteredElements[openElementIndex + 1], openElementIndex + 1);
      };
    }
    if (navCount) {
      navCount.textContent = index >= 0 ? `${index + 1} / ${filteredElements.length}` : '';
    }
  }

  function setupModalMeta(element, modal) {
    const author = normalizeInlineMetaText(element.author);
    modal.querySelector('.modal-title').textContent   = element.name;
    modal.querySelector('.modal-type').textContent    = capitalize(element.type);
    modal.querySelector('.modal-author').textContent  = author ? `by ${author}` : '';
    modal.querySelector('.modal-version').textContent = element.version ? `v${element.version}` : '';
    const modalDate   = modal.querySelector('.modal-date');
    const modalSource = modal.querySelector('.modal-source');
    if (modalDate)   modalDate.textContent   = element.created ? formatDate(element.created) : '';
    if (modalSource) modalSource.textContent = element._local ? 'LOCAL' : '';
  }

  async function installElement(element, btn) {
    const prev = btn.textContent;
    btn.textContent = '⏳ Installing…';
    btn.disabled = true;
    try {
      const res = await DollhouseAuth.apiFetch('/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: element.path, name: element.name, type: element.type }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        btn.textContent = '✅ Installed!';
        setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 3000);
      } else {
        btn.textContent = `✗ ${data.error || 'Failed'}`;
        setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 3000);
      }
    } catch (err) {
      btn.textContent = '✗ Error';
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 3000);
    }
  }

  function setupModalLinks(element, modal) {
    const ghLink = modal.querySelector('#btn-github');
    if (ghLink) {
      if (element._local) {
        ghLink.style.display = 'none';
      } else {
        ghLink.style.display = '';
        ghLink.href = `${GITHUB_BASE}/${element.path}`;
      }
    }
    // Install button for collection elements
    let installBtn = modal.querySelector('#btn-install');
    if (!installBtn) {
      // Create install button if it doesn't exist in the HTML
      const toolbar = modal.querySelector('#modal-toolbar');
      if (toolbar) {
        installBtn = document.createElement('button');
        installBtn.className = 'modal-action-btn modal-action-btn--submit';
        installBtn.id = 'btn-install';
        installBtn.type = 'button';
        toolbar.insertBefore(installBtn, toolbar.querySelector('#modal-nav'));
      }
    }
    if (installBtn) {
      if (!element._local) {
        installBtn.style.display = '';
        installBtn.textContent = '⤓ Install';
        installBtn.onclick = (e) => { e.preventDefault(); installElement(element, installBtn); };
      } else {
        installBtn.style.display = 'none';
      }
    }
    const submitBtn = modal.querySelector('#btn-submit');
    if (submitBtn) {
      if (element._local) {
        submitBtn.style.display = '';
        submitBtn.dataset.elementName = element.name;
        submitBtn.dataset.elementType = element.type;
      } else {
        submitBtn.style.display = 'none';
      }
    }
    return submitBtn;
  }

  async function openModal(element, index = -1) {
    const modal = document.getElementById('element-modal');
    if (!modal) return;

    openElementIndex = index;
    setupModalNav(index);
    setupModalMeta(element, modal);
    const submitBtn = setupModalLinks(element, modal);

    // Reset action buttons
    const copyBtn     = modal.querySelector('#btn-copy');
    const downloadBtn = modal.querySelector('#btn-download');
    copyBtn.onclick     = null;
    downloadBtn.onclick = null;
    copyBtn.textContent = '⎘ Copy';

    // Show modal with loading state
    const body = document.getElementById('modal-body');
    body.innerHTML = '<p class="loading">Loading content…</p>';
    body.tabIndex = -1; // make scrollable body focusable for keyboard scrolling
    modal.showModal();
    document.body.classList.add('modal-open');
    body.focus(); // focus body so arrow/Page/Home/End keys scroll content natively

    // Fetch element content — structured JSON for local, raw text for collection
    try {
      let content;       // raw file content (for Raw view, Copy, Download)
      let structured;    // { metadata, body, type, validation } when available

      if (element._content) {
        content = element._content;
      } else if (element._local) {
        const res = await DollhouseAuth.apiFetch(`/api/elements/${element.path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        structured = data;
        content = data.raw;
      } else {
        const res = await DollhouseAuth.apiFetch(`/api/collection/content/${element.path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        structured = data;
        content = data.raw;
      }

      const renderBtn = modal.querySelector('#btn-render');

      function renderModalBody() {
        if (modalShowRaw) {
          body.innerHTML = `<pre class="element-source"><code class="element-code language-yaml">${escapeHtml(content)}</code></pre>`;
          if (globalThis.hljs) body.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
        } else if (structured) {
          body.innerHTML = renderStructuredDetail(structured);
          body.querySelectorAll('pre code').forEach(b => {
            if (globalThis.hljs) hljs.highlightElement(b);
          });
        } else {
          body.innerHTML = renderDetailView(content, element.type);
          body.querySelectorAll('pre code').forEach(b => {
            if (globalThis.hljs) hljs.highlightElement(b);
          });
        }
      }

      renderModalBody();

      if (renderBtn) {
        // Reflect current sticky state so button label matches on navigation
        renderBtn.textContent = modalShowRaw ? '⇄ Rendered' : '⇄ Raw';
        renderBtn.dataset.mode = modalShowRaw ? 'raw' : 'rendered';
        renderBtn.onclick = () => {
          modalShowRaw = !modalShowRaw;
          renderBtn.textContent = modalShowRaw ? '⇄ Rendered' : '⇄ Raw';
          renderBtn.dataset.mode = modalShowRaw ? 'raw' : 'rendered';
          renderModalBody();
        };
      }

      copyBtn.onclick     = () => copyToClipboard(content, copyBtn);
      downloadBtn.onclick = () => downloadFile(element.name, content);

      if (element._local && submitBtn) {
        submitBtn.onclick = e => { e.preventDefault(); openSubmitIssue(element.name, element.type, content); };
      }

    } catch (err) {
      body.innerHTML = `<p class="error">Could not load content: ${escapeHtml(err.message)}</p>
        <p class="error-hint">
          <a href="${GITHUB_BASE}/${element.path}" target="_blank" rel="noopener noreferrer">
            View on GitHub directly
          </a>
        </p>`;
      console.error('[DollhouseMCP]', {
        error: err.message,
        context: 'modalLoad',
        element: element.path,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── Detail view renderer ───────────────────────────────────────────────────

  function parseFrontmatter(raw) {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return { frontmatter: {}, body: raw };
    let fm = {};
    try {
      fm = safeParseYaml(match[1]) || {};
    } catch {
      fm = {};
    }
    const body = raw.slice(match[0].length).trim();
    return { frontmatter: fm, body };
  }

  function renderComponentSummary(el) {
    // Only for ensembles — show component type counts from index metadata
    if (el.type !== 'ensemble' && el.type !== 'ensembles') return '';
    const counts = ['personas','skills','tools','templates','prompts','memories']
      .filter(k => Array.isArray(el[k]) && el[k].length)
      .map(k => `${el[k].length} ${k}`);
    if (!counts.length) return '';
    return `<p class="card-components">${counts.join(' · ')}</p>`;
  }

  // Fields whose string values are assumed to contain markdown content
  const MEMORY_MARKDOWN_FIELDS = new Set([
    'content', 'body', 'text', 'notes', 'summary', 'context', 'observations',
    'insights', 'instructions', 'thoughts', 'analysis', 'reflection', 'outcome',
    'details', 'log', 'data', 'value', 'message', 'description',
  ]);

  // Heuristic: does a multi-line string look like it has markdown syntax?
  function looksLikeMarkdown(str) {
    if (typeof str !== 'string' || !str.includes('\n')) return false;
    return /^(?:#{1,6}\s|\s{0,3}[-*+]\s|\s{0,3}\d+\.\s|>\s|```|\*\*|__|!\[)/m.test(str);
  }

  // Render a single memory entry object — markdown fields prominent, scalars in meta footer.
  function renderMemoryEntry(item) {
    if (typeof item !== 'object' || item === null) {
      return `<li>${escapeHtml(String(item))}</li>`;
    }
    let entryBody = '';
    const metaParts = [];
    for (const [k, v] of Object.entries(item)) {
      if (typeof v === 'string' && (MEMORY_MARKDOWN_FIELDS.has(k) || looksLikeMarkdown(v))) {
        entryBody += globalThis.marked
          ? `<div class="element-rendered memory-entry-content">${sanitizeHtml(marked.parse(v))}</div>`
          : `<pre class="detail-multiline">${escapeHtml(v)}</pre>`;
      } else if (Array.isArray(v)) {
        if (v.length) metaParts.push(`<span class="memory-meta-key">${escapeHtml(k)}</span> ${v.map(i => escapeHtml(String(i))).join(', ')}`);
      } else if (typeof v !== 'object' && v != null && v !== '') {
        metaParts.push(`<span class="memory-meta-key">${escapeHtml(k.replaceAll('_', ' '))}</span> ${escapeHtml(String(v))}`);
      }
    }
    const metaRow = metaParts.length ? `<div class="memory-entry-meta">${metaParts.join(' · ')}</div>` : '';
    return `<li class="memory-entry">${entryBody}${metaRow}</li>`;
  }

  function renderMemoryField(key, value) {
    const label = key.replaceAll('_', ' ');
    if (typeof value === 'string') {
      const isMarkdown = MEMORY_MARKDOWN_FIELDS.has(key) || looksLikeMarkdown(value);
      if (isMarkdown && globalThis.marked) {
        return detailSection(label, `<div class="element-rendered">${sanitizeHtml(marked.parse(value))}</div>`);
      }
      if (value.includes('\n')) {
        return detailSection(label, `<pre class="detail-multiline">${escapeHtml(value)}</pre>`);
      }
      return detailSection(label, `<p class="detail-prose">${escapeHtml(value)}</p>`);
    }
    if (Array.isArray(value)) {
      const items = value.map(item => renderMemoryEntry(item)).join('');
      return detailSection(label, `<ul class="memory-entries-list">${items}</ul>`);
    }
    if (typeof value === 'object' && value !== null) {
      const rows = Object.entries(value).map(([k, v]) =>
        detailField(k.replaceAll('_', ' '), typeof v === 'object' ? JSON.stringify(v) : String(v))
      ).filter(Boolean).join('');
      return rows ? detailSection(label, rows) : '';
    }
    if (value != null && value !== '') {
      return detailSection(label, `<p class="detail-prose">${escapeHtml(String(value))}</p>`);
    }
    return '';
  }

  // Render a pure-YAML memory file: parse each field, detect markdown, render appropriately
  function renderMemoryView(content) {
    let parsed;
    parsed = safeParseYaml(content);
    if (!parsed || typeof parsed !== 'object') {
      return `<pre class="element-source"><code class="element-code">${escapeHtml(content)}</code></pre>`;
    }

    let html = '';

    // Standard metadata at top
    const createdVal = parsed.created || parsed.created_date;
    if (createdVal) {
      html += `<div class="detail-created"><span class="detail-created-label">Created</span><span class="detail-created-value">${escapeHtml(formatDate(createdVal))}</span></div>`;
    }
    const meta = [detailField('Author', parsed.author), detailField('ID', parsed.unique_id || parsed.id)].filter(Boolean).join('');
    if (meta) html += detailSection('Details', meta);
    if (Array.isArray(parsed.tags) && parsed.tags.length) {
      html += detailSection('Tags', detailPillList(parsed.tags, 'pill-tag'));
    }

    // Render all remaining fields
    const SKIP = new Set(['name','type','created','created_date','updated','author','version','tags','unique_id','id']);
    for (const [key, value] of Object.entries(parsed)) {
      if (SKIP.has(key)) continue;
      html += renderMemoryField(key, value);
    }
    return html || `<pre class="element-source"><code class="element-code">${escapeHtml(content)}</code></pre>`;
  }

  function renderGoalSection(goal) {
    let goalHtml = '';
    if (goal.template) {
      const tplHtml = escapeHtml(String(goal.template))
        .replaceAll(/\{([^}]{1,100})\}/g, '<span class="detail-template-param">{$1}</span>');
      goalHtml += `<div class="detail-goal-template">${tplHtml}</div>`;
    }
    if (Array.isArray(goal.successCriteria) && goal.successCriteria.length) {
      const criteriaItems = goal.successCriteria.map(c => `<li>${escapeHtml(c)}</li>`).join('');
      goalHtml += `<h5 class="detail-subsection-title">Success criteria</h5>
        <ul class="detail-list">${criteriaItems}</ul>`;
    }
    if (Array.isArray(goal.parameters) && goal.parameters.length) {
      goalHtml += `<h5 class="detail-subsection-title">Parameters</h5>`;
      goalHtml += goal.parameters.map(p =>
        `<div class="detail-param">
          <div class="detail-param-header">
            <span class="detail-param-name">${escapeHtml(p.name || '')}</span>
            ${p.type ? `<span class="detail-pill pill-meta">${escapeHtml(p.type)}</span>` : ''}
            ${p.required ? `<span class="detail-pill pill-required">required</span>` : '<span class="detail-pill">optional</span>'}
          </div>
          ${p.description ? `<span class="detail-param-desc">${escapeHtml(p.description)}</span>` : ''}
        </div>`
      ).join('');
    }
    return goalHtml ? detailSection('Goal', goalHtml) : '';
  }

  function renderAutonomySection(a) {
    let aHtml = ['maxSteps','maxAutonomousSteps','safetyTier','riskTolerance']
      .filter(k => a[k] != null)
      .map(k => detailField(k.replaceAll(/([A-Z])/g, ' $1').toLowerCase().trim(), String(a[k])))
      .join('');
    if (Array.isArray(a.autoApprove) && a.autoApprove.length) {
      aHtml += `<div class="detail-field"><span class="detail-label">auto approve</span><span class="detail-value">${a.autoApprove.map(v => detailPill(v, 'pill-tag')).join(' ')}</span></div>`;
    }
    if (Array.isArray(a.requiresApproval) && a.requiresApproval.length) {
      aHtml += `<div class="detail-field"><span class="detail-label">requires approval</span><span class="detail-value">${a.requiresApproval.map(v => detailPill(v, 'pill-required')).join(' ')}</span></div>`;
    }
    return aHtml ? detailSection('Autonomy', aHtml) : '';
  }

  function renderGatekeeperSection(g) {
    let gHtml = '';
    if (Array.isArray(g.allow)   && g.allow.length)   gHtml += `<div class="detail-field"><span class="detail-label">allow</span><span class="detail-value">${g.allow.map(v => detailPill(v, 'pill-tag')).join(' ')}</span></div>`;
    if (Array.isArray(g.confirm) && g.confirm.length) gHtml += `<div class="detail-field"><span class="detail-label">confirm</span><span class="detail-value">${g.confirm.map(v => detailPill(v, 'pill-meta')).join(' ')}</span></div>`;
    if (Array.isArray(g.deny)    && g.deny.length)    gHtml += `<div class="detail-field"><span class="detail-label">deny</span><span class="detail-value">${g.deny.map(v => detailPill(v, 'pill-required')).join(' ')}</span></div>`;
    return gHtml ? detailSection('Gatekeeper', gHtml) : '';
  }

  // ── Agent sub-section helpers (extracted for cognitive complexity) ──────

  function renderLegacyGoals(fm) {
    if (!fm.goals || typeof fm.goals !== 'object') return '';
    let goalsHtml = '';
    if (fm.goals.primary) goalsHtml += `<p class="detail-prose">${escapeHtml(String(fm.goals.primary))}</p>`;
    if (Array.isArray(fm.goals.secondary) && fm.goals.secondary.length) {
      const items = fm.goals.secondary.map(g => `<li>${escapeHtml(g)}</li>`).join('');
      goalsHtml += `<ul class="detail-list">${items}</ul>`;
    }
    return goalsHtml ? detailSection('Goals', goalsHtml) : '';
  }

  function renderStateSection(fm) {
    if (!fm.state || typeof fm.state !== 'object') return '';
    let stateHtml = '';
    for (const [k, v] of Object.entries(fm.state)) {
      if (Array.isArray(v)) {
        stateHtml += `<div class="detail-field"><span class="detail-label">${escapeHtml(k.replaceAll('_', ' '))}</span><span class="detail-value">${detailPillList(v)}</span></div>`;
      } else {
        stateHtml += detailField(k.replaceAll('_', ' '), String(v));
      }
    }
    return stateHtml ? detailSection('State', stateHtml) : '';
  }

  function renderAgentToolsSection(fm) {
    if (!fm.tools || typeof fm.tools !== 'object') return '';
    let toolsHtml = '';
    if (Array.isArray(fm.tools.allowed) && fm.tools.allowed.length) {
      toolsHtml += `<div class="detail-field"><span class="detail-label">allowed</span><span class="detail-value">${fm.tools.allowed.map(v => detailPill(v, 'pill-tag')).join(' ')}</span></div>`;
    }
    if (Array.isArray(fm.tools.denied) && fm.tools.denied.length) {
      toolsHtml += `<div class="detail-field"><span class="detail-label">denied</span><span class="detail-value">${fm.tools.denied.map(v => detailPill(v, 'pill-required')).join(' ')}</span></div>`;
    }
    return toolsHtml ? detailSection('Tools', toolsHtml) : '';
  }

  function renderAgentV1Config(fm) {
    const agentConfig = ['decisionFramework','riskTolerance','learningEnabled','maxConcurrentGoals']
      .map(k => detailField(k.replaceAll(/([A-Z])/g, ' $1').toLowerCase().trim(), fm[k] == null ? null : String(fm[k])))
      .filter(Boolean).join('');
    return agentConfig ? detailSection('Configuration', agentConfig) : '';
  }

  function renderMarkdownOrPre(text) {
    return globalThis.marked
      ? `<div class="element-rendered">${sanitizeHtml(marked.parse(String(text)))}</div>`
      : `<pre class="detail-multiline">${escapeHtml(String(text))}</pre>`;
  }

  /**
   * Render instructions text with smart segmentation.
   *
   * Detects directive-style instructions (lines starting with command-voice
   * keywords like ALWAYS, NEVER, WHEN, YOU ARE, PREFER, etc.) and renders
   * each directive as a visually separated block. Falls back to standard
   * markdown rendering for non-directive content.
   */
  const DIRECTIVE_KEYWORDS = [
    'YOU','ALWAYS','NEVER','WHEN','PREFER','DO',"DON'T",'DONT','MUST','SHOULD',
    'IF','FOR','ENSURE','MAINTAIN','USE','AVOID','FOLLOW','PRIORITIZE','FOCUS',
    'REMEMBER','NOTE','IMPORTANT','CRITICAL',
  ];
  const DIRECTIVE_PATTERN = new RegExp(
    `^(${DIRECTIVE_KEYWORDS.join('|')})(\\s)`, 'i'
  );

  function renderInstructions(text) {
    if (!text) return '';
    const str = String(text);

    // Split on double newlines (paragraph boundaries)
    const paragraphs = str.split(/\n\n+/).filter(p => p.trim());
    if (paragraphs.length === 0) return '';

    // Detect directives in a single pass — cache match results
    const parsed = paragraphs.map(p => {
      const trimmed = p.trim();
      const match = trimmed.match(DIRECTIVE_PATTERN);
      return { trimmed, match };
    });

    const directiveCount = parsed.filter(p => p.match).length;
    const isDirectiveStyle = directiveCount >= 2 && directiveCount >= paragraphs.length * 0.3;

    if (!isDirectiveStyle) {
      return renderMarkdownOrPre(str);
    }

    // Render each paragraph as a segmented directive block.
    // DOMPurify sanitizes all rendered HTML to prevent XSS.
    // CSP headers provide an additional layer of protection.
    const blocks = parsed.map(({ trimmed, match }) => {
      if (match) {
        const keyword = escapeHtml(match[1]);
        const rest = trimmed.slice(match[0].length);
        const rendered = globalThis.marked
          ? sanitizeHtml(marked.parseInline(rest))
          : escapeHtml(rest);
        return `<div class="directive-block"><span class="directive-keyword">${keyword}</span> ${rendered}</div>`;
      }
      // Non-directive paragraph — render as markdown (DOMPurify sanitizes output)
      return globalThis.marked
        ? `<div class="directive-block directive-block--prose">${sanitizeHtml(marked.parse(trimmed))}</div>`
        : `<div class="directive-block directive-block--prose">${escapeHtml(trimmed)}</div>`;
    }).join('');

    return `<div class="directive-list">${blocks}</div>`;
  }

  function renderActivatesSection(fm) {
    if (!fm.activates || typeof fm.activates !== 'object') return '';
    const entries = Object.entries(fm.activates)
      .filter(([, v]) => Array.isArray(v) && v.length)
      .map(([k, v]) => `<div class="detail-field"><span class="detail-label">${escapeHtml(k)}</span><span class="detail-value">${detailPillList(v)}</span></div>`)
      .join('');
    return entries ? detailSection('Activates', entries) : '';
  }

  function renderResilienceSection(fm) {
    if (!fm.resilience || typeof fm.resilience !== 'object') return '';
    const fields = Object.entries(fm.resilience)
      .map(([k, v]) => detailField(k.replaceAll(/([A-Z])/g, ' $1').toLowerCase().trim(), String(v)))
      .filter(Boolean).join('');
    return fields ? detailSection('Resilience', fields) : '';
  }

  function renderRiskThresholds(fm) {
    if (!fm.risk_thresholds || typeof fm.risk_thresholds !== 'object') return '';
    const thresholds = Object.entries(fm.risk_thresholds)
      .map(([k, v]) => detailField(k.replaceAll('_', ' '), String(v)))
      .filter(Boolean).join('');
    return thresholds ? detailSection('Risk thresholds', thresholds) : '';
  }

  function renderAgentSection(fm) {
    let html = '';
    if (fm.instructions) html += detailSection('Instructions', renderInstructions(fm.instructions));
    if (fm.goal && typeof fm.goal === 'object') html += renderGoalSection(fm.goal);
    html += renderLegacyGoals(fm);
    if (fm.autonomy && typeof fm.autonomy === 'object') html += renderAutonomySection(fm.autonomy);
    if (fm.gatekeeper && typeof fm.gatekeeper === 'object') html += renderGatekeeperSection(fm.gatekeeper);
    if (fm.systemPrompt) html += detailSection('System prompt', renderMarkdownOrPre(fm.systemPrompt));
    html += renderActivatesSection(fm);
    html += renderAgentToolsSection(fm);
    html += renderResilienceSection(fm);
    if (Array.isArray(fm.capabilities) && fm.capabilities.length) {
      html += detailSection('Capabilities', detailPillList(fm.capabilities.map(c => String(c).replaceAll('_', ' ')), 'pill-tag'));
    }
    if (fm.decision_framework && typeof fm.decision_framework === 'object') html += renderDecisionFramework(fm.decision_framework);
    html += renderStateSection(fm);
    html += renderRiskThresholds(fm);
    html += renderAgentV1Config(fm);
    return html;
  }

  // ── Ensemble-specific rendering ──────────────────────────────────────────

  function buildElementPills(el) {
    const elType = el.element_type || el.type || '';
    const pills = [];
    if (elType) pills.push(detailPill(elType, 'pill-meta'));
    if (el.role) {
      const cls = (el.role === 'primary' || el.role === 'core') ? 'pill-required' : 'pill-tag';
      pills.push(detailPill(el.role, cls));
    }
    if (el.activation) {
      const cls = el.activation === 'always' ? 'pill-trigger' : '';
      pills.push(detailPill(el.activation, cls));
    }
    if (el.priority != null) {
      pills.push(detailPill(`priority ${el.priority}`));
    }
    return pills.join(' ');
  }

  function renderEnsembleElementRow(el) {
    if (typeof el !== 'object' || el === null) return '';
    const elName = el.element_name || el.name || '(unnamed)';
    const pills = buildElementPills(el);
    const purposeLine = el.purpose ? `<div class="detail-param-desc">${escapeHtml(el.purpose)}</div>` : '';
    const condLine = el.condition ? `<div class="detail-param-desc"><em>when:</em> <code>${escapeHtml(el.condition)}</code></div>` : '';
    const deps = Array.isArray(el.dependencies) && el.dependencies.length;
    const depsLine = deps ? `<div class="detail-param-desc"><em>depends on:</em> ${el.dependencies.map(d => detailPill(d)).join(' ')}</div>` : '';
    return `<div class="detail-param">
      <div class="detail-param-header"><span class="detail-param-name">${escapeHtml(elName)}</span>${pills}</div>
      ${purposeLine}${condLine}${depsLine}
    </div>`;
  }

  function renderEnsembleElements(elements) {
    if (!Array.isArray(elements) || !elements.length) return '';
    const rows = elements.map(renderEnsembleElementRow).filter(Boolean).join('');
    return rows ? detailSection('Elements', rows) : '';
  }

  function renderResourceLimits(fm) {
    const limits = fm.resource_limits || fm.resourceLimits;
    if (!limits || typeof limits !== 'object') return '';
    const fields = Object.entries(limits)
      .map(([k, v]) => detailField(k.replaceAll(/([A-Z])/g, ' $1').replaceAll('_', ' ').toLowerCase().trim(), String(v)))
      .filter(Boolean).join('');
    return fields ? detailSection('Resource limits', fields) : '';
  }

  function renderEnsembleSection(fm) {
    let html = '';
    if (fm.instructions) html += detailSection('Instructions', renderInstructions(fm.instructions));
    const configFields = [
      detailField('Activation strategy', fm.activation_strategy || fm.activationStrategy),
      detailField('Conflict resolution', fm.conflict_resolution || fm.conflictResolution),
      detailField('Context sharing', fm.context_sharing || fm.contextSharing),
      detailField('Allow nested', fm.allowNested == null ? null : String(fm.allowNested)),
      detailField('Max nesting depth', fm.maxNestingDepth == null ? null : String(fm.maxNestingDepth)),
    ].filter(Boolean).join('');
    if (configFields) html += detailSection('Ensemble configuration', configFields);
    html += renderEnsembleElements(fm.elements);
    html += renderResourceLimits(fm);
    if (fm.gatekeeper && typeof fm.gatekeeper === 'object') html += renderGatekeeperSection(fm.gatekeeper);
    return html;
  }

  function renderNestedDfObject(obj) {
    let nested = '';
    for (const [sk, sv] of Object.entries(obj)) {
      if (Array.isArray(sv)) {
        nested += `<div class="detail-field"><span class="detail-label">${escapeHtml(sk.replaceAll('_', ' '))}</span><span class="detail-value">${detailPillList(sv.map(i => String(i).replaceAll('_', ' ')))}</span></div>`;
      } else {
        nested += detailField(sk.replaceAll('_', ' '), String(sv));
      }
    }
    return nested;
  }

  function renderDecisionFramework(df) {
    let html = '';
    if (df.type) html += detailField('Type', String(df.type).replaceAll(/[-_]/g, ' '));

    // Render any array fields as pill lists (rules_engine, ml_components, evaluation_criteria, etc.)
    for (const [k, v] of Object.entries(df)) {
      if (k === 'type') continue;
      if (Array.isArray(v)) {
        html += `<div class="detail-field"><span class="detail-label">${escapeHtml(k.replaceAll('_', ' '))}</span><span class="detail-value">${detailPillList(v.map(i => String(i).replaceAll('_', ' ')))}</span></div>`;
      } else if (typeof v === 'object' && v !== null) {
        const nested = renderNestedDfObject(v);
        if (nested) html += detailSection(k.replaceAll('_', ' '), nested);
      } else {
        html += detailField(k.replaceAll('_', ' '), String(v));
      }
    }
    return html ? detailSection('Decision framework', html) : '';
  }

  function renderDetailParameters(fm) {
    if (!fm.parameters || typeof fm.parameters !== 'object' || Array.isArray(fm.parameters)) return '';
    const paramRows = Object.entries(fm.parameters).map(([name, def]) => {
      const d = typeof def === 'object' && def !== null ? def : {};
      const enumValues = Array.isArray(d.enum) && d.enum.length
        ? `<div class="detail-param-enum">${d.enum.map(v => detailPill(v, 'pill-meta')).join(' ')}</div>`
        : '';
      const defaultVal = d.default === undefined ? ''
        : Array.isArray(d.default)
          ? `<span class="detail-pill">default: ${escapeHtml(d.default.join(', '))}</span>`
          : `<span class="detail-pill">default: ${escapeHtml(String(d.default))}</span>`;
      return `<div class="detail-param">
        <div class="detail-param-header">
          <span class="detail-param-name">${escapeHtml(name)}</span>
          ${d.type ? `<span class="detail-pill pill-meta">${escapeHtml(d.type)}</span>` : ''}
          ${d.required ? `<span class="detail-pill pill-required">required</span>` : ''}
          ${defaultVal}
        </div>
        ${d.description ? `<span class="detail-param-desc">${escapeHtml(d.description)}</span>` : ''}
        ${enumValues}
      </div>`;
    }).join('');
    return paramRows ? detailSection('Parameters', paramRows) : '';
  }

  function renderDetailVariables(fm) {
    if (!Array.isArray(fm.variables) || !fm.variables.length) return '';
    const rows = fm.variables.map(v => {
      if (typeof v === 'string') return `<div class="detail-param"><span class="detail-param-name">${escapeHtml(v)}</span></div>`;
      if (typeof v !== 'object' || v === null) return '';
      return `<div class="detail-param">
        <div class="detail-param-header">
          <span class="detail-param-name">${escapeHtml(v.name || '')}</span>
          ${v.type ? `<span class="detail-pill pill-meta">${escapeHtml(v.type)}</span>` : ''}
          ${v.required ? `<span class="detail-pill pill-required">required</span>` : ''}
          ${v.default === undefined ? '' : `<span class="detail-pill">default: ${escapeHtml(String(v.default))}</span>`}
        </div>
        ${v.description ? `<span class="detail-param-desc">${escapeHtml(v.description)}</span>` : ''}
      </div>`;
    }).filter(Boolean).join('');
    return rows ? detailSection('Variables', rows) : '';
  }

  function renderExtraValue(key, value) {
    const label = key.replaceAll('_', ' ');
    if (value == null || value === '') return '';
    if (typeof value === 'boolean') return detailField(label, value ? 'Yes' : 'No');
    if (typeof value === 'number' || typeof value === 'string') return detailField(label, String(value));
    if (Array.isArray(value)) {
      if (value.length === 0) return '';
      // Array of simple values → pill list
      if (value.every(v => typeof v === 'string' || typeof v === 'number')) {
        return `<div class="detail-field"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${detailPillList(value.map(String))}</span></div>`;
      }
      // Array of objects → render each as a sub-block
      const items = value.map(item => {
        if (typeof item !== 'object' || item === null) return `<li>${escapeHtml(String(item))}</li>`;
        const fields = Object.entries(item)
          .map(([k, v]) => `<strong>${escapeHtml(k.replaceAll('_', ' '))}</strong>: ${escapeHtml(String(v))}`)
          .join(' · ');
        return `<li class="detail-prose">${fields}</li>`;
      }).join('');
      return detailSection(label, `<ul class="detail-list">${items}</ul>`);
    }
    if (typeof value === 'object') {
      // Object → render as field list
      const fields = Object.entries(value)
        .map(([k, v]) => {
          if (typeof v === 'object' && v !== null) return detailField(k.replaceAll('_', ' '), JSON.stringify(v));
          return detailField(k.replaceAll('_', ' '), String(v));
        })
        .filter(Boolean).join('');
      return fields ? detailSection(label, fields) : '';
    }
    return detailField(label, String(value));
  }

  function renderDetailExtra(fm, body) {
    const knownFields = new Set([
      'name','type','description','author','version','category','license','age_rating',
      'created','created_date','updated','modified','tags','triggers','use_cases','parameters',
      'proficiency_levels','coordination_strategy','variables',
      'personas','skills','tools','templates','prompts','memories',
      'instructions','goal','goals','autonomy','gatekeeper',
      'systemPrompt','activates','tools','resilience',
      'capabilities','decision_framework','state','risk_thresholds',
      'decisionFramework','riskTolerance','learningEnabled','maxConcurrentGoals',
      'specializations','ruleEngineConfig',
      'activation_strategy','activationStrategy','conflict_resolution','conflictResolution',
      'context_sharing','contextSharing','resource_limits','resourceLimits',
      'elements','allowNested','maxNestingDepth','components',
      'unique_id','content_flags','system_prompt','systemPrompt',
    ]);

    const extraFields = Object.entries(fm)
      .filter(([k]) => !knownFields.has(k))
      .map(([k, v]) => renderExtraValue(k, v))
      .filter(Boolean).join('');
    let html = extraFields ? detailSection('Additional metadata', extraFields) : '';
    if (body) {
      const rendered = globalThis.marked
        ? `<div class="element-rendered">${sanitizeHtml(marked.parse(body))}</div>`
        : `<pre class="element-source"><code class="element-code">${escapeHtml(body)}</code></pre>`;
      html += detailSection('Content', rendered);
    }
    return html;
  }

  /** Render common metadata sections (created, author, tags, etc.) shared by both renderers */
  function renderCommonMetadata(fm, type) {
    let html = '';

    const createdVal = fm.created || fm.created_date;
    if (createdVal) {
      html += `<div class="detail-created"><span class="detail-created-label">Created</span><span class="detail-created-value">${escapeHtml(formatDate(createdVal))}</span></div>`;
    }

    const coreFields = [
      detailField('Author', fm.author),
      detailField('Version', fm.version ? `v${fm.version}` : null),
      detailField('Category', fm.category),
      detailField('License', fm.license),
      detailField('Age rating', fm.age_rating),
      detailField('Modified', fm.modified ? formatDate(fm.modified) : null),
    ].filter(Boolean).join('');
    if (coreFields) html += detailSection('Details', coreFields);

    if (Array.isArray(fm.tags) && fm.tags.length) {
      html += detailSection('Tags', detailPillList(fm.tags, 'pill-tag'));
    }
    if (Array.isArray(fm.triggers) && fm.triggers.length) {
      html += detailSection('Trigger words', detailPillList(fm.triggers, 'pill-trigger'));
    }

    html += renderComponentsSections(fm);
    if (fm.coordination_strategy) html += detailSection('Coordination', `<p class="detail-prose">${escapeHtml(fm.coordination_strategy)}</p>`);
    html += renderUseCases(fm);

    if (fm.instructions && type !== 'agent' && type !== 'ensemble') {
      html += detailSection('Instructions', renderInstructions(fm.instructions));
    }
    if (fm.gatekeeper && typeof fm.gatekeeper === 'object' && type !== 'agent' && type !== 'ensemble') {
      html += renderGatekeeperSection(fm.gatekeeper);
    }

    return html;
  }

  /** Render components section (ensembles) */
  function renderComponentsSections(fm) {
    const compTypes = ['personas','skills','tools','templates','prompts','memories'];
    const compEntries = compTypes
      .filter(k => Array.isArray(fm[k]) && fm[k].length)
      .map(k => `<div class="detail-field"><span class="detail-label">${capitalize(k)}</span><span class="detail-value">${detailPillList(fm[k])}</span></div>`)
      .join('');
    return compEntries ? detailSection('Components', compEntries) : '';
  }

  /** Render use cases section */
  function renderUseCases(fm) {
    if (!Array.isArray(fm.use_cases) || !fm.use_cases.length) return '';
    const items = fm.use_cases.map(u => `<li>${escapeHtml(u)}</li>`).join('');
    return detailSection('Use cases', `<ul class="detail-list">${items}</ul>`);
  }

  /** Render type-specific sections (parameters, agent, ensemble, proficiency) */
  function renderTypeSpecificSections(fm, type) {
    let html = '';
    html += renderDetailParameters(fm);
    html += renderDetailVariables(fm);
    if (fm.proficiency_levels && typeof fm.proficiency_levels === 'object') {
      const levels = Object.entries(fm.proficiency_levels)
        .map(([lvl, desc]) => detailField(capitalize(lvl), desc)).join('');
      if (levels) html += detailSection('Proficiency levels', levels);
    }
    if (type === 'agent') html += renderAgentSection(fm);
    if (type === 'ensemble') html += renderEnsembleSection(fm);
    return html;
  }

  /**
   * Render element detail from pre-parsed structured JSON.
   * The server has already validated and parsed the YAML — no client-side
   * re-parsing needed. Uses the same rendering helpers as renderDetailView.
   */
  function renderStructuredDetail(data) {
    const { metadata: fm, body, type } = data;
    if (!fm || typeof fm !== 'object') {
      return `<pre class="element-source"><code class="element-code">${escapeHtml(data.raw || JSON.stringify(data))}</code></pre>`;
    }

    if (type === 'memory') {
      return renderMemoryView(data.raw);
    }

    let html = '';

    if (data.validation?.status === 'warn') {
      html += `<div class="detail-validation-warn">Security scan: ${escapeHtml(data.validation?.reason || 'warning')}</div>`;
    }

    html += renderCommonMetadata(fm, type);
    html += renderTypeSpecificSections(fm, type);
    html += renderDetailExtra(fm, body || '');

    return html || `<pre class="element-source"><code class="element-code">${escapeHtml(data.raw || '')}</code></pre>`;
  }

  function renderDetailView(content, type) { // NOSONAR - sequential independent metadata sections; complexity score is inflated by &&-guards on array existence checks
    if (type === 'memory') {
      // Portfolio memories are pure YAML — jsyaml.load succeeds.
      // Collection memories are markdown-with-frontmatter — jsyaml.load throws on the
      // second `---` document marker, so we fall through to the standard renderer below.
      try {
        const parsed = safeParseYaml(content);
        if (parsed && typeof parsed === 'object') return renderMemoryView(content);
      } catch { /* not pure YAML — fall through */ }
    }

    const { frontmatter: fm, body } = parseFrontmatter(content);
    let html = '';

    html += renderCommonMetadata(fm, type);
    html += renderTypeSpecificSections(fm, type);
    html += renderDetailExtra(fm, body);

    return html || `<pre class="element-source"><code class="element-code">${escapeHtml(content)}</code></pre>`;
  }

  function closeModal() {
    const modal = document.getElementById('element-modal');
    if (!modal) return;
    modal.close();
    document.body.classList.remove('modal-open');
  }

  // ── Grid keyboard navigation ───────────────────────────────────────────────

  function highlightCard(index) {
    const grid = document.getElementById('elements-grid');
    if (!grid) return;
    const cards = grid.querySelectorAll('.element-card');
    // Clear previous highlight
    cards.forEach(c => c.classList.remove('keyboard-focus'));
    if (index < 0 || index >= cards.length) return;
    highlightedCardIndex = index;
    const card = cards[index];
    card.classList.add('keyboard-focus');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function getVisibleCardCount() {
    const grid = document.getElementById('elements-grid');
    return grid ? grid.querySelectorAll('.element-card').length : 0;
  }

  function getGridColumns() {
    const grid = document.getElementById('elements-grid');
    if (!grid) return 1;
    // For list view, it's always a single column
    if (grid.dataset.view === 'list') return 1;
    // Read actual computed column count from the CSS grid
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    return Math.max(1, cols);
  }

  function openHighlightedCard() {
    const grid = document.getElementById('elements-grid');
    if (!grid || highlightedCardIndex < 0) return;
    const card = grid.querySelectorAll('.element-card')[highlightedCardIndex];
    if (!card) return;
    const idx = Number.parseInt(card.dataset.index, 10);
    const el = filteredElements[idx];
    if (!el) return;
    const isListView = grid.dataset.view === 'list';
    if (isListView) {
      toggleInlineExpand(card, el);
    } else if (!card.dataset.unavailable) {
      openModal(el, idx);
    }
  }

  function getModalNavTarget(key) {
    const last = filteredElements.length - 1;
    if ((key === 'ArrowLeft' || key === 'k') && openElementIndex > 0) return openElementIndex - 1;
    if ((key === 'ArrowRight' || key === 'j') && openElementIndex < last) return openElementIndex + 1;
    return -1;
  }

  function handleModalKeyboard(e, modal) {
    if (e.key === 'r' || e.key === 'R') {
      const renderBtn = modal.querySelector('#btn-render');
      if (renderBtn?.onclick) { e.preventDefault(); renderBtn.onclick(); }
      return;
    }
    const target = getModalNavTarget(e.key);
    if (target >= 0) {
      e.preventDefault();
      openModal(filteredElements[target], target);
    }
  }

  function handleGridKeyboard(e, sInput) {
    const cardCount = getVisibleCardCount();
    if (!cardCount) return;
    const last = cardCount - 1;
    const cols = getGridColumns();
    let target = highlightedCardIndex;
    switch (e.key) {
      case 'ArrowRight':  target = Math.min(last, target + 1); break;
      case 'ArrowLeft':   target = Math.max(0, target <= 0 ? 0 : target - 1); break;
      case 'j': case 'ArrowDown':  target = Math.min(last, (target < 0 ? -cols : target) + cols); break;
      case 'k': case 'ArrowUp':    target = Math.max(0, target - cols); break;
      case 'Home':        target = 0; break;
      case 'End':         target = last; break;
      case 'PageDown':    target = Math.min(last, target + cols * 3); break;
      case 'PageUp':      target = Math.max(0, target - cols * 3); break;
      case 'Enter': case ' ':
        if (highlightedCardIndex >= 0) { e.preventDefault(); openHighlightedCard(); }
        return;
      case '/':
        e.preventDefault();
        sInput?.focus();
        return;
      default: return;
    }
    e.preventDefault();
    highlightCard(target);
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function copyToClipboard(text, btn) {
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied!';
    } catch {
      // Fallback for non-https contexts
      try {
        const ta = Object.assign(document.createElement('textarea'), {
          value: text,
          style: 'position:fixed;opacity:0;top:-9999px'
        });
        document.body.appendChild(ta);
        ta.select();
        // NOSONAR - Intentional fallback for non-HTTPS contexts where Clipboard API is unavailable
        document.execCommand('copy');
        ta.remove();
        btn.textContent = 'Copied!';
      } catch {
        btn.textContent = 'Copy failed';
      }
    }
    setTimeout(() => { btn.textContent = original; }, 2000);
  }

  function downloadFile(name, content) {
    const slug = name.toLowerCase().split(/[^a-z0-9]/).filter(Boolean).join('-');
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: `${slug}.md` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Open a GitHub "new issue" submission for a local element.
  // Content is copied to clipboard; only metadata goes in the URL (avoids URL-too-long errors).
  function openSubmitIssue(name, type, content) {
    // Copy raw content to clipboard — no fencing until frontmatter detection is reliable.
    navigator.clipboard.writeText(content).catch(() => {});
    const body = `✅ Your element content has already been copied to your clipboard, wrapped in a code block. Just paste (Cmd+V / Ctrl+V) to replace this line.`;
    const issueTitle = `Submit: ${name}`;
    const url  = `https://github.com/DollhouseMCP/collection/issues/new`
               + `?title=${encodeURIComponent(issueTitle)}`
               + `&labels=submission`
               + `&body=${encodeURIComponent(body)}`;
    globalThis.open(url, '_blank', 'noopener,noreferrer');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#x27;');
  }

  /** Sanitize HTML through DOMPurify (falls back to escapeHtml if DOMPurify is unavailable). */
  function sanitizeHtml(html) {
    return globalThis.DOMPurify ? DOMPurify.sanitize(html) : escapeHtml(html);
  }

  function escapeAttr(str) {
    return String(str || '').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });
    } catch {
      return iso;
    }
  }

  // ── Shared detail-view building blocks ────────────────────────────────────

  const detailSection = (label, html) =>
    `<section class="detail-section"><h4 class="detail-section-title">${escapeHtml(label)}</h4><div class="detail-section-body">${html}</div></section>`;

  const detailPill = (text, cls = '') => {
    const clsSuffix = cls ? ` ${cls}` : '';
    return `<span class="detail-pill${clsSuffix}">${escapeHtml(String(text))}</span>`;
  };

  const detailField = (label, value) =>
    value != null && value !== '' ? `<div class="detail-field"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(String(value))}</span></div>` : '';

  const detailPillList = (items, cls) =>
    Array.isArray(items) && items.length
      ? `<div class="detail-pills">${items.map(t => detailPill(t, cls)).join('')}</div>`
      : '';

  // ── Local portfolio ────────────────────────────────────────────────────────

  // Skip hidden files, index/meta files, and backup entries
  function isPortfolioSkip(name) {
    const lower = name.toLowerCase();
    return name.startsWith('.') ||     // hidden (.DS_Store, etc.)
           name.startsWith('_') ||     // meta (_index.json, etc.)
           lower.includes('backup') || // backup dirs/files
           name.endsWith('.backup');   // explicit backup extension
  }

  // Extract a YYYY-MM-DD date string from a relative file path.
  // Handles both slash-separated dirs (2026/01/15/) and hyphen-prefixed filenames (2026-01-15_topic.yaml).
  function dateFromPath(path) {
    const m = path.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  // Recursively collect files matching extensions from a directory handle.
  // Returns { name, handle, path } where path is relative to the type subdir (e.g. "2026/01/15/note.yaml").
  async function collectLocalFiles(dirHandle, extensions, maxDepth = PORTFOLIO_MAX_DEPTH, prefix = '') {
    const results = [];
    try {
      for await (const [name, handle] of dirHandle.entries()) {
        if (isPortfolioSkip(name)) continue;
        if (handle.kind === 'file' && extensions.some(ext => name.endsWith(ext))) {
          results.push({ name, handle, path: prefix + name });
        } else if (handle.kind === 'directory' && maxDepth > 0) {
          const sub = await collectLocalFiles(handle, extensions, maxDepth - 1, prefix + name + '/');
          results.push(...sub);
        }
      }
    } catch (err) {
      console.warn('[DollhouseMCP] Portfolio directory read error:', err.message);
    }
    return results;
  }

  // Parse file content — pure YAML files vs frontmatter markdown
  function parseLocalFile(content, name) {
    if (name.endsWith('.yaml') || name.endsWith('.yml')) {
      try {
        const fm = safeParseYaml(content) || {};
        return { frontmatter: typeof fm === 'object' && fm !== null ? fm : {}, body: '' };
      } catch {
        return { frontmatter: {}, body: '' };
      }
    }
    return parseFrontmatter(content);
  }

  function finalizePortfolioUI(btn) {
    try { renderTypeFilters(); } catch (err) { console.warn('[DollhouseMCP] renderTypeFilters error:', err.message); }
    try { renderTopicFilters(); } catch (err) { console.warn('[DollhouseMCP] renderTopicFilters error:', err.message); }
    applyFilters();
    if (btn) {
      btn.textContent = localElements.length > 0
        ? `📁 Portfolio (${localElements.length})`
        : '📁 Portfolio (empty)';
      btn.dataset.loaded = 'true';
    }
  }

  function handlePortfolioError(err, btn, prevText) {
    if (err.name === 'AbortError') {
      if (btn) btn.textContent = prevText;
    } else {
      console.error('[DollhouseMCP] Portfolio load error:', err.message);
      if (btn) btn.textContent = '📁 Portfolio (error)';
    }
  }

  async function loadTypeDirectory(dirHandle, subdirName, type, extensions, btn) {
    try {
      const subdir = await dirHandle.getDirectoryHandle(subdirName);
      const fileEntries = await collectLocalFiles(subdir, extensions, PORTFOLIO_MAX_DEPTH);
      // Sort descending so newest date-prefixed dirs/files load into page 1 first
      fileEntries.sort((a, b) => b.path.localeCompare(a.path));

      // Read files in parallel batches; update UI every batch so progress is visible
      for (let i = 0; i < fileEntries.length; i += FILE_READ_CONCURRENCY) {
        const batch = fileEntries.slice(i, i + FILE_READ_CONCURRENCY);
        await Promise.all(batch.map(async ({ name, handle, path }) => {
          try {
            const file = await handle.getFile();
            const content = await file.text();
            const { frontmatter: fm } = parseLocalFile(content, name);
            localElements.push({
              name: fm.name || name.replace(/\.(md|yaml|yml)$/, ''),
              type,
              description: fm.description || '',
              author: fm.author || '',
              version: fm.version ? String(fm.version) : '',
              tags: Array.isArray(fm.tags) ? fm.tags : [],
              created: fm.created_date || fm.created || fm.date || dateFromPath(path) || null,
              _local: true,
              _content: content,
              path,
            });
          } catch { /* skip unreadable file */ }
        }));

        // Update UI after each batch so user sees content appear progressively
        allElements = [...collectionElements, ...localElements];
        if (btn) btn.textContent = `📁 Loading… (${localElements.length})`;
        try { applyFilters(); } catch { /* non-fatal */ }
      }
    } catch { /* subdir may not exist — skip silently */ }
  }

  async function loadLocalPortfolio() {
    if (!globalThis.showDirectoryPicker) {
      alert('Your browser does not support the File System Access API.\nTry Chrome or Edge on desktop.');
      return;
    }

    const btn = document.getElementById('btn-portfolio');
    const prevText = btn?.textContent;
    if (btn) btn.textContent = '…';

    try {
      const dirHandle = await globalThis.showDirectoryPicker({ mode: 'read' });

      const TYPE_EXTENSIONS = {
        agents: ['.md'], personas: ['.md'], skills: ['.md'],
        templates: ['.md'], ensembles: ['.md'], prompts: ['.md'],
        memories: ['.yaml', '.yml'], tools: ['.md'],
      };

      localElements = [];

      for (const [subdirName, type] of Object.entries(SINGULAR_TYPE)) {
        const extensions = TYPE_EXTENSIONS[subdirName] || ['.md'];
        await loadTypeDirectory(dirHandle, subdirName, type, extensions, btn);
      }

      finalizePortfolioUI(btn);
    } catch (err) {
      handlePortfolioError(err, btn, prevText);
    }
  }

  // ── URL parameter helpers ────────────────────────────────────────────────

  /**
   * Map sort + order URL params to the select value format used by the UI.
   */
  function mapSortParams(sort = 'name', order = 'asc') {
    if (sort === 'name') return `name-${order}`;
    if (sort === 'updated' || sort === 'created') return `date-${order}`;
    return `${sort}-${order}`;
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    updateFooterVersion();
    wireThemeToggle();
    wireViewToggle();
    wireSortControls();

    // Search
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.addEventListener('input', onSearch);

    // Modal close
    document.getElementById('modal-close')?.addEventListener('click', closeModal);
    document.getElementById('modal-overlay')?.addEventListener('click', closeModal);

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      const inInput = ['INPUT','TEXTAREA'].includes(document.activeElement?.tagName);
      const modal = document.getElementById('element-modal');
      const modalOpen = modal?.open;

      // ── Escape: close modal or clear search ──
      if (e.key === 'Escape') {
        if (modalOpen) { closeModal(); return; }
        if (inInput && searchInput) { searchInput.blur(); return; }
        return;
      }

      // ── Modal-open shortcuts ──
      if (modalOpen && !inInput) {
        handleModalKeyboard(e, modal);
        return;
      }

      // ── Grid navigation (modal closed) ──
      if (!inInput) {
        handleGridKeyboard(e, searchInput);
      }
    });

    wireSourceToggle();

    // Portfolio button
    document.getElementById('btn-portfolio')?.addEventListener('click', loadLocalPortfolio);

    // ── Tab switching ─────────────────────────────────────────────────────────
    const consoleTabs = document.getElementById('console-tabs');
    const headerNavRow = document.querySelector('.header-nav-row');
    const consoleTabMenuToggle = document.getElementById('console-tab-menu-toggle');
    const consoleTabMenu = document.getElementById('console-tab-menu');
    const tabInits = { logs: false, metrics: false, permissions: false, security: false };

    const TAB_KEY = 'dollhousemcp-active-tab';
    const SETUP_SEEN_KEY = 'dollhousemcp-setup-seen';
    const FORCED_RELOAD_KEY = 'dollhousemcp-last-forced-reload';
    // Server version injected at request time — used to show Setup tab once per version
    // so upgraders automatically see it on each new release (not just first-ever visit).
    // Validate format (semver-like) before trusting the value; malformed falls back to
    // 'unknown' which safely triggers setup on every load rather than silently skipping.
    const _rawVersion = document.querySelector('meta[name="dollhouse-server-version"]')?.content || '';
    const currentServerVersion = /^\d+\.\d+\.\d+/.test(_rawVersion) ? _rawVersion : 'unknown';
    const _rawAssetVersion = document.querySelector('meta[name="dollhouse-console-asset-version"]')?.content || '';
    const currentAssetVersion = /^\d+\.\d+\.\d+/.test(_rawAssetVersion) ? _rawAssetVersion : currentServerVersion;
    let forcedReloadInFlight = false;

    function normalizeReloadVersion(version) {
      return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)
        ? version
        : (currentAssetVersion || currentServerVersion || 'unknown');
    }

    function shouldThrottleForcedReload(targetVersion) {
      try {
        const raw = sessionStorage.getItem(FORCED_RELOAD_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return parsed
          && parsed.version === targetVersion
          && typeof parsed.at === 'number'
          && Date.now() - parsed.at < 60_000;
      } catch {
        return false;
      }
    }

    function rememberForcedReload(targetVersion, reason) {
      try {
        sessionStorage.setItem(FORCED_RELOAD_KEY, JSON.stringify({
          version: targetVersion,
          reason: reason || 'manual',
          at: Date.now(),
        }));
      } catch {
        // Ignore storage failures — reload still proceeds.
      }
    }

    function buildCacheBustedConsoleUrl(targetVersion, reason) {
      const url = new URL(globalThis.location.href);
      url.searchParams.set('dollhouse_bust', targetVersion + '-' + Date.now());
      url.searchParams.set('dollhouse_asset_version', targetVersion);
      if (reason) {
        url.searchParams.set('dollhouse_reload_reason', reason);
      }
      return url.toString();
    }

    function forceConsoleReload(reason, targetVersion) {
      const normalizedTargetVersion = normalizeReloadVersion(targetVersion);
      if (forcedReloadInFlight || shouldThrottleForcedReload(normalizedTargetVersion)) {
        return false;
      }
      forcedReloadInFlight = true;
      rememberForcedReload(normalizedTargetVersion, reason);
      const reloadUrl = buildCacheBustedConsoleUrl(normalizedTargetVersion, reason);
      globalThis.location.replace(reloadUrl);
      return true;
    }

    // Determine which tab to show on load:
    // 1. URL hash (deep link)
    // 2. Saved tab from last visit (localStorage)
    // 3. Setup tab if not seen on this version yet
    // 4. Portfolio (HTML default)
    const switchToTab = (tabName) => {
      if (!consoleTabs) return;
      const btn = consoleTabs.querySelector(`[data-tab="${tabName}"]`);
      if (!btn) return;
      consoleTabs.querySelectorAll('.console-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.hidden = p.id !== 'tab-' + tabName;
        p.classList.toggle('active', p.id === 'tab-' + tabName);
      });
      syncConsoleTabMenuSelection();
      closeConsoleTabMenu();
      scheduleConsoleTabOverflowCheck();
    };

    function renderConsoleTabMenu() {
      if (!consoleTabs || !consoleTabMenu) return;
      consoleTabMenu.innerHTML = '';
      consoleTabs.querySelectorAll('.console-tab').forEach((btn) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'console-tab-menu-item';
        item.dataset.tab = btn.dataset.tab || '';
        item.setAttribute('role', 'menuitem');
        item.textContent = btn.textContent || '';
        if (btn.classList.contains('active')) item.classList.add('active');
        consoleTabMenu.appendChild(item);
      });
    }

    function syncConsoleTabMenuSelection() {
      if (!consoleTabs || !consoleTabMenu) return;
      const activeTab = consoleTabs.querySelector('.console-tab.active')?.dataset.tab || '';
      consoleTabMenu.querySelectorAll('.console-tab-menu-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.tab === activeTab);
      });
    }

    function closeConsoleTabMenu() {
      if (!consoleTabMenu || !consoleTabMenuToggle) return;
      consoleTabMenu.hidden = true;
      consoleTabMenuToggle.setAttribute('aria-expanded', 'false');
    }

    function tabsNeedOverflowMenu() {
      if (!consoleTabs) return false;
      const buttons = Array.from(consoleTabs.querySelectorAll('.console-tab'));
      if (buttons.length < 2) return false;
      const firstTop = buttons[0].offsetTop;
      return buttons.some((btn) => btn.offsetTop !== firstTop);
    }

    let consoleTabOverflowFrame = 0;
    function updateConsoleTabOverflow() {
      if (!consoleTabs || !headerNavRow || !consoleTabMenuToggle) return;
      headerNavRow.classList.remove('header-nav-row--collapsed');
      consoleTabMenuToggle.hidden = true;
      const shouldCollapse = tabsNeedOverflowMenu();
      if (shouldCollapse) {
        headerNavRow.classList.add('header-nav-row--collapsed');
        consoleTabMenuToggle.hidden = false;
      }
      if (!shouldCollapse) {
        closeConsoleTabMenu();
      }
    }

    function scheduleConsoleTabOverflowCheck() {
      if (consoleTabOverflowFrame) cancelAnimationFrame(consoleTabOverflowFrame);
      consoleTabOverflowFrame = requestAnimationFrame(() => {
        consoleTabOverflowFrame = 0;
        updateConsoleTabOverflow();
      });
    }

    /**
     * Parse the URL hash into tab name and query parameters.
     * Supports fragment-query pattern: #tab?key=value&key=value
     * @returns {{ tab: string, params: URLSearchParams }}
     */
    function getTabAndParams() {
      const raw = globalThis.location.hash.replace('#', '');
      // Guard against excessively long URLs (browser limit ~2048 chars)
      if (raw.length > 2048) return { tab: '', params: new URLSearchParams() };
      const qIdx = raw.indexOf('?');
      if (qIdx === -1) return { tab: raw, params: new URLSearchParams() };
      return {
        tab: raw.substring(0, qIdx),
        params: new URLSearchParams(raw.substring(qIdx + 1)),
      };
    }

    // Expose for other scripts (logs.js, metrics.js, permissions.js)
    globalThis.DollhouseConsole = globalThis.DollhouseConsole || {};
    globalThis.DollhouseConsole.getUrlParams = () => getTabAndParams().params;
    globalThis.DollhouseConsole.currentServerVersion = currentServerVersion;
    globalThis.DollhouseConsole.currentAssetVersion = currentAssetVersion;
    globalThis.DollhouseConsole.forceReload = forceConsoleReload;

    /**
     * Apply URL params to the portfolio tab.
     * Reads q, type, name, sort, order, active, category, author, page.
     */
    function applyPortfolioParams(params) {
      if (!params || params.toString() === '') return;

      applyPortfolioSearch(params);
      applyPortfolioTypeFilter(params);
      applyPortfolioSort(params);

      // active — filter to active elements only
      if (params.get('active') === 'true') {
        activeSource = 'portfolio';
      }

      // page
      const page = params.get('page');
      if (page) {
        currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
      }

      applyFilters();
      applyPortfolioNameNavigation(params);
    }

    function applyPortfolioSearch(params) {
      const q = params.get('q');
      if (!q) return;
      const searchInput = document.getElementById('search-input');
      if (searchInput) {
        searchInput.value = q;
        searchQuery = q.toLowerCase();
      }
    }

    function applyPortfolioTypeFilter(params) {
      const type = params.get('type');
      if (!type) return;
      activeTypes.clear();
      activeTypes.add(type);
      document.querySelectorAll('.type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === type);
      });
    }

    function applyPortfolioSort(params) {
      const sort = params.get('sort');
      const order = params.get('order');
      if (!sort && !order) return;
      const sortSelect = document.getElementById('sort-select');
      if (sortSelect) {
        const mapped = mapSortParams(sort, order);
        sortSelect.value = mapped;
        activeSort = mapped;
      }
    }

    function applyPortfolioNameNavigation(params) {
      const name = params.get('name');
      if (!name) return;
      requestAnimationFrame(() => {
        const card = document.querySelector(`[data-element-name="${CSS.escape(name)}"]`);
        if (card) {
          card.click();
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }

    // Tab selection priority: URL hash > localStorage > first-visit setup > portfolio default
    function applyHashTab() {
      const { tab: hashTab, params } = getTabAndParams();
      if (hashTab && document.getElementById('tab-' + hashTab)) {
        switchToTab(hashTab);
        lazyInitTab(hashTab, tabInits, params);
        localStorage.setItem(TAB_KEY, hashTab);

        // Apply tab-specific URL params
        if (hashTab === 'portfolio') {
          applyPortfolioParams(params);
        }

        // Clean hash but preserve it for bookmarkability if params were present
        if (params.toString() === '') {
          history.replaceState(null, '', globalThis.location.pathname);
        }
        return true;
      }
      return false;
    }

    if (!applyHashTab()) {
      // Version check takes priority over saved tab — upgraders must see Setup
      // regardless of whether they have a saved tab from their previous session.
      if (localStorage.getItem(SETUP_SEEN_KEY) === currentServerVersion) {
        const savedTab = localStorage.getItem(TAB_KEY);
        if (savedTab) {
          switchToTab(savedTab);
          lazyInitTab(savedTab, tabInits);
        }
      } else {
        localStorage.setItem(SETUP_SEEN_KEY, currentServerVersion);
        switchToTab('setup');
      }
    }

    // Handle hash changes for deep-linking (e.g., open_logs operation)
    globalThis.addEventListener('hashchange', () => applyHashTab());

    renderConsoleTabMenu();
    syncConsoleTabMenuSelection();
    scheduleConsoleTabOverflowCheck();
    globalThis.addEventListener('resize', scheduleConsoleTabOverflowCheck);
    if (typeof ResizeObserver === 'function' && headerNavRow) {
      const tabOverflowObserver = new ResizeObserver(() => scheduleConsoleTabOverflowCheck());
      tabOverflowObserver.observe(headerNavRow);
    }

    if (consoleTabs) {
      consoleTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.console-tab');
        if (!btn) return;
        const tab = btn.dataset.tab;
        if (!tab) return;

        switchToTab(tab);
        localStorage.setItem(TAB_KEY, tab);

        lazyInitTab(tab, tabInits);
      });
    }

    consoleTabMenuToggle?.addEventListener('click', () => {
      if (!consoleTabMenu) return;
      const willOpen = consoleTabMenu.hidden;
      consoleTabMenu.hidden = !willOpen;
      consoleTabMenuToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });

    consoleTabMenu?.addEventListener('click', (e) => {
      const btn = e.target.closest('.console-tab-menu-item');
      if (!btn?.dataset.tab) return;
      const tab = btn.dataset.tab;
      switchToTab(tab);
      localStorage.setItem(TAB_KEY, tab);
      lazyInitTab(tab, tabInits);
    });

    globalThis.addEventListener('click', (e) => {
      if (!consoleTabMenu || !consoleTabMenuToggle) return;
      if (consoleTabMenu.hidden) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (consoleTabMenu.contains(target) || consoleTabMenuToggle.contains(target)) return;
      closeConsoleTabMenu();
    });

    function lazyInitTab(tab, tabInits, params) {
      const dc = globalThis.DollhouseConsole;
      const module = dc?.[tab];
      if (!module) return;
      if (!tabInits[tab]) {
        tabInits[tab] = true;
        module.init(params);
      } else if (module.refresh) {
        module.refresh();
      }
    }

    // 401 recovery (#1792): when the cached token becomes stale (rotation,
    // restart, file deletion), consoleAuth.js fires this event. Show a
    // persistent, idempotent reload banner so the user knows why the UI
    // stopped updating.
    globalThis.addEventListener('dollhouse:session-expired', function () {
      if (document.getElementById('session-expired-toast')) return;
      const toast = document.createElement('div');
      toast.id = 'session-expired-toast';
      toast.setAttribute('role', 'alert');
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);'
        + 'background:#b91c1c;color:#fff;padding:12px 24px;border-radius:8px;'
        + 'font-size:14px;z-index:99999;display:flex;align-items:center;gap:12px;'
        + 'box-shadow:0 4px 12px rgba(0,0,0,0.3);';
      toast.innerHTML = 'Console session token changed\u2009\u2014\u2009'
        + '<button style="background:#fff;color:#b91c1c;border:none;padding:6px 16px;'
        + 'border-radius:4px;cursor:pointer;font-weight:600;font-size:14px"'
        + ' onclick="window.DollhouseConsole.forceReload(\'session-expired\')">Reload</button>';
      document.body.appendChild(toast);
    });

    init();
  });

})();
