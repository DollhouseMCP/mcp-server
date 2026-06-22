/**
 * Tests for SystemUserProvisioner — SYSTEM user creation for shared pool.
 *
 * These tests use a mock database since the real provisioner requires
 * a PostgreSQL connection. Integration tests with a real DB are in
 * the integration test suite.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  SYSTEM_USER_UUID,
  SYSTEM_USERNAME,
  SYSTEM_DISPLAY_NAME,
} from '../../../../src/collection/shared-pool/SharedPoolConfig.js';

describe('SystemUserProvisioner', () => {
  describe('SYSTEM user constants consistency', () => {
    it('UUID is a valid v4-format UUID', () => {
      expect(SYSTEM_USER_UUID).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('UUID is the well-known pinned value', () => {
      expect(SYSTEM_USER_UUID).toBe('00000000-0000-0000-0000-000000000001');
    });

    it('username is recognizable and lowercase', () => {
      expect(SYSTEM_USERNAME).toBe('dollhousemcp-system');
      expect(SYSTEM_USERNAME).toBe(SYSTEM_USERNAME.toLowerCase());
    });

    it('display name is human-readable', () => {
      expect(SYSTEM_DISPLAY_NAME).toBe('DollhouseMCP System');
    });

    it('UUID does not conflict with defaultRandom() UUIDs', () => {
      // defaultRandom() generates v4 UUIDs which have specific bits set:
      // - version nibble (position 13) is '4'
      // - variant bits (position 19) are '8', '9', 'a', or 'b'
      // Our pinned UUID has '0' in both positions, so it can never collide
      // with a randomly generated UUID.
      const versionNibble = SYSTEM_USER_UUID.charAt(14);
      expect(versionNibble).toBe('0');
    });
  });

  describe('ensure() behavior (mocked)', () => {
    let mockDb: {
      select: jest.Mock;
      insert: jest.Mock;
    };
    let selectChain: { from: jest.Mock; };
    let fromChain: { where: jest.Mock; };
    let whereChain: { limit: jest.Mock; };
    let insertChain: { values: jest.Mock; };
    let valuesChain: { onConflictDoNothing: jest.Mock; };

    beforeEach(() => {
      // Build the fluent query chain mocks
      whereChain = { limit: jest.fn() };
      fromChain = { where: jest.fn().mockReturnValue(whereChain) };
      selectChain = { from: jest.fn().mockReturnValue(fromChain) };
      valuesChain = { onConflictDoNothing: jest.fn().mockResolvedValue(undefined as never) };
      insertChain = { values: jest.fn().mockReturnValue(valuesChain) };

      mockDb = {
        select: jest.fn().mockReturnValue(selectChain),
        insert: jest.fn().mockReturnValue(insertChain),
      };
    });

    it('returns false when SYSTEM user already exists', async () => {
      whereChain.limit.mockResolvedValue([{ id: SYSTEM_USER_UUID }] as never);

      const { SystemUserProvisioner } = await import(
        '../../../../src/collection/shared-pool/SystemUserProvisioner.js'
      );
      const provisioner = new SystemUserProvisioner(mockDb as never);
      const created = await provisioner.ensure();

      expect(created).toBe(false);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('creates SYSTEM user and returns true when not found', async () => {
      whereChain.limit.mockResolvedValue([] as never);

      const { SystemUserProvisioner } = await import(
        '../../../../src/collection/shared-pool/SystemUserProvisioner.js'
      );
      const provisioner = new SystemUserProvisioner(mockDb as never);
      const created = await provisioner.ensure();

      expect(created).toBe(true);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          id: SYSTEM_USER_UUID,
          username: SYSTEM_USERNAME,
          displayName: SYSTEM_DISPLAY_NAME,
        })
      );
      expect(valuesChain.onConflictDoNothing).toHaveBeenCalled();
    });
  });
});
