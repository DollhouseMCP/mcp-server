/**
 * Migration Manager - Handles migration from legacy structure to portfolio structure
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PortfolioManager } from './PortfolioManager.js';
import { ElementType } from './types.js';
import { logger } from '../utils/logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { ContentValidator } from '../security/contentValidator.js';
import { FileLockManager } from '../security/fileLockManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

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
      
      // SECURITY FIX: DMCP-SEC-006 - Add security audit logging
      SecurityMonitor.logSecurityEvent({
        type: 'PORTFOLIO_INITIALIZATION',
        severity: 'LOW',
        source: 'migration_manager',
        details: 'Starting migration from legacy personas to portfolio structure',
        metadata: { backup: !!options?.backup }
      });
      
      // Create backup if requested
      if (options?.backup) {
        const backupPath = await this.createBackup();
        result.backedUp = true;
        result.backupPath = backupPath;
        logger.info(`[MigrationManager] Created backup at: ${backupPath}`);
        
        // SECURITY FIX: DMCP-SEC-006 - Log backup creation for audit trail
        SecurityMonitor.logSecurityEvent({
          type: 'FILE_COPIED',
          severity: 'LOW',
          source: 'migration_manager',
          details: `Created backup during migration: ${backupPath}`,
          metadata: { backupPath, operation: 'migration_backup' }
        });
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
          
          // SECURITY FIX: DMCP-SEC-006 - Log each successful migration for audit trail
          SecurityMonitor.logSecurityEvent({
            type: 'FILE_COPIED',
            severity: 'LOW',
            source: 'migration_manager',
            details: `Successfully migrated persona: ${file}`,
            metadata: { filename: file, operation: 'persona_migration' }
          });
        } catch (error) {
          const errorMsg = `Failed to migrate ${file}: ${error instanceof Error ? error.message : String(error)}`;
          logger.error(`[MigrationManager] ${errorMsg}`);
          result.errors.push(errorMsg);
          result.success = false;
          
          // SECURITY FIX: DMCP-SEC-006 - Log individual migration failures for audit trail
          SecurityMonitor.logSecurityEvent({
            type: 'FILE_COPIED',
            severity: 'MEDIUM',
            source: 'migration_manager',
            details: `Failed to migrate persona: ${errorMsg}`,
            metadata: { 
              filename: file, 
              operation: 'persona_migration_failed',
              errorType: error instanceof Error ? error.name : 'unknown'
            }
          });
        }
      }
      
      // If all migrations successful, optionally clean up legacy directory
      if (result.success && result.migratedCount > 0) {
        logger.info(`[MigrationManager] Successfully migrated ${result.migratedCount} personas`);
        
        // SECURITY FIX: DMCP-SEC-006 - Log successful migration completion for audit trail
        SecurityMonitor.logSecurityEvent({
          type: 'PORTFOLIO_POPULATED',
          severity: 'LOW',
          source: 'migration_manager',
          details: `Migration completed successfully: ${result.migratedCount} personas migrated`,
          metadata: { 
            migratedCount: result.migratedCount, 
            backedUp: result.backedUp,
            backupPath: result.backupPath
          }
        });
        
        // Note: We don't automatically delete the legacy directory
        // User should manually remove it after confirming migration success
      }
      
    } catch (error) {
      result.success = false;
      const errorMsg = `Migration failed: ${error instanceof Error ? error.message : String(error)}`;
      result.errors.push(errorMsg);
      
      // SECURITY FIX: DMCP-SEC-006 - Log migration failures for security audit trail
      SecurityMonitor.logSecurityEvent({
        type: 'DIRECTORY_MIGRATION',
        severity: 'HIGH',
        source: 'migration_manager',
        details: `Migration failed: ${errorMsg}`,
        metadata: { 
          errorType: error instanceof Error ? error.name : 'unknown',
          migratedCount: result.migratedCount,
          errorCount: result.errors.length
        }
      });
      
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
      
      // SECURITY FIX: DMCP-SEC-006 - Log Unicode issues for security audit trail
      SecurityMonitor.logSecurityEvent({
        type: 'UNICODE_VALIDATION_ERROR',
        severity: 'MEDIUM',
        source: 'migration_manager',
        details: `Unicode issues detected in filename during migration: ${filenameValidation.detectedIssues?.join(', ')}`,
        metadata: { 
          originalFilename: filename,
          normalizedFilename,
          detectedIssues: filenameValidation.detectedIssues
        }
      });
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
      
      // SECURITY FIX: DMCP-SEC-006 - Log Unicode content issues for security audit trail
      SecurityMonitor.logSecurityEvent({
        type: 'UNICODE_VALIDATION_ERROR',
        severity: 'MEDIUM',
        source: 'migration_manager',
        details: `Unicode issues detected in content during migration: ${contentValidation.detectedIssues?.join(', ')}`,
        metadata: { 
          filename,
          detectedIssues: contentValidation.detectedIssues,
          contentLength: content.length
        }
      });
    }
    
    // SECURITY FIX: Add comprehensive content validation before write
    // FIXED: CVE-2025-XXXX - Direct file write without security validation in migration
    // Original issue: Line 147 used direct fs.writeFile without comprehensive validation
    // Security impact: Could allow malicious content to be written during migration
    // Fix: Added ContentValidator.validateAndSanitize with critical threat blocking
    const validationResult = ContentValidator.validateAndSanitize(normalizedContent);
    if (!validationResult.isValid && validationResult.severity === 'critical') {
      const patterns = validationResult.detectedPatterns?.join(', ') || 'unknown patterns';
      throw new Error(`Critical security threat in migrated content for ${filename}: ${patterns}`);
    }
    
    const validatedContent = validationResult.sanitizedContent || normalizedContent;
    
    // SECURITY FIX: Replace direct write with atomic operation
    // FIXED: Race condition vulnerability in file writes during migration
    // Original issue: Line 147 used non-atomic fs.writeFile operation
    // Security impact: Race conditions could cause data corruption or partial writes
    // Fix: Replaced with FileLockManager.atomicWriteFile for guaranteed atomicity
    await FileLockManager.atomicWriteFile(newPath, validatedContent, { encoding: 'utf-8' });
    
    // SECURITY FIX: DMCP-SEC-006 - Log file operations for security audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'FILE_COPIED',
      severity: 'LOW',
      source: 'migration_manager',
      details: `Persona file migrated with security validation: ${normalizedFilename}`,
      metadata: { 
        originalFilename: filename,
        normalizedFilename,
        sourcePath: legacyPath,
        destinationPath: newPath,
        contentLength: validatedContent.length,
        unicodeNormalized: normalizedFilename !== filename,
        unicodeIssues: !contentValidation.isValid
      }
    });
    
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
    let copiedCount = 0;
    
    for (const file of files) {
      const srcPath = path.join(legacyDir, file);
      const destPath = path.join(backupDir, file);
      
      const stats = await fs.stat(srcPath);
      if (stats.isFile()) {
        await fs.copyFile(srcPath, destPath);
        copiedCount++;
      }
    }
    
    // SECURITY FIX: DMCP-SEC-006 - Log backup operation details for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'FILE_COPIED',
      severity: 'LOW',
      source: 'migration_manager',
      details: `Backup created: ${copiedCount} files copied to ${backupDir}`,
      metadata: { 
        backupDir,
        legacyDir,
        filesCopied: copiedCount,
        operation: 'backup_creation'
      }
    });
    
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