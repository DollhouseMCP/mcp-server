/**
 * NLP Scoring Manager - Jaccard similarity and Shannon entropy for semantic analysis
 *
 * Implements intelligent document similarity scoring using:
 * - Jaccard similarity for vocabulary overlap
 * - Shannon entropy for information density
 * - Combined scoring for meaningful semantic relationships
 *
 * Key insights from analysis:
 * - High Jaccard (>60%) + Moderate entropy (4.5-6.0) = Same technical domain
 * - High Jaccard + Low entropy (<3.0) = Stop word pollution, superficial
 * - Low Jaccard + Similar entropy = Different domains, equally complex
 *
 * Part of Enhanced Capability Index (#1085)
 */

import { logger } from '../utils/logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

/**
 * Scoring result with detailed metrics
 */
export interface ScoringResult {
  jaccard: number;           // 0.0 to 1.0
  entropy: number;           // Typically 0 to 8 bits for text
  combinedScore: number;     // 0.0 to 1.0
  interpretation: string;    // Human-readable explanation
  tokenCount: number;        // Number of unique tokens
  overlapCount: number;      // Number of overlapping tokens
}

/**
 * Pairwise similarity between two elements
 */
export interface PairwiseSimilarity {
  element1: string;
  element2: string;
  similarity: ScoringResult;
  timestamp: string;
}

/**
 * Configuration for scoring algorithm
 */
export interface ScoringConfig {
  minTokenLength: number;
  cacheExpiry: number;      // milliseconds
  entropyBands: {
    low: number;           // < 3.0 typically (high repetition/common words)
    moderate: number;      // 3.0 - 6.0 typically (balanced vocabulary)
    high: number;          // > 6.0 typically (diverse specialized terms)
  };
  jaccardThresholds: {
    low: number;           // < 0.2
    moderate: number;      // 0.2 - 0.6
    high: number;          // > 0.6
  };
}

export class NLPScoringManager {
  private cache: Map<string, { result: ScoringResult; timestamp: number }>;
  private config: ScoringConfig;
  private unicodeValidator: UnicodeValidator;

  constructor(config?: Partial<ScoringConfig>) {
    this.config = {
      minTokenLength: 2,
      cacheExpiry: 5 * 60 * 1000, // 5 minutes
      entropyBands: {
        low: 3.0,
        moderate: 4.5,
        high: 6.0
      },
      jaccardThresholds: {
        low: 0.2,
        moderate: 0.4,
        high: 0.6
      },
      ...config
    };

    this.cache = new Map();
    this.unicodeValidator = new UnicodeValidator();
  }

  /**
   * Clean and tokenize text for analysis
   * Works with any language - no hardcoded stop words
   */
  private cleanAndTokenize(text: string): Set<string> {
    // Normalize Unicode for security
    const validation = UnicodeValidator.normalize(text);
    if (validation.detectedIssues && validation.detectedIssues.length > 0) {
      logger.warn('Unicode issues in NLP text', { issues: validation.detectedIssues });
    }
    text = validation.normalizedContent;

    // Convert to lowercase and split on word boundaries
    // Keep Unicode letter characters for multilingual support
    const tokens = text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')  // Unicode-aware: keep letters, numbers, underscore, hyphen
      .split(/\s+/)
      .filter(token => token.length >= this.config.minTokenLength);

    return new Set(tokens);
  }

  /**
   * Calculate Jaccard similarity between two text strings
   *
   * Jaccard = |A ∩ B| / |A ∪ B|
   *
   * Returns value between 0 (no overlap) and 1 (identical)
   */
  public calculateJaccard(text1: string, text2: string): number {
    const tokens1 = this.cleanAndTokenize(text1);
    const tokens2 = this.cleanAndTokenize(text2);

    if (tokens1.size === 0 && tokens2.size === 0) {
      return 1.0; // Both empty = identical
    }

    if (tokens1.size === 0 || tokens2.size === 0) {
      return 0.0; // One empty = no similarity
    }

    // Calculate intersection
    const intersection = new Set([...tokens1].filter(token => tokens2.has(token)));

    // Calculate union
    const union = new Set([...tokens1, ...tokens2]);

    return intersection.size / union.size;
  }

  /**
   * Calculate Shannon entropy for text
   *
   * H(X) = -Σ p(x) * log2(p(x))
   *
   * Measures information density/vocabulary richness
   * Higher entropy = more diverse vocabulary
   */
  public calculateEntropy(text: string): number {
    const tokens = Array.from(this.cleanAndTokenize(text));

    if (tokens.length === 0) {
      return 0;
    }

    // Calculate token frequencies
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }

    // Calculate probabilities and entropy
    let entropy = 0;
    const totalTokens = tokens.length;

    for (const count of frequencies.values()) {
      const probability = count / totalTokens;
      if (probability > 0) {
        entropy -= probability * Math.log2(probability);
      }
    }

    return entropy;
  }

  /**
   * Calculate combined relevance score using Jaccard and entropy
   *
   * Interprets the relationship between similarity and complexity
   */
  public scoreRelevance(text1: string, text2: string): ScoringResult {
    // Check cache first
    const cacheKey = `${text1.substring(0, 50)}:::${text2.substring(0, 50)}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.config.cacheExpiry) {
      return cached.result;
    }

    // Calculate metrics
    const jaccard = this.calculateJaccard(text1, text2);
    const entropy1 = this.calculateEntropy(text1);
    const entropy2 = this.calculateEntropy(text2);
    const avgEntropy = (entropy1 + entropy2) / 2;

    // Get token sets for additional metrics
    const tokens1 = this.cleanAndTokenize(text1);
    const tokens2 = this.cleanAndTokenize(text2);
    const intersection = new Set([...tokens1].filter(token => tokens2.has(token)));

    // Interpret the combination
    let combinedScore: number;
    let interpretation: string;

    // High Jaccard + Moderate-High entropy = Excellent match (same domain)
    if (jaccard >= this.config.jaccardThresholds.high &&
        avgEntropy >= this.config.entropyBands.low) {
      // Scale score based on entropy quality
      const entropyQuality = Math.min(1.0, (avgEntropy - 2.0) / 4.0); // 0 at entropy=2, 1 at entropy=6+
      combinedScore = 0.7 + (jaccard - 0.6) * 0.5 + entropyQuality * 0.2;

      if (avgEntropy >= this.config.entropyBands.moderate) {
        interpretation = 'Excellent match - same technical domain with rich vocabulary';
      } else {
        interpretation = 'Good match - high overlap but simpler vocabulary';
      }
    }
    // High Jaccard + Very Low entropy = Common word pollution
    else if (jaccard >= this.config.jaccardThresholds.high &&
             avgEntropy < 2.0) {
      combinedScore = 0.3 + jaccard * 0.2; // Penalize heavily
      interpretation = 'Superficial similarity - mostly common words';
    }
    // Moderate Jaccard + Good entropy = Related concepts
    else if (jaccard >= this.config.jaccardThresholds.moderate &&
             avgEntropy >= this.config.entropyBands.low) {
      combinedScore = 0.4 + jaccard * 0.4 + (avgEntropy / 10) * 0.2;
      interpretation = 'Moderate match - related concepts with good complexity';
    }
    // Low Jaccard + Similar entropy = Different domains
    else if (jaccard < this.config.jaccardThresholds.low &&
             Math.abs(entropy1 - entropy2) < 1.0) {
      combinedScore = jaccard * 0.5;
      interpretation = 'Different domains with similar complexity';
    }
    // Low Jaccard + Different entropy = Unrelated
    else {
      combinedScore = jaccard * 0.3;
      interpretation = 'Low relevance - different topics and complexity';
    }

    // Ensure score is between 0 and 1
    combinedScore = Math.max(0, Math.min(1, combinedScore));

    const result: ScoringResult = {
      jaccard,
      entropy: avgEntropy,
      combinedScore,
      interpretation,
      tokenCount: tokens1.size + tokens2.size,
      overlapCount: intersection.size
    };

    // Cache the result
    this.cache.set(cacheKey, {
      result,
      timestamp: Date.now()
    });

    // Log scoring event for monitoring
    logger.debug('NLP scoring completed', {
      jaccard: result.jaccard.toFixed(3),
      entropy: result.entropy.toFixed(3),
      score: result.combinedScore.toFixed(3),
      interpretation: result.interpretation
    });

    return result;
  }

  /**
   * Build a pairwise similarity matrix for multiple texts
   *
   * Useful for clustering and relationship discovery
   */
  public buildSimilarityMatrix(
    elements: Map<string, string>
  ): Map<string, Map<string, ScoringResult>> {
    const matrix = new Map<string, Map<string, ScoringResult>>();
    const keys = Array.from(elements.keys());

    for (let i = 0; i < keys.length; i++) {
      const key1 = keys[i];
      const text1 = elements.get(key1)!;

      if (!matrix.has(key1)) {
        matrix.set(key1, new Map());
      }

      for (let j = i + 1; j < keys.length; j++) {
        const key2 = keys[j];
        const text2 = elements.get(key2)!;

        // Calculate similarity
        const similarity = this.scoreRelevance(text1, text2);

        // Store bidirectionally
        matrix.get(key1)!.set(key2, similarity);

        if (!matrix.has(key2)) {
          matrix.set(key2, new Map());
        }
        matrix.get(key2)!.set(key1, similarity);
      }
    }

    return matrix;
  }

  /**
   * Find most similar elements to a given text
   */
  public findSimilar(
    targetText: string,
    candidates: Map<string, string>,
    topK: number = 5
  ): Array<{ name: string; score: ScoringResult }> {
    const scores: Array<{ name: string; score: ScoringResult }> = [];

    for (const [name, text] of candidates.entries()) {
      const score = this.scoreRelevance(targetText, text);
      scores.push({ name, score });
    }

    // Sort by combined score descending
    scores.sort((a, b) => b.score.combinedScore - a.score.combinedScore);

    return scores.slice(0, topK);
  }

  /**
   * Extract key terms from text based on entropy contribution
   *
   * Terms that contribute most to entropy are likely important
   */
  public extractKeyTerms(text: string, topK: number = 10): string[] {
    const tokens = Array.from(this.cleanAndTokenize(text));

    if (tokens.length === 0) {
      return [];
    }

    // Calculate token frequencies
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }

    // Calculate entropy contribution for each unique token
    const totalTokens = tokens.length;
    const contributions: Array<{ token: string; contribution: number }> = [];

    for (const [token, count] of frequencies.entries()) {
      const probability = count / totalTokens;
      const contribution = -probability * Math.log2(probability);
      contributions.push({ token, contribution });
    }

    // Sort by contribution descending
    contributions.sort((a, b) => b.contribution - a.contribution);

    return contributions.slice(0, topK).map(c => c.token);
  }

  /**
   * Clear the cache
   */
  public clearCache(): void {
    this.cache.clear();
    logger.debug('NLP scoring cache cleared');
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): { size: number; oldestEntry: number | null } {
    let oldest: number | null = null;

    for (const entry of this.cache.values()) {
      if (oldest === null || entry.timestamp < oldest) {
        oldest = entry.timestamp;
      }
    }

    return {
      size: this.cache.size,
      oldestEntry: oldest
    };
  }
}