/** Real autonomy generation, human display and MCP-AQL verification contract (#2656). */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VerificationStore } from '@dollhousemcp/safety';
import type { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

// Only replace the OS display: generation, storage, enforcement and routing are real.
const safety = await import('../../../src/elements/agents/safetyTierService.js');
const display = jest.fn<(code: string, reason: string, options: unknown) => unknown>();
jest.unstable_mockModule('../../../src/elements/agents/safetyTierService.js', () => ({
  ...safety,
  showVerificationDialog: display,
}));
const { evaluateAutonomy } = await import('../../../src/elements/agents/autonomyEvaluator.js');
const { DollhouseMCPServer } = await import('../../../src/index.js');
const { DollhouseContainer } = await import('../../../src/di/Container.js');
const { DangerZoneEnforcer } = await import('../../../src/security/DangerZoneEnforcer.js');

const OWNER = 'autonomy-owner';
const session = Object.freeze({ userId: 'local-user', sessionId: OWNER, tenantId: null, transport: 'stdio' as const, createdAt: Date.now(), roles: ['admin'] });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('Autonomy challenge verification end to end', () => {
  let env: PortfolioTestEnvironment;
  let server: InstanceType<typeof DollhouseMCPServer>;
  let handler: MCPAQLHandler;
  let store: VerificationStore;
  let enforcer: InstanceType<typeof DangerZoneEnforcer>;
  let tracker: ContextTracker;
  let fileOps: FileOperationsService;
  let persistPath: string;
  let originalSuppress: string | undefined;

  async function persistedAgents(expected: string[]): Promise<void> {
    // Enforcement persists asynchronously; wait for the actual disk state, not a fixed sleep.
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const data = JSON.parse(await fs.readFile(persistPath, 'utf8')) as { blocks: Record<string, unknown> };
        if (JSON.stringify(Object.keys(data.blocks).sort()) === JSON.stringify([...expected].sort())) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Persisted block state did not become ${expected.join(', ')}`);
  }

  beforeEach(async () => {
    originalSuppress = process.env.DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG;
    delete process.env.DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG;
    display.mockClear();
    env = await createPortfolioTestEnvironment('autonomy-verification');
    const container = new DollhouseContainer();
    const securityDir = path.join(env.testDir, 'security');
    persistPath = path.join(securityDir, 'blocked-agents.json');
    fileOps = container.resolve<FileOperationsService>('FileOperationsService');
    enforcer = new DangerZoneEnforcer(fileOps, securityDir);
    enforcer.setAdminToken('integration-cleanup');
    container.register('DangerZoneEnforcer', () => enforcer, { override: true });
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
    preConfirmAllOperations(container);
    handler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    store = container.resolve<VerificationStore>('VerificationStore');
    tracker = container.resolve<ContextTracker>('ContextTracker');
  });

  afterEach(async () => {
    store.clear();
    enforcer.clearAll('integration-cleanup');
    await persistedAgents([]);
    await server.dispose();
    await env.cleanup();
    if (originalSuppress === undefined) delete process.env.DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG;
    else process.env.DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG = originalSuppress;
  });

  function verify(challengeId: string, code: string, sessionId = OWNER) {
    return tracker.runAsync({ type: 'test', timestamp: Date.now(), session: { ...session, sessionId } }, () =>
      handler.handleCreate({ operation: 'verify_challenge', params: { challenge_id: challengeId, code } }));
  }

  it('verifies the actual displayed autonomy code and removes only its block in memory and on disk', async () => {
    const directive = evaluateAutonomy({
      agentName: 'blocked-agent', sessionId: OWNER, stepCount: 1,
      currentStepDescription: 'Delete files', currentStepOutcome: 'success', nextActionHint: 'rm -rf /',
      dangerZoneEnforcer: enforcer, verificationStore: store,
    });
    const challengeId = directive.verification!.verificationId;
    expect(challengeId).toMatch(UUID_V4);
    expect(directive.continue).toBe(false);
    expect(display).toHaveBeenCalledTimes(1);
    const code = display.mock.calls[0][0];
    expect(store.get(challengeId)?.code).toBe(code);
    expect(JSON.stringify(directive)).not.toContain(code);
    enforcer.block('other-agent', 'Independent block', ['test'], randomUUID(), undefined, OWNER);
    await persistedAgents(['blocked-agent', 'other-agent']);

    const result = await verify(challengeId, code);
    expect(result).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ verified: true, unblockedAgent: 'blocked-agent' }) }));
    expect(enforcer.check('blocked-agent').blocked).toBe(false);
    expect(enforcer.check('other-agent').blocked).toBe(true);
    expect(store.get(challengeId)).toBeUndefined();
    await persistedAgents(['other-agent']);
    const restored = new DangerZoneEnforcer(fileOps, path.dirname(persistPath));
    await restored.initialize();
    expect(restored.getBlockedAgents()).toEqual(['other-agent']);
    expect((await verify(challengeId, code)).success).toBe(false);
  });

  it('accepts an exact stored legacy ID without bypassing session ownership or one-time use', async () => {
    const id = 'challenge_1733781234567_a1b2c3d4e5f6';
    store.set(id, { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'Legacy danger zone' });
    enforcer.block('legacy-agent', 'Legacy danger zone', ['test'], id, undefined, OWNER);
    await persistedAgents(['legacy-agent']);
    expect((await verify(id, 'ABC123', 'different-session')).success).toBe(false);
    expect(store.get(id)?.code).toBe('ABC123');
    expect(enforcer.check('legacy-agent').blocked).toBe(true);
    expect((await verify(id, 'ABC123')).success).toBe(true);
    expect((await verify(id, 'ABC123')).success).toBe(false);
    await persistedAgents([]);
  });

  it.each(['wrong', 'expired', 'unknown'])('rejects a %s legacy challenge and preserves its block', async failure => {
    const id = 'challenge_1733781234567_a1b2c3d4e5f6';
    if (failure !== 'unknown') store.set(id, { code: 'ABC123', expiresAt: Date.now() + (failure === 'expired' ? -1 : 300000), reason: 'Legacy danger zone' });
    enforcer.block('legacy-agent', 'Legacy danger zone', ['test'], id, undefined, OWNER);
    await persistedAgents(['legacy-agent']);
    const result = await verify(id, failure === 'wrong' ? 'WRONG1' : 'ABC123');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain(failure === 'wrong' ? 'incorrect code' : 'challenge not found');
    expect(enforcer.check('legacy-agent').blocked).toBe(true);
    if (failure === 'wrong') expect(store.get(id)).toBeUndefined();
    await persistedAgents(['legacy-agent']);
  });

  it('rejects a malformed ID even if a matching challenge exists in the store', async () => {
    const id = 'challenge_1733781234567_a1b2c3d4e5f6\n';
    store.set(id, { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'Malformed stored challenge' });
    const result = await verify(id, 'ABC123');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Invalid challenge_id format');
    expect(store.get(id)?.code).toBe('ABC123');
  });

  it('applies the existing failure rate limit to legacy challenges', async () => {
    const id = 'challenge_1733781234567_a1b2c3d4e5f6';
    for (let attempt = 0; attempt < 11; attempt++) {
      store.set(id, { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'Legacy danger zone' });
      expect((await verify(id, 'WRONG1')).success).toBe(false);
      expect(store.get(id)).toBeUndefined();
    }
    store.set(id, { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'Legacy danger zone' });
    const result = await verify(id, 'ABC123');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Too many failed verification attempts');
    expect(store.get(id)?.code).toBe('ABC123');
  });
});
