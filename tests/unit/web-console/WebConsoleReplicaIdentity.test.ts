import { describe, expect, it, jest } from '@jest/globals';

import {
  boundWebConsoleReplicaId,
  resolveStableWebConsoleReplicaId,
  resolveWebConsoleReplicaId,
} from '../../../src/web-console/WebConsoleReplicaIdentity.js';

const ENV_REPLICA_ID = 'env-replica';
const HOST_REPLICA_ID = 'host-replica';

describe('WebConsoleReplicaIdentity', () => {
  it('prefers explicit, env, hostname, then pid replica id sources', () => {
    expect(resolveWebConsoleReplicaId({
      explicitReplicaId: 'explicit-replica',
      envReplicaId: ENV_REPLICA_ID,
      hostname: HOST_REPLICA_ID,
      pid: 123,
    })).toBe('explicit-replica');
    expect(resolveWebConsoleReplicaId({
      envReplicaId: ENV_REPLICA_ID,
      hostname: HOST_REPLICA_ID,
      pid: 123,
    })).toBe(ENV_REPLICA_ID);
    expect(resolveWebConsoleReplicaId({
      hostname: HOST_REPLICA_ID,
      pid: 123,
    })).toBe(HOST_REPLICA_ID);
    expect(resolveWebConsoleReplicaId({
      hostname: '',
      pid: 123,
    })).toBe('pid-123');
  });

  it('rejects empty replica id sources', () => {
    expect(() => boundWebConsoleReplicaId('   ')).toThrow('replica id must be non-empty');
  });

  it('rejects the pid fallback for stable hosted/shared replica identity', () => {
    expect(resolveStableWebConsoleReplicaId({
      envReplicaId: ENV_REPLICA_ID,
      hostname: HOST_REPLICA_ID,
    })).toBe(ENV_REPLICA_ID);
    expect(resolveStableWebConsoleReplicaId({
      hostname: HOST_REPLICA_ID,
    })).toBe(HOST_REPLICA_ID);
    expect(() => resolveStableWebConsoleReplicaId({
      envReplicaId: '',
      hostname: '',
    })).toThrow('requires a stable replica id');
  });

  it('hash-suffixes replica ids longer than the database limit', () => {
    const reportTruncation = jest.fn();
    const raw = 'r'.repeat(140);

    const replicaId = boundWebConsoleReplicaId(raw, reportTruncation);

    expect(replicaId).toHaveLength(128);
    expect(replicaId).toMatch(/^r{111}-[a-f0-9]{16}$/);
    expect(reportTruncation).toHaveBeenCalledWith({
      originalLength: 140,
      replicaId,
    });
  });
});
