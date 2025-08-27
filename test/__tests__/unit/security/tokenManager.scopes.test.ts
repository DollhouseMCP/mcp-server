/**
 * Tests for OAuth scope handling in TokenManager
 * Validates that OAuth tokens with 'public_repo' are properly handled
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { TokenManager } from '../../../../src/security/tokenManager.js';

describe('TokenManager - OAuth Scope Handling', () => {
  describe('getRequiredScopes', () => {
    it('should require public_repo for read operations (OAuth compatible)', () => {
      const scopes = TokenManager.getRequiredScopes('read');
      expect(scopes.required).toEqual(['public_repo']);
      expect(scopes.required).not.toContain('repo');
    });

    it('should require public_repo for write operations (OAuth compatible)', () => {
      const scopes = TokenManager.getRequiredScopes('write');
      expect(scopes.required).toEqual(['public_repo']);
      expect(scopes.required).not.toContain('repo');
    });

    it('should require public_repo for collection operations (OAuth compatible)', () => {
      const scopes = TokenManager.getRequiredScopes('collection');
      expect(scopes.required).toEqual(['public_repo']);
      expect(scopes.required).not.toContain('repo');
    });

    it('should require public_repo for marketplace operations (backward compat)', () => {
      const scopes = TokenManager.getRequiredScopes('marketplace');
      expect(scopes.required).toEqual(['public_repo']);
      expect(scopes.required).not.toContain('repo');
    });

    it('should require gist scope for gist operations', () => {
      const scopes = TokenManager.getRequiredScopes('gist');
      expect(scopes.required).toEqual(['gist']);
      expect(scopes.optional).toEqual(['user:email']);
    });
  });

  describe('Token Type Detection', () => {
    it('should correctly identify OAuth access tokens', () => {
      const oauthToken = 'gho_1234567890abcdef1234567890abcdef12345678';
      const tokenType = TokenManager.getTokenType(oauthToken);
      expect(tokenType).toBe('OAuth Access Token');
    });

    it('should correctly identify Personal Access Tokens', () => {
      const pat = 'ghp_1234567890abcdef1234567890abcdef12345678';
      const tokenType = TokenManager.getTokenType(pat);
      expect(tokenType).toBe('Personal Access Token');
    });

    it('should correctly identify fine-grained PATs', () => {
      const fineGrainedPat = 'github_pat_1234567890abcdef1234567890abcdef12345678';
      const tokenType = TokenManager.getTokenType(fineGrainedPat);
      expect(tokenType).toBe('Fine-grained Personal Access Token');
    });
  });

  describe('validateTokenFormat', () => {
    it('should accept OAuth tokens (gho_ prefix)', () => {
      const oauthToken = 'gho_1234567890abcdef1234567890abcdef12345678';
      const isValid = TokenManager.validateTokenFormat(oauthToken);
      expect(isValid).toBe(true);
    });

    it('should accept PAT tokens (ghp_ prefix)', () => {
      const pat = 'ghp_1234567890abcdef1234567890abcdef12345678';
      const isValid = TokenManager.validateTokenFormat(pat);
      expect(isValid).toBe(true);
    });

    it('should reject invalid token formats', () => {
      const invalidTokens = [
        'not-a-token',
        'gh_missing_type',
        'gxx_invalid_prefix',
        '',
        null,
        undefined
      ];

      invalidTokens.forEach(token => {
        const isValid = TokenManager.validateTokenFormat(token as any);
        expect(isValid).toBe(false);
      });
    });
  });

  describe('Scope Compatibility', () => {
    it('should document that repo scope includes public_repo', () => {
      // This is a documentation test to ensure understanding
      // PATs with 'repo' scope have access to both public and private repos
      // OAuth tokens with 'public_repo' only have access to public repos
      // Therefore, a PAT with 'repo' can do everything 'public_repo' can do
      
      const patScopes = ['repo', 'user:email'];
      const oauthScopes = ['public_repo', 'user:email'];
      const requiredScope = 'public_repo';
      
      // PAT with repo scope should satisfy public_repo requirement
      expect(patScopes.includes('repo') || patScopes.includes(requiredScope)).toBe(true);
      
      // OAuth with public_repo satisfies the requirement
      expect(oauthScopes.includes(requiredScope)).toBe(true);
    });
  });
});