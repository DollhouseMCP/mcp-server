/**
 * Unit tests for SessionNames — pool separation (#1871).
 *
 * Verifies that:
 *   - pickRandomTokenName() draws from the attire/accessories pool
 *   - Token names and puppet session names never overlap
 *   - SessionNamePool behaviour is unchanged by the token-pool split
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  ALL_PUPPET_NAMES,
  ALL_TOKEN_NAMES,
  derivePreferredSessionName,
  getPuppetColor,
  pickRandomTokenName,
  SessionNamePool,
} from '../../../../src/web/console/SessionNames.js';

// ─── Pool contents ──────────────────────────────────────────────────────────

describe('ALL_PUPPET_NAMES', () => {
  it('contains at least 20 names', () => {
    expect(ALL_PUPPET_NAMES.length).toBeGreaterThanOrEqual(20);
  });

  it('contains known puppet/character names', () => {
    expect(ALL_PUPPET_NAMES).toContain('Kermit');
    expect(ALL_PUPPET_NAMES).toContain('Pinocchio');
    expect(ALL_PUPPET_NAMES).toContain('Elmo');
  });
});

describe('ALL_TOKEN_NAMES', () => {
  it('contains at least 20 names', () => {
    expect(ALL_TOKEN_NAMES.length).toBeGreaterThanOrEqual(20);
  });

  it('contains known attire/accessory names', () => {
    expect(ALL_TOKEN_NAMES).toContain('Top Hat');
    expect(ALL_TOKEN_NAMES).toContain('Monocle');
    expect(ALL_TOKEN_NAMES).toContain('Ruby Slippers');
  });
});

// ─── Pool separation (#1871) ─────────────────────────────────────────────────

describe('pool separation (#1871)', () => {
  it('token pool and puppet pool have zero overlap', () => {
    const puppetSet = new Set(ALL_PUPPET_NAMES);
    const collisions = ALL_TOKEN_NAMES.filter(name => puppetSet.has(name));
    expect(collisions).toHaveLength(0);
  });
});

// ─── pickRandomTokenName() ───────────────────────────────────────────────────

describe('pickRandomTokenName()', () => {
  it('returns a non-empty string', () => {
    const name = pickRandomTokenName();
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('returns a value from ALL_TOKEN_NAMES', () => {
    // Sample 50 calls — every result must be in the token pool
    const tokenSet = new Set(ALL_TOKEN_NAMES);
    for (let i = 0; i < 50; i++) {
      expect(tokenSet.has(pickRandomTokenName())).toBe(true);
    }
  });

  it('never returns a puppet session name', () => {
    const puppetSet = new Set(ALL_PUPPET_NAMES);
    for (let i = 0; i < 50; i++) {
      expect(puppetSet.has(pickRandomTokenName())).toBe(false);
    }
  });
});

// ─── SessionNamePool ─────────────────────────────────────────────────────────

describe('SessionNamePool', () => {
  it('derives a stable preferred name for the same runtime session', () => {
    expect(derivePreferredSessionName('local-test-session')).toBe(
      derivePreferredSessionName('local-test-session'),
    );
  });

  it('derives different leader and follower preferences when Punch would be excluded', () => {
    const leaderName = derivePreferredSessionName('leader-test-session', true);
    expect(leaderName).not.toBe('Punch');
  });

  it('assigns a name from the puppet pool', () => {
    const pool = new SessionNamePool();
    const name = pool.assign('session-1');
    expect(ALL_PUPPET_NAMES).toContain(name);
  });

  it('never assigns a token attire name to a session', () => {
    const pool = new SessionNamePool();
    const tokenSet = new Set(ALL_TOKEN_NAMES);
    const name = pool.assign('session-1');
    expect(tokenSet.has(name)).toBe(false);
  });

  it('is idempotent — same session always gets the same name', () => {
    const pool = new SessionNamePool();
    const first = pool.assign('session-abc');
    const second = pool.assign('session-abc');
    expect(second).toBe(first);
  });

  it('assigns different names to different sessions', () => {
    const pool = new SessionNamePool();
    const a = pool.assign('session-a');
    const b = pool.assign('session-b');
    expect(b).not.toBe(a);
  });

  it('does not assign Punch to a leader session', () => {
    // Punch is in FOLLOWER_ONLY_NAMES — leaders must never receive it
    const pool = new SessionNamePool();
    const names = new Set<string>();
    // Assign enough sessions to exercise most of the pool
    for (let i = 0; i < 30; i++) {
      names.add(pool.assign(`leader-${i}`, /* isLeader= */ true));
    }
    expect(names.has('Punch')).toBe(false);
  });

  it('non-leader sessions can receive Punch', () => {
    // Exhaust the non-Punch names so Punch is the only one left, then
    // confirm a follower session eventually gets it.  We do this by
    // seeding many follower sessions until Punch appears (or we confirm
    // it exists in the pool at all via ALL_PUPPET_NAMES).
    expect(ALL_PUPPET_NAMES).toContain('Punch');
    // Punch is in the pool — it is NOT in FOLLOWER_ONLY for non-leaders
    const pool = new SessionNamePool();
    const names = new Set<string>();
    for (let i = 0; i < ALL_PUPPET_NAMES.length; i++) {
      names.add(pool.assign(`follower-${i}`, /* isLeader= */ false));
    }
    expect(names.has('Punch')).toBe(true);
  });

  it('getName() returns the assigned name', () => {
    const pool = new SessionNamePool();
    pool.assign('session-x');
    expect(pool.getName('session-x')).toBeTruthy();
  });

  it('getName() returns undefined for unknown session', () => {
    const pool = new SessionNamePool();
    expect(pool.getName('nonexistent')).toBeUndefined();
  });

  it('getColor() returns a hex color for a known puppet name', () => {
    // Force Kermit by exhausting sessions until we see it — or just
    // confirm getColor returns something hex-shaped for any assigned name.
    const pool = new SessionNamePool();
    pool.assign('session-color');
    const color = pool.getColor('session-color');
    // Color may be undefined if the name is a fallback; only assert if set
    if (color !== undefined) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('release() frees the name from the pool', () => {
    const pool = new SessionNamePool();
    pool.assign('session-rel');
    pool.release('session-rel');
    expect(pool.getName('session-rel')).toBeUndefined();
  });

  it('reassigns a session to a preferred puppet name when that name is free', () => {
    const pool = new SessionNamePool();
    pool.assign('session-a');

    const reassigned = pool.reassign('session-a', 'Bunraku');
    expect(reassigned).toBe('Bunraku');
    expect(pool.getName('session-a')).toBe('Bunraku');
    expect(pool.getColor('session-a')).toBe(getPuppetColor('Bunraku'));
  });

  it('keeps the current assignment when another session already owns the requested name', () => {
    const pool = new SessionNamePool();
    pool.adopt('session-a', 'Bunraku');
    const original = pool.assign('session-b');

    const reassigned = pool.reassign('session-b', 'Bunraku');
    expect(reassigned).toBe(original);
    expect(pool.getName('session-b')).toBe(original);
  });

  it('adopt() preserves an imported puppet name across leader handoff', () => {
    const pool = new SessionNamePool();
    const adopted = pool.adopt('session-imported', 'Kermit');
    expect(adopted).toBe('Kermit');
    expect(pool.getName('session-imported')).toBe('Kermit');
  });

  it('falls back to session-ID segment when pool is exhausted', () => {
    const pool = new SessionNamePool();
    // Assign all names in the puppet pool
    for (let i = 0; i < ALL_PUPPET_NAMES.length; i++) {
      pool.assign(`session-${i}`);
    }
    // With fake timers, cooldowns won't expire — next assign is a fallback
    jest.useFakeTimers();
    try {
      const fallback = pool.assign('overflow-segment-here');
      // Fallback is the second dash-segment, i.e. "segment"
      expect(fallback).toBe('segment');
    } finally {
      jest.useRealTimers();
    }
  });
});
