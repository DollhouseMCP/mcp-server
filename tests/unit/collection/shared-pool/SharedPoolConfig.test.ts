/**
 * Tests for SharedPoolConfig — constants and contract verification.
 *
 * The actual env var parsing (Zod coercion, host-pattern validation)
 * is handled by `env.ts` and tested there. These tests verify the
 * SharedPoolConfig module's contracts: constants are correct, and the
 * config functions return values consistent with the env module.
 */

import { describe, it, expect } from '@jest/globals';
import {
  isSharedPoolEnabled,
  resolveSharedPoolConfig,
  SYSTEM_USER_UUID,
  SYSTEM_USERNAME,
  SYSTEM_DISPLAY_NAME,
} from '../../../../src/collection/shared-pool/SharedPoolConfig.js';
import { env } from '../../../../src/config/env.js';

describe('SharedPoolConfig', () => {
  describe('isSharedPoolEnabled', () => {
    it('returns the value from env.DOLLHOUSE_SHARED_POOL_ENABLED', () => {
      expect(isSharedPoolEnabled()).toBe(env.DOLLHOUSE_SHARED_POOL_ENABLED);
    });

    it('returns a boolean', () => {
      expect(typeof isSharedPoolEnabled()).toBe('boolean');
    });
  });

  describe('resolveSharedPoolConfig', () => {
    it('returns a config object with all required fields', () => {
      const config = resolveSharedPoolConfig();

      expect(config).toHaveProperty('enabled');
      expect(config).toHaveProperty('collectionUrl');
      expect(config).toHaveProperty('collectionAllowlist');
      expect(config).toHaveProperty('sharedPoolDir');
    });

    it('enabled matches isSharedPoolEnabled()', () => {
      const config = resolveSharedPoolConfig();
      expect(config.enabled).toBe(isSharedPoolEnabled());
    });

    it('collectionUrl matches env', () => {
      const config = resolveSharedPoolConfig();
      expect(config.collectionUrl).toBe(env.DOLLHOUSE_COLLECTION_URL);
    });

    it('collectionAllowlist is an array', () => {
      const config = resolveSharedPoolConfig();
      expect(Array.isArray(config.collectionAllowlist)).toBe(true);
    });

    it('collectionAllowlist falls back to empty array when env is undefined', () => {
      const config = resolveSharedPoolConfig();
      if (env.DOLLHOUSE_COLLECTION_ALLOWLIST === undefined) {
        expect(config.collectionAllowlist).toEqual([]);
      } else {
        expect(config.collectionAllowlist).toEqual(env.DOLLHOUSE_COLLECTION_ALLOWLIST);
      }
    });

    it('sharedPoolDir matches env', () => {
      const config = resolveSharedPoolConfig();
      expect(config.sharedPoolDir).toBe(env.DOLLHOUSE_SHARED_POOL_DIR);
    });
  });

  describe('SYSTEM user constants', () => {
    it('has a well-known pinned UUID', () => {
      expect(SYSTEM_USER_UUID).toBe('00000000-0000-0000-0000-000000000001');
      expect(SYSTEM_USER_UUID).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('UUID version nibble is 0 (cannot collide with v4 UUIDs)', () => {
      expect(SYSTEM_USER_UUID.charAt(14)).toBe('0');
    });

    it('has a recognizable username', () => {
      expect(SYSTEM_USERNAME).toBe('dollhousemcp-system');
    });

    it('has a display name', () => {
      expect(SYSTEM_DISPLAY_NAME).toBe('DollhouseMCP System');
    });
  });
});
