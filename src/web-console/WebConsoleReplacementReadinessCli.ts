import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { ConsoleModuleRegistry } from './platform/ConsoleModuleRegistry.js';
import type { WebConsoleComposition } from './WebConsoleRegistrar.js';
import {
  verifyWebConsoleReplacementReadiness,
} from './WebConsoleReplacementReadiness.js';
import {
  parseWebConsoleReplacementReadinessEvidence,
  type WebConsoleReplacementReadinessEvidence,
} from './WebConsoleReplacementReadinessEvidence.js';

export interface ReplacementReadinessCliIo {
  readonly readTextFile: (path: string) => Promise<string>;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
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

    const evidence = parseWebConsoleReplacementReadinessEvidence(JSON.parse(await io.readTextFile(evidencePath)));
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

function compositionFromEvidence(
  evidence: WebConsoleReplacementReadinessEvidence,
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
