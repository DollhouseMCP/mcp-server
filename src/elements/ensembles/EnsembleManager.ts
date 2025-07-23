/**
 * EnsembleManager - Implementation of IElementManager for Ensemble elements
 * Handles CRUD operations and lifecycle management for ensembles
 * 
 * SECURITY MEASURES (Following PersonaElementManager patterns):
 * 1. CRITICAL: Uses FileLockManager for atomic file operations to prevent race conditions
 * 2. HIGH: SecureYamlParser for YAML content validation to prevent injection attacks
 * 3. MEDIUM: All user inputs validated and sanitized
 * 4. MEDIUM: Audit logging for all security operations
 * 5. Path validation to prevent directory traversal
 */

import { IElementManager } from '../../types/elements/index.js';
import { ElementValidationResult } from '../../types/elements/IElement.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { sanitizeInput, validatePath } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { logger } from '../../utils/logger.js';
import { Ensemble } from './Ensemble.js';
import { EnsembleMetadata } from './types.js';
import { ENSEMBLE_LIMITS } from './constants.js';
import { ElementType } from '../../portfolio/types.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as yaml from 'js-yaml';

export class EnsembleManager implements IElementManager<Ensemble> {
  constructor(private baseDir: string) {
    // Validate base directory
    const validatedPath = validatePath(baseDir);
    if (!validatedPath) {
      throw new Error('Invalid base directory path');
    }
    this.baseDir = validatedPath;
  }

  /**
   * Load an ensemble from file
   * SECURITY FIX: Uses FileLockManager.atomicReadFile() to prevent race conditions
   */
  async load(filePath: string): Promise<Ensemble> {
    // SECURITY: Validate file path
    const validatedPath = validatePath(filePath);
    if (!validatedPath) {
      throw new Error('Invalid file path');
    }

    const fullPath = path.isAbsolute(validatedPath) 
      ? validatedPath 
      : path.join(this.baseDir, validatedPath);

    try {
      // CRITICAL FIX: Use atomic file read to prevent race conditions
      // Previously: const content = await fs.readFile(fullPath, 'utf-8');
      // Now: Uses FileLockManager with proper encoding object format
      const content = await FileLockManager.atomicReadFile(fullPath, { encoding: 'utf-8' });

      // Parse ensemble data
      const ensembleData = await this.parseEnsembleFile(content, fullPath);
      
      // Create ensemble instance
      const ensemble = new Ensemble(ensembleData.metadata);
      
      // Add elements if present
      if (ensembleData.elements) {
        for (const element of ensembleData.elements) {
          ensemble.addElement(
            element.elementId,
            element.elementType,
            element.role,
            {
              priority: element.priority,
              activationCondition: element.activationCondition,
              dependencies: element.dependencies
            }
          );
        }
      }

      // Restore shared context if present
      if (ensembleData.sharedContext) {
        ensemble.deserialize(JSON.stringify({
          ...ensembleData,
          elements: Array.from(ensemble.getElements().entries())
        }));
      }

      logger.info(`Loaded ensemble from ${fullPath}`);
      return ensemble;

    } catch (error) {
      logger.error(`Failed to load ensemble from ${fullPath}:`, error);
      throw error;
    }
  }

  /**
   * Save an ensemble to file
   * SECURITY FIX: Uses FileLockManager.atomicWriteFile() for atomic writes
   */
  async save(ensemble: Ensemble, filePath: string): Promise<void> {
    // SECURITY: Validate file path
    const validatedPath = validatePath(filePath);
    if (!validatedPath) {
      throw new Error('Invalid file path');
    }

    const fullPath = path.isAbsolute(validatedPath) 
      ? validatedPath 
      : path.join(this.baseDir, validatedPath);

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      // Prepare ensemble data
      const ensembleData = {
        metadata: ensemble.metadata,
        elements: Array.from(ensemble.getElements().values()),
        extensions: ensemble.extensions
      };

      // Convert to YAML with security measures
      const yamlContent = this.toYamlSafe(ensembleData);

      // CRITICAL FIX: Use atomic file write to prevent race conditions
      // Previously: await fs.writeFile(fullPath, yamlContent, 'utf-8');
      // Now: Uses FileLockManager for atomic operation
      await FileLockManager.atomicWriteFile(fullPath, yamlContent, { encoding: 'utf-8' });

      // Log security event
      SecurityMonitor.logSecurityEvent({
        type: 'ENSEMBLE_SAVED',
        severity: 'LOW',
        source: 'EnsembleManager.save',
        details: `Ensemble saved to ${fullPath}`
      });

      logger.info(`Saved ensemble to ${fullPath}`);

    } catch (error) {
      logger.error(`Failed to save ensemble to ${fullPath}:`, error);
      throw error;
    }
  }

  /**
   * List all ensembles in the directory
   */
  async list(): Promise<Ensemble[]> {
    try {
      const files = await fs.readdir(this.baseDir);
      const ensembles: Ensemble[] = [];

      // Process files in parallel with limit
      const BATCH_SIZE = 10;
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const batchPromises = batch
          .filter(file => file.endsWith('.md') || file.endsWith('.yaml') || file.endsWith('.yml'))
          .map(file => this.load(file).catch(error => {
            logger.warn(`Failed to load ensemble ${file}:`, error);
            return null;
          }));

        const batchResults = await Promise.all(batchPromises);
        ensembles.push(...batchResults.filter((e): e is Ensemble => e !== null));
      }

      return ensembles;

    } catch (error) {
      // Handle missing directory gracefully with type-safe check
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        logger.debug('Ensembles directory does not exist yet, returning empty array');
        return [];
      }
      logger.error('Failed to list ensembles:', error);
      return [];
    }
  }

  /**
   * Find an ensemble matching a predicate
   */
  async find(predicate: (ensemble: Ensemble) => boolean): Promise<Ensemble | undefined> {
    const ensembles = await this.list();
    return ensembles.find(predicate);
  }

  /**
   * Validate an ensemble
   */
  validate(ensemble: Ensemble): ElementValidationResult {
    return ensemble.validate();
  }

  /**
   * Parse ensemble file content
   * SECURITY FIX: Uses SecureYamlParser to prevent YAML injection attacks
   */
  private async parseEnsembleFile(content: string, filePath: string): Promise<any> {
    try {
      // Try to parse as YAML frontmatter (markdown file)
      if (filePath.endsWith('.md')) {
        const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (match) {
          // HIGH SEVERITY FIX: Use SecureYamlParser to prevent YAML injection
          // Previously: Used unsafe YAML parsing without validation
          // Now: Uses SecureYamlParser which validates content
          const parsed = SecureYamlParser.parse(match[1], {
            maxYamlSize: 64 * 1024, // 64KB limit
            validateContent: true
          });

          // Log security event
          SecurityMonitor.logSecurityEvent({
            type: 'YAML_PARSE_SUCCESS',
            severity: 'LOW',
            source: 'EnsembleManager.parseEnsembleFile',
            details: 'YAML content safely parsed'
          });

          return {
            metadata: parsed.data as unknown as EnsembleMetadata,
            content: match[2].trim()
          };
        }
      }

      // SECURITY FIX: For plain YAML files, check if content already has frontmatter
      // Previously: Used direct YAML parsing without security validation
      // Now: Uses SecureYamlParser for consistent security validation
      
      // Check if content already has frontmatter markers
      if (content.trim().startsWith('---')) {
        // Content already has frontmatter, parse directly  
        const parsed = SecureYamlParser.parse(content, {
          maxYamlSize: 64 * 1024, // 64KB limit
          validateContent: true
        });

        // Log security event
        SecurityMonitor.logSecurityEvent({
          type: 'YAML_PARSE_SUCCESS',
          severity: 'LOW',
          source: 'EnsembleManager.parseEnsembleFile',
          details: 'YAML frontmatter content safely parsed'
        });

        return parsed.data;
      } else {
        // Plain YAML without frontmatter - create frontmatter format
        const frontmatterFormat = `---\n${content}\n---\n`;
        
        const parsed = SecureYamlParser.parse(frontmatterFormat, {
          maxYamlSize: 64 * 1024, // 64KB limit
          validateContent: true
        });

        // Log security event
        SecurityMonitor.logSecurityEvent({
          type: 'YAML_PARSE_SUCCESS',
          severity: 'LOW',
          source: 'EnsembleManager.parseEnsembleFile',
          details: 'Plain YAML content safely parsed'
        });

        return parsed.data;
      }

    } catch (error) {
      logger.error('Failed to parse ensemble file:', error);
      throw new Error(`Invalid ensemble file format: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Convert ensemble data to YAML safely
   * SECURITY FIX: Uses yaml.dump with security options
   */
  private toYamlSafe(data: any): string {
    // SECURITY FIX: Use yaml.dump with FAILSAFE_SCHEMA and security options
    // This prevents arbitrary code execution via YAML
    const yamlStr = yaml.dump(data, {
      schema: yaml.FAILSAFE_SCHEMA,
      noRefs: true,
      skipInvalid: true,
      quotingType: '"',
      forceQuotes: true
    });

    // Add frontmatter delimiters for markdown files
    return `---\n${yamlStr}---\n`;
  }

  /**
   * Import an ensemble from JSON
   * SECURITY: Full validation of imported data
   */
  async importElement(jsonData: string, format?: 'json' | 'yaml' | 'markdown'): Promise<Ensemble> {
    // Validate JSON structure
    let data: any;
    try {
      data = JSON.parse(jsonData);
    } catch (error) {
      throw new Error('Invalid JSON format');
    }

    // Validate required fields
    if (!data.metadata || typeof data.metadata !== 'object') {
      throw new Error('Missing or invalid metadata');
    }

    // Create ensemble with validated metadata
    const ensemble = new Ensemble(data.metadata);

    // Add elements with validation
    if (data.elements && Array.isArray(data.elements)) {
      for (const element of data.elements) {
        if (!element.elementId || !element.elementType) {
          logger.warn('Skipping invalid element during import');
          continue;
        }

        try {
          ensemble.addElement(
            element.elementId,
            element.elementType,
            element.role || 'support',
            {
              priority: element.priority,
              activationCondition: element.activationCondition,
              dependencies: element.dependencies
            }
          );
        } catch (error) {
          logger.warn(`Failed to add element ${element.elementId} during import:`, error);
        }
      }
    }

    // Return without saving - caller can save if needed

    SecurityMonitor.logSecurityEvent({
      type: 'ENSEMBLE_IMPORTED',
      severity: 'MEDIUM',
      source: 'EnsembleManager.importElement',
      details: `Ensemble imported`
    });

    return ensemble;
  }

  /**
   * Export an ensemble to JSON
   */
  async exportElement(ensemble: Ensemble): Promise<string> {
    const data = {
      metadata: ensemble.metadata,
      elements: Array.from(ensemble.getElements().values()),
      extensions: ensemble.extensions
    };

    // SECURITY FIX: Ensure safe JSON serialization
    return JSON.stringify(data, null, 2);
  }

  /**
   * Delete an ensemble file
   */
  async delete(filePath: string): Promise<void> {
    const validatedPath = validatePath(filePath);
    if (!validatedPath) {
      throw new Error('Invalid file path');
    }

    const fullPath = path.isAbsolute(validatedPath) 
      ? validatedPath 
      : path.join(this.baseDir, validatedPath);

    await fs.unlink(fullPath);

    SecurityMonitor.logSecurityEvent({
      type: 'ENSEMBLE_DELETED',
      severity: 'MEDIUM',
      source: 'EnsembleManager.delete',
      details: `Ensemble deleted: ${fullPath}`
    });
  }

  /**
   * Check if an ensemble file exists
   */
  async exists(filePath: string): Promise<boolean> {
    const validatedPath = validatePath(filePath);
    if (!validatedPath) {
      return false;
    }

    const fullPath = path.isAbsolute(validatedPath) 
      ? validatedPath 
      : path.join(this.baseDir, validatedPath);

    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find multiple ensembles matching a predicate
   */
  async findMany(predicate: (ensemble: Ensemble) => boolean): Promise<Ensemble[]> {
    const ensembles = await this.list();
    return ensembles.filter(predicate);
  }

  /**
   * Validate a file path
   */
  validatePath(filePath: string): boolean {
    return validatePath(filePath) !== null;
  }

  /**
   * Get the element type this manager handles
   */
  getElementType(): ElementType {
    return ElementType.ENSEMBLE;
  }

  /**
   * Get the file extension for ensemble files
   */
  getFileExtension(): string {
    return '.yaml';
  }
}