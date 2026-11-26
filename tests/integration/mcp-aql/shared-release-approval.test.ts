import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import type { VerificationStore } from '@dollhousemcp/safety';
import { env } from '../../../src/config/env.js';
import type { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import type { IVerificationNotifier } from '../../../src/services/VerificationNotifier.js';
import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';
import { ConsoleTokenStore } from '../../../src/web/console/consoleToken.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

const safety = await import('@dollhousemcp/safety');
const nativeApproval = jest.fn<typeof safety.showNativeApprovalDialog>();
jest.unstable_mockModule('@dollhousemcp/safety', () => ({ ...safety, showNativeApprovalDialog: nativeApproval }));

const { DollhouseContainer } = await import('../../../src/di/Container.js');
const { DollhouseMCPServer } = await import('../../../src/index.js');
const { DangerZoneEnforcer } = await import('../../../src/security/DangerZoneEnforcer.js');
const session = Object.freeze({
  userId: 'local-user', sessionId: 'shared-release-test', tenantId: null,
  transport: 'stdio' as const, createdAt: Date.now(), roles: ['admin'],
});

describe('stdio code and desktop release approvals', () => {
  let fixture: PortfolioTestEnvironment;
  let server: InstanceType<typeof DollhouseMCPServer>;
  let handler: MCPAQLHandler;
  let store: VerificationStore;
  let tracker: ContextTracker;
  let enforcer: InstanceType<typeof DangerZoneEnforcer>;
  let tokenFile: typeof env.DOLLHOUSE_CONSOLE_TOKEN_FILE;
  const showCode = jest.fn<IVerificationNotifier['showCode']>();

  beforeEach(async () => {
    nativeApproval.mockReset();
    showCode.mockReset();
    fixture = await createPortfolioTestEnvironment('shared-release-test');
    tokenFile = env.DOLLHOUSE_CONSOLE_TOKEN_FILE;
    env.DOLLHOUSE_CONSOLE_TOKEN_FILE = path.join(fixture.testDir, 'console-token.json');
    const tokens = new ConsoleTokenStore(env.DOLLHOUSE_CONSOLE_TOKEN_FILE);
    await tokens.ensureInitialized('Stdio', { onlyIfBothAbsent: true });
    const container = new DollhouseContainer();
    enforcer = new DangerZoneEnforcer(new FileDangerZoneBlockStore(
      container.resolve('FileOperationsService'), path.join(fixture.testDir, 'security'),
    ));
    await enforcer.initialize();
    container.register('DangerZoneEnforcer', () => enforcer, { override: true });
    container.register('VerificationNotifier', () => ({ showCode, isAvailable: () => true }), { override: true });
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
    handler = container.resolve('mcpAqlHandler');
    tracker = container.resolve('ContextTracker');
    store = container.resolve('VerificationStore');
  });

  afterEach(async () => {
    await server?.dispose();
    if (fixture) await fixture.cleanup();
    env.DOLLHOUSE_CONSOLE_TOKEN_FILE = tokenFile;
  });

  function request(operation: string, params: Record<string, unknown> = {}) {
    return tracker.runAsync({ type: 'test', timestamp: Date.now(), session },
      () => handler.handleCreate({ operation, params }));
  }

  async function issue(operation: 'verify_challenge' | 'release_deadlock') {
    if (operation === 'release_deadlock') nativeApproval.mockResolvedValueOnce({ confirmed: false, reason: 'unavailable' });
    const result = await request(operation === 'verify_challenge' ? 'beetlejuice_beetlejuice_beetlejuice' : operation);
    expect(result).toMatchObject({ success: true, data: { challenge_id: expect.any(String) } });
    const { challenge_id } = (result as { data: { challenge_id: string } }).data;
    const code = showCode.mock.lastCall?.[0];
    if (!code) throw new Error('No verification code reached the existing notifier');
    expect(JSON.stringify(result)).not.toContain(code);
    expect(store.get(challenge_id)?.code).toBe(code);
    return { challenge_id, code };
  }

  it.each([
    ['verify_challenge', 'verified'],
    ['release_deadlock', 'released'],
  ] as const)('accepts %s through the dialog and refuses the same code afterward', async (operation, decision) => {
    const { challenge_id, code } = await issue(operation);
    nativeApproval.mockResolvedValueOnce({ confirmed: true });
    expect(await request(operation, { challenge_id })).toMatchObject({ success: true, data: { [decision]: true } });
    expect(store.get(challenge_id)).toBeUndefined();
    expect((await request(operation, { challenge_id, code })).success).toBe(false);
    expect((await request(operation, { challenge_id })).success).toBe(false);
  });

  it.each([
    ['verify_challenge', 'verified'],
    ['release_deadlock', 'released'],
  ] as const)('accepts a code for %s while desktop approval is pending and rejects the late dialog', async (operation, decision) => {
    const { challenge_id, code } = await issue(operation);
    let open!: () => void;
    let confirm!: () => void;
    const opened = new Promise<void>(resolve => { open = resolve; });
    nativeApproval.mockImplementationOnce(async () => {
      open();
      return await new Promise(resolve => { confirm = () => resolve({ confirmed: true }); });
    });
    const dialog = request(operation, { challenge_id });
    await expect(Promise.race([opened.then(() => true), dialog.then(() => false)])).resolves.toBe(true);
    try {
      expect(await request(operation, { challenge_id, code })).toMatchObject({ success: true, data: { [decision]: true } });
      expect(store.get(challenge_id)).toBeUndefined();
    } finally {
      confirm();
    }
    expect(await dialog).toMatchObject({ success: true, data: { [decision]: false } });
    expect((await request(operation, { challenge_id, code })).success).toBe(false);
  });

  it('falls back to the displayed code when the block approval dialog is unavailable', async () => {
    const { challenge_id, code } = await issue('verify_challenge');
    nativeApproval.mockResolvedValueOnce({ confirmed: false, reason: 'unavailable' });
    expect(await request('verify_challenge', { challenge_id })).toMatchObject({
      success: true, data: { verified: false, status: 'unavailable' },
    });
    expect((await enforcer.check('beetlejuice-test-agent')).blocked).toBe(true);
    expect(await request('verify_challenge', { challenge_id, code })).toMatchObject({
      success: true, data: { verified: true, unblockedAgent: 'beetlejuice-test-agent' },
    });
  });

  it('shares the verification failure limit with the fallback', async () => {
    const { challenge_id, code } = await issue('verify_challenge');
    nativeApproval.mockResolvedValue({ confirmed: false, reason: 'cancelled' });
    for (let attempt = 0; attempt < 11; attempt++) await request('verify_challenge', { challenge_id });
    expect(await request('verify_challenge', { challenge_id, code })).toMatchObject({
      success: false, error: expect.stringContaining('Too many failed verification attempts'),
    });
    expect((await enforcer.check('beetlejuice-test-agent')).blocked).toBe(true);
  });
});
