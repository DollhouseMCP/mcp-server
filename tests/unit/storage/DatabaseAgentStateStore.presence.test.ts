import { describe, expect, it, jest } from '@jest/globals';
import { inspect } from 'node:util';

import { claimInactiveRuntimePresenceForReclaimWithTx } from '../../../src/storage/DatabaseAgentStateStore.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';

describe('agent-state runtime presence reclaim', () => {
  it('uses PostgreSQL time to claim an expired runtime lease', async () => {
    const presence = {
      userId: USER_ID,
      status: 'active',
      leaseUntil: new Date('2026-08-20T12:00:00.000Z'),
      replicaId: 'replica-a',
    };
    const selectChain = {
      from: jest.fn(() => selectChain),
      where: jest.fn(() => selectChain),
      for: jest.fn(() => selectChain),
      limit: jest.fn(() => Promise.resolve([presence])),
    };
    const updateChain = {
      set: jest.fn(() => updateChain),
      where: jest.fn(() => updateChain),
      returning: jest.fn(() => Promise.resolve([{ sessionId: 'mcp-session-1' }])),
    };
    const tx = {
      select: jest.fn(() => selectChain),
      update: jest.fn(() => updateChain),
    } as unknown as DrizzleTx;

    await expect(claimInactiveRuntimePresenceForReclaimWithTx(
      tx,
      'mcp-session-1',
      USER_ID,
    )).resolves.toBe(true);

    expect(inspect(updateChain.set.mock.calls[0]?.[0], { depth: 12 })).toContain('statement_timestamp()');
    expect(inspect(updateChain.where.mock.calls[0]?.[0], { depth: 12 })).toContain('statement_timestamp()');
  });
});
