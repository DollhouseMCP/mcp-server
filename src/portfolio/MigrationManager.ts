/**
 * Migration Manager - Handles migration from legacy structure to portfolio structure
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PortfolioManager } from './PortfolioManager.js';
import { ElementType } from './types.js';
import { logger } from '../utils/logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface MigrationResult {
  success: boolean;
  migratedCount: number;
  errors: string[];
  backedUp: boolean;
  backupPath?: string;
}

export class MigrationManager {
  private portfolioManager: PortfolioManager;
  
  constructor(portfolioManager: PortfolioManager) {
    this.portfolioManager = portfolioManager;
  }
  
  /**
   * Check if migration is needed
   */
  public async needsMigration(): Promise<boolean> {
    const hasLegacy = await this.portfolioManager.hasLegacyPersonas();
    const portfolioExists = await this.portfolioManager.exists();
    
    // Need migration if we have legacy personas but no portfolio yet
    return hasLegacy && !portfolioExists;
  }
  
  /**
   * Perform migration from legacy to portfolio structure
   */
  public async migrate(options?: { backup?: boolean }): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: true,
      migratedCount: 0,
      errors: [],
      backedUp: false
    };
    
    try {
      // Check if migration is needed
      if (!await this.needsMigration()) {
        logger.info('[MigrationManager] No migration needed');
        return result;
      }
      
      logger.info('[MigrationManager] Starting migration from legacy personas to portfolio structure');
      
      // Create backup if requested
      if (options?.backup) {
        const backupPath = await this.createBackup();
        result.backedUp = true;
        result.backupPath = backupPath;
        logger.info(`[MigrationManager] Created backup at: ${backupPath}`);
      }
      
      // Initialize portfolio structure
      await this.portfolioManager.initialize();
      
      // Get legacy personas
      const legacyDir = this.portfolioManager.getLegacyPersonasDir();
      const files = await fs.readdir(legacyDir);
      const personaFiles = files.filter(file => file.endsWith('.md'));
      
      logger.info(`[MigrationManager] Found ${personaFiles.length} personas to migrate`);
      
      // Migrate each persona
      for (const file of personaFiles) {
        try {
          await this.migratePersona(file);
          result.migratedCount++;
        } catch (error) {
          const errorMsg = `Failed to migrate ${file}: ${error instanceof Error ? error.message : String(error)}`;
          logger.error(`[MigrationManager] ${errorMsg}`);
          result.errors.push(errorMsg);
          result.success = false;
        }
      }
      
      // If all migrations successful, optionally clean up legacy directory
      if (result.success && result.migratedCount > 0) {
        logger.info(`[MigrationManager] Successfully migrated ${result.migratedCount} personas`);
        // Note: We don't automatically delete the legacy directory
        // User should manually remove it after confirming migration success
      }
      
    } catch (error) {
      result.success = false;
      const errorMsg = `Migration failed: ${error instanceof Error ? error.message : String(error)}`;
      result.errors.push(errorMsg);
      
      // Log with full error details including stack trace
      if (error instanceof Error) {
        logger.error(`[MigrationManager] ${errorMsg}`, { 
          stack: error.stack,
          name: error.name,
          cause: error.cause
        });
      } else {
        logger.error(`[MigrationManager] ${errorMsg}`, { rawError: error });
      }
    }
    
    return result;
  }
  
  /**
   * Migrate a single persona file
   */
  private async migratePersona(filename: string): Promise<void> {
    // Normalize filename to prevent Unicode attacks
    const filenameValidation = UnicodeValidator.normalize(filename);
    const normalizedFilename = filenameValidation.normalizedContent;
    
    if (normalizedFilename !== filename) {
      logger.warn(`[MigrationManager] Filename normalized from "${filename}" to "${normalizedFilename}"`);
    }
    
    if (!filenameValidation.isValid) {
      logger.warn(`[MigrationManager] Filename has Unicode issues: ${filenameValidation.detectedIssues?.join(', ')}`);
    }
    
    const legacyPath = path.join(this.portfolioManager.getLegacyPersonasDir(), filename);
    const newPath = this.portfolioManager.getElementPath(ElementType.PERSONA, normalizedFilename);
    
    // Read the content
    const content = await fs.readFile(legacyPath, 'utf-8');
    
    // Normalize content to prevent Unicode issues
    const contentValidation = UnicodeValidator.normalize(content);
    const normalizedContent = contentValidation.normalizedContent;
    
    if (!contentValidation.isValid) {
      logger.warn(`[MigrationManager] Content has Unicode issues in ${filename}: ${contentValidation.detectedIssues?.join(', ')}`);
    }
    
    // Write to new location
    await fs.writeFile(newPath, normalizedContent, 'utf-8');
    
    logger.debug(`[MigrationManager] Migrated: ${filename}`);
  }
  
  /**
   * Create backup of legacy personas
   */
  private async createBackup(): Promise<string> {
    const legacyDir = this.portfolioManager.getLegacyPersonasDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = `${legacyDir}_backup_${timestamp}`;
    
    // Create backup directory
    await fs.mkdir(backupDir, { recursive: true });
    
    // Copy all files
    const files = await fs.readdir(legacyDir);
    for (const file of files) {
      const srcPath = path.join(legacyDir, file);
      const destPath = path.join(backupDir, file);
      
      const stats = await fs.stat(srcPath);
      if (stats.isFile()) {
        await fs.copyFile(srcPath, destPath);
      }
    }
    
    return backupDir;
  }
  
  /**
   * Get migration status report
   */
  public async getMigrationStatus(): Promise<{
    hasLegacyPersonas: boolean;
    legacyPersonaCount: number;
    portfolioExists: boolean;
    portfolioStats: Record<ElementType, number>;
  }> {
    const hasLegacyPersonas = await this.portfolioManager.hasLegacyPersonas();
    let legacyPersonaCount = 0;
    
    if (hasLegacyPersonas) {
      const legacyDir = this.portfolioManager.getLegacyPersonasDir();
      const files = await fs.readdir(legacyDir);
      legacyPersonaCount = files.filter(file => file.endsWith('.md')).length;
    }
    
    const portfolioExists = await this.portfolioManager.exists();
    const portfolioStats = portfolioExists 
      ? await this.portfolioManager.getStatistics()
      : Object.values(ElementType).reduce((acc, type) => ({ ...acc, [type]: 0 }), {}) as Record<ElementType, number>;
    
    return {
      hasLegacyPersonas,
      legacyPersonaCount,
      portfolioExists,
      portfolioStats
    };
  }
}