/**
 * Unit tests for permission_prompt rate limiting (Issue #625 Phase 4)
 */

import { describe, it, expect } from '@jest/globals';
import { RateLimiterFactory } from '../../../../src/utils/RateLimiter.js';

describe('permission_prompt rate limiting', () => {
  describe('permissionPromptLimiter', () => {
    it('should allow up to 100 requests', () => {
      const limiter = RateLimiterFactory.createPermissionPromptLimiter();

      for (let i = 0; i < 100; i++) {
        const status = limiter.checkLimit();
        expect(status.allowed).toBe(true);
        limiter.consumeToken();
      }

      // 101st should be denied
      const status = limiter.checkLimit();
      expect(status.allowed).toBe(false);
      expect(status.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('cliApprovalLimiter', () => {
    it('should allow up to 20 requests', () => {
      const limiter = RateLimiterFactory.createCliApprovalLimiter();

      for (let i = 0; i < 20; i++) {
        const status = limiter.checkLimit();
        expect(status.allowed).toBe(true);
        limiter.consumeToken();
      }

      // 21st should be denied
      const status = limiter.checkLimit();
      expect(status.allowed).toBe(false);
      expect(status.retryAfterMs).toBeGreaterThan(0);
    });
  });
});
