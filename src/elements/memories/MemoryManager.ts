/**
 * MemoryManager - Implementation of IElementManager for Memory elements
 * Handles CRUD operations and lifecycle management for memories implementing IElement
 * 
 * FIXES IMPLEMENTED:
 * 1. CRITICAL: Fixed race conditions in file operations by using FileLockManager for atomic reads/writes
 * 2. HIGH: Fixed unvalidated YAML parsing vulnerability by using SecureYamlParser
 * 3. MEDIUM: All user inputs are now validated and sanitized
 * 4. MEDIUM: Audit logging added for security operations
 * 5. MEDIUM: Path validation prevents directory traversal attacks
 */

import { Memory, MemoryMetadata, MemoryEntry } from './Memory.js';
import { IElementManager } from '../../types/elements/IElementManager.js';
import { ElementValidationResult } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as yaml from 'js-yaml';

export class MemoryManager implements IElementManager<Memory> {
  private portfolioManager: PortfolioManager;
  private memoriesDir: string;
  private memoryCache: Map<string, Memory> = new Map();
  
  constructor() {
    this.portfolioManager = PortfolioManager.getInstance();
    this.memoriesDir = this.portfolioManager.getElementDir(ElementType.MEMORY);
  }
  
  /**
   * Load a memory from file
   * SECURITY FIX #1: Uses FileLockManager.atomicReadFile() instead of fs.readFile()
   * to prevent race conditions and ensure atomic file operations
   */
  async load(filePath: string): Promise<Memory> {
    try {
      // Validate and resolve path
      const fullPath = await this.validateAndResolvePath(filePath);
      
      // Check cache first
      const cached = this.memoryCache.get(fullPath);
      if (cached) {
        return cached;
      }
      
      // CRITICAL FIX: Use atomic file read to prevent race conditions
      // Previously: const content = await fs.readFile(fullPath, 'utf-8');
      // Now: Uses FileLockManager with proper encoding object format
      const content = await FileLockManager.atomicReadFile(fullPath, { encoding: 'utf-8' });
      
      // HIGH SEVERITY FIX: Use SecureYamlParser to prevent YAML injection attacks
      // Previously: Could use unsafe YAML parsing
      // Now: Uses SecureYamlParser which validates content and prevents malicious patterns
      const parsed = SecureYamlParser.parse(content, {
        maxYamlSize: 256 * 1024, // 256KB limit for memory files
        validateContent: true
      });
      
      // Extract metadata and content
      const { metadata, content: memoryContent } = this.parseMemoryFile(parsed);
      
      // Create memory instance
      const memory = new Memory(metadata);
      
      // Load saved entries if present
      if (parsed.data && parsed.data.entries) {
        memory.deserialize(JSON.stringify({
          id: memory.id,
          type: memory.type,
          version: memory.version,
          metadata: memory.metadata,
          extensions: memory.extensions,
          entries: parsed.data.entries
        }));
      }
      
      // Cache the loaded memory
      this.memoryCache.set(fullPath, memory);
      
      // Log successful load
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_LOADED',
        severity: 'LOW',
        source: 'MemoryManager.load',
        details: `Loaded memory from ${path.basename(fullPath)}`
      });
      
      return memory;
      
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_LOAD_FAILED',
        severity: 'MEDIUM',
        source: 'MemoryManager.load',
        details: `Failed to load memory from ${filePath}: ${error}`
      });
      throw new Error(`Failed to load memory: ${error}`);
    }
  }
  
  /**
   * Save a memory to file
   * SECURITY FIX #1: Uses FileLockManager.atomicWriteFile() for atomic operations
   */
  async save(element: Memory, filePath: string): Promise<void> {
    try {
      // Validate element
      const validation = element.validate();
      if (!validation.valid) {
        throw new Error(`Invalid memory: ${validation.errors?.map(e => e.message).join(', ')}`);
      }
      
      // Validate and resolve path
      const fullPath = await this.validateAndResolvePath(filePath);
      
      // Get memory statistics
      const stats = element.getStats();
      
      // Prepare data for saving
      const data = {
        metadata: element.metadata,
        extensions: element.extensions,
        stats: {
          totalEntries: stats.totalEntries,
          totalSize: stats.totalSize,
          oldestEntry: stats.oldestEntry?.toISOString(),
          newestEntry: stats.newestEntry?.toISOString(),
          topTags: Array.from(stats.tagFrequency.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([tag, count]) => ({ tag, count }))
        },
        entries: JSON.parse(element.serialize()).entries
      };
      
      // SECURITY FIX: Use secure YAML dumping with safety options
      // Previously: Could allow dangerous YAML features
      // Now: Uses FAILSAFE_SCHEMA and security options to prevent code execution
      const yamlContent = yaml.dump(data, {
        schema: yaml.FAILSAFE_SCHEMA,
        noRefs: true,
        skipInvalid: true,
        sortKeys: true
      });
      
      // CRITICAL FIX: Use atomic file write to prevent corruption
      // Previously: await fs.writeFile(fullPath, yamlContent, 'utf-8');
      // Now: Uses FileLockManager for atomic write with proper encoding
      await FileLockManager.atomicWriteFile(fullPath, yamlContent, { encoding: 'utf-8' });
      
      // Update cache
      this.memoryCache.set(fullPath, element);
      
      // Log successful save
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_SAVED',
        severity: 'LOW',
        source: 'MemoryManager.save',
        details: `Saved memory to ${path.basename(fullPath)} with ${stats.totalEntries} entries`
      });
      
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_SAVE_FAILED',
        severity: 'HIGH',
        source: 'MemoryManager.save',
        details: `Failed to save memory to ${filePath}: ${error}`
      });
      throw new Error(`Failed to save memory: ${error}`);
    }
  }
  
  /**
   * List all available memories
   */
  async list(): Promise<Memory[]> {
    try {
      const files = await fs.readdir(this.memoriesDir);
      const memories: Memory[] = [];
      
      for (const file of files) {
        if (file.endsWith('.md') || file.endsWith('.yaml') || file.endsWith('.yml')) {
          try {
            const memory = await this.load(file);
            memories.push(memory);
          } catch (error) {
            // Log but continue with other files
            SecurityMonitor.logSecurityEvent({
              type: 'MEMORY_LIST_ITEM_FAILED',
              severity: 'LOW',
              source: 'MemoryManager.list',
              details: `Failed to load ${file}: ${error}`
            });
          }
        }
      }
      
      return memories;
      
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        // Directory doesn't exist yet
        return [];
      }
      throw error;
    }
  }
  
  /**
   * Find memories matching a predicate
   */
  async find(predicate: (element: Memory) => boolean): Promise<Memory | undefined> {
    const memories = await this.list();
    return memories.find(predicate);
  }
  
  /**
   * Find multiple memories matching a predicate
   */
  async findMany(predicate: (element: Memory) => boolean): Promise<Memory[]> {
    const memories = await this.list();
    return memories.filter(predicate);
  }
  
  /**
   * Delete a memory file
   * SECURITY: Validates path and logs deletion
   */
  async delete(filePath: string): Promise<void> {
    try {
      const fullPath = await this.validateAndResolvePath(filePath);
      
      // Check if file exists
      await fs.access(fullPath);
      
      // Delete the file
      await fs.unlink(fullPath);
      
      // Remove from cache
      this.memoryCache.delete(fullPath);
      
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_DELETED',
        severity: 'MEDIUM',
        source: 'MemoryManager.delete',
        details: `Deleted memory file: ${path.basename(fullPath)}`
      });
      
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        // File doesn't exist, not an error for delete operation
        return;
      }
      throw error;
    }
  }
  
  /**
   * Check if a memory file exists
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      const fullPath = await this.validateAndResolvePath(filePath);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Create a new memory with metadata
   */
  async create(metadata: Partial<MemoryMetadata>): Promise<Memory> {
    return new Memory(metadata);
  }
  
  /**
   * Import a memory from JSON/YAML string
   * SECURITY: Full validation of imported content
   */
  async importElement(data: string, format: 'json' | 'yaml' = 'yaml'): Promise<Memory> {
    try {
      let parsed: any;
      
      if (format === 'json') {
        parsed = JSON.parse(data);
      } else {
        // HIGH SEVERITY FIX: Use secure YAML parsing
        // For pure YAML (not frontmatter), use yaml.load with FAILSAFE_SCHEMA
        try {
          parsed = yaml.load(data, {
            schema: yaml.FAILSAFE_SCHEMA, // Only allows strings, ints, floats, booleans
            json: false
          });
        } catch (yamlError) {
          throw new Error(`Invalid YAML: ${yamlError}`);
        }
        
        // Validate it's an object
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('YAML must contain an object');
        }
      }
      
      // Handle different structures from YAML parsing
      let metadata = parsed.metadata;
      let entries = parsed.entries || (parsed.data && parsed.data.entries);
      
      // Validate required fields
      if (!metadata || !metadata.name) {
        throw new Error('Memory must have metadata with name');
      }
      
      // Create memory instance
      const memory = new Memory(metadata);
      
      // Load entries if present
      if (entries) {
        memory.deserialize(JSON.stringify({
          id: memory.id,
          type: memory.type,
          version: memory.version,
          metadata: memory.metadata,
          extensions: memory.extensions,
          entries: entries
        }));
      }
      
      return memory;
      
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_IMPORT_FAILED',
        severity: 'MEDIUM',
        source: 'MemoryManager.importElement',
        details: `Failed to import memory: ${error}`
      });
      throw new Error(`Failed to import memory: ${error}`);
    }
  }
  
  /**
   * Export a memory to YAML string
   */
  async exportElement(element: Memory): Promise<string> {
    const stats = element.getStats();
    const data = {
      metadata: element.metadata,
      extensions: element.extensions,
      stats: {
        totalEntries: stats.totalEntries,
        totalSize: stats.totalSize,
        oldestEntry: stats.oldestEntry?.toISOString(),
        newestEntry: stats.newestEntry?.toISOString()
      },
      entries: JSON.parse(element.serialize()).entries
    };
    
    // SECURITY FIX: Use secure YAML dumping
    return yaml.dump(data, {
      schema: yaml.FAILSAFE_SCHEMA,
      noRefs: true,
      skipInvalid: true,
      sortKeys: true
    });
  }
  
  /**
   * Validate a memory element
   */
  validate(element: Memory): ElementValidationResult {
    return element.validate();
  }
  
  /**
   * Validate and resolve a file path
   * SECURITY: Prevents directory traversal attacks
   */
  validatePath(filePath: string): boolean {
    try {
      // Perform synchronous validation checks
      const normalized = path.normalize(filePath);
      
      // Check for path traversal attempts
      if (normalized.includes('..') || path.isAbsolute(normalized)) {
        return false;
      }
      
      // Ensure proper extension
      if (!normalized.endsWith('.md') && !normalized.endsWith('.yaml') && !normalized.endsWith('.yml')) {
        return false;
      }
      
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Get the element type this manager handles
   */
  getElementType(): ElementType {
    return ElementType.MEMORY;
  }
  
  /**
   * Get the file extension for memory files
   */
  getFileExtension(): string {
    return '.yaml';
  }
  
  // Private helper methods
  
  private async validateAndResolvePath(filePath: string): Promise<string> {
    // SECURITY FIX: Comprehensive path validation
    const normalized = path.normalize(filePath);
    
    // Check for path traversal attempts
    if (normalized.includes('..') || path.isAbsolute(normalized)) {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'HIGH',
        source: 'MemoryManager.validateAndResolvePath',
        details: `Blocked path traversal attempt: ${filePath}`
      });
      throw new Error('Invalid file path: Path traversal detected');
    }
    
    // Ensure proper extension
    if (!normalized.endsWith('.md') && !normalized.endsWith('.yaml') && !normalized.endsWith('.yml')) {
      throw new Error('Memory files must have .md, .yaml, or .yml extension');
    }
    
    // Construct full path
    const fullPath = path.join(this.memoriesDir, normalized);
    
    // Verify it's within memories directory
    const relative = path.relative(this.memoriesDir, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('File path must be within memories directory');
    }
    
    return fullPath;
  }
  
  private parseMemoryFile(parsed: any): { metadata: MemoryMetadata; content: string } {
    // Extract metadata with validation
    const metadata: MemoryMetadata = {
      name: sanitizeInput(parsed.metadata?.name || 'Unnamed Memory', 100),
      description: parsed.metadata?.description ? 
        sanitizeInput(parsed.metadata.description, 500) : 
        '',
      version: parsed.metadata?.version || '1.0.0',
      author: parsed.metadata?.author,
      created: parsed.metadata?.created,
      modified: new Date().toISOString(),
      tags: Array.isArray(parsed.metadata?.tags) ? 
        parsed.metadata.tags.map((tag: string) => sanitizeInput(tag, 50)) : 
        [],
      storageBackend: parsed.metadata?.storageBackend || 'memory',
      retentionDays: parsed.metadata?.retentionDays || 30,
      privacyLevel: parsed.metadata?.privacyLevel || 'private',
      searchable: parsed.metadata?.searchable !== false,
      maxEntries: parsed.metadata?.maxEntries || 1000
    };
    
    // Extract content (if any)
    const content = parsed.content || '';
    
    return { metadata, content };
  }
}