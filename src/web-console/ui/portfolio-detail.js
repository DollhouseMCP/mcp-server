/**
 * portfolio-detail.js — element detail renderers LIFTED VERBATIM from the legacy
 * console (src/web/public/app.js). Only the entry point is new: renderElementDetail()
 * maps our /api/v1 detail ({ metadata, content, type }) into the shape these
 * renderers expect, and the plural API type is mapped to the singular the legacy
 * sections key off. Globals used: marked + DOMPurify (vendored under ./vendor/).
 *
 * Do not "tidy" the bodies — they are a faithful copy so the detail view matches
 * the legacy exactly. Memories render through their own pure-YAML path
 * (renderMemoryView), exactly as the legacy did; everything else renders through
 * the metadata-driven common/type-specific/extra path.
 */

const PLURAL_TO_SINGULAR = { personas: 'persona', skills: 'skill', templates: 'template', agents: 'agent', memories: 'memory', ensembles: 'ensemble' };

/* ── Memory rendering (pure YAML) — LIFTED VERBATIM from legacy app.js ─────── */

const YAML_MAX_SIZE = 1024 * 512; // 512KB — generous but bounded
const MEMORY_MARKDOWN_FIELDS = new Set([
  'content', 'body', 'text', 'notes', 'summary', 'context', 'observations',
  'insights', 'instructions', 'thoughts', 'analysis', 'reflection', 'outcome',
  'details', 'log', 'data', 'value', 'message', 'description',
]);

function safeParseYaml(content) {
  if (!globalThis.jsyaml) return null;
  if (typeof content !== 'string' || content.length > YAML_MAX_SIZE) return null;
  try {
    return globalThis.jsyaml.load(content, { schema: globalThis.jsyaml.CORE_SCHEMA }) || null;
  } catch {
    return null;
  }
}

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

// Storage config the new backend persists on every memory. Legacy memories were
// flatter, so the verbatim loop rendered each remaining field as its own section;
// here that would bury the entries, so these go in a compact Details block.
const MEMORY_CONFIG_FIELDS = ['privacyLevel', 'storageBackend', 'retentionDays', 'maxEntries', 'searchable', 'encryptionEnabled'];

function prettyMemoryKey(key) {
  return key.replaceAll(/([A-Z])/g, ' $1').replaceAll('_', ' ').toLowerCase().trim();
}

// Render a pure-YAML memory file: parse each field, detect markdown, render appropriately.
function renderMemoryView(content) {
  let parsed;
  parsed = safeParseYaml(content);
  if (!parsed || typeof parsed !== 'object') {
    return `<pre class="element-source"><code class="element-code">${escapeHtml(content)}</code></pre>`;
  }

  let html = '';

  const createdVal = parsed.created || parsed.created_date;
  if (createdVal) {
    html += `<div class="detail-created"><span class="detail-created-label">Created</span><span class="detail-created-value">${escapeHtml(formatDate(createdVal))}</span></div>`;
  }
  const detailRows = [
    detailField('Author', parsed.author),
    detailField('ID', parsed.unique_id || parsed.id),
    ...MEMORY_CONFIG_FIELDS.map(k => (parsed[k] !== undefined ? detailField(prettyMemoryKey(k), String(parsed[k])) : '')),
  ].filter(Boolean).join('');
  if (detailRows) html += detailSection('Details', detailRows);
  if (Array.isArray(parsed.tags) && parsed.tags.length) {
    html += detailSection('Tags', detailPillList(parsed.tags, 'pill-tag'));
  }

  const SKIP = new Set([
    'name', 'type', 'created', 'created_date', 'updated', 'author', 'version', 'tags', 'unique_id', 'id',
    'format_version', 'modified', 'triggers', ...MEMORY_CONFIG_FIELDS,
  ]);
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
    String.raw`^(${DIRECTIVE_KEYWORDS.join('|')})(\s)`, 'i'
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


export function renderElementDetail({ metadata, content, type }) {
  const fm = metadata && typeof metadata === 'object' ? metadata : {};
  const t = PLURAL_TO_SINGULAR[type] || type;
  // Memories are pure YAML (entries + config); the BFF serves that document as
  // `content`. Render it through the legacy memory view, exactly as the legacy did.
  if (t === 'memory') {
    return renderMemoryView(typeof content === 'string' ? content : '');
  }
  let html = '';
  html += renderCommonMetadata(fm, t);
  html += renderTypeSpecificSections(fm, t);
  // The backend folds the body into metadata.instructions (rendered above as the
  // Instructions section); `content` is then only a short description stub, so
  // passing it as the body here would duplicate the body as a redundant
  // "Content" section. Only fall back to `content` when there's no instructions.
  const body = fm.instructions ? '' : (typeof content === 'string' ? content : '');
  html += renderDetailExtra(fm, body);
  return html || `<pre class="element-source"><code class="element-code">${escapeHtml(typeof content === 'string' ? content : '')}</code></pre>`;
}
