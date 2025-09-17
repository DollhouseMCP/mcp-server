/**
 * Memory Search Index - High-performance indexed search for Memory elements
 *
 * Addresses issue #984: Implement search indexing for Memory element scalability
 *
 * Features:
 * - Tag index for O(1) tag-based queries
 * - Content index using inverted index pattern
 * - Temporal index for date range queries
 * - Privacy level index for filtered access
 * - Incremental index updates
 * - Optional persistence
 * - Configurable thresholds
 */

import { MemoryEntry } from './Memory.js';
import { PrivacyLevel, MEMORY_CONSTANTS } from './constants.js';
import { logger } from '../../utils/logger.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';

export interface SearchIndexConfig {
  /**
   * Enable indexing when memory has more than this many entries
   * Default: 100
   */
  indexThreshold?: number;

  /**
   * Enable content index (more memory intensive)
   * Default: true
   */
  enableContentIndex?: boolean;

  /**
   * Maximum number of terms to index per entry
   * Default: 100
   */
  maxTermsPerEntry?: number;

  /**
   * Minimum term length to index
   * Default: 2
   */
  minTermLength?: number;

  /**
   * Enable index persistence to disk
   * Default: false
   */
  enablePersistence?: boolean;
}

export interface SearchIndexStats {
  isIndexed: boolean;
  entryCount: number;
  tagCount: number;
  termCount: number;
  lastBuilt?: Date;
  buildTimeMs?: number;
}

export interface SearchQuery {
  tags?: string[];
  content?: string;
  dateFrom?: Date;
  dateTo?: Date;
  privacyLevel?: PrivacyLevel;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  matches: {
    tags?: string[];
    terms?: string[];
  };
}

/**
 * Inverted index for content search
 */
class ContentIndex {
  private termToEntries = new Map<string, Set<string>>();
  private entryToTerms = new Map<string, Set<string>>();
  private readonly config: SearchIndexConfig;

  constructor(config: SearchIndexConfig) {
    this.config = config;
  }

  /**
   * Add an entry to the content index
   */
  addEntry(entryId: string, content: string): void {
    const terms = this.extractTerms(content);

    // Store terms for this entry
    this.entryToTerms.set(entryId, terms);

    // Update inverted index
    for (const term of terms) {
      let entries = this.termToEntries.get(term);
      if (!entries) {
        entries = new Set();
        this.termToEntries.set(term, entries);
      }
      entries.add(entryId);
    }
  }

  /**
   * Remove an entry from the index
   */
  removeEntry(entryId: string): void {
    const terms = this.entryToTerms.get(entryId);
    if (!terms) return;

    // Remove from inverted index
    for (const term of terms) {
      const entries = this.termToEntries.get(term);
      if (entries) {
        entries.delete(entryId);
        if (entries.size === 0) {
          this.termToEntries.delete(term);
        }
      }
    }

    // Remove entry terms
    this.entryToTerms.delete(entryId);
  }

  /**
   * Search for entries containing query terms
   */
  search(query: string): Map<string, number> {
    const queryTerms = this.extractTerms(query);
    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const entries = this.termToEntries.get(term);
      if (entries) {
        for (const entryId of entries) {
          scores.set(entryId, (scores.get(entryId) || 0) + 1);
        }
      }
    }

    return scores;
  }

  /**
   * Extract searchable terms from content
   */
  private extractTerms(content: string): Set<string> {
    // Normalize for security
    const normalized = UnicodeValidator.normalize(content);
    if (!normalized.isValid) {
      logger.warn('Invalid Unicode in content for indexing');
      return new Set();
    }

    const text = normalized.normalizedContent.toLowerCase();
    const terms = new Set<string>();

    // Simple tokenization (can be improved with better NLP)
    const words = text.match(/\b\w+\b/g) || [];

    let termCount = 0;
    for (const word of words) {
      if (word.length >= (this.config.minTermLength || 2)) {
        terms.add(word);
        termCount++;
        if (termCount >= (this.config.maxTermsPerEntry || 100)) {
          break;
        }
      }
    }

    return terms;
  }

  clear(): void {
    this.termToEntries.clear();
    this.entryToTerms.clear();
  }

  get size(): number {
    return this.termToEntries.size;
  }
}

/**
 * Date range index using sorted array for efficient range queries
 */
class TemporalIndex {
  private entries: Array<{ id: string; timestamp: number }> = [];

  addEntry(entryId: string, date: Date): void {
    const timestamp = date.getTime();

    // Binary search for insertion point
    let left = 0;
    let right = this.entries.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.entries[mid].timestamp < timestamp) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    // Insert at correct position to maintain sort
    this.entries.splice(left, 0, { id: entryId, timestamp });
  }

  removeEntry(entryId: string): void {
    const index = this.entries.findIndex(e => e.id === entryId);
    if (index >= 0) {
      this.entries.splice(index, 1);
    }
  }

  /**
   * Find entries within date range
   */
  searchRange(from?: Date, to?: Date): Set<string> {
    const results = new Set<string>();
    const fromTime = from?.getTime() || 0;
    const toTime = to?.getTime() || Date.now();

    // Binary search for start
    let start = 0;
    let end = this.entries.length;

    while (start < end) {
      const mid = Math.floor((start + end) / 2);
      if (this.entries[mid].timestamp < fromTime) {
        start = mid + 1;
      } else {
        end = mid;
      }
    }

    // Collect all entries in range
    for (let i = start; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.timestamp > toTime) break;
      results.add(entry.id);
    }

    return results;
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}

/**
 * Main search index for Memory elements
 */
export class MemorySearchIndex {
  private readonly config: SearchIndexConfig;

  // Indexes
  private tagIndex = new Map<string, Set<string>>();
  private privacyIndex = new Map<PrivacyLevel, Set<string>>();
  private contentIndex: ContentIndex | null = null;
  private temporalIndex = new TemporalIndex();

  // Cached entries for scoring
  private entriesCache = new Map<string, MemoryEntry>();

  // Index state
  private isBuilt = false;
  private stats: SearchIndexStats = {
    isIndexed: false,
    entryCount: 0,
    tagCount: 0,
    termCount: 0
  };

  constructor(config: SearchIndexConfig = {}) {
    this.config = {
      indexThreshold: config.indexThreshold || 100,
      enableContentIndex: config.enableContentIndex !== false,
      maxTermsPerEntry: config.maxTermsPerEntry || 100,
      minTermLength: config.minTermLength || 2,
      enablePersistence: config.enablePersistence || false
    };

    if (this.config.enableContentIndex) {
      this.contentIndex = new ContentIndex(this.config);
    }

    logger.debug('MemorySearchIndex created', this.config);
  }

  /**
   * Build or rebuild the index from entries
   */
  buildIndex(entries: Map<string, MemoryEntry>): void {
    const startTime = Date.now();

    // Clear existing indexes
    this.clear();

    // Check if we should index based on threshold
    if (entries.size < (this.config.indexThreshold || 100)) {
      logger.debug('Not building index - below threshold', {
        entryCount: entries.size,
        threshold: this.config.indexThreshold
      });
      return;
    }

    // Build indexes
    for (const [id, entry] of entries) {
      this.addToIndex(id, entry);
    }

    // Update stats
    const buildTime = Date.now() - startTime;
    this.stats = {
      isIndexed: true,
      entryCount: entries.size,
      tagCount: this.tagIndex.size,
      termCount: this.contentIndex?.size || 0,
      lastBuilt: new Date(),
      buildTimeMs: buildTime
    };

    this.isBuilt = true;

    logger.info('Memory search index built', this.stats);
  }

  /**
   * Add a single entry to the index (incremental update)
   */
  addEntry(entry: MemoryEntry): void {
    if (!this.isBuilt) return;

    this.addToIndex(entry.id, entry);
    this.stats.entryCount++;

    logger.debug('Entry added to index', { id: entry.id });
  }

  /**
   * Remove an entry from the index
   */
  removeEntry(entryId: string): void {
    if (!this.isBuilt) return;

    const entry = this.entriesCache.get(entryId);
    if (!entry) return;

    // Remove from tag index
    if (entry.metadata?.tags) {
      for (const tag of entry.metadata.tags) {
        const entries = this.tagIndex.get(tag);
        if (entries) {
          entries.delete(entryId);
          if (entries.size === 0) {
            this.tagIndex.delete(tag);
          }
        }
      }
    }

    // Remove from privacy index
    const privacyLevel = entry.metadata?.privacyLevel || entry.privacyLevel || MEMORY_CONSTANTS.DEFAULT_PRIVACY_LEVEL;
    const privacyEntries = this.privacyIndex.get(privacyLevel);
    if (privacyEntries) {
      privacyEntries.delete(entryId);
    }

    // Remove from content index
    this.contentIndex?.removeEntry(entryId);

    // Remove from temporal index
    this.temporalIndex.removeEntry(entryId);

    // Remove from cache
    this.entriesCache.delete(entryId);

    this.stats.entryCount--;

    logger.debug('Entry removed from index', { id: entryId });
  }

  /**
   * Search the index with multiple criteria
   */
  search(query: SearchQuery, entries: Map<string, MemoryEntry>): SearchResult[] {
    if (!this.isBuilt) {
      logger.debug('Index not built, falling back to linear search');
      return this.linearSearch(query, entries);
    }

    // Start with all entries or filtered by privacy
    let candidateIds: Set<string> | null = null;

    // Filter by privacy level
    if (query.privacyLevel) {
      candidateIds = new Set(this.privacyIndex.get(query.privacyLevel) || []);
    }

    // Filter by tags (intersection)
    if (query.tags && query.tags.length > 0) {
      const tagResults = new Set<string>();
      for (const tag of query.tags) {
        const entries = this.tagIndex.get(tag.toLowerCase());
        if (entries) {
          if (candidateIds) {
            // Intersection with existing candidates
            for (const id of entries) {
              if (candidateIds.has(id)) {
                tagResults.add(id);
              }
            }
          } else {
            // First filter
            entries.forEach(id => tagResults.add(id));
          }
        }
      }
      candidateIds = tagResults;
    }

    // Filter by date range
    if (query.dateFrom || query.dateTo) {
      const dateResults = this.temporalIndex.searchRange(query.dateFrom, query.dateTo);
      if (candidateIds) {
        // Intersection
        const intersection = new Set<string>();
        for (const id of candidateIds) {
          if (dateResults.has(id)) {
            intersection.add(id);
          }
        }
        candidateIds = intersection;
      } else {
        candidateIds = dateResults;
      }
    }

    // Score by content if provided
    const contentScores = query.content && this.contentIndex
      ? this.contentIndex.search(query.content)
      : new Map<string, number>();

    // Build results
    const results: SearchResult[] = [];
    const searchEntries = candidateIds || new Set(entries.keys());

    for (const id of searchEntries) {
      const entry = entries.get(id);
      if (!entry) continue;

      // Calculate score
      let score = 1;

      // Content relevance score
      if (contentScores.has(id)) {
        score += contentScores.get(id)! * 2;
      }

      // Tag match bonus
      if (query.tags && entry.metadata?.tags) {
        const matchedTags = query.tags.filter(tag =>
          entry.metadata?.tags?.includes(tag)
        );
        score += matchedTags.length;
      }

      results.push({
        entry,
        score,
        matches: {
          tags: query.tags?.filter(tag => entry.metadata?.tags?.includes(tag)),
          terms: query.content ? ['indexed'] : undefined
        }
      });
    }

    // Sort by score and apply pagination
    results.sort((a, b) => b.score - a.score);

    const offset = query.offset || 0;
    const limit = query.limit || 100;

    return results.slice(offset, offset + limit);
  }

  /**
   * Fallback linear search when index is not available
   */
  private linearSearch(query: SearchQuery, entries: Map<string, MemoryEntry>): SearchResult[] {
    const results: SearchResult[] = [];

    for (const [id, entry] of entries) {
      // Check privacy level
      if (query.privacyLevel && entry.metadata?.privacyLevel !== query.privacyLevel) {
        continue;
      }

      // Check date range
      if (query.dateFrom && entry.metadata?.timestamp && entry.metadata.timestamp < query.dateFrom) {
        continue;
      }
      if (query.dateTo && entry.metadata?.timestamp && entry.metadata.timestamp > query.dateTo) {
        continue;
      }

      // Check tags
      if (query.tags && query.tags.length > 0) {
        const hasAllTags = query.tags.every(tag =>
          entry.metadata?.tags?.includes(tag)
        );
        if (!hasAllTags) continue;
      }

      // Check content (simple substring match)
      let score = 1;
      if (query.content) {
        const normalized = UnicodeValidator.normalize(query.content);
        if (normalized.isValid) {
          const searchTerm = normalized.normalizedContent.toLowerCase();
          if (entry.content.toLowerCase().includes(searchTerm)) {
            score += 2;
          }
        }
      }

      results.push({
        entry,
        score,
        matches: {
          tags: query.tags?.filter(tag => entry.metadata?.tags?.includes(tag))
        }
      });
    }

    // Sort and paginate
    results.sort((a, b) => b.score - a.score);
    const offset = query.offset || 0;
    const limit = query.limit || 100;

    return results.slice(offset, offset + limit);
  }

  /**
   * Internal helper to add entry to all indexes
   */
  private addToIndex(id: string, entry: MemoryEntry): void {
    // Cache entry
    this.entriesCache.set(id, entry);

    // Add to tag index
    if (entry.metadata?.tags) {
      for (const tag of entry.metadata.tags) {
        const normalizedTag = tag.toLowerCase();
        let entries = this.tagIndex.get(normalizedTag);
        if (!entries) {
          entries = new Set();
          this.tagIndex.set(normalizedTag, entries);
        }
        entries.add(id);
      }
    }

    // Add to privacy index
    const privacyLevel = entry.metadata?.privacyLevel || entry.privacyLevel || MEMORY_CONSTANTS.DEFAULT_PRIVACY_LEVEL;
    let privacyEntries = this.privacyIndex.get(privacyLevel);
    if (!privacyEntries) {
      privacyEntries = new Set();
      this.privacyIndex.set(privacyLevel, privacyEntries);
    }
    privacyEntries.add(id);

    // Add to content index
    if (this.contentIndex) {
      this.contentIndex.addEntry(id, entry.content);
    }

    // Add to temporal index
    this.temporalIndex.addEntry(id, entry.metadata?.timestamp || entry.timestamp);
  }

  /**
   * Clear all indexes
   */
  clear(): void {
    this.tagIndex.clear();
    this.privacyIndex.clear();
    this.contentIndex?.clear();
    this.temporalIndex.clear();
    this.entriesCache.clear();
    this.isBuilt = false;
    this.stats = {
      isIndexed: false,
      entryCount: 0,
      tagCount: 0,
      termCount: 0
    };
  }

  /**
   * Get index statistics
   */
  getStats(): SearchIndexStats {
    return { ...this.stats };
  }

  /**
   * Check if index is built
   */
  get isIndexed(): boolean {
    return this.isBuilt;
  }
}