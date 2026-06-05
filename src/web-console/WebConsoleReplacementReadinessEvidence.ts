import {
  WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS,
  WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS,
  type WebConsoleReplacementLiveCheck,
  type WebConsoleReplacementPhase,
} from './WebConsoleReplacementReadiness.js';

type EvidenceRecord = Record<string, unknown>;

export interface WebConsoleReplacementReadinessEvidence {
  readonly phase: WebConsoleReplacementPhase;
  readonly composition: {
    readonly activationProfile: 'development' | 'shared-hosted';
    readonly storageBackend: 'memory' | 'postgres';
    readonly apiV1MountCreated: boolean;
    readonly routesMounted: boolean;
    readonly registeredRouteModuleIds: readonly string[];
  };
  readonly liveChecks: readonly WebConsoleReplacementLiveCheck[];
}

export function parseWebConsoleReplacementReadinessEvidence(
  value: unknown,
): WebConsoleReplacementReadinessEvidence {
  const record = asRecord(value, 'evidence');
  const composition = asRecord(record.composition, 'composition');
  const liveChecks = asArray(record.liveChecks, 'liveChecks').map(parseLiveCheck);
  assertKnownLiveCheckCoverage(liveChecks);

  return {
    phase: parsePhase(record.phase),
    composition: {
      activationProfile: parseOneOf(
        composition.activationProfile,
        ['development', 'shared-hosted'],
        'composition.activationProfile',
      ),
      storageBackend: parseOneOf(composition.storageBackend, ['memory', 'postgres'], 'composition.storageBackend'),
      apiV1MountCreated: parseBoolean(composition.apiV1MountCreated, 'composition.apiV1MountCreated'),
      routesMounted: parseBoolean(composition.routesMounted, 'composition.routesMounted'),
      registeredRouteModuleIds: parseStringArray(
        composition.registeredRouteModuleIds,
        'composition.registeredRouteModuleIds',
      ),
    },
    liveChecks,
  };
}

function parseLiveCheck(value: unknown): WebConsoleReplacementLiveCheck {
  const record = asRecord(value, 'liveChecks[]');
  const id = parseOneOf(record.id, WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS, 'liveChecks[].id');
  return {
    id,
    ready: parseBoolean(record.ready, `liveChecks[${id}].ready`),
    detail: record.detail === undefined ? undefined : parseString(record.detail, `liveChecks[${id}].detail`),
  };
}

function assertKnownLiveCheckCoverage(liveChecks: readonly WebConsoleReplacementLiveCheck[]): void {
  const supplied = new Set(liveChecks.map(liveCheck => liveCheck.id));
  const missing = WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS.filter(id => !supplied.has(id));
  if (missing.length > 0) {
    throw new Error(`Evidence is missing required live check result(s): ${missing.join(', ')}`);
  }
}

function parsePhase(value: unknown): WebConsoleReplacementPhase {
  return parseOneOf(value, ['pre-replacement', 'active-replacement'], 'phase');
}

function asRecord(value: unknown, field: string): EvidenceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as EvidenceRecord;
}

function asArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  return value;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  const values = asArray(value, field).map((entry, index) => parseString(entry, `${field}[${index}]`));
  const missing = WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS.filter(moduleId => !values.includes(moduleId));
  if (missing.length > 0) {
    throw new Error(`${field} is missing required v1 route module(s): ${missing.join(', ')}`);
  }
  return values;
}

function parseOneOf<const T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}
