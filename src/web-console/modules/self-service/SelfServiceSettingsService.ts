import type { UserConfig, IUserConfigStore } from '../../../storage/userConfig/IUserConfigStore.js';
import { UserConfigConflictError } from '../../../storage/userConfig/IUserConfigStore.js';
import type { ConsoleHandlerResult, ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import { serializeSelfSettings, settingsEtag } from './SelfServiceDtos.js';

const SECTION_MAP = {
  github_config: 'githubConfig',
  sync_config: 'syncConfig',
  autoload_config: 'autoloadConfig',
  retention_config: 'retentionConfig',
  wizard_config: 'wizardConfig',
  display_config: 'displayConfig',
  collection_config: 'collectionConfig',
  auto_activate_config: 'autoActivateConfig',
  source_priority_config: 'sourcePriorityConfig',
  user_identity_config: 'userIdentityConfig',
} as const;
const VALIDATION_FAILED_TITLE = 'Validation failed';

type PublicSection = keyof typeof SECTION_MAP;
type ConfigSection = typeof SECTION_MAP[PublicSection];

export class SelfServiceSettingsService {
  constructor(private readonly userConfigStore: IUserConfigStore) {}

  async getSettings(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const config = await this.load(req);
    return settingsResult(200, serializeSelfSettings(actor.userId, config), actor.userId, config);
  }

  async getSetting(req: ConsoleRequest, key: string): Promise<ConsoleHandlerResult> {
    const parsed = parseSettingPath(key);
    if (parsed.kind === 'problem') return parsed.result;
    const actor = requireConsoleAuthentication(req);
    const config = await this.load(req);
    return settingsResult(200, {
      key,
      value: getSettingValue(config, parsed.section, parsed.path),
      updated_at: config.updatedAt,
      etag: settingsEtag(actor.userId, config),
    }, actor.userId, config);
  }

  async putSetting(req: ConsoleRequest, key: string): Promise<ConsoleHandlerResult> {
    const parsed = parseSettingPath(key);
    if (parsed.kind === 'problem') return parsed.result;
    const current = await this.load(req);
    const actor = requireConsoleAuthentication(req);
    const precondition = requireCurrentEtag(req, actor.userId, current);
    if (precondition) return precondition;
    const body = parseSettingMutationBody(req.body);
    if (body.kind === 'problem') return body.result;
    const next = cloneConfig(current);
    const setResult = setSettingValue(next, parsed.section, parsed.path, body.value);
    if (setResult) return setResult;
    const sizeResult = validateConfigSize(next);
    if (sizeResult) return sizeResult;
    const saveResult = await this.save(actor.userId, next, current.updatedAt);
    if (saveResult) return saveResult;
    return this.getSetting(req, key);
  }

  async deleteSetting(req: ConsoleRequest, key: string): Promise<ConsoleHandlerResult> {
    const parsed = parseSettingPath(key);
    if (parsed.kind === 'problem') return parsed.result;
    const current = await this.load(req);
    const actor = requireConsoleAuthentication(req);
    const precondition = requireCurrentEtag(req, actor.userId, current);
    if (precondition) return precondition;
    const next = cloneConfig(current);
    deleteSettingValue(next, parsed.section, parsed.path);
    const saveResult = await this.save(actor.userId, next, current.updatedAt);
    if (saveResult) return saveResult;
    return this.getSetting(req, key);
  }

  private async load(req: ConsoleRequest): Promise<UserConfig> {
    return this.userConfigStore.load(requireConsoleAuthentication(req).userId);
  }

  private async save(userId: string, config: UserConfig, expectedUpdatedAt: number): Promise<ConsoleHandlerResult | null> {
    try {
      await this.userConfigStore.save(userId, config, { expectedUpdatedAt });
      return null;
    } catch (error) {
      if (error instanceof UserConfigConflictError) {
        return problem(412, 'precondition_failed', 'Precondition failed', 'Settings changed before the write completed.');
      }
      throw error;
    }
  }
}

function settingsResult(status: number, body: unknown, userId: string, config: UserConfig): ConsoleHandlerResult {
  return {
    status,
    body,
    headers: { ETag: settingsEtag(userId, config) },
  };
}

function parseSettingMutationBody(body: unknown):
  | { readonly kind: 'valid'; readonly value: unknown }
  | { readonly kind: 'problem'; readonly result: ConsoleHandlerResult } {
  if (!isRecord(body) || !Object.hasOwn(body, 'value')) {
    return { kind: 'problem', result: problem(400, 'invalid_request', 'Invalid request', 'Request body must contain value.') };
  }
  if (!isJsonCompatible(body.value)) {
    return { kind: 'problem', result: problem(422, 'validation_failed', VALIDATION_FAILED_TITLE, 'value must be JSON-compatible.') };
  }
  if (jsonSize(body.value) > 65_536) {
    return { kind: 'problem', result: problem(422, 'validation_failed', VALIDATION_FAILED_TITLE, 'value is too large.') };
  }
  return { kind: 'valid', value: body.value };
}

function parseSettingPath(key: string):
  | { readonly kind: 'valid'; readonly section: ConfigSection; readonly path: readonly string[] }
  | { readonly kind: 'problem'; readonly result: ConsoleHandlerResult } {
  if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(key)) {
    return { kind: 'problem', result: problem(400, 'invalid_request', 'Invalid request', 'Setting key must be a dotted allowlist path.') };
  }
  const [section, ...path] = key.split('.');
  if (!isPublicSection(section)) {
    return { kind: 'problem', result: problem(404, 'not_found', 'Not found', 'Setting key was not found.') };
  }
  return { kind: 'valid', section: SECTION_MAP[section], path };
}

function requireCurrentEtag(req: ConsoleRequest, userId: string, config: UserConfig): ConsoleHandlerResult | null {
  const value = singleHeader(req.headers['if-match']);
  if (!value) {
    return problem(428, 'precondition_required', 'Precondition required', 'If-Match is required for settings mutations.');
  }
  if (value !== settingsEtag(userId, config)) {
    return problem(412, 'precondition_failed', 'Precondition failed', 'If-Match does not match the current settings ETag.');
  }
  return null;
}

function getSettingValue(config: UserConfig, section: ConfigSection, path: readonly string[]): unknown {
  let cursor: unknown = config[section];
  for (const segment of path) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) return null;
    cursor = cursor[segment];
  }
  return cloneJson(cursor);
}

function setSettingValue(
  config: UserConfig,
  section: ConfigSection,
  path: readonly string[],
  value: unknown,
): ConsoleHandlerResult | null {
  if (path.length === 0) {
    const sectionValue = asRecordValue(value);
    if (!sectionValue) {
      return problem(422, 'validation_failed', VALIDATION_FAILED_TITLE, 'section replacement must be an object.');
    }
    config[section] = sectionValue;
    return null;
  }
  let cursor = config[section];
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (next === undefined) cursor[segment] = {};
    else if (!isRecord(next)) {
      return problem(422, 'validation_failed', VALIDATION_FAILED_TITLE, 'setting path crosses a non-object value.');
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path.at(-1) ?? ''] = cloneJson(value);
  return null;
}

function deleteSettingValue(config: UserConfig, section: ConfigSection, path: readonly string[]): void {
  if (path.length === 0) {
    config[section] = {};
    return;
  }
  let cursor: unknown = config[section];
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(cursor)) return;
    cursor = cursor[segment];
  }
  if (isRecord(cursor)) delete cursor[path.at(-1) ?? ''];
}

function cloneConfig(config: UserConfig): UserConfig {
  return {
    githubConfig: { ...config.githubConfig },
    syncConfig: { ...config.syncConfig },
    autoloadConfig: { ...config.autoloadConfig },
    retentionConfig: { ...config.retentionConfig },
    wizardConfig: { ...config.wizardConfig },
    displayConfig: { ...config.displayConfig },
    collectionConfig: { ...config.collectionConfig },
    autoActivateConfig: { ...config.autoActivateConfig },
    sourcePriorityConfig: { ...config.sourcePriorityConfig },
    userIdentityConfig: { ...config.userIdentityConfig },
    configVersion: config.configVersion,
    updatedAt: config.updatedAt,
  };
}

function asRecordValue(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return { ...value };
}

function isPublicSection(value: string): value is PublicSection {
  return Object.hasOwn(SECTION_MAP, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isJsonCompatible(value: unknown): boolean {
  if (value === null) return true;
  if (['string', 'number', 'boolean'].includes(typeof value)) return typeof value !== 'number' || Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonCompatible);
  if (isRecord(value)) return Object.values(value).every(isJsonCompatible);
  return false;
}

function cloneJson(value: unknown): unknown {
  return value === undefined ? null : structuredClone(value) as unknown;
}

function validateConfigSize(config: UserConfig): ConsoleHandlerResult | null {
  return jsonSize(config) > 262_144
    ? problem(422, 'validation_failed', VALIDATION_FAILED_TITLE, 'settings document is too large.')
    : null;
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function problem(status: number, code: string, title: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: 'about:blank',
      title,
      status,
      code,
      detail,
    },
  };
}
