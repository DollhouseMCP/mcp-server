/**
 * Portfolio Index Manager - Maps element names to file paths
 * 
 * Solves critical issues:
 * 1. submit_content can't find elements by metadata name (e.g., "Safe Roundtrip Tester" -> "safe-roundtrip-tester.md")
 * 2. search_collection doesn't search local portfolio content
 * 
 * Features:
 * - In-memory index mapping metadata.name → file path
 * - Keywords/tags → file paths mapping
 * - Element type → file paths mapping
 * - Fast O(1) lookups with Maps
 * - Lazy loading with 5-minute TTL cache
 * - Unicode normalization for security
 * - Error handling and logging
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger.js';
import { ElementType } from './types.js';
import { PortfolioManager } from './PortfolioManager.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';

export interface IndexEntry {
  filePath: string;
  elementType: ElementType;
  metadata: {
    name: string;
    description?: string;
    version?: string;
    author?: string;
    tags?: string[];
    keywords?: string[];
    triggers?: string[];
    category?: string;
    created?: string;
    updated?: string;
  };
  lastModified: Date;
  filename: string; // Base filename without extension
}

export interface PortfolioIndex {
  byName: Map<string, IndexEntry>;
  byFilename: Map<string, IndexEntry>;
  byType: Map<ElementType, IndexEntry[]>;
  byKeyword: Map<string, IndexEntry[]>;
  byTag: Map<string, IndexEntry[]>;
  byTrigger: Map<string, IndexEntry[]>;
}

export interface SearchOptions {
  elementType?: ElementType;
  fuzzyMatch?: boolean;
  maxResults?: number;
  includeKeywords?: boolean;
  includeTags?: boolean;
  includeTriggers?: boolean;
  includeDescriptions?: boolean;
}

export interface SearchResult {
  entry: IndexEntry;
  matchType: 'name' | 'filename' | 'keyword' | 'tag' | 'trigger' | 'description';
  score: number; // For future ranking
}

export class PortfolioIndexManager {
  private static instance: PortfolioIndexManager | null = null;
  private static instanceLock = false;
  
  private index: PortfolioIndex | null = null;
  private lastBuilt: Date | null = null;
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes
  private isBuilding = false;
  private buildPromise: Promise<void> | null = null;

  private constructor() {
    logger.debug('PortfolioIndexManager created');
  }

  public static getInstance(): PortfolioIndexManager {
    if (!this.instance) {
      if (this.instanceLock) {
        throw new Error('PortfolioIndexManager instance is being created by another thread');
      }
      
      try {
        this.instanceLock = true;
        this.instance = new PortfolioIndexManager();
      } finally {
        this.instanceLock = false;
      }
    }
    return this.instance;
  }

  /**
   * Get the current index, building it if necessary
   */
  public async getIndex(): Promise<PortfolioIndex> {
    // Check if we need to rebuild
    if (this.needsRebuild()) {
      await this.buildIndex();
    }
    
    return this.index!;
  }

  /**
   * Search the portfolio index by name with fuzzy matching
   */
  public async findByName(name: string, options: SearchOptions = {}): Promise<IndexEntry | null> {
    const index = await this.getIndex();
    
    // Normalize input for security - always use normalizedContent per Unicode fix #706
    const normalizedName = UnicodeValidator.normalize(name);
    if (normalizedName.detectedIssues && normalizedName.detectedIssues.length > 0) {
      logger.debug('Unicode normalization applied to search name', {
        issues: normalizedName.detectedIssues,
        severity: normalizedName.severity
      });
      // Only block truly dangerous patterns, not just confusable characters
      const hasDangerousPatterns = normalizedName.detectedIssues.some(issue => 
        issue.includes('Direction override') ||
        issue.includes('Malformed surrogate') ||
        issue.includes('Excessive Unicode escapes')
      );
      if (hasDangerousPatterns) {
        logger.warn('Dangerous Unicode pattern blocked in search name', {
          issues: normalizedName.detectedIssues
        });
        return null;
      }
    }
    
    const safeName = normalizedName.normalizedContent;
    
    // Try exact match first (case insensitive)
    const exactMatch = index.byName.get(safeName.toLowerCase());
    if (exactMatch) {
      logger.debug('Found exact name match', { name: safeName, filePath: exactMatch.filePath });
      return exactMatch;
    }
    
    // Try filename match
    const filenameMatch = index.byFilename.get(safeName.toLowerCase());
    if (filenameMatch) {
      logger.debug('Found filename match', { name: safeName, filePath: filenameMatch.filePath });
      return filenameMatch;
    }
    
    // Try fuzzy matching if enabled
    if (options.fuzzyMatch !== false) {
      const fuzzyMatch = this.findFuzzyMatch(safeName, index, options);
      if (fuzzyMatch) {
        logger.debug('Found fuzzy match', { 
          name: safeName, 
          matchName: fuzzyMatch.metadata.name,
          filePath: fuzzyMatch.filePath 
        });
        return fuzzyMatch;
      }
    }
    
    logger.debug('No match found for name', { name: safeName });
    return null;
  }

  /**
   * Search the portfolio with comprehensive text search
   */
  public async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const index = await this.getIndex();
    
    // Normalize query for security - always use normalizedContent per Unicode fix #706
    const normalizedQuery = UnicodeValidator.normalize(query);
    if (normalizedQuery.detectedIssues && normalizedQuery.detectedIssues.length > 0) {
      logger.debug('Unicode normalization applied to search query', {
        issues: normalizedQuery.detectedIssues,
        severity: normalizedQuery.severity
      });
      // Only block truly dangerous patterns, not just confusable characters
      const hasDangerousPatterns = normalizedQuery.detectedIssues.some(issue => 
        issue.includes('Direction override') ||
        issue.includes('Malformed surrogate') ||
        issue.includes('Excessive Unicode escapes')
      );
      if (hasDangerousPatterns) {
        logger.warn('Dangerous Unicode pattern blocked in search query', {
          issues: normalizedQuery.detectedIssues
        });
        return [];
      }
    }
    
    const safeQuery = normalizedQuery.normalizedContent.toLowerCase().trim();
    const queryTokens = safeQuery.split(/\s+/).filter(token => token.length > 0);
    
    if (queryTokens.length === 0) {
      return [];
    }
    
    const results: SearchResult[] = [];
    const seenPaths = new Set<string>();
    const maxResults = options.maxResults || 20;
    
    // Helper to add unique results
    const addResult = (entry: IndexEntry, matchType: SearchResult['matchType'], score: number = 1) => {
      if (!seenPaths.has(entry.filePath) && results.length < maxResults) {
        // Filter by element type if specified
        if (options.elementType && entry.elementType !== options.elementType) {
          return;
        }
        
        seenPaths.add(entry.filePath);
        results.push({ entry, matchType, score });
      }
    };
    
    // 1. Search by name (highest priority)
    for (const [name, entry] of index.byName) {
      if (this.matchesQuery(name, queryTokens)) {
        addResult(entry, 'name', 3);
      }
    }
    
    // 2. Search by filename
    for (const [filename, entry] of index.byFilename) {
      if (this.matchesQuery(filename, queryTokens)) {
        addResult(entry, 'filename', 2.5);
      }
    }
    
    // 3. Search by keywords
    if (options.includeKeywords !== false) {
      for (const [keyword, entries] of index.byKeyword) {
        if (this.matchesQuery(keyword, queryTokens)) {
          for (const entry of entries) {
            addResult(entry, 'keyword', 2);
          }
        }
      }
    }
    
    // 4. Search by tags
    if (options.includeTags !== false) {
      for (const [tag, entries] of index.byTag) {
        if (this.matchesQuery(tag, queryTokens)) {
          for (const entry of entries) {
            addResult(entry, 'tag', 2);
          }
        }
      }
    }
    
    // 5. Search by triggers
    if (options.includeTriggers !== false) {
      for (const [trigger, entries] of index.byTrigger) {
        if (this.matchesQuery(trigger, queryTokens)) {
          for (const entry of entries) {
            addResult(entry, 'trigger', 1.8);
          }
        }
      }
    }
    
    // 6. Search by description
    if (options.includeDescriptions !== false) {
      for (const [_, entry] of index.byName) {
        if (entry.metadata.description && 
            this.matchesQuery(entry.metadata.description.toLowerCase(), queryTokens)) {
          addResult(entry, 'description', 1.5);
        }
      }
    }
    
    // Sort by score (descending)
    results.sort((a, b) => b.score - a.score);
    
    logger.debug('Portfolio search completed', {
      query: safeQuery,
      resultCount: results.length,
      totalIndexed: index.byName.size
    });
    
    return results;
  }

  /**
   * Get all elements of a specific type
   */
  public async getElementsByType(elementType: ElementType): Promise<IndexEntry[]> {
    const index = await this.getIndex();
    return index.byType.get(elementType) || [];
  }

  /**
   * Get statistics about the index
   */
  public async getStats(): Promise<{
    totalElements: number;
    elementsByType: Record<ElementType, number>;
    lastBuilt: Date | null;
    isStale: boolean;
  }> {
    const index = await this.getIndex();
    const stats = {
      totalElements: index.byName.size,
      elementsByType: {} as Record<ElementType, number>,
      lastBuilt: this.lastBuilt,
      isStale: this.needsRebuild()
    };
    
    for (const elementType of Object.values(ElementType)) {
      stats.elementsByType[elementType] = (index.byType.get(elementType) || []).length;
    }
    
    return stats;
  }

  /**
   * Force rebuild the index
   */
  public async rebuildIndex(): Promise<void> {
    this.index = null;
    this.lastBuilt = null;
    await this.buildIndex();
  }

  /**
   * Check if the index needs rebuilding
   */
  private needsRebuild(): boolean {
    if (!this.index || !this.lastBuilt) {
      return true;
    }
    
    const age = Date.now() - this.lastBuilt.getTime();
    return age > this.TTL_MS;
  }

  /**
   * Build the index by scanning all portfolio directories
   */
  private async buildIndex(): Promise<void> {
    // Prevent concurrent builds
    if (this.isBuilding) {
      if (this.buildPromise) {
        await this.buildPromise;
      }
      return;
    }
    
    this.isBuilding = true;
    
    this.buildPromise = this.performBuild();
    
    try {
      await this.buildPromise;
    } finally {
      this.isBuilding = false;
      this.buildPromise = null;
    }
  }

  /**
   * Perform the actual index building
   */
  private async performBuild(): Promise<void> {
    const startTime = Date.now();
    logger.info('Building portfolio index...');
    
    try {
      const portfolioManager = PortfolioManager.getInstance();
      
      // Initialize empty index
      const newIndex: PortfolioIndex = {
        byName: new Map(),
        byFilename: new Map(),
        byType: new Map(),
        byKeyword: new Map(),
        byTag: new Map(),
        byTrigger: new Map()
      };
      
      // Initialize type maps
      for (const elementType of Object.values(ElementType)) {
        newIndex.byType.set(elementType, []);
      }
      
      let totalFiles = 0;
      let processedFiles = 0;
      
      // Scan each element type
      for (const elementType of Object.values(ElementType)) {
        try {
          const elementDir = portfolioManager.getElementDir(elementType);
          
          // Check if directory exists
          try {
            await fs.access(elementDir);
          } catch {
            logger.debug(`Element directory doesn't exist: ${elementDir}`);
            continue;
          }
          
          const files = await fs.readdir(elementDir);
          const mdFiles = files.filter(file => file.endsWith('.md'));
          totalFiles += mdFiles.length;
          
          for (const file of mdFiles) {
            try {
              const filePath = path.join(elementDir, file);
              const entry = await this.createIndexEntry(filePath, elementType);
              
              if (entry) {
                this.addToIndex(newIndex, entry);
                processedFiles++;
              }
            } catch (error) {
              logger.warn(`Failed to index file: ${file}`, {
                elementType,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
        } catch (error) {
          logger.error(`Failed to scan element type: ${elementType}`, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      // Update instance state
      this.index = newIndex;
      this.lastBuilt = new Date();
      
      const duration = Date.now() - startTime;
      logger.info('Portfolio index built successfully', {
        totalFiles,
        processedFiles,
        duration: `${duration}ms`,
        uniqueNames: newIndex.byName.size,
        uniqueKeywords: newIndex.byKeyword.size,
        uniqueTags: newIndex.byTag.size
      });
      
      // Log security event for audit trail
      SecurityMonitor.logSecurityEvent({
        type: 'PORTFOLIO_INITIALIZATION',
        severity: 'LOW',
        source: 'PortfolioIndexManager.performBuild',
        details: `Portfolio index rebuilt with ${processedFiles} elements in ${duration}ms`
      });
      
    } catch (error) {
      ErrorHandler.logError('PortfolioIndexManager.performBuild', error);
      throw ErrorHandler.wrapError(error, 'Failed to build portfolio index', ErrorCategory.SYSTEM_ERROR);
    }
  }

  /**
   * Create an index entry from a file
   */
  private async createIndexEntry(filePath: string, elementType: ElementType): Promise<IndexEntry | null> {
    try {
      // Get file stats
      const stats = await fs.stat(filePath);
      
      // Read file content
      const content = await fs.readFile(filePath, 'utf-8');
      
      // Parse frontmatter securely
      const parsed = SecureYamlParser.parse(content);
      
      // Extract base filename
      const filename = path.basename(filePath, '.md');
      
      // Build metadata with defaults
      const metadata = {
        name: parsed.data.name || filename,
        description: parsed.data.description,
        version: parsed.data.version,
        author: parsed.data.author,
        tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [],
        keywords: Array.isArray(parsed.data.keywords) ? parsed.data.keywords : [],
        triggers: Array.isArray(parsed.data.triggers) ? parsed.data.triggers : [],
        category: parsed.data.category,
        created: parsed.data.created || parsed.data.created_date,
        updated: parsed.data.updated || parsed.data.updated_date
      };
      
      const entry: IndexEntry = {
        filePath,
        elementType,
        metadata,
        lastModified: stats.mtime,
        filename
      };
      
      return entry;
      
    } catch (error) {
      logger.debug(`Failed to create index entry for: ${filePath}`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Add entry to all relevant index maps
   */
  private addToIndex(index: PortfolioIndex, entry: IndexEntry): void {
    // Normalize keys for case-insensitive lookup
    const normalizedName = entry.metadata.name.toLowerCase();
    const normalizedFilename = entry.filename.toLowerCase();
    
    // Add to name map
    index.byName.set(normalizedName, entry);
    
    // Add to filename map
    index.byFilename.set(normalizedFilename, entry);
    
    // Add to type map
    const typeEntries = index.byType.get(entry.elementType) || [];
    typeEntries.push(entry);
    index.byType.set(entry.elementType, typeEntries);
    
    // Add keywords
    for (const keyword of entry.metadata.keywords || []) {
      const normalizedKeyword = keyword.toLowerCase();
      const keywordEntries = index.byKeyword.get(normalizedKeyword) || [];
      keywordEntries.push(entry);
      index.byKeyword.set(normalizedKeyword, keywordEntries);
    }
    
    // Add tags
    for (const tag of entry.metadata.tags || []) {
      const normalizedTag = tag.toLowerCase();
      const tagEntries = index.byTag.get(normalizedTag) || [];
      tagEntries.push(entry);
      index.byTag.set(normalizedTag, tagEntries);
    }
    
    // Add triggers
    for (const trigger of entry.metadata.triggers || []) {
      const normalizedTrigger = trigger.toLowerCase();
      const triggerEntries = index.byTrigger.get(normalizedTrigger) || [];
      triggerEntries.push(entry);
      index.byTrigger.set(normalizedTrigger, triggerEntries);
    }
  }

  /**
   * Find fuzzy matches for a name
   */
  private findFuzzyMatch(searchName: string, index: PortfolioIndex, options: SearchOptions): IndexEntry | null {
    const search = searchName.toLowerCase();
    let bestMatch: IndexEntry | null = null;
    let bestScore = 0;
    
    // Search names with partial matching
    for (const [name, entry] of index.byName) {
      if (options.elementType && entry.elementType !== options.elementType) {
        continue;
      }
      
      const score = this.calculateSimilarity(search, name);
      if (score > bestScore && score > 0.3) { // Minimum similarity threshold
        bestScore = score;
        bestMatch = entry;
      }
    }
    
    // Also check filenames
    for (const [filename, entry] of index.byFilename) {
      if (options.elementType && entry.elementType !== options.elementType) {
        continue;
      }
      
      const score = this.calculateSimilarity(search, filename);
      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = entry;
      }
    }
    
    return bestMatch;
  }

  /**
   * Calculate similarity between two strings
   */
  private calculateSimilarity(a: string, b: string): number {
    // Simple similarity based on substring containment and length
    if (a === b) return 1.0;
    if (a.includes(b) || b.includes(a)) return 0.8;
    
    // Check for word overlap
    const wordsA = a.split(/\s+/);
    const wordsB = b.split(/\s+/);
    const commonWords = wordsA.filter(word => wordsB.includes(word));
    
    if (commonWords.length > 0) {
      return commonWords.length / Math.max(wordsA.length, wordsB.length);
    }
    
    return 0;
  }

  /**
   * Check if any query tokens match the text
   */
  private matchesQuery(text: string, queryTokens: string[]): boolean {
    return queryTokens.some(token => text.includes(token));
  }
}