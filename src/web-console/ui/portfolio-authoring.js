/** Portfolio create/edit/delete and GitHub sync controls. */

import { del, get, patch, post } from './api.js';
import { parseBrowserYaml } from './yaml-safety.js';

const TYPES = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
const TYPE_GUIDANCE = Object.freeze({
  personas: {
    label: 'Persona',
    summary: 'Voice, behavior, and role instructions.',
    instructionsLabel: 'Behavioral instructions',
    instructionsHelp: 'Tell the assistant who it is and how it must behave. Use direct language such as “You are…” and “Always…”.',
    instructionsPlaceholder: 'You are a thoughtful technical editor. Always explain tradeoffs clearly…',
    instructionsRequired: true,
    contentLabel: 'Reference material',
    contentHelp: 'Optional reference material, examples, or domain knowledge the persona can draw from.',
    placeholder: 'Add background knowledge, examples, or reference material…',
    contentRequired: false,
  },
  skills: {
    label: 'Skill',
    summary: 'A reusable capability or procedure.',
    instructionsLabel: 'Procedure',
    instructionsHelp: 'Give the ordered steps and decision rules for performing this skill.',
    instructionsPlaceholder: `When asked to review code:
1. Identify the intended behavior…`,
    instructionsRequired: true,
    contentLabel: 'Supporting material',
    contentHelp: 'Optional examples, reference material, or supporting documentation.',
    placeholder: 'Add examples, checklists, or reference material…',
    contentRequired: false,
  },
  templates: {
    label: 'Template',
    summary: 'Reusable content with optional variables.',
    instructionsLabel: 'Usage instructions',
    instructionsHelp: 'Optionally explain when and how this template should be used.',
    instructionsPlaceholder: 'Use this template when drafting a project status update…',
    instructionsRequired: false,
    contentLabel: 'Template content',
    contentHelp: 'Write the reusable content. Include any placeholders your template expects.',
    placeholder: `# {{project_name}} status

Owner: {{owner}}
…`,
    contentRequired: true,
  },
  agents: {
    label: 'Agent',
    summary: 'A goal-oriented autonomous configuration.',
    instructionsLabel: 'Operating instructions',
    instructionsHelp: 'Explain how the agent should work, make decisions, and report progress.',
    instructionsPlaceholder: 'Work incrementally, verify each result, and pause when approval is required…',
    instructionsRequired: false,
    contentLabel: 'Reference material',
    contentHelp: 'Optional reference material the agent can use while pursuing its goal.',
    placeholder: 'Add project context, policies, or reference material…',
    contentRequired: false,
  },
  memories: {
    label: 'Memory',
    summary: 'Durable context or structured memory entries.',
    instructionsLabel: 'Recall instructions',
    instructionsHelp: 'Optionally explain when this memory should be loaded or how it should be used.',
    instructionsPlaceholder: 'Use this memory when helping with this project…',
    instructionsRequired: false,
    contentLabel: 'Memory content',
    contentHelp: 'Plain text becomes one memory entry. Existing entries YAML is also accepted.',
    placeholder: 'Enter something worth remembering, or paste an entries: YAML document…',
    contentRequired: true,
  },
  ensembles: {
    label: 'Ensemble',
    summary: 'A coordinated set of Dollhouse elements.',
    instructionsLabel: 'Coordination instructions',
    instructionsHelp: 'Explain how the selected elements should work together as one system.',
    instructionsPlaceholder: 'Let the primary persona set the voice while supporting skills provide…',
    instructionsRequired: false,
    contentLabel: 'Ensemble notes',
    contentHelp: 'Optional reference notes shared by the ensemble.',
    placeholder: 'Add shared context or reference notes…',
    contentRequired: false,
  },
});
const DEFAULT_PORTFOLIO_CONSOLE_REQUEST_MAX_BYTES = 1024 * 1024;
const IMPORT_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
const ACTIVE_SYNC_JOB_STORAGE_KEY = 'dollhouse.portfolio.active-sync-job.v1';
const IMPORT_ENVELOPE_KEYS = new Set([
  'metadata', 'content', 'instructions', 'entries', 'stats', 'extensions', 'id', 'type', 'name', 'tags',
  'display_name', 'canonical_name', 'validation_status', 'updated_at',
]);
const GUIDED_METADATA_KEYS = new Set([
  'name', 'description', 'tags', 'instructions', 'author', 'version', 'triggers',
  'tone', 'voice', 'domain', 'expertise', 'communication_style', 'communicationStyle',
  'complexity', 'domains', 'prerequisites', 'category', 'parameters',
  'output_format', 'outputFormat', 'variables',
  'goal', 'activates', 'tools', 'autonomy',
  'privacyLevel', 'memoryType', 'retentionDays', 'maxEntries', 'searchable', 'autoLoad',
  'activationStrategy', 'activation_strategy', 'conflictResolution', 'conflict_resolution',
  'contextSharing', 'context_sharing', 'allowNested', 'allow_nested', 'elements',
]);
const TERMINAL_SYNC_STATES = new Set(['succeeded', 'failed']);
const SYNC_POLL_INTERVAL_MS = 1_000;
// The portfolio exposes one authoring workspace; opening another closes the
// previous workspace and removes its document-level listeners first.
let activeWorkspaceCleanup = null;

export function createPortfolioAuthoring({ host, hasRoute, notify, refresh, requestMaxBytes }) {
  const effectiveRequestMaxBytes = Number.isSafeInteger(requestMaxBytes) && requestMaxBytes > 0
    ? requestMaxBytes
    : DEFAULT_PORTFOLIO_CONSOLE_REQUEST_MAX_BYTES;
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
    openCreate: () => openEditor({ host, mode: 'create', capabilities, notify, refresh, requestMaxBytes: effectiveRequestMaxBytes }),
    openImport: () => openEditor({ host, mode: 'import', capabilities, notify, refresh, requestMaxBytes: effectiveRequestMaxBytes }),
    openEdit: element => openEditor({ host, mode: 'edit', element, capabilities, notify, refresh, requestMaxBytes: effectiveRequestMaxBytes }),
    deleteElement: element => deleteElement(element, { notify, refresh }),
    openSync: () => openSync({ notify, refresh }),
  });
}

function openEditor(context) {
  activeWorkspaceCleanup?.();
  const previousFocus = document.activeElement;
  const browser = context.host.querySelector('[data-portfolio-browser]');
  const workspace = context.host.querySelector('[data-portfolio-authoring]');
  workspace.innerHTML = editorWorkspace(context);
  workspace.hidden = false;
  browser.hidden = true;
  const form = workspace.querySelector('form');
  form.dataset.requestMaxBytes = String(context.requestMaxBytes ?? DEFAULT_PORTFOLIO_CONSOLE_REQUEST_MAX_BYTES);
  populateGuidedMetadata(form, context.element?.metadata ?? {}, context.element?.type ?? 'personas');
  let initialDraft = formDraft(form);
  let unsavedImport = false;

  const close = () => {
    document.removeEventListener('keydown', onKeydown);
    workspace.replaceChildren();
    workspace.hidden = true;
    browser.hidden = false;
    activeWorkspaceCleanup = null;
    restoreFocus(previousFocus);
  };
  const requestClose = async () => {
    if (unsavedImport || formDraft(form) !== initialDraft) {
      const discard = await confirmDialog('Discard this unsaved draft?', 'Discard draft');
      if (!discard) return;
    }
    close();
  };
  const onKeydown = event => {
    if (event.key === 'Escape' && !workspace.hidden) {
      event.preventDefault();
      requestClose();
    }
  };
  activeWorkspaceCleanup = close;
  workspace.querySelectorAll('[data-editor-close]').forEach(button => {
    button.addEventListener('click', () => requestClose());
  });
  document.addEventListener('keydown', onKeydown);

  form.addEventListener('submit', event => {
    event.preventDefault();
    saveEditor(form, workspace, context, () => {
      initialDraft = formDraft(form);
      unsavedImport = false;
      close();
    });
  });
  workspace.querySelector('[data-editor-validate]')?.addEventListener('click', () => validateEditor(form, workspace));
  workspace.querySelector('[data-editor-render]')?.addEventListener('click', () => renderEditor(form, workspace));
  workspace.querySelector('[data-editor-reload]')?.addEventListener('click', async () => {
    const reloaded = await reloadEditor(form, workspace, context);
    if (reloaded) initialDraft = formDraft(form);
  });
  form.addEventListener('change', event => {
    if (event.target?.name === 'type') updateTypeGuidance(form, workspace);
  });
  wireImport(workspace, form, draft => {
    applyImportedDraft(form, workspace, draft);
    unsavedImport = true;
  });
  wireBuilderControls(workspace);
  wireCustomMetadata(workspace, form);
  updateTypeGuidance(form, workspace);
  focusElement(context.mode === 'import'
    ? workspace.querySelector('[data-import-file]')
    : form.querySelector('[name="type"]:checked, [name="name"]'));
}

function editorWorkspace({ mode, element, capabilities }) {
  const isEdit = mode === 'edit';
  const isImport = mode === 'import';
  const copy = workspaceCopy(mode);
  const selectedType = TYPES.includes(element?.type) ? element.type : 'personas';
  const picker = isImport ? importPicker() : '';
  const fields = elementFields({ element, mode, selectedType });
  const validateAction = capabilities.validate ? validationAction(isImport) : '';
  const previewAction = isEdit && capabilities.render
    ? '<button class="btn btn-ghost" data-editor-render type="button">Preview</button>'
    : '';
  const submitAction = submitButton(mode);
  return `
    <form class="portfolio-editor" data-editor-mode="${mode}" novalidate>
      <header class="portfolio-editor-head">
        <div>
          <button class="portfolio-back-link" data-editor-close type="button">&#8592; Back to portfolio</button>
          <h2 id="portfolio-editor-title">${copy.title}</h2>
          <p>${copy.description}</p>
        </div>
      </header>
      <div class="portfolio-editor-feedback" data-editor-feedback aria-live="polite" tabindex="-1">
        <p class="portfolio-message portfolio-message--info">${copy.intro}</p>
      </div>
      <div class="portfolio-editor-body">
        ${picker}
        <div data-editor-fields${isImport ? ' hidden' : ''}>
          ${fields}
          <section class="portfolio-preview" data-editor-preview hidden aria-label="Rendered preview"></section>
        </div>
      </div>
      <footer class="portfolio-editor-actions">
        ${validateAction}
        ${previewAction}
        <button class="btn btn-ghost" data-editor-reload type="button" hidden>Reload latest</button>
        <span class="portfolio-editor-spacer"></span>
        <button class="btn btn-ghost" data-editor-close type="button">Cancel</button>
        ${submitAction}
      </footer>
    </form>`;
}

function workspaceCopy(mode) {
  if (mode === 'edit') {
    return {
      title: 'Edit element',
      description: 'Review and safely update this element. A newer server version cannot be overwritten.',
      intro: 'Required fields are marked. Validate at any time to check the draft without saving it.',
    };
  }
  if (mode === 'import') {
    return {
      title: 'Import element',
      description: 'Choose a local Dollhouse element file, review what was detected, then validate and import it.',
      intro: 'No file selected. Your portfolio will not change until you review and submit an imported draft.',
    };
  }
  return {
    title: 'Create element',
    description: 'Choose what you are building, then use the guidance below to create a validated element.',
    intro: 'Required fields are marked. Validate at any time to check the draft without saving it.',
  };
}

function elementFields({ element, mode, selectedType }) {
  const isEdit = mode === 'edit';
  const typeField = isEdit
    ? `<input name="type" type="hidden" value="${escapeAttr(selectedType)}">
       <div class="portfolio-readonly-type"><span>Element type</span><strong>${escapeHtml(TYPE_GUIDANCE[selectedType].label)}</strong></div>`
    : typeChooser(selectedType);
  const readonlyName = isEdit ? 'readonly' : '';
  return `
    ${typeField}
    <aside class="portfolio-builder-overview" data-builder-overview></aside>
    <section class="portfolio-builder-step">
      <header><span>1</span><div><h3>Purpose</h3><p>Give the element an identity and make it discoverable.</p></div></header>
      <div class="portfolio-form-grid">
        <label class="portfolio-field"><span>Name <small>Required</small></span>
          <input name="name" required maxlength="200" value="${escapeAttr(element?.name ?? '')}" ${readonlyName}>
          <small>Use a short, recognizable name. The server normalizes it for storage.</small>
        </label>
        <label class="portfolio-field"><span>Version</span>
          <input name="version" maxlength="20" placeholder="1.0.0">
          <small>Use semantic versions such as 1.0.0.</small>
        </label>
        <label class="portfolio-field portfolio-field--wide"><span>Description <small>Required</small></span>
          <input name="description" required maxlength="500" value="${escapeAttr(descriptionFrom(element))}">
          <small>One sentence explaining what this element does and when someone should use it.</small>
        </label>
        <label class="portfolio-field"><span>Author</span>
          <input name="author" maxlength="100" placeholder="Your name or team">
        </label>
        <label class="portfolio-field"><span>Tags <small>(comma separated)</small></span>
          <input name="tags" value="${escapeAttr((element?.tags ?? []).join(', '))}" placeholder="writing, planning">
        </label>
        <label class="portfolio-field portfolio-field--wide"><span>Triggers <small>(comma separated)</small></span>
          <input name="triggers" placeholder="review, analyze, draft">
          <small>Words that help Dollhouse discover this element. Up to 20; letters, numbers, -, _, @, and . only.</small>
        </label>
      </div>
    </section>
    <section class="portfolio-builder-step">
      <header><span>2</span><div><h3>Behavior</h3><p>Instructions tell the assistant what to do. They are different from reference content.</p></div></header>
      <label class="portfolio-field portfolio-field--wide"><span data-instructions-label>Instructions</span>
        <textarea name="instructions" rows="10" spellcheck="false"></textarea>
        <small data-instructions-help></small>
      </label>
    </section>
    <section class="portfolio-builder-step">
      <header><span>3</span><div><h3>Content</h3><p>Content is the material the element uses or produces—not a command to the assistant.</p></div></header>
      <label class="portfolio-field portfolio-field--wide"><span data-content-label>Content</span>
        <textarea name="content" rows="12" spellcheck="false">${escapeHtml(element?.content ?? '')}</textarea>
        <small data-content-help></small>
      </label>
    </section>
    <section class="portfolio-builder-step">
      <header><span>4</span><div><h3>Type settings</h3><p data-type-settings-intro>Configure the fields that are valid for this element type.</p></div></header>
      ${typeSettings()}
    </section>
    ${customMetadataSection(element?.metadata, mode)}`;
}

function typeSettings() {
  return [
    personaSettings(),
    skillSettings(),
    templateSettings(),
    agentSettings(),
    memorySettings(),
    ensembleSettings(),
  ].join('');
}

function personaSettings() {
  return `
    <div class="portfolio-type-settings" data-guided-type="personas">
      <div class="portfolio-form-grid">
        ${textField('persona_tone', 'Tone', 'Examples: warm, direct, analytical')}
        ${textField('persona_voice', 'Voice', 'Examples: concise, conversational, formal')}
        ${textField('persona_domain', 'Domain', 'The subject area this persona specializes in')}
        ${textField('persona_expertise', 'Expertise', 'Comma-separated specialties')}
        ${textField('persona_communication_style', 'Communication style', 'How it should structure and present answers', true)}
      </div>
    </div>`;
}

function skillSettings() {
  return `
    <div class="portfolio-type-settings" data-guided-type="skills" hidden>
      <div class="portfolio-form-grid">
        ${selectField('skill_complexity', 'Complexity', ['beginner', 'intermediate', 'advanced', 'expert'])}
        ${textField('skill_domains', 'Domains', 'Comma-separated areas such as web-dev, writing')}
        ${textField('skill_prerequisites', 'Prerequisites', 'Comma-separated knowledge or skills')}
        ${textField('skill_category', 'Category', 'A short grouping label')}
      </div>
      <div class="portfolio-repeat-head"><div><h4>Parameters</h4><p>Optional inputs this skill accepts.</p></div><button class="btn btn-ghost" data-add-row="skill-parameters" type="button">Add parameter</button></div>
      <div class="portfolio-repeat-list" data-repeat-list="skill-parameters"></div>
    </div>`;
}

function templateSettings() {
  return `
    <div class="portfolio-type-settings" data-guided-type="templates" hidden>
      <div class="portfolio-form-grid">
        ${textField('template_category', 'Category', 'Examples: email, report, code')}
        ${textField('template_output_format', 'Output format', 'Examples: markdown, html, json')}
      </div>
      <div class="portfolio-repeat-head"><div><h4>Variables</h4><p>Define every placeholder used by the template content.</p></div><button class="btn btn-ghost" data-add-row="template-variables" type="button">Add variable</button></div>
      <div class="portfolio-repeat-list" data-repeat-list="template-variables"></div>
    </div>`;
}

function agentSettings() {
  return `
    <div class="portfolio-type-settings" data-guided-type="agents" hidden>
      <div class="portfolio-form-grid">
        <label class="portfolio-field portfolio-field--wide"><span>Goal template <small>Required</small></span>
          <textarea name="agent_goal_template" rows="4" placeholder="Research {topic} and produce a decision-ready recommendation."></textarea>
          <small>Use {parameter} placeholders for values supplied when the agent runs.</small>
        </label>
        <label class="portfolio-field portfolio-field--wide"><span>Success criteria <small>(one per line)</small></span>
          <textarea name="agent_success_criteria" rows="4" placeholder="Sources are cited&#10;Tradeoffs are explicit&#10;Recommendation answers the goal"></textarea>
        </label>
        ${textField('agent_activates_personas', 'Activate personas', 'Comma-separated element names')}
        ${textField('agent_activates_skills', 'Activate skills', 'Comma-separated element names')}
        ${textField('agent_tools_allowed', 'Allowed tools', 'Comma-separated MCP-AQL tool names')}
        ${textField('agent_tools_denied', 'Denied tools', 'Comma-separated MCP-AQL tool names')}
        ${selectField('agent_risk_tolerance', 'Risk tolerance', ['moderate', 'conservative', 'aggressive'])}
        ${numberField('agent_max_steps', 'Maximum autonomous steps', '0 means unlimited', 0)}
      </div>
    </div>`;
}

function memorySettings() {
  return `
    <div class="portfolio-type-settings" data-guided-type="memories" hidden>
      <div class="portfolio-form-grid">
        ${selectField('memory_privacy_level', 'Privacy level', ['private', 'public', 'sensitive'])}
        ${selectField('memory_type', 'Memory type', ['user', 'system', 'adapter'])}
        ${numberField('memory_retention_days', 'Retention days', 'Leave blank to use the server default', 1)}
        ${numberField('memory_max_entries', 'Maximum entries', 'Leave blank to use the server default', 1)}
        ${checkboxField('memory_searchable', 'Searchable', 'Allow this memory to appear in memory search', true)}
        ${checkboxField('memory_auto_load', 'Auto-load', 'Load this memory automatically when relevant', false)}
      </div>
    </div>`;
}

function ensembleSettings() {
  return `
    <div class="portfolio-type-settings" data-guided-type="ensembles" hidden>
      <div class="portfolio-form-grid">
        ${selectField('ensemble_activation_strategy', 'Activation strategy', ['all', 'sequential', 'lazy', 'conditional', 'priority'])}
        ${selectField('ensemble_conflict_resolution', 'Conflict resolution', ['priority', 'last-write', 'first-write', 'merge', 'error'])}
        ${selectField('ensemble_context_sharing', 'Context sharing', ['selective', 'none', 'full'])}
        ${checkboxField('ensemble_allow_nested', 'Allow nested ensembles', 'Permit ensemble members to reference other ensembles', false)}
      </div>
      <div class="portfolio-repeat-head"><div><h4>Elements <small>Required</small></h4><p>Add the portfolio elements that work together in this ensemble.</p></div><button class="btn btn-ghost" data-add-row="ensemble-elements" type="button">Add element</button></div>
      <div class="portfolio-repeat-list" data-repeat-list="ensemble-elements"></div>
    </div>`;
}

function textField(name, label, help, wide = false) {
  return `<label class="portfolio-field${wide ? ' portfolio-field--wide' : ''}"><span>${label}</span><input name="${name}"><small>${help}</small></label>`;
}

function numberField(name, label, help, min) {
  return `<label class="portfolio-field"><span>${label}</span><input name="${name}" type="number" min="${min}" step="1"><small>${help}</small></label>`;
}

function selectField(name, label, values) {
  const options = values.map(value => `<option value="${value}">${capitalize(value.replaceAll('-', ' '))}</option>`).join('');
  return `<label class="portfolio-field"><span>${label}</span><select name="${name}">${options}</select></label>`;
}

function checkboxField(name, label, help, checked) {
  return `<label class="portfolio-check-field"><input name="${name}" type="checkbox"${checked ? ' checked' : ''}><span><strong>${label}</strong><small>${help}</small></span></label>`;
}

function validationAction(disabled) {
  const disabledAttribute = disabled ? ' disabled' : '';
  return `<button class="btn btn-ghost" data-editor-validate type="button"${disabledAttribute}>Validate draft</button>`;
}

function submitButton(mode) {
  if (mode === 'edit') return '<button class="btn btn-primary" type="submit">Save changes</button>';
  if (mode === 'import') return '<button class="btn btn-primary" type="submit" disabled>Import element</button>';
  return '<button class="btn btn-primary" type="submit">Create element</button>';
}

function typeChooser(selected) {
  const choices = TYPES.map(type => {
    const guidance = TYPE_GUIDANCE[type];
    return `
      <label class="portfolio-type-choice">
        <input type="radio" name="type" value="${type}"${type === selected ? ' checked' : ''}>
        <span><strong>${guidance.label}</strong><small>${guidance.summary}</small></span>
      </label>`;
  }).join('');
  return `<fieldset class="portfolio-type-chooser"><legend>What kind of element is this?</legend><div class="portfolio-type-grid">${choices}</div></fieldset>`;
}

function importPicker() {
  return `
    <section class="portfolio-import-picker" data-import-picker>
      <div class="portfolio-drop-zone" data-import-drop>
        <strong>Choose a Dollhouse element file</strong>
        <p>Drop a file here or browse for Markdown, YAML, or a portable JSON export.</p>
        <label class="btn btn-primary">Choose file
          <input data-import-file type="file" accept=".md,.markdown,.yaml,.yml,.json,text/markdown,application/yaml,application/json" hidden>
        </label>
        <small>Maximum file size: 1 MB. Nothing is uploaded until you press Import element.</small>
      </div>
      <div class="portfolio-import-source" data-import-source hidden></div>
    </section>`;
}

function descriptionFrom(element) {
  return typeof element?.metadata?.description === 'string' ? element.metadata.description : '';
}

function advancedMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !GUIDED_METADATA_KEYS.has(key)));
}

function customMetadataSection(metadata, mode) {
  const additional = advancedMetadata(metadata);
  const count = Object.keys(additional).length;
  const notice = count ? customMetadataNotice(count, mode) : '';
  return `
    <p class="portfolio-custom-metadata-notice" data-custom-metadata-notice${count ? '' : ' hidden'}>${escapeHtml(notice)}</p>
    <details class="portfolio-advanced" data-custom-metadata data-metadata-origin="${escapeAttr(mode)}">
      <summary data-custom-metadata-summary>${escapeHtml(customMetadataSummary(count))}</summary>
      <p>Most people will not need this. Use custom metadata only when a Dollhouse schema or integration requires fields that are not available above.</p>
      <button class="portfolio-metadata-enable" data-custom-metadata-enable type="button"${count ? ' hidden' : ''}>Add custom metadata</button>
      <label class="portfolio-field" data-custom-metadata-editor${count ? '' : ' hidden'}>
        <span>Raw metadata <small>(JSON object)</small></span>
        <textarea name="metadata" rows="8" spellcheck="false" aria-describedby="portfolio-custom-metadata-help">${escapeHtml(JSON.stringify(additional, null, 2))}</textarea>
        <small id="portfolio-custom-metadata-help">Guided fields above take precedence if the same field appears here.</small>
        <small class="portfolio-metadata-status${count ? ' is-valid' : ''}" data-custom-metadata-status aria-live="polite">${count ? escapeHtml(validCustomMetadataMessage(count)) : ''}</small>
      </label>
    </details>`;
}

function wireCustomMetadata(workspace, form) {
  const enable = workspace.querySelector('[data-custom-metadata-enable]');
  const editor = workspace.querySelector('[data-custom-metadata-editor]');
  const textarea = form.elements.metadata;
  enable.addEventListener('click', () => {
    editor.hidden = false;
    enable.hidden = true;
    renderCustomMetadataValidation(form, workspace);
    textarea.focus();
  });
  textarea.addEventListener('input', () => renderCustomMetadataValidation(form, workspace));
}

function setCustomMetadata(form, workspace, metadata, origin) {
  const additional = advancedMetadata(metadata);
  const count = Object.keys(additional).length;
  const details = workspace.querySelector('[data-custom-metadata]');
  const editor = workspace.querySelector('[data-custom-metadata-editor]');
  const enable = workspace.querySelector('[data-custom-metadata-enable]');
  const notice = workspace.querySelector('[data-custom-metadata-notice]');
  form.elements.metadata.value = JSON.stringify(additional, null, 2);
  details.dataset.metadataOrigin = origin;
  workspace.querySelector('[data-custom-metadata-summary]').textContent = customMetadataSummary(count);
  editor.hidden = count === 0;
  enable.hidden = count > 0;
  notice.hidden = count === 0;
  notice.textContent = count ? customMetadataNotice(count, origin) : '';
  renderCustomMetadataValidation(form, workspace);
}

function renderCustomMetadataValidation(form, workspace) {
  const textarea = form.elements.metadata;
  const status = workspace.querySelector('[data-custom-metadata-status]');
  const parsed = parseCustomMetadata(textarea.value.trim());
  status.classList.toggle('is-error', Boolean(parsed.problem));
  status.classList.toggle('is-valid', !parsed.problem && Boolean(textarea.value.trim()));
  if (parsed.problem) {
    status.textContent = parsed.problem;
    textarea.setAttribute('aria-invalid', 'true');
    return;
  }
  textarea.removeAttribute('aria-invalid');
  const count = Object.keys(parsed.metadata).length;
  status.textContent = textarea.value.trim()
    ? validCustomMetadataMessage(count)
    : 'Enter a JSON object containing only fields not covered by the guided form.';
  workspace.querySelector('[data-custom-metadata-summary]').textContent = customMetadataSummary(count);
}

function parseCustomMetadata(text) {
  if (!text) return { metadata: {} };
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch {
    return { metadata: {}, problem: 'Custom metadata must be valid JSON.' };
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { metadata: {}, problem: 'Custom metadata must be a JSON object.' };
  }
  return { metadata };
}

function customMetadataNotice(count, origin) {
  const fields = `${count} additional metadata field${count === 1 ? '' : 's'}`;
  if (origin === 'import') return `${fields} from this file will be preserved when imported.`;
  const subject = count === 1 ? 'It' : 'They';
  return `This element contains ${fields}. ${subject} will be preserved when saved.`;
}

function customMetadataSummary(count) {
  if (!count) return 'Developer options';
  const label = count === 1 ? 'field' : 'fields';
  return `Custom metadata (${count} ${label})`;
}

function validCustomMetadataMessage(count) {
  return `Valid JSON object · ${count} custom field${count === 1 ? '' : 's'}.`;
}

function editorPayload(form, includeName) {
  const metadataText = form.elements.metadata.value.trim();
  const parsedMetadata = parseCustomMetadata(metadataText);
  if (parsedMetadata.problem) return { problem: parsedMetadata.problem, field: form.elements.metadata };
  const additionalMetadata = parsedMetadata.metadata;
  const type = form.elements.type.value;
  const description = form.elements.description.value.trim();
  if (!description) return { problem: 'Description is required.', field: form.elements.description };
  const instructions = form.elements.instructions.value.trim();
  const guidance = TYPE_GUIDANCE[type] ?? TYPE_GUIDANCE.personas;
  if (form.dataset.editorMode !== 'edit' && guidance.instructionsRequired && !instructions) {
    return { problem: `${guidance.instructionsLabel} are required.`, field: form.elements.instructions };
  }
  const content = form.elements.content.value;
  if (guidance.contentRequired && !content.trim()) {
    return { problem: `${guidance.contentLabel} is required.`, field: form.elements.content };
  }
  if (type === 'agents' && !fieldText(form, 'agent_goal_template')) {
    return { problem: 'Goal template is required for an agent.', field: form.elements.agent_goal_template };
  }
  const ensembleHasElement = [...form.querySelectorAll('[data-repeat-row="ensemble-elements"] [data-row-field="name"]')]
    .some(field => field.value.trim());
  if (type === 'ensembles' && !ensembleHasElement) {
    return { problem: 'Add at least one element to the ensemble.', field: form.querySelector('[data-add-row="ensemble-elements"]') };
  }
  const typeMetadata = guidedMetadata(form, type);
  const payload = {
    tags: form.elements.tags.value.split(',').map(tag => tag.trim()).filter(Boolean),
    metadata: {
      ...additionalMetadata,
      ...commonGuidedMetadata(form),
      ...typeMetadata,
      description,
      ...(instructions ? { instructions } : {}),
    },
    content,
  };
  if (includeName) payload.name = form.elements.name.value.trim();
  const requestSizeProblem = portfolioRequestSizeProblem(payload, Number(form.dataset.requestMaxBytes));
  if (requestSizeProblem) return { problem: requestSizeProblem, field: form.elements.content };
  return { payload };
}

export function serializedJsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function portfolioRequestSizeProblem(payload, maxBytes = DEFAULT_PORTFOLIO_CONSOLE_REQUEST_MAX_BYTES) {
  return serializedJsonByteLength(payload) > maxBytes
    ? `This draft exceeds the ${formatBytes(maxBytes)} web console request limit. Reduce its content or metadata before validating or saving.`
    : null;
}

function commonGuidedMetadata(form) {
  return compactRecord({
    author: fieldText(form, 'author'),
    version: fieldText(form, 'version'),
    triggers: commaList(fieldText(form, 'triggers')),
  });
}

function guidedMetadata(form, type) {
  const builders = {
    personas: personaMetadata,
    skills: skillMetadata,
    templates: templateMetadata,
    agents: agentMetadata,
    memories: memoryMetadata,
    ensembles: ensembleMetadata,
  };
  return builders[type]?.(form) ?? {};
}

function personaMetadata(form) {
  return compactRecord({
    tone: fieldText(form, 'persona_tone'),
    voice: fieldText(form, 'persona_voice'),
    domain: fieldText(form, 'persona_domain'),
    expertise: commaList(fieldText(form, 'persona_expertise')),
    communication_style: fieldText(form, 'persona_communication_style'),
  });
}

function skillMetadata(form) {
  return compactRecord({
    complexity: fieldText(form, 'skill_complexity'),
    domains: commaList(fieldText(form, 'skill_domains')),
    prerequisites: commaList(fieldText(form, 'skill_prerequisites')),
    category: fieldText(form, 'skill_category'),
    parameters: repeatedRows(form, 'skill-parameters', definitionFromRow),
  });
}

function templateMetadata(form) {
  return compactRecord({
    category: fieldText(form, 'template_category'),
    output_format: fieldText(form, 'template_output_format'),
    variables: repeatedRows(form, 'template-variables', definitionFromRow),
  });
}

function agentMetadata(form) {
  const template = fieldText(form, 'agent_goal_template');
  const successCriteria = lineList(fieldText(form, 'agent_success_criteria'));
  const activates = compactRecord({
    personas: commaList(fieldText(form, 'agent_activates_personas')),
    skills: commaList(fieldText(form, 'agent_activates_skills')),
  });
  const allowed = commaList(fieldText(form, 'agent_tools_allowed'));
  const denied = commaList(fieldText(form, 'agent_tools_denied'));
  const tools = allowed.length || denied.length
    ? { allowed, ...(denied.length ? { denied } : {}) }
    : undefined;
  const maxAutonomousSteps = optionalNumber(fieldText(form, 'agent_max_steps'));
  const autonomy = compactRecord({
    riskTolerance: fieldText(form, 'agent_risk_tolerance'),
    maxAutonomousSteps,
  });
  return compactRecord({
    goal: template ? { template, parameters: [], ...(successCriteria.length ? { successCriteria } : {}) } : undefined,
    activates,
    tools,
    autonomy,
  });
}

function memoryMetadata(form) {
  return compactRecord({
    privacyLevel: fieldText(form, 'memory_privacy_level'),
    memoryType: fieldText(form, 'memory_type'),
    retentionDays: optionalNumber(fieldText(form, 'memory_retention_days')),
    maxEntries: optionalNumber(fieldText(form, 'memory_max_entries')),
    searchable: form.elements.memory_searchable.checked,
    autoLoad: form.elements.memory_auto_load.checked,
  });
}

function ensembleMetadata(form) {
  return compactRecord({
    activationStrategy: fieldText(form, 'ensemble_activation_strategy'),
    conflictResolution: fieldText(form, 'ensemble_conflict_resolution'),
    contextSharing: fieldText(form, 'ensemble_context_sharing'),
    allowNested: form.elements.ensemble_allow_nested.checked,
    elements: repeatedRows(form, 'ensemble-elements', ensembleElementFromRow),
  });
}

function repeatedRows(form, kind, mapper) {
  return [...form.querySelectorAll(`[data-repeat-row="${kind}"]`)].map(row => mapper(row)).filter(Boolean);
}

function definitionFromRow(row) {
  const name = row.querySelector('[data-row-field="name"]').value.trim();
  if (!name) return null;
  return compactRecord({
    name,
    type: row.querySelector('[data-row-field="type"]').value,
    description: row.querySelector('[data-row-field="description"]').value.trim(),
    required: row.querySelector('[data-row-field="required"]').checked,
  });
}

function ensembleElementFromRow(row) {
  const elementName = row.querySelector('[data-row-field="name"]').value.trim();
  if (!elementName) return null;
  const priority = optionalNumber(row.querySelector('[data-row-field="priority"]').value.trim()) ?? 10;
  return compactRecord({
    element_name: elementName,
    element_type: row.querySelector('[data-row-field="type"]').value,
    role: row.querySelector('[data-row-field="role"]').value,
    priority,
    activation: row.querySelector('[data-row-field="activation"]').value,
    purpose: row.querySelector('[data-row-field="purpose"]').value.trim(),
  });
}

function compactRecord(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => {
    if (value === undefined || value === '') return false;
    return !Array.isArray(value) || value.length > 0;
  }));
}

function fieldText(form, name) {
  return typeof form.elements[name]?.value === 'string' ? form.elements[name].value.trim() : '';
}

function commaList(value) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function lineList(value) {
  return value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean);
}

function optionalNumber(value) {
  return value === '' ? undefined : Number(value);
}

function editorPath(form, suffix = '') {
  const type = encodeURIComponent(form.elements.type.value);
  const name = encodeURIComponent(form.elements.name.value.trim());
  return `/me/portfolio/elements/${type}/${name}${suffix}`;
}

async function validateEditor(form, workspace) {
  if (!form.elements.name.value.trim()) {
    showEditorMessage(workspace, 'Name is required.', 'error', form.elements.name);
    return false;
  }
  const parsed = editorPayload(form, false);
  if (parsed.problem) return showEditorMessage(workspace, parsed.problem, 'error', parsed.field ?? form.elements.metadata);
  setEditorBusy(workspace, true);
  try {
    const response = await post(editorPath(form, '/validate'), { body: parsed.payload });
    showValidation(workspace, response, form);
    return response.status === 200 && response.body?.valid === true;
  } catch {
    showEditorMessage(workspace, 'Validation could not reach the server.', 'error');
    return false;
  } finally {
    setEditorBusy(workspace, false);
  }
}

function showValidation(workspace, response, form) {
  if (response.status !== 200) {
    showEditorMessage(workspace, responseDetail(response, 'Validation failed.'), 'error');
    return;
  }
  const issues = Array.isArray(response.body?.issues) ? response.body.issues : [];
  if (response.body?.valid) {
    showEditorMessage(workspace, 'Validation passed. This draft is ready to save.', 'success');
    return;
  }
  const list = issues.map(issue => `<li><strong>${escapeHtml(issue.path || 'element')}</strong>: ${escapeHtml(issue.message || issue.code || 'Invalid value')}</li>`).join('');
  showEditorHtml(
    workspace,
    `<div class="portfolio-message portfolio-message--error"><p>Fix these validation issues:</p><ul>${list}</ul></div>`,
    fieldForIssue(form, issues[0]?.path),
  );
}

async function renderEditor(form, workspace) {
  const parsed = editorPayload(form, false);
  if (parsed.problem) return showEditorMessage(workspace, parsed.problem, 'error', parsed.field ?? form.elements.metadata);
  setEditorBusy(workspace, true);
  try {
    const response = await post(editorPath(form, '/render'), { body: parsed.payload });
    if (response.status !== 200 || typeof response.body?.preview !== 'string') {
      showEditorMessage(workspace, responseDetail(response, 'Preview failed.'), 'error');
      return;
    }
    const preview = workspace.querySelector('[data-editor-preview]');
    preview.hidden = false;
    preview.innerHTML = `<h3>Server preview</h3><pre>${escapeHtml(response.body.preview)}</pre>`;
    showEditorMessage(workspace, 'Preview refreshed from the server.', 'success');
  } catch {
    showEditorMessage(workspace, 'Preview could not reach the server.', 'error');
  } finally {
    setEditorBusy(workspace, false);
  }
}

async function saveEditor(form, workspace, context, close) {
  const includeName = context.mode !== 'edit';
  const parsed = editorPayload(form, includeName);
  if (parsed.problem) return showEditorMessage(workspace, parsed.problem, 'error', parsed.field ?? form.elements.metadata);
  if (!form.elements.name.value.trim()) return showEditorMessage(workspace, 'Name is required.', 'error', form.elements.name);
  setEditorBusy(workspace, true);
  try {
    if (context.capabilities.validate) {
      const valid = await validateDraft(form, workspace, parsed.payload);
      if (!valid) return;
    }
    const response = includeName
      ? await post(`/me/portfolio/elements/${encodeURIComponent(form.elements.type.value)}`, { body: parsed.payload })
      : await patch(editorPath(form), { body: parsed.payload, ifMatch: context.element?._etag });
    if (response.status === 412) {
      showConflict(workspace);
      return;
    }
    if (includeName && response.status === 409) {
      showEditorMessage(workspace, 'An element with this type and name already exists. Nothing was overwritten. Choose another name or cancel this draft.', 'error', form.elements.name);
      return;
    }
    const expectedStatus = includeName ? 201 : 200;
    if (response.status !== expectedStatus) {
      showEditorMessage(workspace, responseDetail(response, 'The element could not be saved.'), 'error');
      return;
    }
    const action = savedAction(context.mode);
    context.notify(`${action} “${response.body?.display_name || response.body?.name || 'element'}”.`, 'success');
    await context.refresh();
    close();
  } catch {
    showEditorMessage(workspace, 'The element could not be saved because the server is unreachable.', 'error');
  } finally {
    setEditorBusy(workspace, false);
  }
}

function savedAction(mode) {
  if (mode === 'import') return 'Imported';
  return mode === 'create' ? 'Created' : 'Updated';
}

async function validateDraft(form, workspace, payload) {
  const response = await post(editorPath(form, '/validate'), { body: payload });
  showValidation(workspace, response, form);
  return response.status === 200 && response.body?.valid === true;
}

function showConflict(workspace) {
  showEditorMessage(workspace, 'This element changed after you opened it. Your draft was not saved. Review or copy it, then reload the latest version before editing again.', 'error');
  workspace.querySelector('[data-editor-reload]').hidden = false;
}

async function reloadEditor(form, workspace, context) {
  setEditorBusy(workspace, true);
  try {
    const response = await get(editorPath(form));
    if (response.status !== 200 || !response.body) {
      showEditorMessage(workspace, responseDetail(response, 'The latest version could not be loaded.'), 'error');
      return false;
    }
    if (typeof response.etag !== 'string' || !response.etag) {
      showEditorMessage(workspace, 'The latest version did not include an ETag, so editing remains blocked.', 'error');
      return false;
    }
    // Event handlers share this context, so replacing the element also advances
    // the ETag used by every subsequent save in this editor.
    context.element = { ...response.body, _etag: response.etag };
    resetGuidedMetadata(form);
    form.elements.tags.value = Array.isArray(response.body.tags) ? response.body.tags.join(', ') : '';
    form.elements.description.value = descriptionFrom(response.body);
    setCustomMetadata(form, workspace, response.body.metadata, 'edit');
    form.elements.content.value = typeof response.body.content === 'string' ? response.body.content : '';
    populateGuidedMetadata(form, response.body.metadata ?? {}, response.body.type);
    workspace.querySelector('[data-editor-reload]').hidden = true;
    showEditorMessage(workspace, 'Latest version loaded. The previous draft was replaced only after your confirmation.', 'success');
    return true;
  } finally {
    setEditorBusy(workspace, false);
  }
}

function updateTypeGuidance(form, workspace) {
  const type = form.elements.type.value;
  const guidance = TYPE_GUIDANCE[type] ?? TYPE_GUIDANCE.personas;
  const instructionsRequired = guidance.instructionsRequired ? ' <small>Required</small>' : ' <small>Optional</small>';
  const contentRequired = guidance.contentRequired ? ' <small>Required</small>' : ' <small>Optional</small>';
  workspace.querySelector('[data-instructions-label]').innerHTML = escapeHtml(guidance.instructionsLabel) + instructionsRequired;
  workspace.querySelector('[data-instructions-help]').textContent = guidance.instructionsHelp;
  form.elements.instructions.placeholder = guidance.instructionsPlaceholder;
  form.elements.instructions.required = guidance.instructionsRequired;
  workspace.querySelector('[data-content-label]').innerHTML = escapeHtml(guidance.contentLabel) + contentRequired;
  workspace.querySelector('[data-content-help]').textContent = guidance.contentHelp;
  form.elements.content.placeholder = guidance.placeholder;
  form.elements.content.required = guidance.contentRequired;
  workspace.querySelector('[data-builder-overview]').innerHTML = `
    <strong>Building a ${escapeHtml(guidance.label)}</strong>
    <span>${escapeHtml(guidance.summary)} Complete the four sections below; only fields valid for this type are shown.</span>`;
  workspace.querySelectorAll('[data-guided-type]').forEach(section => {
    section.hidden = section.dataset.guidedType !== type;
  });
  if (type === 'ensembles' && !form.querySelector('[data-repeat-row="ensemble-elements"]')) {
    addRepeatRow(workspace, 'ensemble-elements');
  }
}

function wireBuilderControls(workspace) {
  workspace.addEventListener('click', event => {
    const add = event.target.closest('[data-add-row]');
    if (add) {
      addRepeatRow(workspace, add.dataset.addRow);
      return;
    }
    const remove = event.target.closest('[data-remove-row]');
    remove?.closest('[data-repeat-row]')?.remove();
  });
}

function addRepeatRow(workspace, kind, values = {}, shouldFocus = true) {
  const list = workspace.querySelector(`[data-repeat-list="${kind}"]`);
  if (!list) return;
  list.insertAdjacentHTML('beforeend', repeatRow(kind, values));
  if (shouldFocus) list.lastElementChild?.querySelector('input')?.focus();
}

function repeatRow(kind, values) {
  if (kind === 'ensemble-elements') return ensembleElementRow(values);
  if (kind === 'template-variables') return definitionRow(kind, values, ['string', 'number', 'boolean', 'date', 'array', 'object']);
  return definitionRow(kind, values, ['string', 'number', 'boolean', 'enum']);
}

function definitionRow(kind, values, types) {
  const options = types.map(type => `<option value="${type}"${values.type === type ? ' selected' : ''}>${capitalize(type)}</option>`).join('');
  return `
    <div class="portfolio-repeat-row" data-repeat-row="${kind}">
      <label><span>Name</span><input data-row-field="name" value="${escapeAttr(values.name ?? '')}" placeholder="topic"></label>
      <label><span>Type</span><select data-row-field="type">${options}</select></label>
      <label class="portfolio-repeat-grow"><span>Description</span><input data-row-field="description" value="${escapeAttr(values.description ?? '')}" placeholder="What this value controls"></label>
      <label class="portfolio-repeat-check"><input data-row-field="required" type="checkbox"${values.required ? ' checked' : ''}><span>Required</span></label>
      <button class="btn btn-ghost" data-remove-row type="button" aria-label="Remove row">Remove</button>
    </div>`;
}

function ensembleElementRow(values) {
  const typeOptions = ['persona', 'skill', 'template', 'agent', 'memory', 'ensemble'];
  const roleOptions = ['primary', 'support', 'override', 'monitor'];
  const activationOptions = ['always', 'on-demand', 'conditional'];
  return `
    <div class="portfolio-repeat-row portfolio-repeat-row--ensemble" data-repeat-row="ensemble-elements">
      <label><span>Element name</span><input data-row-field="name" value="${escapeAttr(values.element_name ?? '')}" placeholder="technical-writer"></label>
      <label><span>Type</span><select data-row-field="type">${rowOptions(typeOptions, values.element_type)}</select></label>
      <label><span>Role</span><select data-row-field="role">${rowOptions(roleOptions, values.role)}</select></label>
      <label><span>Activation</span><select data-row-field="activation">${rowOptions(activationOptions, values.activation)}</select></label>
      <label><span>Priority</span><input data-row-field="priority" type="number" min="0" max="100" value="${escapeAttr(values.priority ?? 10)}"></label>
      <label class="portfolio-repeat-grow"><span>Purpose</span><input data-row-field="purpose" value="${escapeAttr(values.purpose ?? '')}" placeholder="Why this element is included"></label>
      <button class="btn btn-ghost" data-remove-row type="button" aria-label="Remove element">Remove</button>
    </div>`;
}

function rowOptions(values, selected) {
  return values.map(value => `<option value="${value}"${selected === value ? ' selected' : ''}>${capitalize(value.replaceAll('-', ' '))}</option>`).join('');
}

function populateGuidedMetadata(form, metadata, type) {
  if (!metadata || typeof metadata !== 'object') return;
  setFieldValue(form, 'author', metadata.author);
  setFieldValue(form, 'version', metadata.version);
  setFieldValue(form, 'triggers', joined(metadata.triggers));
  setFieldValue(form, 'instructions', metadata.instructions);
  const populators = {
    personas: populatePersonaMetadata,
    skills: populateSkillMetadata,
    templates: populateTemplateMetadata,
    agents: populateAgentMetadata,
    memories: populateMemoryMetadata,
    ensembles: populateEnsembleMetadata,
  };
  populators[type]?.(form, metadata);
}

function resetGuidedMetadata(form) {
  for (const name of ['author', 'version', 'triggers', 'instructions']) setFieldValue(form, name, '');
  form.querySelectorAll('[data-guided-type] input, [data-guided-type] textarea').forEach(field => {
    if (field.type === 'checkbox') field.checked = field.defaultChecked;
    else field.value = '';
  });
  form.querySelectorAll('[data-guided-type] select').forEach(field => { field.selectedIndex = 0; });
  form.querySelectorAll('[data-repeat-list]').forEach(list => list.replaceChildren());
}

function populatePersonaMetadata(form, metadata) {
  setFieldValue(form, 'persona_tone', metadata.tone);
  setFieldValue(form, 'persona_voice', metadata.voice);
  setFieldValue(form, 'persona_domain', metadata.domain);
  setFieldValue(form, 'persona_expertise', joined(metadata.expertise));
  setFieldValue(form, 'persona_communication_style', metadata.communication_style ?? metadata.communicationStyle);
}

function populateSkillMetadata(form, metadata) {
  setFieldValue(form, 'skill_complexity', metadata.complexity);
  setFieldValue(form, 'skill_domains', joined(metadata.domains));
  setFieldValue(form, 'skill_prerequisites', joined(metadata.prerequisites));
  setFieldValue(form, 'skill_category', metadata.category);
  populateRows(form, 'skill-parameters', metadata.parameters);
}

function populateTemplateMetadata(form, metadata) {
  setFieldValue(form, 'template_category', metadata.category);
  setFieldValue(form, 'template_output_format', metadata.output_format ?? metadata.outputFormat);
  populateRows(form, 'template-variables', metadata.variables);
}

function populateAgentMetadata(form, metadata) {
  const goal = asRecord(metadata.goal);
  const activates = asRecord(metadata.activates);
  const tools = asRecord(metadata.tools);
  const autonomy = asRecord(metadata.autonomy);
  setFieldValue(form, 'agent_goal_template', goal.template);
  setFieldValue(form, 'agent_success_criteria', lines(goal.successCriteria));
  setFieldValue(form, 'agent_activates_personas', joined(activates.personas));
  setFieldValue(form, 'agent_activates_skills', joined(activates.skills));
  setFieldValue(form, 'agent_tools_allowed', joined(tools.allowed));
  setFieldValue(form, 'agent_tools_denied', joined(tools.denied));
  setFieldValue(form, 'agent_risk_tolerance', autonomy.riskTolerance);
  setFieldValue(form, 'agent_max_steps', autonomy.maxAutonomousSteps);
}

function populateMemoryMetadata(form, metadata) {
  setFieldValue(form, 'memory_privacy_level', metadata.privacyLevel);
  setFieldValue(form, 'memory_type', metadata.memoryType);
  setFieldValue(form, 'memory_retention_days', metadata.retentionDays);
  setFieldValue(form, 'memory_max_entries', metadata.maxEntries);
  setCheckbox(form, 'memory_searchable', metadata.searchable);
  setCheckbox(form, 'memory_auto_load', metadata.autoLoad);
}

function populateEnsembleMetadata(form, metadata) {
  setFieldValue(form, 'ensemble_activation_strategy', metadata.activationStrategy ?? metadata.activation_strategy);
  setFieldValue(form, 'ensemble_conflict_resolution', metadata.conflictResolution ?? metadata.conflict_resolution);
  setFieldValue(form, 'ensemble_context_sharing', metadata.contextSharing ?? metadata.context_sharing);
  setCheckbox(form, 'ensemble_allow_nested', metadata.allowNested ?? metadata.allow_nested);
  populateRows(form, 'ensemble-elements', metadata.elements);
}

function populateRows(form, kind, values) {
  if (!Array.isArray(values) || !values.length) return;
  const workspace = form.closest('[data-portfolio-authoring]');
  const list = form.querySelector(`[data-repeat-list="${kind}"]`);
  list?.replaceChildren();
  values.forEach(value => addRepeatRow(workspace, kind, asRecord(value), false));
}

function setFieldValue(form, name, value) {
  const field = form.elements[name];
  if (field && (typeof value === 'string' || typeof value === 'number')) field.value = String(value);
}

function setCheckbox(form, name, value) {
  if (typeof value === 'boolean' && form.elements[name]) form.elements[name].checked = value;
}

function joined(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').join(', ') : '';
}

function lines(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : '';
}

function wireImport(workspace, form, onDraft) {
  const input = workspace.querySelector('[data-import-file]');
  const dropZone = workspace.querySelector('[data-import-drop]');
  if (!input || !dropZone) return;
  const handleFile = async file => {
    if (!file) return;
    setEditorBusy(workspace, true);
    try {
      const draft = await parseElementFile(file);
      onDraft(draft);
      showEditorMessage(workspace, `Loaded “${file.name}”. Review the detected fields, then validate before importing.`, 'success');
    } catch (error) {
      showEditorMessage(workspace, error instanceof Error ? error.message : 'The selected file could not be read.', 'error', input);
    } finally {
      setEditorBusy(workspace, false);
      input.value = '';
    }
  };
  input.addEventListener('change', () => handleFile(input.files?.[0]));
  for (const eventName of ['dragenter', 'dragover']) {
    dropZone.addEventListener(eventName, event => {
      event.preventDefault();
      dropZone.classList.add('is-dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    dropZone.addEventListener(eventName, event => {
      event.preventDefault();
      dropZone.classList.remove('is-dragging');
    });
  }
  dropZone.addEventListener('drop', event => handleFile(event.dataTransfer?.files?.[0]));
}

async function parseElementFile(file) {
  if (file.size > IMPORT_FILE_LIMIT_BYTES) throw new Error('This file is larger than the 10 MiB element import limit.');
  const extension = file.name.toLowerCase().split('.').pop();
  if (!['md', 'markdown', 'yaml', 'yml', 'json'].includes(extension)) {
    throw new Error('Choose a Markdown, YAML, or JSON Dollhouse element file.');
  }
  const source = await file.text();
  if (!source.trim()) throw new Error('The selected file is empty.');
  const parsed = parseImportedSource(source, extension);
  return normalizeImportedDraft(parsed, source, file.name);
}

function parseImportedSource(source, extension) {
  if (extension === 'md' || extension === 'markdown') return parseMarkdownImport(source);
  if (extension === 'json') {
    try {
      return { record: JSON.parse(source), format: 'json' };
    } catch {
      throw new Error('This JSON file is not valid.');
    }
  }
  return { record: loadYaml(source), format: 'yaml' };
}

function parseMarkdownImport(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/u.exec(source);
  if (!match) throw new Error('This Markdown file needs YAML frontmatter between opening and closing --- lines.');
  return { record: loadYaml(match[1]), content: match[2], format: 'markdown' };
}

function loadYaml(source) {
  try {
    return parseBrowserYaml(source, { maxBytes: IMPORT_FILE_LIMIT_BYTES, schema: 'json' });
  } catch {
    throw new Error('This YAML file is not valid.');
  }
}

export function normalizeImportedDraft(parsed, originalSource, filename) {
  const packageRecord = asRecord(parsed.record);
  const portable = typeof packageRecord.exportVersion === 'string' && packageRecord.data !== undefined;
  const nested = portable ? parsePortableData(packageRecord) : packageRecord;
  const metadata = importedMetadata(nested);
  const typeCandidate = portable ? packageRecord.elementType : nested.type ?? metadata.type;
  const packageName = portable ? packageRecord.elementName : undefined;
  const detectedType = normalizeType(typeCandidate);
  const name = firstString(
    packageName,
    nested.name,
    metadata.name,
    filename.replace(/\.[^.]+$/u, ''),
  );
  const type = detectedType ?? 'personas';
  const importedBody = importedContent({
    type,
    parsed,
    nested,
    metadata,
    originalSource,
    portable,
    packageRecord,
  });
  const explicitInstructions = firstString(
    nested.instructions,
    metadata.instructions,
    asRecord(nested.extensions).instructions,
  );
  const legacyInstructionBody = parsed.format === 'markdown' &&
    ['personas', 'skills', 'agents'].includes(type) &&
    !explicitInstructions;
  const instructions = legacyInstructionBody ? importedBody : explicitInstructions;
  const content = legacyInstructionBody ? '' : importedBody;
  const tags = importedTags(nested, metadata);
  return {
    type,
    typeDetected: Boolean(detectedType),
    name,
    description: firstString(nested.description, metadata.description),
    tags: tags.filter(tag => typeof tag === 'string'),
    instructions,
    metadata,
    content,
    filename,
    format: parsed.format,
  };
}

function importedTags(record, metadata) {
  if (Array.isArray(record.tags)) return record.tags;
  return Array.isArray(metadata.tags) ? metadata.tags : [];
}

function parsePortableData(packageRecord) {
  const data = packageRecord.data;
  if (data && typeof data === 'object') return asRecord(data);
  if (typeof data !== 'string') throw new Error('This portable export does not contain readable element data.');
  if (packageRecord.format === 'yaml') return asRecord(loadYaml(data));
  try {
    return asRecord(JSON.parse(data));
  } catch {
    throw new Error('The data inside this portable JSON export is not valid JSON.');
  }
}

function importedMetadata(record) {
  if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
    const metadata = { ...record.metadata };
    for (const [key, value] of Object.entries(record)) {
      if (!IMPORT_ENVELOPE_KEYS.has(key) && metadata[key] === undefined) metadata[key] = value;
    }
    return metadata;
  }
  const metadata = { ...record };
  for (const key of IMPORT_ENVELOPE_KEYS) delete metadata[key];
  return metadata;
}

function importedContent({ type, parsed, nested, originalSource, portable, packageRecord }) {
  if (type === 'memories') {
    if (portable) {
      if (typeof packageRecord.data === 'string') return packageRecord.data;
      return JSON.stringify(nested, null, 2);
    }
    return originalSource;
  }
  if (typeof parsed.content === 'string') return parsed.content;
  if (typeof nested.content === 'string') return nested.content;
  return '';
}

function normalizeType(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  const aliases = {
    persona: 'personas',
    skill: 'skills',
    template: 'templates',
    agent: 'agents',
    memory: 'memories',
    ensemble: 'ensembles',
  };
  const type = aliases[normalized] ?? normalized;
  return TYPES.includes(type) ? type : null;
}

function applyImportedDraft(form, workspace, draft) {
  const typeControl = form.querySelector(`[name="type"][value="${draft.type}"]`);
  if (typeControl) typeControl.checked = true;
  resetGuidedMetadata(form);
  form.elements.name.value = draft.name;
  form.elements.description.value = draft.description;
  form.elements.tags.value = draft.tags.join(', ');
  form.elements.instructions.value = draft.instructions;
  setCustomMetadata(form, workspace, draft.metadata, 'import');
  form.elements.content.value = draft.content;
  populateGuidedMetadata(form, draft.metadata, draft.type);
  workspace.querySelector('[data-editor-fields]').hidden = false;
  workspace.querySelector('button[type="submit"]').disabled = false;
  workspace.querySelector('[data-editor-validate]')?.removeAttribute('disabled');
  const source = workspace.querySelector('[data-import-source]');
  const typeStatus = draft.typeDetected
    ? `${escapeHtml(TYPE_GUIDANCE[draft.type].label)} detected`
    : 'Choose the correct element type';
  source.hidden = false;
  source.innerHTML = `<strong>${escapeHtml(draft.filename)}</strong><span>${escapeHtml(draft.format.toUpperCase())} · ${typeStatus}</span>`;
  updateTypeGuidance(form, workspace);
}

function fieldForIssue(form, path) {
  if (typeof path !== 'string') return null;
  const field = path.split(/[.[\]]/u).find(Boolean);
  return form.elements[field] instanceof HTMLElement ? form.elements[field] : null;
}

function formDraft(form) {
  return [...new FormData(form).entries()].map(([key, value]) => `${key}:${formDraftValue(value)}`).join('|');
}

function formDraftValue(value) {
  if (typeof value === 'string') return value;
  return `${value.name}:${value.size}:${value.type}:${value.lastModified}`;
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() ?? '';
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
  const pendingJobId = readPendingPortfolioSyncJob();
  if (pendingJobId) {
    renderSyncStatus(dialog, null, 'Resuming the last portfolio sync…', 'neutral');
    void watchSync(dialog, pendingJobId, { notify, refresh, signal: controller.signal });
  }
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
    rememberPortfolioSyncJob(response.body.job_id);
    renderSyncStatus(dialog, response.body, 'Sync queued.');
    await handleSyncResult(await pollSync(dialog, response.body.job_id, context.signal), context);
  } catch (error) {
    if (error?.name !== 'AbortError') renderSyncStatus(dialog, null, 'Sync status could not reach the server.');
  } finally {
    setSyncBusy(dialog, false);
  }
}

async function watchSync(dialog, jobId, context) {
  setSyncBusy(dialog, true);
  try {
    await handleSyncResult(await pollSync(dialog, jobId, context.signal), context);
  } catch (error) {
    if (error?.name !== 'AbortError') renderSyncStatus(dialog, null, 'Sync status could not reach the server.');
  } finally {
    setSyncBusy(dialog, false);
  }
}

async function handleSyncResult(result, context) {
  if (result?.status === 'succeeded') {
    context.notify('Portfolio sync completed.', 'success');
    await context.refresh();
  } else if (result?.status === 'failed') {
    const errorSuffix = result.error_code ? ` (${result.error_code})` : '';
    context.notify(`Portfolio sync failed${errorSuffix}.`, 'error');
  }
}

async function pollSync(dialog, jobId, signal) {
  dialog.dataset.syncJobId = jobId;
  while (!signal.aborted) {
    const response = await get(`/me/portfolio/sync/${encodeURIComponent(jobId)}`, { signal });
    if (response.status !== 200 || !response.body) {
      if (response.status === 404) forgetPortfolioSyncJob(jobId);
      renderSyncStatus(dialog, null, responseDetail(response, 'Could not read sync status.'));
      return null;
    }
    renderSyncStatus(dialog, response.body);
    if (TERMINAL_SYNC_STATES.has(response.body.status)) {
      forgetPortfolioSyncJob(jobId);
      return response.body;
    }
    await delay(SYNC_POLL_INTERVAL_MS, signal);
  }
  return null;
}

function renderSyncStatus(dialog, job, fallback, fallbackKind = 'error') {
  const status = dialog.querySelector('[data-sync-status]');
  if (!job) {
    status.innerHTML = `<p class="portfolio-message portfolio-message--${fallbackKind}">${escapeHtml(fallback)}</p>`;
    return;
  }
  const summary = job.result_summary ? `<pre>${escapeHtml(JSON.stringify(job.result_summary, null, 2))}</pre>` : '';
  const error = job.error_code ? `<p>Error: <code>${escapeHtml(job.error_code)}</code></p>` : '';
  status.innerHTML = `<p><strong>${escapeHtml(capitalize(job.status || fallback || 'updated'))}</strong> · ${escapeHtml(job.direction || '')} · ${escapeHtml(job.conflict_policy || '')}</p>${error}${summary}`;
}

export function rememberPortfolioSyncJob(jobId, storage = portfolioSyncStorage()) {
  if (!isValidSyncJobId(jobId) || !storage) return false;
  try {
    storage.setItem(ACTIVE_SYNC_JOB_STORAGE_KEY, jobId);
    return true;
  } catch {
    return false;
  }
}

export function readPendingPortfolioSyncJob(storage = portfolioSyncStorage()) {
  if (!storage) return null;
  try {
    const jobId = storage.getItem(ACTIVE_SYNC_JOB_STORAGE_KEY);
    if (isValidSyncJobId(jobId)) return jobId;
    if (jobId !== null) storage.removeItem(ACTIVE_SYNC_JOB_STORAGE_KEY);
  } catch {
    return null;
  }
  return null;
}

export function forgetPortfolioSyncJob(jobId, storage = portfolioSyncStorage()) {
  if (!storage) return;
  try {
    if (jobId === undefined || storage.getItem(ACTIVE_SYNC_JOB_STORAGE_KEY) === jobId) {
      storage.removeItem(ACTIVE_SYNC_JOB_STORAGE_KEY);
    }
  } catch {
    // Storage availability is best-effort; server state remains authoritative.
  }
}

function portfolioSyncStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isValidSyncJobId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(value);
}

function setEditorBusy(workspace, busy) {
  const controls = workspace.querySelectorAll(
    '[data-editor-validate], [data-editor-render], [data-editor-reload], button[type="submit"], [data-import-file]',
  );
  controls.forEach(control => {
    if (busy && !control.disabled) {
      control.dataset.busyDisabled = '1';
      control.disabled = true;
    } else if (!busy && control.dataset.busyDisabled) {
      control.disabled = false;
      delete control.dataset.busyDisabled;
    }
  });
}

function setSyncBusy(dialog, busy) {
  dialog.querySelectorAll('select, button[type="submit"]').forEach(control => { control.disabled = busy; });
}

function showEditorMessage(workspace, message, kind, field = null) {
  showEditorHtml(workspace, `<p class="portfolio-message portfolio-message--${kind}">${escapeHtml(message)}</p>`, field);
}

function showEditorHtml(workspace, html, field = null) {
  const feedback = workspace.querySelector('[data-editor-feedback]');
  feedback.innerHTML = html;
  if (field instanceof HTMLElement) {
    field.focus();
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (feedback.querySelector('.portfolio-message--error')) {
    feedback.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
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

function formatBytes(value) {
  if (value >= 1024 * 1024 && value % (1024 * 1024) === 0) return `${value / (1024 * 1024)} MiB`;
  if (value >= 1024 && value % 1024 === 0) return `${value / 1024} KiB`;
  return `${value} bytes`;
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}
