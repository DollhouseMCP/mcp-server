/**
 * Security tests for PortfolioManager
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import { tmpdir } from 'os';
import { PortfolioManager, ElementType } from '../../../../src/portfolio/PortfolioManager.js';

describe('PortfolioManager - Security', () => {
  let testDir: string;
  let portfolioManager: PortfolioManager;
  const originalEnv = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  
  beforeEach(() => {
    // Create a unique test directory
    testDir = path.join(tmpdir(), `portfolio-security-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    
    // Clear environment variable
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    
    // Reset singleton
    (PortfolioManager as any).instance = undefined;
    (PortfolioManager as any).instanceLock = false;
  });
  
  afterEach(() => {
    // Restore environment variable
    if (originalEnv) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalEnv;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }
  });
  
  describe('getElementPath - path traversal prevention', () => {
    beforeEach(() => {
      portfolioManager = PortfolioManager.getInstance({ baseDir: testDir });
    });
    
    it('should reject path traversal attempts with ..', () => {
      expect(() => portfolioManager.getElementPath(ElementType.PERSONA, '../../../etc/passwd'))
        .toThrow('Invalid filename: contains path traversal characters');
    });
    
    it('should reject absolute paths', () => {
      expect(() => portfolioManager.getElementPath(ElementType.PERSONA, '/etc/passwd'))
        .toThrow('Invalid filename: contains path traversal characters');
    });
    
    it('should reject paths with forward slashes', () => {
      expect(() => portfolioManager.getElementPath(ElementType.PERSONA, 'subdir/file.md'))
        .toThrow('Invalid filename: contains path traversal characters');
    });
    
    it('should reject paths with backslashes', () => {
      expect(() => portfolioManager.getElementPath(ElementType.PERSONA, 'subdir\\file.md'))
        .toThrow('Invalid filename: contains path traversal characters');
    });
    
    it('should reject hidden files', () => {
      expect(() => portfolioManager.getElementPath(ElementType.PERSONA, '.hidden'))
        .toThrow('Invalid filename: contains invalid characters');
    });
    
    it('should reject null bytes', () => {
      expect(() => portfolioManager.getElementPath(ElementType.PERSONA, 'file\0.md'))
        .toThrow('Invalid filename: contains invalid characters');
    });
    
    it('should reject empty filenames', () => {
      expect(() => portfolioManager.getElementPath(ElementType.PERSONA, ''))
        .toThrow('Invalid filename: must be a non-empty string');
    });
    
    it('should reject non-string filenames', () => {
      expect(() => portfolioManager.getElementPath(ElementType.PERSONA, null as any))
        .toThrow('Invalid filename: must be a non-empty string');
      
      expect(() => portfolioManager.getElementPath(ElementType.PERSONA, undefined as any))
        .toThrow('Invalid filename: must be a non-empty string');
      
      expect(() => portfolioManager.getElementPath(ElementType.PERSONA, 123 as any))
        .toThrow('Invalid filename: must be a non-empty string');
    });
    
    it('should accept valid filenames', () => {
      const validNames = [
        'test-persona',
        'test-persona.md',
        'test_persona',
        'test.persona',
        '123-test',
        'UPPERCASE',
        'with-numbers-123'
      ];
      
      for (const name of validNames) {
        expect(() => portfolioManager.getElementPath(ElementType.PERSONA, name))
          .not.toThrow();
      }
    });
  });
  
  describe('environment variable validation', () => {
    it('should reject non-absolute paths in environment variable', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = 'relative/path';
      
      expect(() => PortfolioManager.getInstance())
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR must be an absolute path');
    });
    
    it('should reject paths with .. in environment variable', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = '/home/../etc';
      
      expect(() => PortfolioManager.getInstance())
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
    });
    
    it('should reject /etc paths', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = '/etc/portfolio';
      
      expect(() => PortfolioManager.getInstance())
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
    });
    
    it('should reject /sys paths', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = '/sys/portfolio';
      
      expect(() => PortfolioManager.getInstance())
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
    });
    
    it('should accept valid absolute paths', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
      
      expect(() => PortfolioManager.getInstance()).not.toThrow();
      expect(PortfolioManager.getInstance().getBaseDir()).toBe(testDir);
    });
  });
  
  describe('config validation', () => {
    it('should reject non-absolute paths in config', () => {
      expect(() => PortfolioManager.getInstance({ baseDir: 'relative/path' }))
        .toThrow('Portfolio config baseDir must be an absolute path');
    });
    
    it('should accept valid absolute paths in config', () => {
      expect(() => PortfolioManager.getInstance({ baseDir: testDir }))
        .not.toThrow();
    });
  });
  
  describe('race condition prevention', () => {
    it('should prevent concurrent instance creation', () => {
      // Set the lock manually to simulate concurrent access
      (PortfolioManager as any).instanceLock = true;
      
      expect(() => PortfolioManager.getInstance())
        .toThrow('PortfolioManager instance is being created by another thread');
      
      // Reset lock
      (PortfolioManager as any).instanceLock = false;
    });
  });
});