import { describe, expect, it } from '@jest/globals';

import {
  runWebConsoleReplacementReadinessCli,
  type ReplacementReadinessCliIo,
} from '../../../src/web-console/WebConsoleReplacementReadinessCli.js';
import {
  WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS,
  WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS,
  type WebConsoleReplacementLiveCheckId,
} from '../../../src/web-console/WebConsoleReplacementReadiness.js';

const EVIDENCE_PATH = 'evidence.json';

describe('WebConsoleReplacementReadinessCli', () => {
  it('returns 0 and reports ready for complete all-ready evidence', async () => {
    const io = cliIo(evidence());

    const exitCode = await runWebConsoleReplacementReadinessCli([EVIDENCE_PATH], io);

    expect(exitCode).toBe(0);
    expect(io.stdout).toEqual(['Web console replacement readiness: ready']);
    expect(io.stderr).toEqual([]);
  });

  it('returns 1 and prints readiness failures when evidence is complete but not ready', async () => {
    const io = cliIo(evidence({
      liveChecks: liveChecks({ fail: 'security_invalidation_multi_replica' }),
    }));

    const exitCode = await runWebConsoleReplacementReadinessCli([EVIDENCE_PATH], io);

    expect(exitCode).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual(expect.arrayContaining([
      'Web console replacement readiness: not ready',
      '- security_invalidation_multi_replica: multi-replica invalidation did not drain',
    ]));
  });

  it('returns 2 when required live-check evidence is omitted', async () => {
    const io = cliIo(evidence({
      liveChecks: liveChecks({ omit: 'portfolio_sync_live_repository' }),
    }));

    const exitCode = await runWebConsoleReplacementReadinessCli([EVIDENCE_PATH], io);

    expect(exitCode).toBe(2);
    expect(io.stderr).toEqual([
      'Evidence is missing required live check result(s): portfolio_sync_live_repository',
    ]);
  });

  it('returns 2 when required route modules are omitted from the evidence', async () => {
    const io = cliIo(evidence({
      registeredRouteModuleIds: WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS.slice(1),
    }));

    const exitCode = await runWebConsoleReplacementReadinessCli([EVIDENCE_PATH], io);

    expect(exitCode).toBe(2);
    expect(io.stderr).toEqual([
      'composition.registeredRouteModuleIds is missing required v1 route module(s): auth',
    ]);
  });

  it('returns 2 for malformed evidence fields', async () => {
    const io = cliIo({
      ...evidence(),
      phase: 'after-party',
    });

    const exitCode = await runWebConsoleReplacementReadinessCli([EVIDENCE_PATH], io);

    expect(exitCode).toBe(2);
    expect(io.stderr).toEqual([
      'phase must be one of: pre-replacement, active-replacement',
    ]);
  });

  it('returns 2 when no evidence path is supplied', async () => {
    const io = cliIo(evidence());

    const exitCode = await runWebConsoleReplacementReadinessCli([], io);

    expect(exitCode).toBe(2);
    expect(io.stderr).toEqual([
      'Usage: tsx src/web-console/WebConsoleReplacementReadinessCli.ts <evidence.json> [--json]',
    ]);
  });

  it('can emit JSON readiness output for automation', async () => {
    const io = cliIo(evidence());

    const exitCode = await runWebConsoleReplacementReadinessCli([EVIDENCE_PATH, '--json'], io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toEqual(expect.objectContaining({
      ready: true,
      failures: [],
    }));
    expect(io.stderr).toEqual([]);
  });
});

function evidence(overrides: {
  readonly registeredRouteModuleIds?: readonly string[];
  readonly liveChecks?: readonly unknown[];
} = {}): Record<string, unknown> {
  return {
    phase: 'pre-replacement',
    composition: {
      activationProfile: 'shared-hosted',
      storageBackend: 'postgres',
      apiV1MountCreated: true,
      routesMounted: false,
      registeredRouteModuleIds: overrides.registeredRouteModuleIds ?? WEB_CONSOLE_REPLACEMENT_REQUIRED_ROUTE_MODULE_IDS,
    },
    liveChecks: overrides.liveChecks ?? liveChecks(),
  };
}

function liveChecks(options: {
  readonly fail?: WebConsoleReplacementLiveCheckId;
  readonly omit?: WebConsoleReplacementLiveCheckId;
} = {}): readonly Record<string, unknown>[] {
  return WEB_CONSOLE_REPLACEMENT_LIVE_CHECK_IDS
    .filter(id => id !== options.omit)
    .map(id => ({
      id,
      ready: id !== options.fail,
      detail: id === options.fail
        ? 'multi-replica invalidation did not drain'
        : 'selected deployment verification passed',
    }));
}

function cliIo(evidenceJson: unknown): ReplacementReadinessCliIo & {
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    readTextFile: () => Promise.resolve(JSON.stringify(evidenceJson)),
    writeStdout: message => stdout.push(message),
    writeStderr: message => stderr.push(message),
  };
}
