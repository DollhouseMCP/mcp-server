import { createHash } from 'node:crypto';

import {
  OperatorConfigConflictError,
  type IOperatorConfigStore,
  type OperatorConfig,
} from '../../../storage/operatorConfig/IOperatorConfigStore.js';
import type { ConsoleCapability, ConsoleHandlerResult } from '../../platform/ConsolePlatformTypes.js';
import type {
  OperatorConfigListDto,
  OperatorConfigMutability,
  OperatorConfigSensitivity,
  OperatorConfigSettingDto,
  OperatorConfigValueSchemaDto,
} from './OperationsDtos.js';

export type OperatorConfigSection =
  | 'enhancedIndexConfig'
  | 'consoleConfig'
  | 'licenseConfig'
  | 'defaultsConfig';

export interface OperatorConfigSettingDefinition {
  readonly key: string;
  readonly section: OperatorConfigSection;
  readonly path: readonly string[];
  readonly schema: OperatorConfigValueSchemaDto;
  readonly schemaVersion: number;
  readonly sensitivity: OperatorConfigSensitivity;
  readonly mutability: OperatorConfigMutability;
  readonly requiredCapability: ConsoleCapability;
  readonly defaultValue?: unknown;
  readonly validateChange?: (oldValue: unknown, newValue: unknown) => string | null;
  readonly apply?: (newValue: unknown) => Promise<{ readonly restartRequired?: boolean }>;
}

export interface OperatorConfigUpdateInput {
  readonly key: string;
  readonly ifMatch: string | null;
  readonly body: unknown;
}

const OPERATE_CAPABILITY = 'console:admin:operate';
const CONFIG_METADATA_KEY = '__operator_config_status';
const MAX_CONFIG_VALUE_BYTES = 64 * 1024;

export const DEFAULT_OPERATOR_CONFIG_DEFINITIONS: readonly OperatorConfigSettingDefinition[] = [
  {
    key: 'enhanced_index.enabled',
    section: 'enhancedIndexConfig',
    path: ['enabled'],
    schema: { type: 'boolean' },
    schemaVersion: 1,
    sensitivity: 'public_admin',
    mutability: 'dynamic',
    requiredCapability: OPERATE_CAPABILITY,
    defaultValue: false,
  },
  {
    key: 'enhanced_index.max_cache_entries',
    section: 'enhancedIndexConfig',
    path: ['max_cache_entries'],
    schema: { type: 'integer', minimum: 0, maximum: 100000 },
    schemaVersion: 1,
    sensitivity: 'public_admin',
    mutability: 'dynamic',
    requiredCapability: OPERATE_CAPABILITY,
    defaultValue: 1000,
  },
  {
    key: 'console.port',
    section: 'consoleConfig',
    path: ['port'],
    schema: { type: 'integer', minimum: 1, maximum: 65535 },
    schemaVersion: 1,
    sensitivity: 'public_admin',
    mutability: 'restart_required',
    requiredCapability: OPERATE_CAPABILITY,
    defaultValue: 3000,
  },
  {
    key: 'license.key',
    section: 'licenseConfig',
    path: ['key'],
    schema: { type: 'string', min_length: 1, max_length: 4096 },
    schemaVersion: 1,
    sensitivity: 'secret_write_only',
    mutability: 'restart_required',
    requiredCapability: OPERATE_CAPABILITY,
  },
];

export class OperatorConfigurationService {
  private readonly definitions: readonly OperatorConfigSettingDefinition[];

  constructor(
    private readonly store: IOperatorConfigStore,
    definitions: readonly OperatorConfigSettingDefinition[] = DEFAULT_OPERATOR_CONFIG_DEFINITIONS,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.definitions = [...definitions]
      .filter(definition => definition.requiredCapability === OPERATE_CAPABILITY)
      .sort((left, right) => left.key.localeCompare(right.key));
    assertUniqueDefinitions(this.definitions);
  }

  async listConfig(): Promise<ConsoleHandlerResult> {
    const config = await this.store.load();
    return {
      status: 200,
      body: {
        items: this.definitions.map(definition => this.toDto(config, definition)),
      } satisfies OperatorConfigListDto,
    };
  }

  async getConfig(key: string): Promise<ConsoleHandlerResult> {
    const definition = this.findDefinition(key);
    if (!definition) return configProblem(404, 'not_found', 'Operator configuration key was not found.');
    const config = await this.store.load();
    const dto = this.toDto(config, definition);
    return {
      status: 200,
      body: dto,
      headers: { ETag: dto.etag },
    };
  }

  async updateConfig(input: OperatorConfigUpdateInput): Promise<ConsoleHandlerResult> {
    const definition = this.findDefinition(input.key);
    if (!definition) return configProblem(404, 'not_found', 'Operator configuration key was not found.');
    if (definition.mutability === 'read_only') {
      return configProblem(409, 'config_read_only', 'Operator configuration key is read-only.');
    }
    if (!input.ifMatch) {
      return configProblem(428, 'precondition_required', 'If-Match is required for operator configuration mutations.');
    }

    const loaded = await this.store.load();
    const current = this.toDto(loaded, definition);
    if (input.ifMatch !== current.etag) {
      return configProblem(412, 'precondition_failed', 'If-Match does not match the current operator configuration ETag.');
    }

    const valueResult = parseMutationValue(input.body);
    if (!valueResult.ok) {
      return configProblem(422, 'validation_failed', valueResult.detail);
    }
    const validationError = validateSchema(definition.schema, valueResult.value);
    if (validationError) return configProblem(422, 'validation_failed', validationError);
    const changeError = definition.validateChange?.(currentValue(loaded, definition), valueResult.value);
    if (changeError) return configProblem(422, 'validation_failed', changeError);

    const next = cloneConfig(loaded);
    setDefinitionValue(next, definition, valueResult.value);
    const applyResult = definition.apply ? await definition.apply(valueResult.value) : {};
    const pendingRestart = definition.mutability === 'restart_required' || applyResult.restartRequired === true;
    setConfigMetadata(next, definition.key, {
      effectiveAt: pendingRestart ? null : this.now().toISOString(),
      pendingRestart,
    });
    try {
      await this.store.save(next, { expectedUpdatedAt: loaded.updatedAt });
    } catch (error) {
      if (error instanceof OperatorConfigConflictError) {
        return configProblem(412, 'precondition_failed', 'Operator configuration changed while this request was being applied.');
      }
      throw error;
    }

    const saved = await this.store.load();
    const dto = this.toDto(saved, definition);
    return {
      status: 200,
      body: dto,
      headers: { ETag: dto.etag },
    };
  }

  private findDefinition(key: string): OperatorConfigSettingDefinition | null {
    if (!isOperatorConfigKey(key)) return null;
    return this.definitions.find(definition => definition.key === key) ?? null;
  }

  private toDto(config: OperatorConfig, definition: OperatorConfigSettingDefinition): OperatorConfigSettingDto {
    const value = currentValue(config, definition);
    const metadata = configMetadata(config, definition.key);
    const base = {
      key: definition.key,
      schema_version: definition.schemaVersion,
      sensitivity: definition.sensitivity,
      mutability: definition.mutability,
      value_schema: definition.schema,
      effective_at: metadata.pendingRestart ? null : metadata.effectiveAt ?? effectiveAt(config),
      pending_restart: metadata.pendingRestart,
      etag: settingEtag(config, definition),
    };
    if (definition.sensitivity === 'secret_write_only') {
      return {
        ...base,
        configured: isConfiguredSecret(value),
      };
    }
    return {
      ...base,
      value,
    };
  }
}

function parseMutationValue(body: unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly detail: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'value')) {
    return { ok: false, detail: 'Request body must be an object with a value field.' };
  }
  const value = (body as { readonly value?: unknown }).value;
  if (!isJsonCompatible(value)) {
    return { ok: false, detail: 'Operator configuration value must be JSON-compatible.' };
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CONFIG_VALUE_BYTES) {
    return { ok: false, detail: 'Operator configuration value exceeds the maximum size.' };
  }
  return { ok: true, value };
}

function validateSchema(schema: OperatorConfigValueSchemaDto, value: unknown): string | null {
  switch (schema.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Value must be a boolean.';
    case 'string':
      return validateStringSchema(schema, value);
    case 'integer':
      return validateNumberSchema(schema, value, true);
    case 'number':
      return validateNumberSchema(schema, value, false);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? null : 'Value must be an object.';
  }
}

function validateStringSchema(schema: OperatorConfigValueSchemaDto, value: unknown): string | null {
  if (typeof value !== 'string') return 'Value must be a string.';
  if (schema.min_length !== undefined && value.length < schema.min_length) return 'Value is shorter than the minimum length.';
  if (schema.max_length !== undefined && value.length > schema.max_length) return 'Value exceeds the maximum length.';
  return null;
}

function validateNumberSchema(schema: OperatorConfigValueSchemaDto, value: unknown, integer: boolean): string | null {
  if (typeof value !== 'number') return integer ? 'Value must be an integer.' : 'Value must be a finite number.';
  if (integer && !Number.isSafeInteger(value)) return 'Value must be an integer.';
  if (!integer && !Number.isFinite(value)) return 'Value must be a finite number.';
  if (schema.minimum !== undefined && value < schema.minimum) return 'Value is below the minimum.';
  if (schema.maximum !== undefined && value > schema.maximum) return 'Value exceeds the maximum.';
  return null;
}

function currentValue(config: OperatorConfig, definition: OperatorConfigSettingDefinition): unknown {
  const found = getNested(config[definition.section], definition.path);
  return found === undefined ? definition.defaultValue ?? null : cloneJson(found);
}

function setDefinitionValue(config: OperatorConfig, definition: OperatorConfigSettingDefinition, value: unknown): void {
  setNested(config[definition.section], definition.path, cloneJson(value));
}

function getNested(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setNested(record: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = record;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path.at(-1) ?? ''] = value;
}

function settingEtag(config: OperatorConfig, definition: OperatorConfigSettingDefinition): string {
  const value = currentValue(config, definition);
  const payload = {
    key: definition.key,
    schemaVersion: definition.schemaVersion,
    sensitivity: definition.sensitivity,
    configured: definition.sensitivity === 'secret_write_only' ? isConfiguredSecret(value) : undefined,
    value: definition.sensitivity === 'secret_write_only' ? undefined : value,
    updatedAt: config.updatedAt,
    metadata: configMetadata(config, definition.key),
  };
  const digest = createHash('sha256').update(canonicalJson(payload)).digest('base64url').slice(0, 32);
  return `W/"operator-config:${definition.key}:${digest}"`;
}

function configMetadata(config: OperatorConfig, key: string): { readonly effectiveAt: string | null; readonly pendingRestart: boolean } {
  const metadata = config.defaultsConfig[CONFIG_METADATA_KEY];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { effectiveAt: null, pendingRestart: false };
  }
  const item = (metadata as Record<string, unknown>)[key];
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { effectiveAt: null, pendingRestart: false };
  }
  const record = item as Record<string, unknown>;
  return {
    effectiveAt: typeof record.effectiveAt === 'string' ? record.effectiveAt : null,
    pendingRestart: record.pendingRestart === true,
  };
}

function setConfigMetadata(
  config: OperatorConfig,
  key: string,
  metadata: { readonly effectiveAt: string | null; readonly pendingRestart: boolean },
): void {
  const existing = config.defaultsConfig[CONFIG_METADATA_KEY];
  const root = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...existing as Record<string, unknown> }
    : {};
  root[key] = metadata;
  config.defaultsConfig[CONFIG_METADATA_KEY] = root;
}

function effectiveAt(config: OperatorConfig): string | null {
  return config.updatedAt > 0 ? new Date(config.updatedAt).toISOString() : null;
}

function isConfiguredSecret(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function isOperatorConfigKey(key: string): boolean {
  return /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(key) && key.length <= 128;
}

function isJsonCompatible(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonCompatible);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isJsonCompatible);
  return false;
}

function cloneConfig(config: OperatorConfig): OperatorConfig {
  return {
    enhancedIndexConfig: cloneRecord(config.enhancedIndexConfig),
    consoleConfig: cloneRecord(config.consoleConfig),
    licenseConfig: cloneRecord(config.licenseConfig),
    defaultsConfig: cloneRecord(config.defaultsConfig),
    configVersion: config.configVersion,
    updatedAt: config.updatedAt,
  };
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return cloneJson(record) as Record<string, unknown>;
}

function cloneJson(value: unknown): unknown {
  return structuredClone(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertUniqueDefinitions(definitions: readonly OperatorConfigSettingDefinition[]): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.key)) throw new Error(`duplicate operator config definition: ${definition.key}`);
    if (definition.path.some(segment => segment.startsWith('__'))) {
      throw new Error(`operator config definition uses reserved path segment: ${definition.key}`);
    }
    seen.add(definition.key);
  }
}

function configProblem(status: number, code: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: 'about:blank',
      title: status >= 500 ? 'Service unavailable' : 'Invalid request',
      status,
      code,
      detail,
    },
  };
}
