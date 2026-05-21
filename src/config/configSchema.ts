/**
 * dollhouse_config schema registry.
 *
 * Canonical list of valid configuration paths and their expected value
 * types. ConfigManager.updateSetting validates against this on every
 * write so typos (`sync.enabled = "tru"`), schema drift (renamed keys
 * silently writing into the JSONB blob), and type mismatches surface as
 * errors instead of "✅ saved" lies.
 *
 * The schema mirrors the TypeScript interfaces in ConfigManager.ts
 * (UserConfig, GitHubConfig, SyncConfig, CollectionConfig, etc.). When
 * those interfaces gain a new field, add the corresponding path entry
 * here too — both should change together.
 *
 * Strictness is controlled by `DOLLHOUSE_CONFIG_STRICT_PATHS` env var:
 *   - default `true`  — reject unknown paths with a clear error
 *   - `false`         — log a warning and allow (back-compat for old
 *                       operator workflows that may have stored phantom
 *                       keys that the schema hasn't catalogued yet)
 *
 * @module config/configSchema
 */

/**
 * Allowed value shape for a single configuration path. `enum` is used
 * for string-literal unions; `nullable` for `string | null` fields;
 * `arrayOf` for typed array fields.
 */
export type ConfigFieldType =
  | 'boolean'
  | 'number'
  | 'string'
  | 'array'
  | 'object';

export interface ConfigFieldSpec {
  type: ConfigFieldType;
  /** When type='string', the set of acceptable literal values. */
  enum?: readonly string[];
  /** When true, `null` is an acceptable value (e.g. user.username before setup). */
  nullable?: boolean;
  /** When type='array', the element type for items in the array. */
  arrayOf?: 'string' | 'number';
  /** When type='number', the inclusive minimum. */
  min?: number;
  /** When type='number', the inclusive maximum. */
  max?: number;
  /** Human-readable description, surfaced in error messages. */
  description: string;
}

/**
 * The schema registry. Keys are dot-notation paths exactly as
 * `dollhouse_config set <path>` accepts them.
 */
export const CONFIG_SCHEMA: Readonly<Record<string, ConfigFieldSpec>> = {
  // ── User identity ──────────────────────────────────────────────────
  'user.username': { type: 'string', nullable: true, description: 'Display username for portfolio attribution' },
  'user.email': { type: 'string', nullable: true, description: 'Contact email (only used for verification / license attestation)' },
  'user.display_name': { type: 'string', nullable: true, description: 'Human-readable display name' },

  // ── GitHub integration ─────────────────────────────────────────────
  'github.portfolio.repository_url': { type: 'string', nullable: true, description: 'Full URL to the operator\'s GitHub portfolio repo' },
  'github.portfolio.repository_name': { type: 'string', description: 'Repository name (e.g. "dollhouse-portfolio")' },
  'github.portfolio.default_branch': { type: 'string', description: 'Default branch for portfolio commits' },
  'github.portfolio.auto_create': { type: 'boolean', description: 'Auto-create the portfolio repo on first sync if missing' },
  'github.auth.use_oauth': { type: 'boolean', description: 'Use OAuth device flow for portfolio sync (vs personal access token)' },
  'github.auth.token_source': { type: 'string', enum: ['environment', 'oauth', 'config'], description: 'Where to source the GitHub token from' },
  'github.auth.client_id': { type: 'string', description: 'GitHub OAuth app client ID (for device flow)' },

  // ── Sync ───────────────────────────────────────────────────────────
  'sync.enabled': { type: 'boolean', description: 'Master toggle for portfolio sync' },
  'sync.individual.require_confirmation': { type: 'boolean', description: 'Require confirm before single-element sync' },
  'sync.individual.show_diff_before_sync': { type: 'boolean', description: 'Show a diff before pushing a single element' },
  'sync.individual.track_versions': { type: 'boolean', description: 'Keep version history for individual elements' },
  'sync.individual.keep_history': { type: 'number', min: 0, description: 'Number of historical versions to keep per element' },
  'sync.bulk.upload_enabled': { type: 'boolean', description: 'Allow bulk upload operations' },
  'sync.bulk.download_enabled': { type: 'boolean', description: 'Allow bulk download operations' },
  'sync.bulk.require_preview': { type: 'boolean', description: 'Show preview before bulk operations' },
  'sync.bulk.respect_local_only': { type: 'boolean', description: 'Honor the local-only flag on elements during bulk sync' },
  'sync.privacy.scan_for_secrets': { type: 'boolean', description: 'Scan element content for secrets before sync' },
  'sync.privacy.scan_for_pii': { type: 'boolean', description: 'Scan element content for PII before sync' },
  'sync.privacy.warn_on_sensitive': { type: 'boolean', description: 'Warn (don\'t block) when sync content matches sensitive patterns' },
  'sync.privacy.excluded_patterns': { type: 'array', arrayOf: 'string', description: 'Glob patterns to exclude from sync entirely' },

  // ── Collection ─────────────────────────────────────────────────────
  'collection.auto_submit': { type: 'boolean', description: 'Auto-submit new elements to the public collection' },
  'collection.require_review': { type: 'boolean', description: 'Require human review before collection submission' },
  'collection.add_attribution': { type: 'boolean', description: 'Stamp portfolio attribution onto collection submissions' },

  // ── Elements ───────────────────────────────────────────────────────
  'elements.auto_activate.personas': { type: 'array', arrayOf: 'string', description: 'Personas auto-activated at startup' },
  'elements.auto_activate.skills': { type: 'array', arrayOf: 'string', description: 'Skills auto-activated at startup' },
  'elements.auto_activate.templates': { type: 'array', arrayOf: 'string', description: 'Templates auto-activated at startup' },
  'elements.auto_activate.agents': { type: 'array', arrayOf: 'string', description: 'Agents auto-activated at startup' },
  'elements.auto_activate.memories': { type: 'array', arrayOf: 'string', description: 'Memories auto-activated at startup' },
  'elements.auto_activate.ensembles': { type: 'array', arrayOf: 'string', description: 'Ensembles auto-activated at startup' },
  'elements.default_element_dir': { type: 'string', description: 'Override for the element root directory' },
  'elements.enhanced_index.enabled': { type: 'boolean', description: 'Master toggle for the enhanced verb-trigger index' },
  'elements.enhanced_index.limits.maxTriggersPerElement': { type: 'number', min: 0, description: 'Cap on triggers extracted per element' },
  'elements.enhanced_index.limits.maxTriggerLength': { type: 'number', min: 1, description: 'Max characters per trigger string' },
  'elements.enhanced_index.limits.maxKeywordsToCheck': { type: 'number', min: 0, description: 'Cap on keywords scanned per trigger evaluation' },
  'elements.enhanced_index.telemetry.enabled': { type: 'boolean', description: 'Emit enhanced-index telemetry events' },
  'elements.enhanced_index.telemetry.sampleRate': { type: 'number', min: 0, max: 1, description: 'Sampling rate for telemetry (0..1)' },
  'elements.enhanced_index.telemetry.metricsInterval': { type: 'number', min: 1000, description: 'Metrics flush interval in ms' },
  'elements.enhanced_index.verbPatterns.customPrefixes': { type: 'array', arrayOf: 'string', description: 'Operator-defined verb prefixes' },
  'elements.enhanced_index.verbPatterns.customSuffixes': { type: 'array', arrayOf: 'string', description: 'Operator-defined verb suffixes' },
  'elements.enhanced_index.verbPatterns.excludedNouns': { type: 'array', arrayOf: 'string', description: 'Nouns excluded from trigger extraction' },
  'elements.enhanced_index.backgroundAnalysis.enabled': { type: 'boolean', description: 'Run trigger analysis on a background schedule' },
  'elements.enhanced_index.backgroundAnalysis.scanInterval': { type: 'number', min: 1000, description: 'Background scan interval in ms' },
  'elements.enhanced_index.backgroundAnalysis.maxConcurrentScans': { type: 'number', min: 1, description: 'Concurrency cap for background scans' },
  'elements.enhanced_index.resources.advertise_resources': { type: 'boolean', description: 'Expose enhanced-index data via MCP resources' },
  'elements.enhanced_index.resources.variants.summary': { type: 'boolean', description: 'Include the summary resource variant' },
  'elements.enhanced_index.resources.variants.full': { type: 'boolean', description: 'Include the full resource variant' },
  'elements.enhanced_index.resources.variants.stats': { type: 'boolean', description: 'Include the stats resource variant' },

  // ── Display ────────────────────────────────────────────────────────
  'display.persona_indicators.enabled': { type: 'boolean', description: 'Show persona-indicator prefix on tool output' },
  'display.persona_indicators.style': { type: 'string', enum: ['full', 'minimal', 'compact', 'custom'], description: 'Indicator render style' },
  'display.persona_indicators.include_emoji': { type: 'boolean', description: 'Include the persona emoji in the indicator' },
  'display.verbose_logging': { type: 'boolean', description: 'Verbose log output for operator debugging' },
  'display.show_progress': { type: 'boolean', description: 'Render progress for long-running operations' },
  // display.indicator.* maps to PersonaIndicatorService (separate from persona_indicators)
  'display.indicator.enabled': { type: 'boolean', description: 'Enable the runtime persona indicator' },
  'display.indicator.style': { type: 'string', enum: ['full', 'minimal', 'compact', 'custom'], description: 'Runtime indicator render style' },
  'display.indicator.customFormat': { type: 'string', description: 'Custom format string for style="custom"' },
  'display.indicator.showEmoji': { type: 'boolean', description: 'Render the emoji in the runtime indicator' },
  'display.indicator.showName': { type: 'boolean', description: 'Render the name in the runtime indicator' },
  'display.indicator.showVersion': { type: 'boolean', description: 'Render the version in the runtime indicator' },
  'display.indicator.showAuthor': { type: 'boolean', description: 'Render the author in the runtime indicator' },
  'display.indicator.showCategory': { type: 'boolean', description: 'Render the category in the runtime indicator' },
  'display.indicator.separator': { type: 'string', description: 'Separator between indicator fields' },
  'display.indicator.emoji': { type: 'string', description: 'Emoji override for the runtime indicator' },
  'display.indicator.bracketStyle': { type: 'string', enum: ['square', 'round', 'curly', 'angle', 'none'], description: 'Bracket style around the indicator' },

  // ── Wizard ─────────────────────────────────────────────────────────
  'wizard.completed': { type: 'boolean', description: 'True when the operator finished the setup wizard' },
  'wizard.dismissed': { type: 'boolean', description: 'True when the operator chose "don\'t show again"' },
  'wizard.completedAt': { type: 'string', description: 'ISO-8601 timestamp the wizard was completed at' },
  'wizard.version': { type: 'string', description: 'Wizard schema version (deprecated; prefer lastSeenVersion)' },
  'wizard.lastSeenVersion': { type: 'string', description: 'Last wizard version shown to the operator' },
  'wizard.skippedSections': { type: 'array', arrayOf: 'string', description: 'Sections the operator skipped' },

  // ── Auto-load ──────────────────────────────────────────────────────
  'autoLoad.enabled': { type: 'boolean', description: 'Auto-load configured memories at session start' },
  'autoLoad.maxTokenBudget': { type: 'number', min: 0, description: 'Cap on total tokens loaded by auto-load' },
  'autoLoad.maxSingleMemoryTokens': { type: 'number', min: 0, description: 'Cap on a single memory\'s contribution' },
  'autoLoad.suppressLargeMemoryWarnings': { type: 'boolean', description: 'Suppress the "memory exceeded budget" warning' },
  'autoLoad.memories': { type: 'array', arrayOf: 'string', description: 'Memory names to load automatically' },

  // ── Retention policy ───────────────────────────────────────────────
  'retentionPolicy.enabled': { type: 'boolean', description: 'Master switch for memory retention enforcement' },
  'retentionPolicy.enforcement_mode': { type: 'string', enum: ['disabled', 'manual', 'on_load', 'scheduled'], description: 'When retention runs' },
  'retentionPolicy.safety.require_confirmation': { type: 'boolean', description: 'Require confirm before any retention deletion' },
  'retentionPolicy.safety.dry_run_first': { type: 'boolean', description: 'Always preview before deletion' },
  'retentionPolicy.safety.warn_on_expiring': { type: 'boolean', description: 'Warn when entries approach expiration' },
  'retentionPolicy.safety.warning_threshold_days': { type: 'number', min: 0, description: 'Days before expiration to warn' },
  'retentionPolicy.audit.log_deletions': { type: 'boolean', description: 'Log retention deletions to the audit trail' },
  'retentionPolicy.audit.backup_before_delete': { type: 'boolean', description: 'Keep a backup before permanent removal' },
  'retentionPolicy.audit.backup_retention_days': { type: 'number', min: 0, description: 'Days to keep deletion backups' },
  'retentionPolicy.defaults.ttl_days': { type: 'number', min: 0, description: 'Default TTL (days) for new memory entries' },
  'retentionPolicy.defaults.max_entries': { type: 'number', min: 0, description: 'Default cap on entries per memory' },

  // ── License ────────────────────────────────────────────────────────
  'license.tier': { type: 'string', enum: ['agpl', 'free-commercial', 'paid-commercial'], description: 'Active license tier' },
  'license.email': { type: 'string', description: 'License contact email (required for commercial tiers)' },
  'license.attestedAt': { type: 'string', description: 'ISO-8601 timestamp of license attestation' },
  'license.telemetryRequired': { type: 'boolean', description: 'True for commercial tiers (license condition)' },
  'license.revenueScale': { type: 'string', description: 'Paid commercial revenue band' },
  'license.companyName': { type: 'string', description: 'Paid commercial: required company name' },
  'license.useCase': { type: 'string', description: 'Paid commercial: required use case' },

  // ── Console ────────────────────────────────────────────────────────
  'console.port': { type: 'number', min: 1024, max: 65535, description: 'Web console port (1024..65535)' },

  // ── Source priority (top-level path also accepted but handled by source_priority handler) ──
  'source_priority.order': { type: 'array', arrayOf: 'string', description: 'Source resolution order (local, github, collection)' },
  'source_priority.stop_on_first': { type: 'boolean', description: 'Stop at the first source that returns a hit' },
  'source_priority.check_all_for_updates': { type: 'boolean', description: 'Always check all sources for updates' },
  'source_priority.fallback_on_error': { type: 'boolean', description: 'Fall back to next source on error' },
};

/**
 * Result of validating a single `set` operation.
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a `dollhouse_config set <path> <value>` invocation against
 * the schema. Returns ok=false with a human-readable error when:
 *   - path is unknown (and strict mode is on)
 *   - value type does not match the schema entry's type
 *   - enum constraint is violated
 *   - numeric min/max is violated
 *   - array element type is wrong
 *
 * `strict` defaults to true; pass false to allow unknown paths through
 * (for back-compat with operator workflows storing phantom keys).
 */
export function validateConfigPath(
  path: string,
  value: unknown,
  options: { strict?: boolean } = {},
): ValidationResult {
  const strict = options.strict ?? true;
  const spec = CONFIG_SCHEMA[path];

  if (!spec) {
    if (!strict) return { ok: true };
    const suggestion = suggestNearestPath(path);
    const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
    return {
      ok: false,
      error: `Unknown configuration path '${path}'.${hint} Run \`dollhouse_config action: "get"\` to see valid paths, or set DOLLHOUSE_CONFIG_STRICT_PATHS=false to allow unknown paths.`,
    };
  }

  return checkValueAgainstSpec(spec, value, path);
}

/** True when the path is a schema-known leaf setting. */
export function isKnownConfigPath(path: string): boolean {
  return CONFIG_SCHEMA[path] !== undefined;
}

function checkValueAgainstSpec(spec: ConfigFieldSpec, value: unknown, path: string): ValidationResult {
  if (value === null) {
    return spec.nullable
      ? { ok: true }
      : { ok: false, error: `Configuration path '${path}' does not accept null.` };
  }

  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, error: `Configuration path '${path}' expects boolean, got ${describeValue(value)}.` };

    case 'number':
      return checkNumber(spec, value, path);

    case 'string':
      return checkString(spec, value, path);

    case 'array':
      return checkArray(spec, value, path);

    case 'object':
      return typeof value === 'object' && !Array.isArray(value)
        ? { ok: true }
        : { ok: false, error: `Configuration path '${path}' expects object, got ${describeValue(value)}.` };
  }
}

function checkNumber(spec: ConfigFieldSpec, value: unknown, path: string): ValidationResult {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: `Configuration path '${path}' expects number, got ${describeValue(value)}.` };
  }
  if (spec.min !== undefined && value < spec.min) {
    return { ok: false, error: `Configuration path '${path}' must be ≥ ${spec.min}, got ${value}.` };
  }
  if (spec.max !== undefined && value > spec.max) {
    return { ok: false, error: `Configuration path '${path}' must be ≤ ${spec.max}, got ${value}.` };
  }
  return { ok: true };
}

function checkString(spec: ConfigFieldSpec, value: unknown, path: string): ValidationResult {
  if (typeof value !== 'string') {
    return { ok: false, error: `Configuration path '${path}' expects string, got ${describeValue(value)}.` };
  }
  if (spec.enum && !spec.enum.includes(value)) {
    return {
      ok: false,
      error: `Configuration path '${path}' must be one of: ${spec.enum.map(v => `'${v}'`).join(', ')}. Got '${value}'.`,
    };
  }
  return { ok: true };
}

function checkArray(spec: ConfigFieldSpec, value: unknown, path: string): ValidationResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: `Configuration path '${path}' expects array, got ${describeValue(value)}.` };
  }
  if (!spec.arrayOf) return { ok: true };

  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (spec.arrayOf === 'string' && typeof item !== 'string') {
      return { ok: false, error: `Configuration path '${path}'[${i}] expects string, got ${describeValue(item)}.` };
    }
    if (spec.arrayOf === 'number' && (typeof item !== 'number' || !Number.isFinite(item))) {
      return { ok: false, error: `Configuration path '${path}'[${i}] expects number, got ${describeValue(item)}.` };
    }
  }
  return { ok: true };
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array (${value.length} item${value.length === 1 ? '' : 's'})`;
  return `${typeof value} (${JSON.stringify(value).slice(0, 40)})`;
}

/**
 * Return the schema's nearest path to `candidate` by Levenshtein
 * distance, or undefined if nothing is close (distance > 5). Used to
 * power "did you mean" suggestions for typos.
 */
export function suggestNearestPath(candidate: string): string | undefined {
  const knownPaths = Object.keys(CONFIG_SCHEMA);
  let best: { path: string; distance: number } | undefined;
  for (const path of knownPaths) {
    const distance = levenshtein(candidate, path);
    if (best === undefined || distance < best.distance) {
      best = { path, distance };
    }
  }
  if (best && best.distance <= 5) return best.path;
  return undefined;
}

/**
 * Return all schema paths matching an optional prefix. Used by the
 * `dollhouse_config list-paths` UX so operators can discover what's
 * available.
 */
export function listKnownPaths(prefix?: string): string[] {
  const all = Object.keys(CONFIG_SCHEMA).sort();
  if (!prefix) return all;
  return all.filter(p => p.startsWith(prefix));
}

// ── Levenshtein distance for path suggestions ─────────────────────

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}
