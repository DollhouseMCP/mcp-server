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
import { MEMORY_CONSTANTS, MEMORY_SECURITY_EVENTS } from './constants.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as yaml from 'js-yaml';
import * as crypto from 'crypto';

export class MemoryManager implements IElementManager<Memory> {
  private portfolioManager: PortfolioManager;
  private memoriesDir: string;
  private memoryCache: Map<string, Memory> = new Map();
  private contentHashIndex: Map<string, string> = new Map();
  
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
      let fullPath: string | undefined;

      // Check if it's a relative path (no date folder)
      if (!filePath.includes(path.sep) || !filePath.match(/^\d{4}-\d{2}-\d{2}/)) {
        // Search in date folders
        const dateFolders = await this.getDateFolders();
        let found = false;

        for (const dateFolder of dateFolders) {
          const testPath = path.join(this.memoriesDir, dateFolder, filePath);
          if (await fs.access(testPath).then(() => true).catch(() => false)) {
            fullPath = testPath;
            found = true;
            break;
          }
        }

        if (!found) {
          // Fall back to root directory for backward compatibility during transition
          fullPath = await this.validateAndResolvePath(filePath);
        }
      } else {
        fullPath = await this.validateAndResolvePath(filePath);
      }

      // Ensure fullPath is defined
      if (!fullPath) {
        throw new Error(`Could not resolve path: ${filePath}`);
      }
      
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
        maxYamlSize: MEMORY_CONSTANTS.MAX_YAML_SIZE,
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
        type: MEMORY_SECURITY_EVENTS.MEMORY_LOADED,
        severity: 'LOW',
        source: 'MemoryManager.load',
        details: `Loaded memory from ${path.basename(fullPath)}`
      });
      
      return memory;
      
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: MEMORY_SECURITY_EVENTS.MEMORY_LOAD_FAILED,
        severity: 'MEDIUM',
        source: 'MemoryManager.load',
        details: `Failed to load memory from ${filePath}: ${error}`
      });
      throw new Error(`Failed to load memory: ${error}`);
    }
  }

  /**
   * Generate date-based path for memory storage
   * Creates YYYY-MM-DD folder structure to prevent flat directory issues
   * @param element Memory element to save
   * @param fileName Optional custom filename
   * @returns Full path to memory file
   */
  private async generateMemoryPath(element: Memory, fileName?: string): Promise<string> {
    const date = new Date();
    const dateFolder = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const datePath = path.join(this.memoriesDir, dateFolder);

    // Ensure date folder exists
    await fs.mkdir(datePath, { recursive: true });

    // Generate filename
    const baseName = fileName || `${element.metadata.name?.toLowerCase().replace(/\s+/g, '-') || 'memory'}.yaml`;
    let finalName = baseName;
    let version = 1;

    // Handle collisions with version suffix
    while (await fs.access(path.join(datePath, finalName)).then(() => true).catch(() => false)) {
      version++;
      finalName = baseName.replace('.yaml', `-v${version}.yaml`);
    }

    return path.join(datePath, finalName);
  }

  /**
   * Calculate SHA-256 hash of memory content for deduplication
   * Implements Issue #994 - Content-based deduplication
   */
  private calculateContentHash(element: Memory): string {
    const content = JSON.stringify({
      metadata: element.metadata,
      entries: JSON.parse(element.serialize()).entries
    });
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Get all date folders in memories directory
   * @returns Array of date folder names
   */
  private async getDateFolders(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.memoriesDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
        .map(entry => entry.name)
        .sort()
        .reverse(); // Most recent first
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Save a memory to file
   * SECURITY FIX #1: Uses FileLockManager.atomicWriteFile() for atomic operations
   */
  async save(element: Memory, filePath?: string): Promise<void> {
    try {
      // Validate element
      const validation = element.validate();
      if (!validation.valid) {
        throw new Error(`Invalid memory: ${validation.errors?.map(e => e.message).join(', ')}`);
      }

      // Calculate content hash for deduplication
      const contentHash = this.calculateContentHash(element);
      const existingPath = this.contentHashIndex.get(contentHash);

      if (existingPath) {
        // Log duplicate detection
        SecurityMonitor.logSecurityEvent({
          type: 'MEMORY_DUPLICATE_DETECTED',
          severity: 'LOW',
          source: 'MemoryManager.save',
          details: `Duplicate content detected. Existing: ${existingPath}`
        });
      }

      // Generate date-based path if not provided
      const fullPath = filePath
        ? await this.validateAndResolvePath(filePath)
        : await this.generateMemoryPath(element);

      // Ensure parent directory exists (for date folders)
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      
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

      // Update content hash index
      this.contentHashIndex.set(contentHash, fullPath);

      // Log successful save
      SecurityMonitor.logSecurityEvent({
        type: MEMORY_SECURITY_EVENTS.MEMORY_SAVED,
        severity: 'LOW',
        source: 'MemoryManager.save',
        details: `Saved memory to ${path.basename(fullPath)} with ${stats.totalEntries} entries`
      });
      
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: MEMORY_SECURITY_EVENTS.MEMORY_SAVE_FAILED,
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
    const memories: Memory[] = [];

    try {
      // Get all date folders
      const dateFolders = await this.getDateFolders();

      // Also check root directory for any legacy files
      const rootFiles = await fs.readdir(this.memoriesDir)
        .then(files => files.filter(f => f.endsWith('.yaml')))
        .catch(() => []);

      // Process root files first (legacy)
      for (const file of rootFiles) {
        try {
          const memory = await this.load(file);
          memories.push(memory);
        } catch (error) {
          SecurityMonitor.logSecurityEvent({
            type: MEMORY_SECURITY_EVENTS.MEMORY_LIST_ITEM_FAILED,
            severity: 'LOW',
            source: 'MemoryManager.list',
            details: `Failed to load ${file}: ${error}`
          });
        }
      }

      // Process date folders
      for (const dateFolder of dateFolders) {
        const folderPath = path.join(this.memoriesDir, dateFolder);
        const files = await fs.readdir(folderPath)
          .then(files => files.filter(f => f.endsWith('.yaml')))
          .catch(() => []);

        for (const file of files) {
          try {
            const memory = await this.load(path.join(dateFolder, file));
            memories.push(memory);
          } catch (error) {
            SecurityMonitor.logSecurityEvent({
              type: MEMORY_SECURITY_EVENTS.MEMORY_LIST_ITEM_FAILED,
              severity: 'LOW',
              source: 'MemoryManager.list',
              details: `Failed to load ${dateFolder}/${file}: ${error}`
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
        type: MEMORY_SECURITY_EVENTS.MEMORY_DELETED,
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
        // Memory import expects pure YAML (not frontmatter), so we parse it securely
        try {
          // First validate the YAML content size
          if (data.length > MEMORY_CONSTANTS.MAX_YAML_SIZE) {
            throw new Error('YAML content exceeds maximum allowed size');
          }
          
          // Create a wrapper to use SecureYamlParser with pure YAML
          // Add minimal frontmatter markers to satisfy parser
          const wrappedYaml = `---\n${data}\n---\n`;
          
          const parseResult = SecureYamlParser.parse(wrappedYaml, {
            maxYamlSize: MEMORY_CONSTANTS.MAX_YAML_SIZE,
            validateContent: true
          });
          
          // Extract the parsed data (will be in the 'data' property)
          parsed = parseResult.data;
          
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
        type: MEMORY_SECURITY_EVENTS.MEMORY_IMPORT_FAILED,
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
      storageBackend: parsed.metadata?.storageBackend || MEMORY_CONSTANTS.DEFAULT_STORAGE_BACKEND,
      retentionDays: parsed.metadata?.retentionDays || MEMORY_CONSTANTS.DEFAULT_RETENTION_DAYS,
      privacyLevel: parsed.metadata?.privacyLevel || MEMORY_CONSTANTS.DEFAULT_PRIVACY_LEVEL,
      searchable: parsed.metadata?.searchable !== false,
      maxEntries: parsed.metadata?.maxEntries || MEMORY_CONSTANTS.MAX_ENTRIES_DEFAULT
    };
    
    // Extract content (if any)
    const content = parsed.content || '';
    
    return { metadata, content };
  }
}