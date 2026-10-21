import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MCPAQLHandler, type HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import { OperationRegistry } from '../../../../src/handlers/mcp-aql/OperationRegistry.js';
import { PermissionLevel } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { env } from '../../../../src/config/env.js';

const INFRA_OPERATIONS = ['verify_challenge', 'release_deadlock', 'abort_execution',
  'approve_cli_permission', 'permission_prompt', 'confirm_operation'];
const FAILURE = new Error('policy storage unavailable');

function fixture() {
  const collect = jest.fn<HandlerRegistry['elementCRUD']['getActiveElementsForPolicy']>().mockRejectedValue(FAILURE);
  const gatekeeper = new Gatekeeper(undefined, { enableAuditLogging: false });
  const enforce = jest.spyOn(gatekeeper, 'enforce');
  const record = jest.fn();
  const handlers = { elementCRUD: { getActiveElementsForPolicy: collect }, memoryManager: {},
    gatekeeper, gatekeeperMetricsTracker: { record } } as unknown as HandlerRegistry;
  const handler = new MCPAQLHandler(handlers);
  const operations = new OperationRegistry();
  // Isolate outer enforcement: recovery dispatch has its own challenge/target checks.
  const enforceOperation = (operation: string) => handler['enforceOperationGatekeeper'](
    { operation, element_type: 'skill' }, operations.getRoute(operation)!.endpoint, 0);
  return { collect, gatekeeper, enforce, record, handler, enforceOperation };
}

beforeEach(() => { jest.replaceProperty(env, 'DOLLHOUSE_GATEKEEPER_ENABLED', true); });

describe('infrastructure-first operation enforcement', () => {
  it('keeps batch dispatch sequential across an unfinished operation', async () => {
    const { handler } = fixture();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const execute = jest.spyOn(handler as unknown as {
      executeOperation: typeof handler['executeOperation'];
    }, 'executeOperation').mockImplementation(async () => {
      started();
      await pending;
      return { success: true, data: {}, _meta: handler['buildMeta'](performance.now()) };
    });
    const batch = handler['executeBatch']({ operations: [
      { operation: 'list_elements' }, { operation: 'list_elements' },
    ] }, 'READ');
    await firstStarted;
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    expect((await batch).summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('propagates a mid-batch throw unchanged without completing the batch', async () => {
    const { handler } = fixture();
    const error = new Error('second operation failed');
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const execute = jest.spyOn(handler as unknown as {
      executeOperation: typeof handler['executeOperation'];
    }, 'executeOperation')
      .mockResolvedValueOnce({ success: true, data: {}, _meta: handler['buildMeta'](performance.now()) })
      .mockRejectedValueOnce(error);
    await expect(handler['executeBatch']({ operations: [
      { operation: 'list_elements' }, { operation: 'list_elements' }, { operation: 'list_elements' },
    ] }, 'READ')).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls.filter(([event]) => event.type === 'BATCH_COMPLETED')).toHaveLength(0);
  });

  it.each(INFRA_OPERATIONS)('%s reaches gatekeeper without acquiring broken element policies', async operation => {
    const f = fixture();
    await expect(f.enforceOperation(operation)).resolves.toBeNull();
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.enforce).toHaveBeenCalledWith(expect.objectContaining({
      operation, activeElements: [], skipElementPolicies: true,
    }), expect.any(OperationRegistry));
    expect(f.record).toHaveBeenCalledTimes(1);
    // Abort retains its default single-use confirmation bookkeeping.
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining(operation === 'abort_execution'
      ? { allowed: false, confirmationPending: true } : { allowed: true }));
  });

  it('retains the ordinary operation collection error and cause', async () => {
    const f = fixture();
    await expect(f.enforceOperation('list_elements')).rejects.toMatchObject({
      message: 'Failed to gather active elements for Gatekeeper policy evaluation: policy storage unavailable',
      cause: FAILURE,
    });
    expect(f.collect).toHaveBeenCalledWith({ allowCoalescing: false });
    expect(f.enforce).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });

  it('preserves successful ordinary enforcement arguments and metrics', async () => {
    const f = fixture();
    const policy = { deny: ['delete_element'] };
    f.collect.mockResolvedValue([{ type: 'skill', name: 'guard', metadata: { description: 'guard policy', gatekeeper: policy } }]);
    await expect(f.enforceOperation('list_elements')).resolves.toBeNull();
    expect(f.enforce).toHaveBeenCalledWith({ operation: 'list_elements', endpoint: 'READ', elementType: 'skill',
      activeElements: [{ type: 'skill', name: 'guard', metadata: { name: 'guard', description: 'guard policy', gatekeeper: policy } }],
      skipElementPolicies: false,
    }, expect.any(OperationRegistry));
    expect(f.record).toHaveBeenCalledTimes(1);
  });

  it('still validates infrastructure routes through the real gatekeeper', async () => {
    const f = fixture();
    await expect(f.handler['enforceOperationGatekeeper']({ operation: 'verify_challenge' }, 'READ', 0)).rejects.toThrow();
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.enforce).toHaveBeenCalled();
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ allowed: false }));
  });

  it('honors an infrastructure denial rather than returning early', async () => {
    const f = fixture();
    f.enforce.mockReturnValue({ allowed: false, permissionLevel: PermissionLevel.DENY, reason: 'route denied' });
    await expect(f.enforceOperation('permission_prompt')).rejects.toThrow('route denied');
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ allowed: false }));
  });

  it('keeps the disabled-gatekeeper route-only behavior', async () => {
    jest.replaceProperty(env, 'DOLLHOUSE_GATEKEEPER_ENABLED', false);
    const f = fixture();
    const validate = jest.spyOn(f.gatekeeper, 'validateRoute');
    await expect(f.enforceOperation('list_elements')).resolves.toBeNull();
    expect(validate).toHaveBeenCalledWith('list_elements', 'READ', expect.any(OperationRegistry));
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.enforce).not.toHaveBeenCalled();
  });
});
