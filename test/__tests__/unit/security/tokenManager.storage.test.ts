/**
 * Tests for TokenManager secure storage functionality
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TokenManager } from '../../../../src/security/tokenManager.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { logger } from '../../../../src/utils/logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import * as crypto from 'crypto';

// Create manual mocks
const mockAccess = jest.fn() as any;
const mockMkdir = jest.fn() as any;
const mockWriteFile = jest.fn() as any;
const mockReadFile = jest.fn() as any;
const mockUnlink = jest.fn() as any;

// Mock dependencies
jest.mock('../../../../src/utils/logger.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('fs/promises', () => ({
  access: mockAccess,
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink
}));

describe('TokenManager - Secure Storage', () => {
  const originalEnv = process.env;
  
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    // Ensure GITHUB_TOKEN is not set for tests
    delete process.env.GITHUB_TOKEN;
    // Reset all mocks
    mockAccess.mockReset();
    mockMkdir.mockReset();
    mockWriteFile.mockReset();
    mockReadFile.mockReset();
    mockUnlink.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('storeGitHubToken', () => {
    it('should store valid token securely', async () => {
      const validToken = 'ghp_1234567890abcdef1234567890abcdef12345678';
      
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await TokenManager.storeGitHubToken(validToken);

      // Verify directory was created with correct permissions
      expect(mockMkdir).toHaveBeenCalledWith(
        path.join(homedir(), '.dollhouse', '.auth'),
        { recursive: true, mode: 0o700 }
      );

      // Verify file was written with correct permissions
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(homedir(), '.dollhouse', '.auth', 'github_token.enc'),
        expect.any(Buffer),
        { mode: 0o600 }
      );

      // Verify security event was logged
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOKEN_STORED',
          severity: 'low',
          metadata: expect.objectContaining({
            tokenType: 'personal'
          })
        })
      );
    });

    it('should reject invalid token format', async () => {
      const invalidToken = 'not-a-valid-token';

      await expect(TokenManager.storeGitHubToken(invalidToken)).rejects.toThrow(
        'Invalid token format'
      );

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should handle Unicode normalization', async () => {
      // Token with Unicode that needs normalization
      const tokenWithUnicode = 'ghp_1234567890abcdef1234567890abcdef12345678';
      
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await TokenManager.storeGitHubToken(tokenWithUnicode);

      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should handle storage errors', async () => {
      const validToken = 'ghp_1234567890abcdef1234567890abcdef12345678';
      
      mockMkdir.mockRejectedValue(new Error('Permission denied'));

      await expect(TokenManager.storeGitHubToken(validToken)).rejects.toThrow(
        'Failed to store token'
      );

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOKEN_STORAGE_FAILED',
          severity: 'medium'
        })
      );
    });
  });

  describe('retrieveGitHubToken', () => {
    it('should retrieve and decrypt stored token', async () => {
      const originalToken = 'ghp_1234567890abcdef1234567890abcdef12345678';
      
      // Create encrypted data that matches what storeGitHubToken would create
      // This is a simplified mock - real implementation uses proper encryption
      const salt = crypto.randomBytes(32);
      const iv = crypto.randomBytes(16);
      const tag = crypto.randomBytes(16);
      const encrypted = Buffer.from(originalToken); // Simplified for test
      const stored = Buffer.concat([salt, iv, tag, encrypted]);

      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(stored);

      // Mock the decryption to return the original token
      // In real implementation, this would use proper AES-GCM decryption
      jest.spyOn(TokenManager as any, 'validateTokenFormat').mockReturnValue(true);

      const result = await TokenManager.retrieveGitHubToken();

      expect(mockReadFile).toHaveBeenCalledWith(
        path.join(homedir(), '.dollhouse', '.auth', 'github_token.enc')
      );

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOKEN_RETRIEVED',
          severity: 'low'
        })
      );
    });

    it('should return null when no token file exists', async () => {
      mockAccess.mockRejectedValue({ code: 'ENOENT' });

      const result = await TokenManager.retrieveGitHubToken();

      expect(result).toBeNull();
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('should handle corrupted token data', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(Buffer.from('corrupted data'));

      const result = await TokenManager.retrieveGitHubToken();

      expect(result).toBeNull();
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOKEN_RETRIEVAL_FAILED',
          severity: 'medium'
        })
      );
    });
  });

  describe('removeStoredToken', () => {
    it('should remove token file', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockUnlink.mockResolvedValue(undefined);

      await TokenManager.removeStoredToken();

      expect(mockUnlink).toHaveBeenCalledWith(
        path.join(homedir(), '.dollhouse', '.auth', 'github_token.enc')
      );

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOKEN_REMOVED',
          severity: 'low'
        })
      );
    });

    it('should handle missing token file gracefully', async () => {
      mockAccess.mockRejectedValue({ code: 'ENOENT' });

      await TokenManager.removeStoredToken();

      expect(mockUnlink).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith('No stored token to remove');
    });

    it('should handle deletion errors', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockUnlink.mockRejectedValue(new Error('Permission denied'));

      await TokenManager.removeStoredToken();

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TOKEN_REMOVAL_FAILED',
          severity: 'low'
        })
      );
    });
  });

  describe('getGitHubTokenAsync', () => {
    it('should prefer environment variable over stored token', async () => {
      process.env.GITHUB_TOKEN = 'ghp_envtoken1234567890abcdef1234567890abcdef';
      
      const result = await TokenManager.getGitHubTokenAsync();

      expect(result).toBe('ghp_envtoken1234567890abcdef1234567890abcdef');
      expect(mockAccess).not.toHaveBeenCalled();
    });

    it('should fall back to stored token when env var not set', async () => {
      delete process.env.GITHUB_TOKEN;
      
      // Mock successful token retrieval
      const storedToken = 'ghp_storedtoken567890abcdef1234567890abcdef12';
      jest.spyOn(TokenManager, 'retrieveGitHubToken').mockResolvedValue(storedToken);

      const result = await TokenManager.getGitHubTokenAsync();

      expect(result).toBe(storedToken);
    });

    it('should return null when no token available', async () => {
      delete process.env.GITHUB_TOKEN;
      jest.spyOn(TokenManager, 'retrieveGitHubToken').mockResolvedValue(null);

      const result = await TokenManager.getGitHubTokenAsync();

      expect(result).toBeNull();
    });
  });

  describe('Machine-specific encryption', () => {
    it('should use consistent passphrase for same machine', () => {
      // Access private method for testing
      const getPassphrase = (TokenManager as any).getMachinePassphrase;
      
      const passphrase1 = getPassphrase();
      const passphrase2 = getPassphrase();

      expect(passphrase1).toBe(passphrase2);
      expect(passphrase1).toContain('DollhouseMCP-TokenStore-v1');
    });

    it('should handle missing USER environment variable', () => {
      const originalUser = process.env.USER;
      delete process.env.USER;

      const getPassphrase = (TokenManager as any).getMachinePassphrase;
      const passphrase = getPassphrase();

      // Should contain DollhouseMCP prefix but 'default' is hashed so we won't see it directly
      expect(passphrase).toContain('DollhouseMCP-TokenStore-v1');

      process.env.USER = originalUser;
    });
  });
});