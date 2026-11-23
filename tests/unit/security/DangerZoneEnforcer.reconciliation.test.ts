import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';
import type { IDangerZoneBlockStore } from '../../../src/state/IDangerZoneBlockStore.js';

function fixture() {
  let blocks: Record<string, unknown> = {};
  const store: IDangerZoneBlockStore = {
    location: 'test storage',
    load: jest.fn(async () => ({ status: 'loaded' as const, value: { ...blocks } })),
    apply: jest.fn(async (_mutation, snapshot) => { blocks = { ...snapshot }; return true; }),
    reset: jest.fn(async () => { blocks = {}; return 'saved evidence'; }),
  };
  return { store, enforcer: new DangerZoneEnforcer(store) };
}
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
describe('block-state reconciliation', () => {
  it('retains stored blocks after an unconfirmed clear and records only a confirmed retry', async () => {
    const { store, enforcer } = fixture();
    enforcer.setAdminToken('admin');
    await enforcer.block('agent', 'Review required', [], 'code');
    const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const warn = jest.spyOn(logger, 'warn');
    jest.spyOn(store, 'apply').mockRejectedValueOnce(new Error('Unavailable'));
    expect(await enforcer.clearAll('admin')).toBe(false);
    expect(await enforcer.getBlockedAgents()).toEqual(['agent']);
    expect(enforcer.getMetrics().totalClearAllCalls).toBe(0);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ details: 'Danger zone block clear was not confirmed' }));
    expect(events.mock.calls.filter(([event]) => event.details.startsWith('All danger zone blocks cleared'))).toHaveLength(0);
    await enforcer.initialize();
    expect(await store.load()).toMatchObject({ status: 'loaded', value: { agent: { verificationId: 'code' } } });
    expect(await enforcer.check('agent')).toMatchObject({ blocked: true, verificationId: 'code' });
    expect(await enforcer.clearAll('admin')).toBe(true);
    expect(enforcer.getMetrics().totalClearAllCalls).toBe(1);
    expect(events.mock.calls.filter(([event]) => event.details.startsWith('All danger zone blocks cleared'))).toHaveLength(1);
    expect(warn.mock.calls.filter(([message]) => String(message).startsWith('All danger zone blocks cleared'))).toHaveLength(1);
    expect(await store.load()).toEqual({ status: 'loaded', value: {} });
  });
  it('retains a block after a failed release until the same challenge is retried', async () => {
    const { store, enforcer } = fixture();
    await enforcer.block('agent', 'Review required', [], 'code');
    jest.spyOn(store, 'apply').mockRejectedValueOnce(new Error('Unavailable'));
    expect(await enforcer.releaseChallenge('code')).toMatchObject({ released: false, reason: 'unavailable' });
    expect(await enforcer.getBlockedAgents()).toContain('agent');
    await enforcer.initialize();
    expect(await enforcer.check('agent')).toMatchObject({ blocked: true, verificationId: 'code' });
    expect(await enforcer.releaseChallenge('code')).toEqual({ released: true, agentName: 'agent' });
    expect(await enforcer.check('agent')).toEqual({ blocked: false });
  });

  it('preserves a later block admitted during an unsuccessful release', async () => {
    const { store, enforcer } = fixture();
    await enforcer.block('agent', 'Review required', [], 'code');
    let later!: Promise<boolean>;
    jest.spyOn(store, 'apply').mockImplementationOnce(async () => {
      later = enforcer.block('agent', 'Updated review', [], 'later-code');
      throw new Error('Unavailable');
    });
    expect(await enforcer.releaseChallenge('code')).toMatchObject({ released: false, reason: 'unavailable' });
    expect(await later).toBe(false);
    await enforcer.initialize();
    expect(await enforcer.check('agent')).toMatchObject({ blocked: true, verificationId: 'later-code' });
    expect(await enforcer.releaseChallenge('later-code')).toMatchObject({ released: true, agentName: 'agent' });
  });

  it('reports a declined block write and keeps the current challenge', async () => {
    const { store, enforcer } = fixture();
    await enforcer.block('agent', 'Current review', [], 'current-code');
    jest.spyOn(store, 'apply').mockResolvedValueOnce(false);
    const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    expect(await enforcer.block('agent', 'Earlier review', [], 'earlier-code')).toBe(false);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'HIGH', details: 'Agent block was not confirmed',
      additionalData: { agentName: 'agent', verificationId: 'earlier-code', reason: 'declined' },
    }));
    expect(await enforcer.check('agent')).toMatchObject({ blocked: true, verificationId: 'current-code' });
  });

  it('accepts ordinary verification while another challenge remains current', async () => {
    const { enforcer } = fixture();
    await enforcer.block('agent', 'First review', [], 'first-code');
    await enforcer.block('agent', 'Current review', [], 'current-code');
    expect(await enforcer.releaseChallenge('ordinary-code')).toEqual({ released: true });
    expect(await enforcer.check('agent')).toMatchObject({ blocked: true, verificationId: 'current-code' });
  });
  it.each(['unblock', 'clearAll', 'block'])('settles a healthy refresh before %s', async operation => {
    const { store, enforcer } = fixture();
    await enforcer.initialize();
    await enforcer.block('agent', 'Review required', [], 'code');
    enforcer.setAdminToken('admin');
    const original = store.load.bind(store);
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    jest.spyOn(store, 'load').mockImplementationOnce(async () => { await held; return original(); });
    const checking = enforcer.check('other');
    const mutation = operation === 'unblock' ? enforcer.unblock('agent', 'code')
      : operation === 'clearAll' ? enforcer.clearAll('admin') : enforcer.block('new', 'Review required', [], 'new-code');
    finish();
    await checking;
    const result = await mutation;
    if (operation === 'block') expect((await enforcer.check('new')).verificationId).toBe('new-code');
    else { expect(result).toBe(true); expect((await enforcer.check('agent')).blocked).toBe(false); }
  });
  it('retries transient reads at most once per second and preserves blocks', async () => {
    jest.useFakeTimers();
    const { store, enforcer } = fixture();
    await enforcer.initialize();
    await enforcer.block('agent', 'Review required', [], 'code');
    const read = jest.spyOn(store, 'load').mockResolvedValueOnce({ status: 'unreadable', cause: new Error('temporary') });
    expect((await enforcer.check('other')).blocked).toBe(true);
    const calls = read.mock.calls.length;
    await Promise.all([enforcer.check('other'), enforcer.check('agent')]);
    expect(read).toHaveBeenCalledTimes(calls);
    jest.advanceTimersByTime(1000);
    expect((await enforcer.check('other')).blocked).toBe(false);
    expect((await enforcer.check('agent')).verificationId).toBe('code');
  });
  it('keeps content failures latched until explicit reload', async () => {
    jest.useFakeTimers();
    const { store, enforcer } = fixture();
    const read = jest.spyOn(store, 'load').mockResolvedValueOnce({ status: 'invalid', cause: new Error('invalid snapshot') });
    await enforcer.initialize();
    jest.advanceTimersByTime(10000);
    expect((await enforcer.check('other')).blocked).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    await enforcer.initialize();
    expect((await enforcer.check('other')).blocked).toBe(false);
  });
  it('reports an incomplete reset when a pending block cannot be persisted', async () => {
    const { store, enforcer } = fixture();
    jest.spyOn(store, 'load').mockResolvedValueOnce({ status: 'invalid', cause: new Error('invalid') });
    await enforcer.initialize();
    enforcer.setAdminToken('admin');
    const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    jest.spyOn(store, 'apply').mockRejectedValue(new Error('write failed'));
    const resetting = enforcer.clearAll('admin');
    await enforcer.block('new', 'Review required', [], 'code');
    expect(await resetting).toBe(false);
    expect((await enforcer.check('other')).reason).toContain('unavailable');
    expect(events.mock.calls.some(([event]) => event.details.includes('reset completed'))).toBe(false);
    expect(events.mock.calls.some(([event]) => event.details.includes('enforcement continues in-memory'))).toBe(false);
  });
});
