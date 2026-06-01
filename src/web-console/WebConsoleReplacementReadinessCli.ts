import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { ConsoleModuleRegistry } from './platform/ConsoleModuleRegistry.js';
import type { WebConsoleComposition } from './WebConsoleRegistrar.js';
import {
  WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS,
  WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS,
  verifyWebConsoleReplacementReadiness,
  type WebConsoleReplacementLiveCheck,
  type WebConsoleReplacementPhase,
} from './WebConsoleReplacementReadiness.js';

type EvidenceRecord = Record<string, unknown>;

export interface ReplacementReadinessCliIo {
  readonly readTextFile: (path: string) => Promise<string>;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

interface ReplacementEvidence {
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

const DEFAULT_CLI_IO: ReplacementReadinessCliIo = {
  readTextFile: path => readFile(path, 'utf8'),
  writeStdout: message => console.log(message),
  writeStderr: message => console.error(message),
};

export async function runWebConsoleReplacementReadinessCli(
  args: readonly string[],
  io: ReplacementReadinessCliIo = DEFAULT_CLI_IO,
): Promise<number> {
  try {
    const jsonOutput = args.includes('--json');
    const evidencePath = args.find(arg => arg !== '--json');
    if (!evidencePath) {
      throw new Error('Usage: tsx src/web-console/WebConsoleReplacementReadinessCli.ts <evidence.json> [--json]');
    }

    const evidence = parseEvidence(JSON.parse(await io.readTextFile(evidencePath)));
    const result = verifyWebConsoleReplacementReadiness({
      composition: compositionFromEvidence(evidence),
      phase: evidence.phase,
      liveChecks: evidence.liveChecks,
    });

    if (jsonOutput) {
      io.writeStdout(JSON.stringify(result, null, 2));
    } else {
      printHumanReadableResult(result.ready, result.failures, io);
    }

    return result.ready ? 0 : 1;
  } catch (error) {
    io.writeStderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function parseEvidence(value: unknown): ReplacementEvidence {
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

function compositionFromEvidence(
  evidence: ReplacementEvidence,
): Pick<WebConsoleComposition, 'activationProfile' | 'apiV1Mount' | 'registry' | 'routesMounted' | 'storageBackend'> {
  const registry = new ConsoleModuleRegistry();
  for (const moduleId of evidence.composition.registeredRouteModuleIds) {
    registry.register({
      id: moduleId,
      apiVersion: 'v1',
      capabilities: ['console:self'],
      routes: [],
    });
  }

  return {
    activationProfile: evidence.composition.activationProfile,
    storageBackend: evidence.composition.storageBackend,
    apiV1Mount: evidence.composition.apiV1MountCreated
      ? { router: {} as never, mounted: () => evidence.composition.routesMounted, markMounted: () => {} }
      : null,
    routesMounted: evidence.composition.routesMounted,
    registry,
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
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
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

function printHumanReadableResult(
  ready: boolean,
  failures: readonly { readonly id: string; readonly detail: string }[],
  io: ReplacementReadinessCliIo,
): void {
  if (ready) {
    io.writeStdout('Web console replacement readiness: ready');
    return;
  }

  io.writeStderr('Web console replacement readiness: not ready');
  for (const failure of failures) {
    io.writeStderr(`- ${failure.id}: ${failure.detail}`);
  }
}

function isDirectRun(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  void runWebConsoleReplacementReadinessCli(process.argv.slice(2)).then(exitCode => {
    process.exitCode = exitCode;
  });
}
