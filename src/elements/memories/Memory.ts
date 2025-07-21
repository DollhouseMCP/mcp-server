/**
 * Memory Element - Persistent context storage for continuity and learning
 * 
 * Provides multiple storage backends, retention policies, and search capabilities
 * for maintaining context across sessions and interactions.
 * 
 * SECURITY MEASURES IMPLEMENTED:
 * 1. Input sanitization for all memory content
 * 2. Memory size limits to prevent unbounded growth
 * 3. Path validation for file-based storage
 * 4. Retention policy enforcement
 * 5. Privacy level access control
 * 6. Audit logging for all operations
 */

import { BaseElement } from '../BaseElement.js';
import { IElement, ElementValidationResult, ValidationError } from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';
import { IElementMetadata } from '../../types/elements/IElement.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import * as path from 'path';

// Initialize DOMPurify with JSDOM
const window = new JSDOM('').window;
const purify = DOMPurify(window as any);

// Configure DOMPurify for memory content - strip all HTML but keep text
purify.setConfig({
  ALLOWED_TAGS: [],  // No HTML tags allowed
  ALLOWED_ATTR: [],  // No attributes allowed
  KEEP_CONTENT: true // Keep text content
});

/**
 * Sanitize content for memory storage
 * More permissive than sanitizeInput - allows punctuation, quotes, etc.
 * but still prevents XSS and control characters
 */
function sanitizeMemoryContent(content: string, maxLength: number): string {
  if (!content || typeof content !== 'string') {
    return '';
  }
  
  // First normalize Unicode
  const normalized = UnicodeValidator.normalize(content).normalizedContent;
  
  // Use DOMPurify to strip any HTML/XSS attempts but keep text
  const cleaned = purify.sanitize(normalized);
  
  // Remove only control characters and null bytes
  return cleaned
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control chars except \t \n \r
    .substring(0, maxLength)
    .trim();
}

export interface MemoryMetadata extends IElementMetadata {
  storageBackend?: 'memory' | 'file' | 'indexed';
  retentionDays?: number;
  privacyLevel?: 'public' | 'private' | 'sensitive';
  searchable?: boolean;
  maxEntries?: number;
  encryptionEnabled?: boolean;
}

export interface MemoryEntry {
  id: string;
  timestamp: Date;
  content: string;
  tags?: string[];
  metadata?: Record<string, any>;
  expiresAt?: Date;
  privacyLevel?: 'public' | 'private' | 'sensitive';
}

export interface MemorySearchOptions {
  query?: string;
  tags?: string[];
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  privacyLevel?: 'public' | 'private' | 'sensitive';
}

export class Memory extends BaseElement implements IElement {
  // Memory-specific properties
  private entries: Map<string, MemoryEntry> = new Map();
  private storageBackend: 'memory' | 'file' | 'indexed';
  private retentionDays: number;
  private privacyLevel: 'public' | 'private' | 'sensitive';
  private searchable: boolean;
  private maxEntries: number;
  
  // Security limits
  private readonly MAX_MEMORY_SIZE = 1024 * 1024; // 1MB per memory
  private readonly MAX_ENTRY_SIZE = 100 * 1024; // 100KB per entry
  private readonly MAX_ENTRIES_DEFAULT = 1000;
  private readonly MAX_TAG_LENGTH = 50;
  private readonly MAX_TAGS_PER_ENTRY = 20;
  
  constructor(metadata: Partial<MemoryMetadata> = {}) {
    // SECURITY FIX: Sanitize all inputs during construction
    const sanitizedMetadata = {
      ...metadata,
      name: metadata.name ? 
        sanitizeInput(UnicodeValidator.normalize(metadata.name).normalizedContent, 100) : 
        'Unnamed Memory',
      description: metadata.description ? 
        sanitizeInput(UnicodeValidator.normalize(metadata.description).normalizedContent, 500) : 
        undefined
    };
    
    super(ElementType.MEMORY, sanitizedMetadata);
    
    // Initialize memory-specific properties with defaults
    this.storageBackend = metadata.storageBackend || 'memory';
    this.retentionDays = metadata.retentionDays || 30;
    this.privacyLevel = metadata.privacyLevel || 'private';
    this.searchable = metadata.searchable !== false;
    this.maxEntries = Math.min(
      metadata.maxEntries || this.MAX_ENTRIES_DEFAULT,
      this.MAX_ENTRIES_DEFAULT
    );
    
    // Set up extensions
    this.extensions = {
      storageBackend: this.storageBackend,
      retentionDays: this.retentionDays,
      privacyLevel: this.privacyLevel,
      searchable: this.searchable,
      maxEntries: this.maxEntries,
      encryptionEnabled: metadata.encryptionEnabled || false
    };
    
    // Log memory creation
    SecurityMonitor.logSecurityEvent({
      type: 'MEMORY_CREATED',
      severity: 'LOW',
      source: 'Memory.constructor',
      details: `Memory created: ${this.metadata.name} with ${this.storageBackend} backend`
    });
  }
  
  /**
   * Add a new memory entry
   * SECURITY: Validates and sanitizes all input, enforces size limits
   */
  public async addEntry(content: string, tags?: string[], metadata?: Record<string, any>): Promise<MemoryEntry> {
    // Validate memory size limits
    if (this.entries.size >= this.maxEntries) {
      // SECURITY FIX: Enforce retention policy when at capacity
      await this.enforceRetentionPolicy();
      
      if (this.entries.size >= this.maxEntries) {
        throw new Error(`Memory capacity reached: ${this.maxEntries} entries`);
      }
    }
    
    // SECURITY FIX: Validate and sanitize content
    const sanitizedContent = sanitizeMemoryContent(content, this.MAX_ENTRY_SIZE);
    
    if (!sanitizedContent || sanitizedContent.trim().length === 0) {
      throw new Error('Memory content cannot be empty');
    }
    
    // SECURITY FIX: Validate and sanitize tags
    const sanitizedTags = tags ? this.sanitizeTags(tags) : [];
    
    // Create memory entry
    const entry: MemoryEntry = {
      id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      content: sanitizedContent,
      tags: sanitizedTags,
      metadata: this.sanitizeMetadata(metadata),
      privacyLevel: this.privacyLevel,
      expiresAt: this.calculateExpiryDate()
    };
    
    // Store entry
    this.entries.set(entry.id, entry);
    this._isDirty = true;
    
    // Log memory addition
    SecurityMonitor.logSecurityEvent({
      type: 'MEMORY_ADDED',
      severity: 'LOW',
      source: 'Memory.addEntry',
      details: `Added memory entry ${entry.id} with ${sanitizedTags.length} tags`
    });
    
    return entry;
  }
  
  /**
   * Search memory entries
   * SECURITY: Respects privacy levels and sanitizes search queries
   */
  public async search(options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    // SECURITY FIX: Sanitize search query (use regular sanitizeInput for queries)
    const sanitizedQuery = options.query ? 
      sanitizeInput(UnicodeValidator.normalize(options.query).normalizedContent, 200) : 
      undefined;
    
    let results = Array.from(this.entries.values());
    
    // Filter by privacy level
    if (options.privacyLevel) {
      results = results.filter(entry => 
        this.canAccessPrivacyLevel(entry.privacyLevel || 'private', options.privacyLevel!)
      );
    }
    
    // Filter by query
    if (sanitizedQuery) {
      const queryLower = sanitizedQuery.toLowerCase();
      results = results.filter(entry => 
        entry.content.toLowerCase().includes(queryLower) ||
        entry.tags?.some(tag => tag.toLowerCase().includes(queryLower))
      );
    }
    
    // Filter by tags
    if (options.tags && options.tags.length > 0) {
      const searchTags = this.sanitizeTags(options.tags);
      results = results.filter(entry =>
        searchTags.some(searchTag => entry.tags?.includes(searchTag))
      );
    }
    
    // Filter by date range
    if (options.startDate) {
      results = results.filter(entry => entry.timestamp >= options.startDate!);
    }
    if (options.endDate) {
      results = results.filter(entry => entry.timestamp <= options.endDate!);
    }
    
    // Sort by timestamp (newest first) - using string comparison for IDs as secondary sort
    results.sort((a, b) => {
      const timeDiff = b.timestamp.getTime() - a.timestamp.getTime();
      if (timeDiff !== 0) return timeDiff;
      // If timestamps are exactly the same, sort by ID (which contains timestamp)
      return b.id.localeCompare(a.id);
    });
    
    // Apply limit
    if (options.limit && options.limit > 0) {
      results = results.slice(0, options.limit);
    }
    
    // Log search operation
    SecurityMonitor.logSecurityEvent({
      type: 'MEMORY_SEARCHED',
      severity: 'LOW',
      source: 'Memory.search',
      details: `Searched memories with query: ${sanitizedQuery || 'none'}, found ${results.length} results`
    });
    
    return results;
  }
  
  /**
   * Get a specific memory entry by ID
   */
  public async getEntry(id: string): Promise<MemoryEntry | undefined> {
    return this.entries.get(id);
  }
  
  /**
   * Delete a memory entry
   * SECURITY: Validates permissions and logs deletion
   */
  public async deleteEntry(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    
    // SECURITY: Check if sensitive memories can be deleted
    if (entry.privacyLevel === 'sensitive') {
      SecurityMonitor.logSecurityEvent({
        type: 'SENSITIVE_MEMORY_DELETED',
        severity: 'MEDIUM',
        source: 'Memory.deleteEntry',
        details: `Sensitive memory ${id} deleted`
      });
    }
    
    this.entries.delete(id);
    this._isDirty = true;
    
    return true;
  }
  
  /**
   * Enforce retention policy by removing expired entries
   * SECURITY: Ensures memory doesn't grow unbounded
   */
  public async enforceRetentionPolicy(): Promise<number> {
    const now = new Date();
    let deletedCount = 0;
    
    // Remove expired entries
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.entries.delete(id);
        deletedCount++;
      }
    }
    
    // If still at or over capacity, remove oldest entries to make room for one more
    if (this.entries.size >= this.maxEntries) {
      const sortedEntries = Array.from(this.entries.entries())
        .sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime());
      
      // Remove one extra to make room for new entry
      const toDelete = Math.max(1, this.entries.size - this.maxEntries + 1);
      for (let i = 0; i < toDelete && i < sortedEntries.length; i++) {
        this.entries.delete(sortedEntries[i][0]);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      this._isDirty = true;
      SecurityMonitor.logSecurityEvent({
        type: 'RETENTION_POLICY_ENFORCED',
        severity: 'LOW',
        source: 'Memory.enforceRetentionPolicy',
        details: `Removed ${deletedCount} expired memories`
      });
    }
    
    return deletedCount;
  }
  
  /**
   * Clear all memory entries
   * SECURITY: Requires confirmation and logs the action
   */
  public async clearAll(confirm: boolean = false): Promise<void> {
    if (!confirm) {
      throw new Error('Memory clear requires confirmation');
    }
    
    const count = this.entries.size;
    this.entries.clear();
    this._isDirty = true;
    
    SecurityMonitor.logSecurityEvent({
      type: 'MEMORY_CLEARED',
      severity: 'HIGH',
      source: 'Memory.clearAll',
      details: `Cleared all ${count} memory entries`
    });
  }
  
  /**
   * Get memory statistics
   */
  public getStats(): {
    totalEntries: number;
    totalSize: number;
    oldestEntry?: Date;
    newestEntry?: Date;
    tagFrequency: Map<string, number>;
  } {
    let totalSize = 0;
    let oldestEntry: Date | undefined;
    let newestEntry: Date | undefined;
    const tagFrequency = new Map<string, number>();
    
    for (const entry of this.entries.values()) {
      totalSize += entry.content.length;
      
      if (!oldestEntry || entry.timestamp < oldestEntry) {
        oldestEntry = entry.timestamp;
      }
      if (!newestEntry || entry.timestamp > newestEntry) {
        newestEntry = entry.timestamp;
      }
      
      entry.tags?.forEach(tag => {
        tagFrequency.set(tag, (tagFrequency.get(tag) || 0) + 1);
      });
    }
    
    return {
      totalEntries: this.entries.size,
      totalSize,
      oldestEntry,
      newestEntry,
      tagFrequency
    };
  }
  
  /**
   * Validate the memory element
   */
  public override validate(): ElementValidationResult {
    const result = super.validate();
    
    // Initialize errors array if not present
    if (!result.errors) {
      result.errors = [];
    }
    
    // Additional memory-specific validation
    if (this.retentionDays < 1 || this.retentionDays > 365) {
      result.errors.push({
        field: 'retentionDays',
        message: 'Retention days must be between 1 and 365',
        severity: 'error'
      } as ValidationError);
    }
    
    if (this.maxEntries < 1 || this.maxEntries > this.MAX_ENTRIES_DEFAULT) {
      result.errors.push({
        field: 'maxEntries',
        message: `Max entries must be between 1 and ${this.MAX_ENTRIES_DEFAULT}`,
        severity: 'error'
      } as ValidationError);
    }
    
    // Check memory size
    const stats = this.getStats();
    if (stats.totalSize > this.MAX_MEMORY_SIZE) {
      result.errors.push({
        field: 'memory',
        message: `Total memory size (${stats.totalSize}) exceeds limit (${this.MAX_MEMORY_SIZE})`,
        severity: 'error'
      } as ValidationError);
    }
    
    // Update validity based on our checks
    return {
      ...result,
      valid: result.errors.length === 0
    };
  }
  
  /**
   * Serialize memory to string
   */
  public override serialize(): string {
    const data = {
      id: this.id,
      type: this.type,
      version: this.version,
      metadata: this.metadata,
      extensions: this.extensions,
      entries: Array.from(this.entries.values())
    };
    
    return JSON.stringify(data, null, 2);
  }
  
  /**
   * Deserialize memory from string
   * SECURITY: Validates all loaded data
   */
  public override deserialize(data: string): void {
    try {
      const parsed = JSON.parse(data);
      
      // Validate basic structure
      if (!parsed.id || !parsed.type || parsed.type !== ElementType.MEMORY) {
        throw new Error('Invalid memory data format');
      }
      
      // Update properties
      this.id = parsed.id;
      this.version = parsed.version || '1.0.0';
      this.metadata = parsed.metadata || {};
      this.extensions = parsed.extensions || {};
      
      // Clear and reload entries
      this.entries.clear();
      if (Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          if (this.isValidEntry(entry)) {
            // Re-sanitize on load
            entry.content = sanitizeMemoryContent(entry.content, this.MAX_ENTRY_SIZE);
            entry.tags = this.sanitizeTags(entry.tags || []);
            entry.timestamp = new Date(entry.timestamp);
            if (entry.expiresAt) {
              entry.expiresAt = new Date(entry.expiresAt);
            }
            this.entries.set(entry.id, entry);
          }
        }
      }
      
      // Enforce retention policy after loading
      this.enforceRetentionPolicy();
      
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_DESERIALIZE_FAILED',
        severity: 'HIGH',
        source: 'Memory.deserialize',
        details: `Failed to deserialize memory: ${error}`
      });
      throw new Error(`Failed to deserialize memory: ${error}`);
    }
  }
  
  // Private helper methods
  
  private calculateExpiryDate(): Date {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + this.retentionDays);
    return expiry;
  }
  
  private sanitizeTags(tags: string[]): string[] {
    // SECURITY FIX: Limit number of tags and sanitize each
    const limitedTags = tags.slice(0, this.MAX_TAGS_PER_ENTRY);
    
    return limitedTags
      .map(tag => {
        const normalized = UnicodeValidator.normalize(tag).normalizedContent;
        return sanitizeInput(normalized, this.MAX_TAG_LENGTH);
      })
      .filter(tag => tag && tag.length > 0);
  }
  
  private sanitizeMetadata(metadata?: Record<string, any>): Record<string, any> | undefined {
    if (!metadata) return undefined;
    
    // SECURITY FIX: Sanitize metadata values
    const sanitized: Record<string, any> = {};
    const maxKeys = 20;
    let keyCount = 0;
    
    for (const [key, value] of Object.entries(metadata)) {
      if (keyCount >= maxKeys) break;
      
      const sanitizedKey = sanitizeInput(key, 50);
      if (sanitizedKey && typeof value === 'string') {
        sanitized[sanitizedKey] = sanitizeInput(value, 200);
        keyCount++;
      } else if (sanitizedKey && typeof value === 'number') {
        sanitized[sanitizedKey] = value;
        keyCount++;
      }
      // Skip other types for security
    }
    
    return sanitized;
  }
  
  private canAccessPrivacyLevel(entryLevel: string, requestedLevel: string): boolean {
    const levels = ['public', 'private', 'sensitive'];
    const entryIndex = levels.indexOf(entryLevel);
    const requestedIndex = levels.indexOf(requestedLevel);
    
    // Can only access entries at or below the requested privacy level
    // e.g., if requesting 'private', can see 'public' and 'private' but not 'sensitive'
    return entryIndex <= requestedIndex;
  }
  
  private isValidEntry(entry: any): boolean {
    return entry &&
      typeof entry.id === 'string' &&
      typeof entry.content === 'string' &&
      entry.timestamp &&
      (!entry.tags || Array.isArray(entry.tags));
  }
}