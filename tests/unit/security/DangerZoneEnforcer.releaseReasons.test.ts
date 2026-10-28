import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import type { IDangerZoneBlockStore } from '../../../src/state/IDangerZoneBlockStore.js';
import { logger } from '../../../src/utils/logger.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';

const record = { reason: 'Review required', blockedAt: new Date(0).toISOString(), verificationId: 'code' };
function fixture(block: unknown = record) {
  const store: IDangerZoneBlockStore = {
    location: 'test storage',
    load: jest.fn(async () => ({ status: 'loaded' as const, value: { agent: block } })),
    apply: jest.fn(async () => true),
    reset: jest.fn(async () => ''),
  };
  return { store, enforcer: new DangerZoneEnforcer(store) };
}
afterEach(() => { jest.restoreAllMocks(); });
describe('challenge release reasons', () => {
  it('keeps unavailable diagnostics in administrative logs', async () => {
    const { store, enforcer } = fixture();
    jest.spyOn(store, 'load').mockResolvedValue({ status: 'unsupportedVersion' });
    const warn = jest.spyOn(logger, 'warn');
    const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    expect(await enforcer.check('agent')).toEqual({
      blocked: true, reason: 'Blocked-agent state is unavailable.', resolution: 'Contact an administrator.',
    });
    const diagnostics = expect.objectContaining({
      reason: 'unsupportedVersion', location: store.location, recovery: expect.stringContaining('clearAll'),
    });
    expect(warn).toHaveBeenCalledWith('Blocked-agent state is unavailable', diagnostics);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ severity: 'HIGH', additionalData: diagnostics }));
  });
  it('reports unavailable storage', async () => {
    const { store, enforcer } = fixture();
    jest.spyOn(store, 'load').mockResolvedValue({ status: 'unreadable', cause: new Error('Unavailable') });
    expect(await enforcer.releaseChallenge('code')).toEqual({ released: false, reason: 'unavailable' });
  });
  it('requires an administrator for a malformed definition', async () => {
    const { enforcer } = fixture({ ...record, reason: 42 });
    expect(await enforcer.releaseChallenge('code')).toMatchObject({ released: false, reason: 'admin-only' });
  });
  it('requires the originating session', async () => {
    const { enforcer } = fixture({ ...record, sessionId: 'owner' });
    expect(await enforcer.releaseChallenge('code', 'other')).toMatchObject({ released: false, reason: 'session' });
  });
  it('reports a conditional decline', async () => {
    const { store, enforcer } = fixture();
    jest.spyOn(store, 'apply').mockResolvedValue(false);
    expect(await enforcer.releaseChallenge('code')).toMatchObject({ released: false, reason: 'declined' });
  });
  it('reports a write failure as unavailable', async () => {
    const { store, enforcer } = fixture();
    jest.spyOn(store, 'apply').mockRejectedValue(new Error('Unavailable'));
    expect(await enforcer.releaseChallenge('code')).toMatchObject({ released: false, reason: 'unavailable' });
  });
  it('logs a rejected snapshot cause', async () => {
    const { store, enforcer } = fixture();
    jest.spyOn(store, 'load').mockResolvedValue({ status: 'loaded', value: { 'bad/name': record } });
    const warn = jest.spyOn(logger, 'warn');
    await enforcer.initialize();
    expect(warn).toHaveBeenCalledWith('Blocked-agent snapshot could not be restored', { error: expect.any(Error) });
  });
});
