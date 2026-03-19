/**
 * Tests for VerificationStore
 */

import { VerificationStore } from '../src/VerificationStore.js';

describe('VerificationStore', () => {
  let store: VerificationStore;

  beforeEach(() => {
    store = new VerificationStore(0); // Disable auto-cleanup for tests
  });

  afterEach(() => {
    store.destroy();
  });

  describe('set and get', () => {
    it('should store and retrieve a challenge', () => {
      const challenge = {
        code: 'ABC123',
        expiresAt: Date.now() + 60000,
        reason: 'Test verification',
      };

      store.set('challenge1', challenge);
      const retrieved = store.get('challenge1');

      expect(retrieved).toEqual(challenge);
    });

    it('should return undefined for non-existent challenge', () => {
      const retrieved = store.get('nonexistent');
      expect(retrieved).toBeUndefined();
    });

    it('should return undefined for expired challenge', () => {
      const challenge = {
        code: 'ABC123',
        expiresAt: Date.now() - 1000, // Expired 1 second ago
        reason: 'Test verification',
      };

      store.set('challenge1', challenge);
      const retrieved = store.get('challenge1');

      expect(retrieved).toBeUndefined();
    });

    it('should auto-delete expired challenge on get', () => {
      const challenge = {
        code: 'ABC123',
        expiresAt: Date.now() - 1000,
        reason: 'Test verification',
      };

      store.set('challenge1', challenge);
      store.get('challenge1'); // Should delete it

      expect(store.size()).toBe(0);
    });
  });

  describe('verify', () => {
    it('should verify correct code', () => {
      const challenge = {
        code: 'ABC123',
        expiresAt: Date.now() + 60000,
        reason: 'Test verification',
      };

      store.set('challenge1', challenge);
      const result = store.verify('challenge1', 'ABC123');

      expect(result).toBe(true);
    });

    it('should reject incorrect code', () => {
      const challenge = {
        code: 'ABC123',
        expiresAt: Date.now() + 60000,
        reason: 'Test verification',
      };

      store.set('challenge1', challenge);
      const result = store.verify('challenge1', 'WRONG');

      expect(result).toBe(false);
    });

    it('should reject non-existent challenge', () => {
      const result = store.verify('nonexistent', 'ABC123');
      expect(result).toBe(false);
    });

    it('should reject expired challenge', () => {
      const challenge = {
        code: 'ABC123',
        expiresAt: Date.now() - 1000,
        reason: 'Test verification',
      };

      store.set('challenge1', challenge);
      const result = store.verify('challenge1', 'ABC123');

      expect(result).toBe(false);
    });

    it('should delete challenge after verification attempt', () => {
      const challenge = {
        code: 'ABC123',
        expiresAt: Date.now() + 60000,
        reason: 'Test verification',
      };

      store.set('challenge1', challenge);
      store.verify('challenge1', 'ABC123');

      expect(store.get('challenge1')).toBeUndefined();
      expect(store.size()).toBe(0);
    });

    it('should delete challenge even on failed verification', () => {
      const challenge = {
        code: 'ABC123',
        expiresAt: Date.now() + 60000,
        reason: 'Test verification',
      };

      store.set('challenge1', challenge);
      store.verify('challenge1', 'WRONG');

      expect(store.get('challenge1')).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('should remove all expired challenges', () => {
      const now = Date.now();

      store.set('active1', { code: 'A1', expiresAt: now + 60000, reason: 'Active' });
      store.set('expired1', { code: 'E1', expiresAt: now - 1000, reason: 'Expired' });
      store.set('active2', { code: 'A2', expiresAt: now + 60000, reason: 'Active' });
      store.set('expired2', { code: 'E2', expiresAt: now - 2000, reason: 'Expired' });

      expect(store.size()).toBe(4);

      store.cleanup();

      expect(store.size()).toBe(2);
      expect(store.get('active1')).toBeDefined();
      expect(store.get('active2')).toBeDefined();
      expect(store.get('expired1')).toBeUndefined();
      expect(store.get('expired2')).toBeUndefined();
    });

    it('should handle cleanup with no expired challenges', () => {
      const now = Date.now();

      store.set('active1', { code: 'A1', expiresAt: now + 60000, reason: 'Active' });
      store.set('active2', { code: 'A2', expiresAt: now + 60000, reason: 'Active' });

      expect(store.size()).toBe(2);

      store.cleanup();

      expect(store.size()).toBe(2);
    });
  });

  describe('clear', () => {
    it('should remove all challenges', () => {
      store.set('challenge1', { code: 'C1', expiresAt: Date.now() + 60000, reason: 'Test' });
      store.set('challenge2', { code: 'C2', expiresAt: Date.now() + 60000, reason: 'Test' });
      store.set('challenge3', { code: 'C3', expiresAt: Date.now() + 60000, reason: 'Test' });

      expect(store.size()).toBe(3);

      store.clear();

      expect(store.size()).toBe(0);
    });
  });

  describe('size', () => {
    it('should return correct size', () => {
      expect(store.size()).toBe(0);

      store.set('challenge1', { code: 'C1', expiresAt: Date.now() + 60000, reason: 'Test' });
      expect(store.size()).toBe(1);

      store.set('challenge2', { code: 'C2', expiresAt: Date.now() + 60000, reason: 'Test' });
      expect(store.size()).toBe(2);

      store.clear();
      expect(store.size()).toBe(0);
    });
  });

  describe('auto-cleanup', () => {
    it('should auto-cleanup expired challenges when enabled', (done) => {
      // Create store with 100ms cleanup interval
      const autoStore = new VerificationStore(100);

      const now = Date.now();
      autoStore.set('active', { code: 'A', expiresAt: now + 60000, reason: 'Active' });
      autoStore.set('expired', { code: 'E', expiresAt: now - 1000, reason: 'Expired' });

      expect(autoStore.size()).toBe(2);

      // Wait for auto-cleanup to run
      setTimeout(() => {
        expect(autoStore.size()).toBe(1);
        expect(autoStore.get('active')).toBeDefined();
        expect(autoStore.get('expired')).toBeUndefined();
        autoStore.destroy();
        done();
      }, 150);
    });
  });

  describe('destroy', () => {
    it('should stop auto-cleanup interval', () => {
      const autoStore = new VerificationStore(100);
      expect(autoStore).toBeDefined();
      autoStore.destroy();
      // If this doesn't throw, the interval was cleared successfully
    });

    it('should handle multiple destroy calls', () => {
      const autoStore = new VerificationStore(100);
      autoStore.destroy();
      autoStore.destroy(); // Should not throw
    });
  });
});
