/**
 * Tests for the dollhouse_config schema validator. Covers the key
 * decision rules: known-path acceptance, unknown-path rejection (with
 * suggestion), type checking per spec, enum constraint, numeric range,
 * array element type, and non-strict mode back-compat.
 */

import { describe, it, expect } from '@jest/globals';
import {
  validateConfigPath,
  suggestNearestPath,
  listKnownPaths,
  CONFIG_SCHEMA,
} from '../../../src/config/configSchema.js';

const SYNC_ENABLED = 'sync.enabled';
const LICENSE_TIER = 'license.tier';

describe('validateConfigPath — known paths and types', () => {
  it('accepts a boolean value for a boolean-typed path', () => {
    expect(validateConfigPath(SYNC_ENABLED, true)).toEqual({ ok: true });
    expect(validateConfigPath(SYNC_ENABLED, false)).toEqual({ ok: true });
  });

  it('rejects a string value for a boolean-typed path', () => {
    const result = validateConfigPath(SYNC_ENABLED, 'true');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('boolean');
      expect(result.error).toContain('string');
    }
  });

  it('accepts a number within range for console.port', () => {
    expect(validateConfigPath('console.port', 41716)).toEqual({ ok: true });
  });

  it('rejects a number below min for console.port', () => {
    const result = validateConfigPath('console.port', 80);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('≥');
      expect(result.error).toContain('1024');
    }
  });

  it('rejects a number above max for console.port', () => {
    const result = validateConfigPath('console.port', 99999);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('≤');
      expect(result.error).toContain('65535');
    }
  });

  it('accepts an enum value for license.tier', () => {
    expect(validateConfigPath(LICENSE_TIER, 'agpl')).toEqual({ ok: true });
    expect(validateConfigPath(LICENSE_TIER, 'free-commercial')).toEqual({ ok: true });
    expect(validateConfigPath(LICENSE_TIER, 'paid-commercial')).toEqual({ ok: true });
  });

  it('rejects a string outside the enum for license.tier', () => {
    const result = validateConfigPath(LICENSE_TIER, 'pro');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must be one of');
      expect(result.error).toContain("'agpl'");
    }
  });

  it('accepts null for nullable user fields', () => {
    expect(validateConfigPath('user.username', null)).toEqual({ ok: true });
    expect(validateConfigPath('user.email', null)).toEqual({ ok: true });
  });

  it('rejects null for non-nullable fields', () => {
    const result = validateConfigPath(SYNC_ENABLED, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('null');
  });

  it('accepts an array of strings for elements.auto_activate.personas', () => {
    expect(validateConfigPath('elements.auto_activate.personas', ['creative-writer'])).toEqual({ ok: true });
    expect(validateConfigPath('elements.auto_activate.personas', [])).toEqual({ ok: true });
  });

  it('rejects an array with a wrong element type', () => {
    const result = validateConfigPath('elements.auto_activate.personas', ['ok-name', 42]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('[1]');
      expect(result.error).toContain('string');
    }
  });

  it('rejects a non-array value for an array-typed path', () => {
    const result = validateConfigPath('autoLoad.memories', 'just-one-memory');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('array');
  });
});

describe('validateConfigPath — strict mode (unknown paths)', () => {
  it('rejects unknown paths by default', () => {
    const result = validateConfigPath('totally.made.up.path', 'value');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unknown configuration path");
      expect(result.error).toContain('totally.made.up.path');
      expect(result.error).toContain('DOLLHOUSE_CONFIG_STRICT_PATHS=false');
    }
  });

  it('suggests a nearest match when the typo is close', () => {
    const result = validateConfigPath('sync.enable', true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Did you mean 'sync.enabled'");
    }
  });

  it('allows unknown paths when strict=false', () => {
    expect(validateConfigPath('legacy.unknown.path', 'anything', { strict: false })).toEqual({ ok: true });
  });
});

describe('suggestNearestPath', () => {
  it('returns the nearest known path for a close typo', () => {
    expect(suggestNearestPath('sync.enable')).toBe(SYNC_ENABLED);
    expect(suggestNearestPath('wizard.complted')).toBe('wizard.completed');
  });

  it('returns undefined when no close match exists', () => {
    expect(suggestNearestPath('totally-unrelated-xyz-abc-123')).toBeUndefined();
  });
});

describe('listKnownPaths', () => {
  it('returns all schema paths when no prefix is given', () => {
    const paths = listKnownPaths();
    expect(paths.length).toBe(Object.keys(CONFIG_SCHEMA).length);
    // Sorted
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });

  it('filters by prefix', () => {
    const syncPaths = listKnownPaths('sync.');
    expect(syncPaths.length).toBeGreaterThan(0);
    for (const p of syncPaths) {
      expect(p.startsWith('sync.')).toBe(true);
    }
  });
});

describe('CONFIG_SCHEMA — coverage spot checks', () => {
  // These are the paths most likely to be set by operators in production —
  // failing this case = operator hit a path the schema didn't know about.
  it.each([
    'user.username',
    'user.email',
    SYNC_ENABLED,
    'collection.auto_submit',
    'wizard.completed',
    'console.port',
    LICENSE_TIER,
    'display.persona_indicators.enabled',
    'display.indicator.style',
    'elements.default_element_dir',
    'elements.auto_activate.personas',
    'autoLoad.enabled',
    'retentionPolicy.enabled',
    'retentionPolicy.defaults.ttl_days',
  ])('schema covers %s', (path) => {
    expect(CONFIG_SCHEMA[path]).toBeDefined();
  });
});
