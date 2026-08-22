import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { createHttpSession } from '../../../src/context/HttpSession.js';
import type { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import type { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import type { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';

const ELEMENT_TYPES = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];

describe('HTTP write sandbox enforcement', () => {
  let savedEnv: Record<string, string | undefined>;
  let portfolioRoot: string;
  let homeRoot: string;
  let container: DollhouseContainer | undefined;

  beforeEach(async () => {
    savedEnv = {
      DOLLHOUSE_PORTFOLIO_DIR: process.env.DOLLHOUSE_PORTFOLIO_DIR,
      DOLLHOUSE_HOME_DIR: process.env.DOLLHOUSE_HOME_DIR,
      MCP_INTERFACE_MODE: process.env.MCP_INTERFACE_MODE,
      DOLLHOUSE_WEB_CONSOLE: process.env.DOLLHOUSE_WEB_CONSOLE,
      DOLLHOUSE_PERMISSION_SERVER: process.env.DOLLHOUSE_PERMISSION_SERVER,
    };
    portfolioRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'write-sandbox-portfolio-'));
    homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'write-sandbox-home-'));
    await Promise.all(
      ELEMENT_TYPES.map(t => fs.mkdir(path.join(portfolioRoot, t), { recursive: true })),
    );
    process.env.DOLLHOUSE_PORTFOLIO_DIR = portfolioRoot;
    process.env.DOLLHOUSE_HOME_DIR = homeRoot;
    process.env.MCP_INTERFACE_MODE = 'mcpaql';
    process.env.DOLLHOUSE_WEB_CONSOLE = 'false';
    process.env.DOLLHOUSE_PERMISSION_SERVER = 'false';
  });

  afterEach(async () => {
    await container?.dispose().catch(() => {});
    await fs.rm(portfolioRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(homeRoot, { recursive: true, force: true }).catch(() => {});
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.restoreAllMocks();
  });

  it('rejects an active HTTP session writing into another user subtree', async () => {
    container = new DollhouseContainer();
    await container.preparePortfolio();
    await container.bootstrapHttpHandlers();

    const session = createHttpSession({ userId: 'alice' });
    const { dispose } = await container.createServerForHttpSession(session);
    const contextTracker = container.resolve<ContextTracker>('ContextTracker');
    const fileOperations = container.resolve<FileOperationsService>('FileOperationsService');
    const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const bobTarget = path.join(portfolioRoot, 'users', 'bob', 'portfolio', 'personas', 'alice-attack.md');

    await expect(contextTracker.runAsync(
      contextTracker.createSessionContext('llm-request', session),
      () => fileOperations.writeFile(bobTarget, 'attack', { source: 'write-sandbox-test' }),
    )).rejects.toThrow('Path access denied');

    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'WRITE_SANDBOX_VIOLATION',
      severity: 'HIGH',
    }));
    await expect(fs.access(bobTarget)).rejects.toThrow();

    await dispose();
  });

  it('restores a user danger-zone block before exposing a replacement HTTP session', async () => {
    const securityDir = path.join(portfolioRoot, 'users', 'alice', 'security');
    await fs.mkdir(securityDir, { recursive: true });
    await fs.writeFile(path.join(securityDir, 'blocked-agents.json'), JSON.stringify({
      version: 1,
      blocks: {
        'blocked-agent': {
          eventId: 'event-1',
          reason: 'human verification required',
          triggeredPatterns: ['dangerous-operation'],
          blockedAt: '2026-08-20T12:00:00.000Z',
          verificationId: 'challenge-1',
        },
      },
    }));

    container = new DollhouseContainer();
    await container.preparePortfolio();
    await container.bootstrapHttpHandlers();

    const session = createHttpSession({ userId: 'alice' });
    const { dispose } = await container.createServerForHttpSession(session);
    const registry = container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const child = registry.get(session.sessionId);
    const enforcer = child?.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');

    expect(enforcer?.check('blocked-agent')).toMatchObject({
      blocked: true,
      eventId: 'event-1',
      verificationId: 'challenge-1',
    });

    await dispose();
  });
});
