/**
 * Portfolio Manager - Manages the portfolio directory structure for all element types
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { ElementType, PortfolioConfig } from './types.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

export { ElementType };
export type { PortfolioConfig };

export class PortfolioManager {
  private static instance: PortfolioManager;
  private static instanceLock = false;
  private baseDir: string;
  
  private constructor(config?: PortfolioConfig) {
    // Get potential directory from environment or config
    const envDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
    const configDir = config?.baseDir;
    const defaultDir = path.join(homedir(), '.dollhouse', 'portfolio');
    
    // Validate environment variable if provided
    if (envDir) {
      if (!path.isAbsolute(envDir)) {
        throw new Error('DOLLHOUSE_PORTFOLIO_DIR must be an absolute path');
      }
      // Additional validation for suspicious paths
      if (envDir.includes('..') || envDir.startsWith('/etc') || envDir.startsWith('/sys')) {
        throw new Error('DOLLHOUSE_PORTFOLIO_DIR contains suspicious path segments');
      }
    }
    
    // Validate config directory if provided
    if (configDir && !path.isAbsolute(configDir)) {
      throw new Error('Portfolio config baseDir must be an absolute path');
    }
    
    // Use environment variable if set, otherwise config, otherwise default
    this.baseDir = envDir || configDir || defaultDir;
    
    logger.info(`[PortfolioManager] Portfolio base directory: ${this.baseDir}`);
  }
  
  public static getInstance(config?: PortfolioConfig): PortfolioManager {
    if (!PortfolioManager.instance) {
      // Check if another thread is already creating the instance
      if (PortfolioManager.instanceLock) {
        throw new Error('PortfolioManager instance is being created by another thread');
      }
      
      try {
        PortfolioManager.instanceLock = true;
        PortfolioManager.instance = new PortfolioManager(config);
      } finally {
        PortfolioManager.instanceLock = false;
      }
    }
    return PortfolioManager.instance;
  }
  
  /**
   * Get the base portfolio directory
   */
  public getBaseDir(): string {
    return this.baseDir;
  }
  
  /**
   * Get the directory for a specific element type
   */
  public getElementDir(type: ElementType): string {
    return path.join(this.baseDir, type);
  }
  
  /**
   * Initialize the portfolio directory structure
   */
  public async initialize(): Promise<void> {
    logger.info('[PortfolioManager] Initializing portfolio directory structure');
    
    // Create base directory
    await fs.mkdir(this.baseDir, { recursive: true });
    
    // Create subdirectories for each element type
    for (const elementType of Object.values(ElementType)) {
      const elementDir = path.join(this.baseDir, elementType);
      await fs.mkdir(elementDir, { recursive: true });
      logger.debug(`[PortfolioManager] Created directory: ${elementDir}`);
    }
    
    // Create special directories for stateful elements
    const agentStateDir = path.join(this.baseDir, ElementType.AGENT, '.state');
    await fs.mkdir(agentStateDir, { recursive: true });
    
    logger.info('[PortfolioManager] Portfolio directory structure initialized');
  }
  
  /**
   * Check if portfolio directory exists
   */
  public async exists(): Promise<boolean> {
    try {
      await fs.access(this.baseDir);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * List all elements of a specific type
   */
  public async listElements(type: ElementType): Promise<string[]> {
    const elementDir = this.getElementDir(type);
    
    try {
      const files = await fs.readdir(elementDir);
      // Filter for .md files only
      return files.filter(file => file.endsWith('.md'));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      
      if (err.code === 'ENOENT') {
        // Directory doesn't exist yet - this is expected for new installations
        logger.debug(`[PortfolioManager] Element directory doesn't exist yet: ${elementDir}`);
        return [];
      }
      
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        // Permission denied - log but return empty array
        logger.error(`[PortfolioManager] Permission denied accessing directory: ${elementDir}`, {
          code: err.code,
          message: err.message
        });
        return [];
      }
      
      if (err.code === 'ENOTDIR') {
        // Path exists but is not a directory
        logger.error(`[PortfolioManager] Path is not a directory: ${elementDir}`, {
          code: err.code,
          message: err.message
        });
        throw new Error(`Path is not a directory: ${elementDir}`);
      }
      
      // For any other errors, throw with context
      logger.error(`[PortfolioManager] Error reading directory: ${elementDir}`, {
        code: err.code,
        message: err.message,
        stack: err.stack
      });
      throw error;
    }
  }
  
  /**
   * Get full path to an element file
   */
  public getElementPath(type: ElementType, filename: string): string {
    // Validate filename to prevent path traversal
    if (!filename || typeof filename !== 'string') {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'MEDIUM',
        source: 'PortfolioManager.getElementPath',
        details: `Invalid filename provided: ${typeof filename}`,
        additionalData: { elementType: type, filename: String(filename) }
      });
      throw new Error('Invalid filename: must be a non-empty string');
    }
    
    // Check for path traversal attempts
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\') || path.isAbsolute(filename)) {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'HIGH',
        source: 'PortfolioManager.getElementPath',
        details: `Path traversal attempt detected in filename: ${filename}`,
        additionalData: { elementType: type, filename }
      });
      throw new Error(`Invalid filename: contains path traversal characters: ${filename}`);
    }
    
    // Additional validation for hidden files and special characters
    if (filename.startsWith('.') || filename.includes('\0')) {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'MEDIUM',
        source: 'PortfolioManager.getElementPath',
        details: `Invalid filename characters detected: ${filename}`,
        additionalData: { elementType: type, filename, hasHiddenFile: filename.startsWith('.'), hasNullByte: filename.includes('\0') }
      });
      throw new Error(`Invalid filename: contains invalid characters: ${filename}`);
    }
    
    // Ensure filename ends with .md
    const safeFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
    return path.join(this.getElementDir(type), safeFilename);
  }
  
  /**
   * Check if an element exists
   */
  public async elementExists(type: ElementType, filename: string): Promise<boolean> {
    try {
      await fs.access(this.getElementPath(type, filename));
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Get legacy personas directory path (for migration)
   */
  public getLegacyPersonasDir(): string {
    return path.join(homedir(), '.dollhouse', 'personas');
  }
  
  /**
   * Check if legacy personas directory exists
   */
  public async hasLegacyPersonas(): Promise<boolean> {
    try {
      await fs.access(this.getLegacyPersonasDir());
      const files = await fs.readdir(this.getLegacyPersonasDir());
      return files.some(file => file.endsWith('.md'));
    } catch {
      return false;
    }
  }
  
  /**
   * Get portfolio statistics
   */
  public async getStatistics(): Promise<Record<ElementType, number>> {
    const stats: Record<string, number> = {};
    
    for (const elementType of Object.values(ElementType)) {
      const elements = await this.listElements(elementType);
      stats[elementType] = elements.length;
    }
    
    return stats as Record<ElementType, number>;
  }
}