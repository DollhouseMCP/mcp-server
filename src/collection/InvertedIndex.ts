/**
 * Inverted Index for fast collection search
 *
 * Provides O(k) search performance where k = number of matching entries
 * compared to O(n) linear search through all entries.
 *
 * Architecture:
 * - Token -> Set<entryId> mapping for fast lookups
 * - Separate indexes for different fields (name, description, tags, etc.)
 * - Efficient tokenization with stop word filtering
 * - Case-insensitive with normalization
 */

import { IndexEntry } from '../types/collection.js';
import { normalizeSearchTerm } from '../utils/searchUtils.js';

/**
 * Single token entry in the inverted index
 */
interface TokenEntry {
  token: string;
  entryIds: Set<number>;
  // Field where this token appears (for weighted scoring)
  fields: Map<number, Set<'name' | 'description' | 'tags' | 'path'>>;
}

/**
 * Statistics about the inverted index
 */
export interface InvertedIndexStats {
  totalTokens: number;
  totalEntries: number;
  avgTokensPerEntry: number;
  estimatedMemoryKB: number;
  lastBuilt: Date;
  buildTimeMs: number;
}

/**
 * Inverted index for fast collection search
 */
export class InvertedIndex {
  // Main index: token -> entry IDs and field locations
  private index: Map<string, TokenEntry> = new Map();

  // Entry storage: ID -> full entry
  private entries: IndexEntry[] = [];

  // ID lookup: entry path -> entry ID
  private pathToId: Map<string, number> = new Map();

  // Statistics
  private stats: InvertedIndexStats = {
    totalTokens: 0,
    totalEntries: 0,
    avgTokensPerEntry: 0,
    estimatedMemoryKB: 0,
    lastBuilt: new Date(),
    buildTimeMs: 0
  };

  /**
   * Build inverted index from entries
   */
  build(entries: IndexEntry[]): void {
    const startTime = performance.now();

    // Clear existing index
    this.index.clear();
    this.entries = [];
    this.pathToId.clear();

    // Build index
    entries.forEach((entry, idx) => {
      // Store entry
      this.entries.push(entry);
      this.pathToId.set(entry.path, idx);

      // Tokenize and index each field
      this.indexField(idx, entry.name, 'name');
      this.indexField(idx, entry.description, 'description');
      this.indexField(idx, entry.path, 'path');

      // Index tags separately
      entry.tags.forEach(tag => {
        this.indexField(idx, tag, 'tags');
      });
    });

    // Update statistics
    const endTime = performance.now();
    this.updateStats(endTime - startTime);
  }

  /**
   * Index a single field for an entry
   */
  private indexField(
    entryId: number,
    fieldValue: string,
    fieldName: 'name' | 'description' | 'tags' | 'path'
  ): void {
    const tokens = this.tokenize(fieldValue);

    tokens.forEach(token => {
      let tokenEntry = this.index.get(token);

      if (!tokenEntry) {
        tokenEntry = {
          token,
          entryIds: new Set(),
          fields: new Map()
        };
        this.index.set(token, tokenEntry);
      }

      // Add entry ID to this token
      tokenEntry.entryIds.add(entryId);

      // Track which field this token appears in
      if (!tokenEntry.fields.has(entryId)) {
        tokenEntry.fields.set(entryId, new Set());
      }
      tokenEntry.fields.get(entryId)!.add(fieldName);
    });
  }

  /**
   * Tokenize a string into searchable tokens
   *
   * Uses the same normalization as searchUtils for consistency
   */
  private tokenize(text: string): string[] {
    if (!text || text.trim().length === 0) {
      return [];
    }

    // Normalize using shared utility
    const normalized = normalizeSearchTerm(text);

    // Split into words
    const tokens = normalized.split(/\s+/).filter(token => {
      // Remove empty tokens and common stop words
      return token.length > 0 && !this.isStopWord(token);
    });

    return tokens;
  }

  /**
   * Check if a token is a common stop word
   *
   * Stop words are filtered to reduce index size and improve relevance
   */
  private isStopWord(token: string): boolean {
    // Common English stop words that don't add search value
    const stopWords = new Set([
      'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for',
      'from', 'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on',
      'that', 'the', 'to', 'was', 'will', 'with'
    ]);

    return stopWords.has(token);
  }

  /**
   * Search the index for matching entries
   *
   * Returns entry IDs matching the query with relevance scores
   */
  search(query: string): Array<{ entryId: number; score: number }> {
    const queryTokens = this.tokenize(query);

    if (queryTokens.length === 0) {
      return [];
    }

    // Find all entries matching any query token
    const candidateScores = new Map<number, number>();

    queryTokens.forEach(queryToken => {
      const tokenEntry = this.index.get(queryToken);

      if (tokenEntry) {
        // Add matching entries with field-based scoring
        tokenEntry.entryIds.forEach(entryId => {
          const fields = tokenEntry.fields.get(entryId);
          const score = this.calculateFieldScore(fields);

          // Accumulate scores (multiple token matches increase relevance)
          const currentScore = candidateScores.get(entryId) || 0;
          candidateScores.set(entryId, currentScore + score);
        });
      }
    });

    // Convert to array and sort by score
    return Array.from(candidateScores.entries())
      .map(([entryId, score]) => ({ entryId, score }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Calculate relevance score based on which fields matched
   *
   * Name matches are most relevant, followed by tags, description, path
   */
  private calculateFieldScore(fields: Set<'name' | 'description' | 'tags' | 'path'> | undefined): number {
    if (!fields) return 0;

    let score = 0;

    // Field weights (name is most important)
    if (fields.has('name')) score += 100;
    if (fields.has('tags')) score += 25;
    if (fields.has('description')) score += 50;
    if (fields.has('path')) score += 10;

    return score;
  }

  /**
   * Get entry by ID
   */
  getEntry(entryId: number): IndexEntry | undefined {
    return this.entries[entryId];
  }

  /**
   * Get all entries (for filtering/sorting after search)
   */
  getAllEntries(): IndexEntry[] {
    return this.entries;
  }

  /**
   * Get index statistics
   */
  getStats(): InvertedIndexStats {
    return { ...this.stats };
  }

  /**
   * Update statistics after index build
   */
  private updateStats(buildTimeMs: number): void {
    const totalTokenInstances = Array.from(this.index.values())
      .reduce((sum, entry) => sum + entry.entryIds.size, 0);

    this.stats = {
      totalTokens: this.index.size,
      totalEntries: this.entries.length,
      avgTokensPerEntry: this.entries.length > 0
        ? totalTokenInstances / this.entries.length
        : 0,
      estimatedMemoryKB: this.estimateMemoryUsage(),
      lastBuilt: new Date(),
      buildTimeMs
    };
  }

  /**
   * Estimate memory usage of the index
   */
  private estimateMemoryUsage(): number {
    // Token string overhead: ~50 bytes per unique token
    const tokenOverhead = this.index.size * 50;

    // Set overhead: ~8 bytes per entry ID
    const entryIdOverhead = Array.from(this.index.values())
      .reduce((sum, entry) => sum + entry.entryIds.size * 8, 0);

    // Field map overhead: ~16 bytes per field tracking
    const fieldOverhead = Array.from(this.index.values())
      .reduce((sum, entry) => sum + entry.fields.size * 16, 0);

    // Total in KB
    return (tokenOverhead + entryIdOverhead + fieldOverhead) / 1024;
  }

  /**
   * Check if index is empty
   */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * Get number of indexed entries
   */
  size(): number {
    return this.entries.length;
  }
}
