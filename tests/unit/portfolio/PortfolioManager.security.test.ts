/**
 * Security tests for PortfolioManager
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as path from 'path';
import { tmpdir } from 'os';
import { PortfolioManager, ElementType } from '../../../src/portfolio/PortfolioManager.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';

// Create shared file operations service for tests using di-mocks helper
const fileOperations = createTestFileOperationsService();

describe('PortfolioManager - Security', () => {
  let testDir: string;
  let portfolioManager: PortfolioManager;
  const originalEnv = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  
  beforeEach(() => {
    // Create a unique test directory
    testDir = path.join(tmpdir(), `portfolio-security-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    // Clear environment variable
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
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
      portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
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

      expect(() => new PortfolioManager(fileOperations))
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR must be an absolute path');
    });

    it('should reject paths with .. in environment variable', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = '/home/../etc';

      expect(() => new PortfolioManager(fileOperations))
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
    });

    it('should reject /etc paths', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = '/etc/portfolio';

      expect(() => new PortfolioManager(fileOperations))
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
    });

    it('should reject /sys paths', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = '/sys/portfolio';

      expect(() => new PortfolioManager(fileOperations))
        .toThrow('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
    });

    it('should accept valid absolute paths', () => {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

      const manager = new PortfolioManager(fileOperations);
      expect(() => manager).not.toThrow();
      expect(manager.getBaseDir()).toBe(testDir);
    });
  });

  describe('config validation', () => {
    it('should reject non-absolute paths in config', () => {
      expect(() => new PortfolioManager(fileOperations, { baseDir: 'relative/path' }))
        .toThrow('Portfolio config baseDir must be an absolute path');
    });

    it('should accept valid absolute paths in config', () => {
      expect(() => new PortfolioManager(fileOperations, { baseDir: testDir }))
        .not.toThrow();
    });
  });
});