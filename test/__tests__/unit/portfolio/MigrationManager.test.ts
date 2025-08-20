/**
 * Tests for MigrationManager
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { PortfolioManager, ElementType } from '../../../../src/portfolio/PortfolioManager.js';
import { MigrationManager } from '../../../../src/portfolio/MigrationManager.js';

describe('MigrationManager', () => {
  let testDir: string;
  let legacyDir: string;
  let portfolioDir: string;
  let portfolioManager: PortfolioManager;
  let migrationManager: MigrationManager;
  const originalEnv = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  
  beforeEach(async () => {
    // Create test directories
    testDir = path.join(tmpdir(), `migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    
    // Setup legacy directory structure
    const dollhouseDir = path.join(testDir, '.dollhouse');
    legacyDir = path.join(dollhouseDir, 'personas');
    portfolioDir = path.join(dollhouseDir, 'portfolio');
    
    // Clear environment and reset singleton
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    (PortfolioManager as any).instance = undefined;
    
    // Create portfolio manager with test directory
    portfolioManager = PortfolioManager.getInstance({ 
      baseDir: portfolioDir 
    });
    
    // Override getLegacyPersonasDir to use test directory
    jest.spyOn(portfolioManager, 'getLegacyPersonasDir').mockReturnValue(legacyDir);
    
    migrationManager = new MigrationManager(portfolioManager);
  });
  
  afterEach(async () => {
    // Restore environment
    if (originalEnv) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalEnv;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }
    
    // Clean up
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    
    jest.restoreAllMocks();
  });
  
  describe('needsMigration', () => {
    it('should return false when no legacy personas exist', async () => {
      expect(await migrationManager.needsMigration()).toBe(false);
    });
    
    it('should return false when portfolio already exists', async () => {
      // Create legacy personas
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, 'sample.md'), 'content');
      
      // Create portfolio
      await portfolioManager.initialize();
      
      expect(await migrationManager.needsMigration()).toBe(false);
    });
    
    it('should return true when legacy exists but portfolio does not', async () => {
      // Create legacy personas
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, 'sample.md'), 'content');
      
      expect(await migrationManager.needsMigration()).toBe(true);
    });
  });
  
  describe('migrate', () => {
    it('should return early when no migration needed', async () => {
      const result = await migrationManager.migrate();
      
      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.backedUp).toBe(false);
    });
    
    it('should migrate all persona files', async () => {
      // Create legacy personas
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, 'persona1.md'), '# Persona 1');
      await fs.writeFile(path.join(legacyDir, 'persona2.md'), '# Persona 2');
      await fs.writeFile(path.join(legacyDir, 'not-md.txt'), 'ignored');
      
      const result = await migrationManager.migrate();
      
      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(2);
      expect(result.errors).toEqual([]);
      
      // Verify files were copied
      const newPersonasDir = portfolioManager.getElementDir(ElementType.PERSONA);
      const persona1 = await fs.readFile(path.join(newPersonasDir, 'persona1.md'), 'utf-8');
      const persona2 = await fs.readFile(path.join(newPersonasDir, 'persona2.md'), 'utf-8');
      
      expect(persona1).toBe('# Persona 1');
      expect(persona2).toBe('# Persona 2');
      
      // Verify non-md file was not copied
      await expect(fs.access(path.join(newPersonasDir, 'not-md.txt')))
        .rejects.toThrow();
    });
    
    it('should create backup when requested', async () => {
      // Create legacy personas
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, 'sample.md'), '# Test');
      
      const result = await migrationManager.migrate({ backup: true });
      
      expect(result.success).toBe(true);
      expect(result.backedUp).toBe(true);
      expect(result.backupPath).toBeDefined();
      
      // Verify backup exists
      if (result.backupPath) {
        await expect(fs.access(result.backupPath)).resolves.toBeUndefined();
        const backupFile = await fs.readFile(path.join(result.backupPath, 'sample.md'), 'utf-8');
        expect(backupFile).toBe('# Test');
      }
    });
    
    it.skip('should handle migration errors gracefully', async () => {
      // Skip this test - file permission testing is platform-specific
      // The error handling is tested in integration tests
    });
    
    it('should preserve original files after migration', async () => {
      // Create legacy personas
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, 'sample.md'), '# Test');
      
      await migrationManager.migrate();
      
      // Original file should still exist
      await expect(fs.access(path.join(legacyDir, 'sample.md')))
        .resolves.toBeUndefined();
    });
  });
  
  describe('getMigrationStatus', () => {
    it('should report no legacy personas initially', async () => {
      const status = await migrationManager.getMigrationStatus();
      
      expect(status.hasLegacyPersonas).toBe(false);
      expect(status.legacyPersonaCount).toBe(0);
      expect(status.portfolioExists).toBe(false);
      expect(status.portfolioStats[ElementType.PERSONA]).toBe(0);
    });
    
    it('should report legacy personas count', async () => {
      // Create legacy personas
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, 'p1.md'), 'content');
      await fs.writeFile(path.join(legacyDir, 'p2.md'), 'content');
      await fs.writeFile(path.join(legacyDir, 'other.txt'), 'ignored');
      
      const status = await migrationManager.getMigrationStatus();
      
      expect(status.hasLegacyPersonas).toBe(true);
      expect(status.legacyPersonaCount).toBe(2);
    });
    
    it('should report portfolio statistics after migration', async () => {
      // Create and migrate legacy personas
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, 'p1.md'), 'content');
      await fs.writeFile(path.join(legacyDir, 'p2.md'), 'content');
      
      await migrationManager.migrate();
      
      const status = await migrationManager.getMigrationStatus();
      
      expect(status.portfolioExists).toBe(true);
      expect(status.portfolioStats[ElementType.PERSONA]).toBe(2);
      expect(status.portfolioStats[ElementType.SKILL]).toBe(0);
    });
  });
  
  describe('backup functionality', () => {
    it('should create timestamped backup directory', async () => {
      // Create legacy content
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, 'sample.md'), 'content');
      await fs.mkdir(path.join(legacyDir, 'subdir'), { recursive: true });
      await fs.writeFile(path.join(legacyDir, 'subdir', 'nested.md'), 'nested');
      
      const result = await migrationManager.migrate({ backup: true });
      
      expect(result.backupPath).toMatch(/_backup_\d{4}-\d{2}-\d{2}T/);
      
      // Verify only files were backed up (not subdirectories)
      if (result.backupPath) {
        const backupContents = await fs.readdir(result.backupPath);
        expect(backupContents).toContain('sample.md');
        expect(backupContents).not.toContain('subdir');
      }
    });
  });
});