import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';
/** Real autonomy generation, human display and MCP-AQL verification contract (#2656). */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import type { VerificationStore } from '@dollhousemcp/safety';
import { env as runtimeEnv } from '../../../src/config/env.js';
import type { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';
import type { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { ChallengeInput } from '../../../src/state/IChallengeStore.js';
import { ConsoleTokenStore } from '../../../src/web/console/consoleToken.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

// Only replace the OS display: generation, storage, enforcement and routing are real.
const nativeSafety = await import('@dollhousemcp/safety');
const nativeApproval = jest.fn<typeof nativeSafety.showNativeApprovalDialog>();
const display = jest.fn<(code: string, reason: string, options: unknown) => unknown>();
jest.unstable_mockModule('@dollhousemcp/safety', () => ({
  ...nativeSafety,
  showNativeApprovalDialog: nativeApproval,
  showVerificationDialog: display,
  showVerificationDialogAsync: async () => ({ success: true }),
}));
const safety = await import('../../../src/elements/agents/safetyTierService.js');
jest.unstable_mockModule('../../../src/elements/agents/safetyTierService.js', () => ({
  ...safety,
  showVerificationDialog: display,
}));
const { evaluateAutonomy } = await import('../../../src/elements/agents/autonomyEvaluator.js');
const { DollhouseMCPServer } = await import('../../../src/index.js');
const { DollhouseContainer } = await import('../../../src/di/Container.js');
const { DangerZoneEnforcer } = await import('../../../src/security/DangerZoneEnforcer.js');

const OWNER = 'autonomy-owner';
// The old code contract remains covered for HTTP clients during the desktop migration.
const session = Object.freeze({ userId: 'local-user', sessionId: OWNER, tenantId: null, transport: 'http' as const, createdAt: Date.now(), roles: ['admin'] });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('Autonomy challenge verification end to end', () => {
  let env: PortfolioTestEnvironment;
  let server: InstanceType<typeof DollhouseMCPServer>;
  let handler: MCPAQLHandler;
  let gatekeeper: Gatekeeper;
  let store: VerificationStore<ChallengeInput>;
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
    nativeApproval.mockReset();
    env = await createPortfolioTestEnvironment('autonomy-verification');
    const container = new DollhouseContainer();
    const securityDir = path.join(env.testDir, 'security');
    persistPath = path.join(securityDir, 'blocked-agents.json');
    fileOps = container.resolve<FileOperationsService>('FileOperationsService');
    enforcer = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, securityDir));
    await enforcer.initialize();
    enforcer.setAdminToken('integration-cleanup');
    container.register('DangerZoneEnforcer', () => enforcer, { override: true });
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
    preConfirmAllOperations(container);
    handler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    gatekeeper = container.resolve<Gatekeeper>('gatekeeper');
    store = container.resolve<VerificationStore<ChallengeInput>>('VerificationStore');
    tracker = container.resolve<ContextTracker>('ContextTracker');
  });

  afterEach(async () => {
    store.clear();
    await enforcer.clearAll('integration-cleanup');
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
    expect((await enforcer.check('blocked-agent')).blocked).toBe(false);
    expect((await enforcer.check('other-agent')).blocked).toBe(true);
    expect(store.get(challengeId)).toBeUndefined();
    await persistedAgents(['other-agent']);
    const restored = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, path.dirname(persistPath)));
    await restored.initialize();
    expect((await restored.getBlockedAgents())).toEqual(['other-agent']);
    expect((await verify(challengeId, code)).success).toBe(false);
  });

  it('accepts an exact stored legacy ID without bypassing session ownership or one-time use', async () => {
    const id = 'challenge_1733781234567_a1b2c3d4e5f6';
    store.set(id, { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'Legacy danger zone' });
    enforcer.block('legacy-agent', 'Legacy danger zone', ['test'], id, undefined, OWNER);
    await persistedAgents(['legacy-agent']);
    expect((await verify(id, 'ABC123', 'different-session')).success).toBe(false);
    expect(store.get(id)?.code).toBe('ABC123');
    expect((await enforcer.check('legacy-agent')).blocked).toBe(true);
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
    expect((await enforcer.check('legacy-agent')).blocked).toBe(true);
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

  describe('stdio authorizes through the server-owned dialog', () => {
    let originalTokenFile: typeof runtimeEnv.DOLLHOUSE_CONSOLE_TOKEN_FILE;
    let tokenStore: ConsoleTokenStore;

    beforeEach(async () => {
      originalTokenFile = runtimeEnv.DOLLHOUSE_CONSOLE_TOKEN_FILE;
      runtimeEnv.DOLLHOUSE_CONSOLE_TOKEN_FILE = path.join(env.testDir, 'console-token.json');
      tokenStore = new ConsoleTokenStore(runtimeEnv.DOLLHOUSE_CONSOLE_TOKEN_FILE);
      await tokenStore.ensureInitialized('Stdio', { onlyIfBothAbsent: true });
    });

    afterEach(() => {
      runtimeEnv.DOLLHOUSE_CONSOLE_TOKEN_FILE = originalTokenFile;
    });

    function local<T>(work: () => Promise<T>, sessionId = OWNER) {
      return tracker.runAsync({ type: 'test', timestamp: Date.now(), session: { ...session, transport: 'stdio', sessionId } }, work);
    }

    function verifyLocal(challengeId: string, sessionId = OWNER, extraParams: Record<string, unknown> = {}) {
      return local(() =>
        handler.handleCreate({ operation: 'verify_challenge', params: { challenge_id: challengeId, ...extraParams } }), sessionId);
    }

    it('releases only the reviewed block after a dialog decision and refuses replay', async () => {
      const directive = evaluateAutonomy({
        agentName: 'blocked-agent', sessionId: OWNER, sessionTransport: 'stdio', stepCount: 1,
        currentStepDescription: 'Delete files', currentStepOutcome: 'success', nextActionHint: 'rm -rf /',
        dangerZoneEnforcer: enforcer, verificationStore: store,
      });
      const challengeId = directive.verification!.verificationId;
      expect(challengeId).toMatch(UUID_V4);
      expect(directive.continue).toBe(false);
      expect(directive.verification).not.toHaveProperty('displayCode');
      expect(display).not.toHaveBeenCalled();
      expect(store.get(challengeId)).toEqual({
        dialog: 'block', reason: 'Release blocked agent', expiresAt: Date.parse(directive.verification!.expiresAt),
      });
      await enforcer.block('other-agent', 'Independent block', ['test'], randomUUID(), undefined, OWNER);
      await persistedAgents(['blocked-agent', 'other-agent']);

      expect(await verifyLocal(challengeId, 'different-session')).toMatchObject({
        success: true, data: { verified: false, status: 'session' },
      });
      expect((await verifyLocal(challengeId, OWNER, { code: 'legacy-input' })).success).toBe(false);
      expect(nativeApproval).not.toHaveBeenCalled();
      nativeApproval.mockResolvedValueOnce({ confirmed: false, reason: 'cancelled' });
      expect(await verifyLocal(challengeId)).toMatchObject({ success: true, data: { verified: false } });
      await persistedAgents(['blocked-agent', 'other-agent']);

      nativeApproval.mockResolvedValueOnce({ confirmed: true });
      expect(await verifyLocal(challengeId)).toMatchObject({
        success: true, data: { verified: true, unblockedAgent: 'blocked-agent' },
      });
      expect(nativeApproval).toHaveBeenLastCalledWith(expect.objectContaining({ approveLabel: 'Release' }), false, expect.any(Number));
      expect((await enforcer.check('blocked-agent')).blocked).toBe(false);
      expect((await enforcer.check('other-agent')).blocked).toBe(true);
      await persistedAgents(['other-agent']);
      const restored = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, path.dirname(persistPath)));
      try {
        await restored.initialize();
        expect(await restored.getBlockedAgents()).toEqual(['other-agent']);
      } finally {
        await restored.shutdown();
      }
      expect((await verifyLocal(challengeId)).success).toBe(false);
      expect(nativeApproval).toHaveBeenCalledTimes(2);
    });

    it('requires proof for enrolled action approval, refuses replay, and expires unused requests', async () => {
      const enrollment = tokenStore.beginTotpEnrollment();
      const totp = new TOTP({ secret: Secret.fromBase32(enrollment.secret), algorithm: 'SHA1', digits: 6, period: 30 });
      await tokenStore.confirmTotpEnrollment(enrollment.pendingId, totp.generate());
      const challengeId = randomUUID();
      const expiredId = randomUUID();
      const request = { dialog: 'action' as const, reason: 'Verify the next action', expiresAt: Date.now() + 60_000 };
      store.set(challengeId, request);
      store.set(expiredId, { ...request, expiresAt: Date.now() - 1 });
      expect((await verifyLocal(expiredId)).success).toBe(false);
      expect(nativeApproval).not.toHaveBeenCalled();

      nativeApproval.mockResolvedValueOnce({ confirmed: true, code: 'invalid-code' });
      expect(await verifyLocal(challengeId)).toMatchObject({ success: true, data: { verified: false } });
      nativeApproval.mockResolvedValue({ confirmed: true, code: totp.generate() });
      expect(await verifyLocal(challengeId)).toMatchObject({ success: true, data: { verified: true } });
      expect(nativeApproval).toHaveBeenLastCalledWith(expect.objectContaining({ approveLabel: 'Approve' }), true, expect.any(Number));
      expect(await verifyLocal(challengeId)).toMatchObject({
        success: true, data: { verified: false, status: 'spent' },
      });
    });

    it.each(['before prompting', 'with the prompt open'])('keeps an expired stdio block in place %s', async phase => {
      const challengeId = randomUUID();
      const expiresAt = Date.now() + (phase === 'before prompting' ? -1 : 60_000);
      store.set(challengeId, { dialog: 'block', expiresAt, reason: 'Release blocked agent' });
      await enforcer.block('expired-agent', 'Expired approval', ['test'], challengeId, undefined, OWNER);
      await persistedAgents(['expired-agent']);

      if (phase === 'before prompting') {
        const result = await verifyLocal(challengeId);
        expect(result).toMatchObject({ success: false, error: expect.stringContaining('expired') });
        expect(nativeApproval).not.toHaveBeenCalled();
      } else {
        const clock = jest.spyOn(Date, 'now');
        try {
          nativeApproval.mockImplementationOnce(async () => {
            clock.mockReturnValue(expiresAt + 1);
            return { confirmed: true };
          });
          expect(await verifyLocal(challengeId)).toMatchObject({
            success: true, data: { verified: false, status: 'expired' },
          });
        } finally {
          clock.mockRestore();
        }
      }
      expect((await enforcer.check('expired-agent')).blocked).toBe(true);
      await persistedAgents(['expired-agent']);
    });

    it('requires a dialog decision for a pending CLI approval and rejects a second approval', async () => {
      const rawContent = 'Synthetic unredacted file content';
      const requestId = await local(() => gatekeeper.createCliApprovalRequest({
        toolName: 'Write', toolInput: { file_path: '/synthetic/note.md', content: rawContent },
        riskLevel: 'dangerous', riskScore: 88, irreversible: true, denyReason: 'Review the write', allowedScopes: ['single'],
      }));
      const approve = (scope = 'single') => local(() => handler.handleExecute({
        operation: 'approve_cli_permission', params: { request_id: requestId, scope },
      }));
      expect(await approve('tool_session')).toMatchObject({
        success: false, error: expect.stringContaining('does not permit scope "tool_session"'),
      });
      expect(nativeApproval).not.toHaveBeenCalled();
      nativeApproval.mockResolvedValueOnce({ confirmed: false, reason: 'cancelled' });
      expect((await approve()).success).toBe(false);
      const pending = await local(async () => gatekeeper.getPendingCliApprovals());
      expect(pending).toEqual(expect.arrayContaining([
        expect.objectContaining({ requestId }),
      ]));
      const preview = nativeApproval.mock.lastCall?.[0].reviewDetails;
      expect(preview).toContain(JSON.stringify(pending[0].toolInputDigest, null, 2));
      expect(preview).toContain('/synthetic/note.md');
      expect(preview).toContain('Risk: dangerous (88/100)');
      expect(preview).toContain('Irreversible: yes');
      expect(preview).not.toContain(rawContent);

      nativeApproval.mockResolvedValueOnce({ confirmed: true });
      expect(await approve()).toMatchObject({ success: true, data: { approved: true, requestId, scope: 'single' } });
      expect((await approve()).success).toBe(false);
      expect(nativeApproval).toHaveBeenCalledTimes(2);
    });
  });
});
