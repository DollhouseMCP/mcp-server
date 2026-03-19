import { logger } from '../../utils/logger.js';
import { createRelationship, RelationshipTypes } from '../types/RelationshipTypes.js';
import type { IndexConfiguration } from '../config/IndexConfig.js';
import type { EnhancedIndex } from '../types/IndexTypes.js';
import { parseElementId, parseElementIdStrict, formatElementId } from '../../utils/elementId.js';
import type { NLPScoringManager } from '../NLPScoringManager.js';
import type { RelationshipManager } from '../RelationshipManager.js';

export interface SemanticRelationshipServiceDeps {
  nlpScoring: NLPScoringManager;
  relationshipManager: RelationshipManager;
}

export class SemanticRelationshipService {
  private readonly nlpScoring: NLPScoringManager;
  private readonly relationshipManager: RelationshipManager;

  constructor({ nlpScoring, relationshipManager }: SemanticRelationshipServiceDeps) {
    this.nlpScoring = nlpScoring;
    this.relationshipManager = relationshipManager;
  }

  public async calculate(index: EnhancedIndex, config: IndexConfiguration): Promise<void> {
    const startTime = Date.now();
    const MAX_EXECUTION_TIME = config.performance.circuitBreakerTimeoutMs;

    const elementTexts = new Map<string, string>();
    const elementCount = Object.values(index.elements)
      .reduce((sum, elements) => sum + Object.keys(elements).length, 0);

    logger.info('Starting semantic relationship calculation', {
      elementCount,
      maxForFullMatrix: config.performance.maxElementsForFullMatrix
    });

    for (const [elementType, elements] of Object.entries(index.elements)) {
      for (const [name, element] of Object.entries(elements)) {
        if (Date.now() - startTime > MAX_EXECUTION_TIME) {
          logger.warn('Semantic relationship calculation timeout', {
            elapsed: Date.now() - startTime,
            processed: elementTexts.size
          });
          return;
        }

        const textParts = [
          element.core.name,
          element.core.description || '',
          ...(element.search?.keywords || []),
          ...(element.search?.tags || []),
          ...(element.search?.triggers || [])
        ];

        const fullText = textParts.join(' ');
        const key = `${elementType}:${name}`;
        elementTexts.set(key, fullText);

        if (!element.semantic) {
          element.semantic = {};
        }
        element.semantic.entropy = this.nlpScoring.calculateEntropy(fullText);
        element.semantic.unique_terms = fullText.split(/\s+/).filter(t => t.length > 1).length;
      }
    }

    const keys = Array.from(elementTexts.keys());
    const MAX_SAFE_ELEMENTS = 50;
    const MAX_SAFE_COMPARISONS = 500;

    const safeConfig = {
      ...config,
      performance: {
        ...config.performance,
        maxElementsForFullMatrix: Math.min(
          config.performance.maxElementsForFullMatrix,
          MAX_SAFE_ELEMENTS
        ),
        maxSimilarityComparisons: Math.min(
          config.performance.maxSimilarityComparisons,
          MAX_SAFE_COMPARISONS
        )
      }
    } as IndexConfiguration;

    if (keys.length <= safeConfig.performance.maxElementsForFullMatrix) {
      await this.calculateFullMatrix(index, elementTexts, keys, safeConfig);
    } else {
      await this.calculateSampledRelationships(index, elementTexts, keys, safeConfig);
    }

    const duration = Date.now() - startTime;
    logger.info('Semantic relationships calculated', {
      elements: elementTexts.size,
      duration: `${duration}ms`,
      strategy: keys.length <= config.performance.maxElementsForFullMatrix ? 'full' : 'sampled',
      timedOut: duration > MAX_EXECUTION_TIME
    });
  }

  private async calculateFullMatrix(
    index: EnhancedIndex,
    elementTexts: Map<string, string>,
    keys: string[],
    config: IndexConfiguration
  ): Promise<void> {
    let comparisons = 0;
    const batchSize = config.performance.similarityBatchSize;
    const threshold = config.performance.similarityThreshold;
    const startTime = Date.now();
    const MAX_EXECUTION_TIME = config.performance.circuitBreakerTimeoutMs;

    for (let i = 0; i < keys.length; i++) {
      if (Date.now() - startTime > MAX_EXECUTION_TIME) {
        logger.warn('Full matrix calculation timeout', {
          elapsed: Date.now() - startTime,
          processed: `${i}/${keys.length}`,
          comparisons
        });
        return;
      }

      const key1 = keys[i];
      const parsed1 = parseElementIdStrict(key1);
      const text1 = elementTexts.get(key1)!;

      const batch: Array<{ key2: string; type2: string; name2: string }> = [];
      for (let j = i + 1; j < keys.length && batch.length < batchSize; j++) {
        const key2 = keys[j];
        const parsed2 = parseElementIdStrict(key2);
        batch.push({ key2, type2: parsed2.type, name2: parsed2.name });
      }

      await Promise.all(batch.map(async ({ key2, type2, name2 }) => {
        const text2 = elementTexts.get(key2)!;
        const scoring = this.nlpScoring.scoreRelevance(text1, text2);

        if (scoring.combinedScore > threshold) {
          const element1 = index.elements[parsed1.type]?.[parsed1.name];
          const element2 = index.elements[type2]?.[name2];
          if (!element1 || !element2) return;
          this.storeRelationship(index, parsed1.type, parsed1.name, type2, name2, scoring);
        }
      }));

      comparisons += batch.length;

      if (comparisons % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }

  private async calculateSampledRelationships(
    index: EnhancedIndex,
    elementTexts: Map<string, string>,
    keys: string[],
    config: IndexConfiguration
  ): Promise<void> {
    const threshold = config.performance.similarityThreshold;
    const maxComparisons = config.performance.maxSimilarityComparisons;

    logger.info('Using sampled relationship calculation', {
      elements: keys.length,
      maxComparisons
    });

    if (keys.length === 0) {
      logger.debug('No elements to calculate relationships for');
      return;
    }

    const keywordClusters = await this.buildKeywordClusters(index, keys);
    let comparisons = 0;
    const clusterBudgetRatio = 0.6;
    const clusterComparisons = Math.floor(maxComparisons * clusterBudgetRatio);

    for (const [, clusterKeys] of keywordClusters.entries()) {
      if (comparisons >= clusterComparisons) break;

      for (let i = 0; i < clusterKeys.length - 1; i++) {
        if (comparisons >= clusterComparisons) break;

        const key1 = clusterKeys[i];
        const parsed1 = parseElementIdStrict(key1);
        const text1 = elementTexts.get(key1)!;

        const sampleSize = Math.min(
          Math.ceil(Math.sqrt(clusterKeys.length - i - 1)),
          config.sampling.clusterSampleLimit
        );

        const sampledIndices = this.randomSample(
          Array.from({ length: clusterKeys.length - i - 1 }, (_, j) => i + j + 1),
          sampleSize
        );

        for (const j of sampledIndices) {
          if (comparisons >= clusterComparisons) break;

          const key2 = clusterKeys[j];
          const parsed2 = parseElementIdStrict(key2);
          const text2 = elementTexts.get(key2)!;
          const scoring = this.nlpScoring.scoreRelevance(text1, text2);
          comparisons++;

          if (scoring.combinedScore > threshold) {
            this.storeRelationship(index, parsed1.type, parsed1.name, parsed2.type, parsed2.name, scoring);
          }
        }
      }

      if (comparisons % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    const crossTypeComparisons = maxComparisons - comparisons;
    if (comparisons >= maxComparisons || crossTypeComparisons <= 0) {
      logger.debug('Skipping cross-type sampling, comparison budget exhausted', {
        comparisons,
        maxComparisons
      });
      return;
    }

    const elementsByType = new Map<string, string[]>();
    const typeCounts = new Map<string, number>();

    for (const key of keys) {
      const parsed = parseElementId(key);
      if (!parsed) continue;
      if (!elementsByType.has(parsed.type)) {
        elementsByType.set(parsed.type, []);
        typeCounts.set(parsed.type, 0);
      }
      elementsByType.get(parsed.type)!.push(key);
      typeCounts.set(parsed.type, typeCounts.get(parsed.type)! + 1);
    }

    const totalElements = keys.length;
    const typeSampleSizes = new Map<string, number>();

    for (const [type, count] of typeCounts.entries()) {
      const proportion = count / totalElements;
      const allocatedComparisons = Math.max(1, Math.floor(crossTypeComparisons * proportion));
      const sampleSize = Math.ceil(Math.sqrt(allocatedComparisons));
      typeSampleSizes.set(type, sampleSize);
    }

    logger.debug('Proportional sampling distribution', {
      typeCounts: Object.fromEntries(typeCounts),
      sampleSizes: Object.fromEntries(typeSampleSizes)
    });

    const maxKeysToProcess = Math.min(
      Math.ceil(Math.sqrt(keys.length)),
      Math.ceil(crossTypeComparisons / Math.max(1, typeSampleSizes.size))
    );

    const sampledKeys1 = this.randomSample(keys, maxKeysToProcess);

    logger.debug('Cross-type sampling with limited key set', {
      totalKeys: keys.length,
      sampledKeys: sampledKeys1.length,
      maxKeysToProcess
    });

    for (const key1 of sampledKeys1) {
      if (comparisons >= maxComparisons) break;

      const parsed1 = parseElementIdStrict(key1);
      const text1 = elementTexts.get(key1)!;

      for (const [type, sampleSize] of typeSampleSizes.entries()) {
        if (comparisons >= maxComparisons) break;

        const keysOfType = elementsByType.get(type);
        if (!keysOfType || keysOfType.length === 0) continue;

        const sampledKeys2 = this.randomSample(keysOfType, sampleSize);

        for (const key2 of sampledKeys2) {
          if (comparisons >= maxComparisons) break;
          if (key1 === key2) continue;

          const parsed2 = parseElementIdStrict(key2);
          const text2 = elementTexts.get(key2)!;
          const scoring = this.nlpScoring.scoreRelevance(text1, text2);
          comparisons++;

          if (scoring.combinedScore > threshold) {
            this.storeRelationship(index, parsed1.type, parsed1.name, parsed2.type, parsed2.name, scoring);
          }
        }
      }
    }
  }

  private async buildKeywordClusters(
    index: EnhancedIndex,
    keys: string[]
  ): Promise<Map<string, string[]>> {
    const keywordFrequency = new Map<string, number>();

    for (const key of keys) {
      const parsed = parseElementIdStrict(key);
      const element = index.elements[parsed.type]?.[parsed.name];
      if (!element) continue;

      const keywords = [
        ...(element.search?.keywords || []),
        ...(element.search?.tags || []),
        ...(element.search?.triggers || [])
      ];

      for (const keyword of keywords) {
        const normalized = keyword.toLowerCase();
        keywordFrequency.set(normalized, (keywordFrequency.get(normalized) || 0) + 1);
      }
    }

    const clusters = new Map<string, string[]>();
    for (const key of keys) {
      const parsed = parseElementIdStrict(key);
      const element = index.elements[parsed.type]?.[parsed.name];
      if (!element) continue;

      const keywords = [
        ...(element.search?.keywords || []),
        ...(element.search?.tags || []),
        ...(element.search?.triggers || [])
      ];

      for (const keyword of keywords) {
        const normalized = keyword.toLowerCase();
        const frequency = keywordFrequency.get(normalized) || 0;
        if (frequency < 2) continue;

        if (!clusters.has(normalized)) {
          clusters.set(normalized, []);
        }
        clusters.get(normalized)!.push(key);
      }
    }

    const significantClusters = new Map<string, string[]>();
    const maxFrequency = Math.floor(keys.length * 0.5);

    for (const [keyword, elementKeys] of clusters.entries()) {
      if (elementKeys.length >= 2 && elementKeys.length <= maxFrequency) {
        significantClusters.set(keyword, elementKeys);
      }
    }

    logger.debug('Keyword clusters built', {
      totalClusters: clusters.size,
      significantClusters: significantClusters.size,
      largestCluster: Math.max(...Array.from(significantClusters.values()).map(v => v.length))
    });

    return significantClusters;
  }

  private storeRelationship(
    index: EnhancedIndex,
    type1: string,
    name1: string,
    type2: string,
    name2: string,
    scoring: any
  ): void {
    if (!index.elements[type1][name1].relationships) {
      index.elements[type1][name1].relationships = {};
    }
    if (!index.elements[type1][name1].relationships.similar) {
      index.elements[type1][name1].relationships.similar = [];
    }

    const targetElement = formatElementId(type2, name2);
    const existing1 = index.elements[type1][name1].relationships.similar
      .find(r => r.element === targetElement);

    if (!existing1) {
      index.elements[type1][name1].relationships.similar.push(createRelationship(
        type2,
        name2,
        RelationshipTypes.SEMANTIC_SIMILARITY,
        scoring.combinedScore,
        {
          jaccard: scoring.jaccard,
          entropy_diff: Math.abs(
            (index.elements[type1][name1].semantic?.entropy || 0) -
            (index.elements[type2][name2].semantic?.entropy || 0)
          )
        }
      ));
    }

    if (!index.elements[type2][name2].relationships) {
      index.elements[type2][name2].relationships = {};
    }
    if (!index.elements[type2][name2].relationships.similar) {
      index.elements[type2][name2].relationships.similar = [];
    }

    const sourceElement = formatElementId(type1, name1);
    const existing2 = index.elements[type2][name2].relationships.similar
      .find(r => r.element === sourceElement);

    if (!existing2) {
      index.elements[type2][name2].relationships.similar.push(createRelationship(
        type1,
        name1,
        RelationshipTypes.SEMANTIC_SIMILARITY,
        scoring.combinedScore,
        {
          jaccard: scoring.jaccard,
          entropy_diff: Math.abs(
            (index.elements[type1][name1].semantic?.entropy || 0) -
            (index.elements[type2][name2].semantic?.entropy || 0)
          )
        }
      ));
    }
  }

  private randomSample<T>(array: T[], size: number): T[] {
    const shuffled = [...array].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, size);
  }
}
