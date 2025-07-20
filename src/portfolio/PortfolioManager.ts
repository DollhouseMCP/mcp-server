/**
 * Portfolio Manager - Manages the portfolio directory structure for all element types
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

export enum ElementType {
  PERSONA = 'personas',
  SKILL = 'skills',
  TEMPLATE = 'templates',
  ENSEMBLE = 'ensembles',
  AGENT = 'agents',
  MEMORY = 'memories'
}

export interface PortfolioConfig {
  baseDir?: string;  // Override default location
  createIfMissing?: boolean;
  migrateExisting?: boolean;
}

export class PortfolioManager {
  private static instance: PortfolioManager;
  private baseDir: string;
  
  private constructor(config?: PortfolioConfig) {
    // Use environment variable if set, otherwise config, otherwise default
    this.baseDir = process.env.DOLLHOUSE_PORTFOLIO_DIR || 
                   config?.baseDir || 
                   path.join(homedir(), '.dollhouse', 'portfolio');
    
    logger.info(`[PortfolioManager] Portfolio base directory: ${this.baseDir}`);
  }
  
  public static getInstance(config?: PortfolioConfig): PortfolioManager {
    if (!PortfolioManager.instance) {
      PortfolioManager.instance = new PortfolioManager(config);
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
    
    const memoryStorageDir = path.join(this.baseDir, ElementType.MEMORY, '.storage');
    await fs.mkdir(memoryStorageDir, { recursive: true });
    
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Directory doesn't exist yet
        return [];
      }
      throw error;
    }
  }
  
  /**
   * Get full path to an element file
   */
  public getElementPath(type: ElementType, filename: string): string {
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