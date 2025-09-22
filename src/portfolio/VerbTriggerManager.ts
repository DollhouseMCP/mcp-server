/**
 * Verb Trigger Manager - Maps action verbs to elements
 *
 * This manager handles verb-based action triggers that map user intent
 * to specific elements. Uses action verbs (debug, fix, create) instead
 * of nouns for better intent matching.
 *
 * Key principles:
 * - Verbs have higher attention probability than nouns
 * - Multiple verbs can map to the same element
 * - Verbs are extracted from queries and element metadata
 * - Supports synonyms and related verb forms
 */

import { logger } from '../utils/logger.js';
import { EnhancedIndexManager } from './EnhancedIndexManager.js';
import { ElementDefinition } from './EnhancedIndexManager.js';

/**
 * Verb taxonomy - Common verbs grouped by intent
 */
export const VERB_TAXONOMY = {
  // Debugging & Fixing
  debugging: ['debug', 'fix', 'troubleshoot', 'diagnose', 'solve', 'resolve', 'repair'],

  // Creating & Writing
  creation: ['create', 'write', 'generate', 'make', 'build', 'construct', 'compose'],

  // Explanation & Learning
  explanation: ['explain', 'teach', 'clarify', 'describe', 'simplify', 'elaborate', 'define'],

  // Analysis & Investigation
  analysis: ['analyze', 'investigate', 'examine', 'inspect', 'review', 'assess', 'evaluate'],

  // Memory & Recall
  recall: ['remember', 'recall', 'retrieve', 'find', 'locate', 'search', 'lookup'],

  // Execution & Running
  execution: ['run', 'execute', 'start', 'launch', 'activate', 'trigger', 'invoke'],

  // Testing & Validation
  testing: ['test', 'verify', 'validate', 'check', 'confirm', 'ensure', 'prove'],

  // Configuration & Setup
  configuration: ['configure', 'setup', 'install', 'initialize', 'prepare', 'arrange'],

  // Security & Protection
  security: ['secure', 'protect', 'audit', 'scan', 'encrypt', 'authenticate', 'authorize'],

  // Optimization & Improvement
  optimization: ['optimize', 'improve', 'enhance', 'refactor', 'streamline', 'accelerate'],

  // Documentation
  documentation: ['document', 'annotate', 'comment', 'record', 'note', 'log'],

  // Collaboration
  collaboration: ['share', 'collaborate', 'sync', 'merge', 'integrate', 'combine']
};

/**
 * Verb trigger configuration
 */
export interface VerbTriggerConfig {
  // Minimum confidence to trigger
  confidenceThreshold?: number;

  // Whether to include synonyms
  includeSynonyms?: boolean;

  // Maximum elements to return per verb
  maxElementsPerVerb?: number;

  // Custom verb mappings
  customVerbs?: Record<string, string[]>;
}

/**
 * Verb match result
 */
export interface VerbMatch {
  verb: string;
  elements: ElementMatch[];
  category?: string;
}

export interface ElementMatch {
  name: string;
  type: string;
  confidence: number;
  source: 'explicit' | 'inferred' | 'name-based' | 'description-based';
}

export class VerbTriggerManager {
  private static instance: VerbTriggerManager | null = null;
  private indexManager: EnhancedIndexManager;
  private verbCache: Map<string, ElementMatch[]> = new Map();
  private config: VerbTriggerConfig;

  private constructor(config: VerbTriggerConfig = {}) {
    this.indexManager = EnhancedIndexManager.getInstance();
    this.config = {
      confidenceThreshold: config.confidenceThreshold || 0.5,
      includeSynonyms: config.includeSynonyms !== false,
      maxElementsPerVerb: config.maxElementsPerVerb || 10,
      customVerbs: config.customVerbs || {}
    };

    logger.debug('VerbTriggerManager initialized', { config: this.config });
  }

  public static getInstance(config?: VerbTriggerConfig): VerbTriggerManager {
    if (!this.instance) {
      this.instance = new VerbTriggerManager(config);
    }
    return this.instance;
  }

  /**
   * Extract verbs from a user query
   */
  public extractVerbs(query: string): string[] {
    const verbs: string[] = [];
    const normalizedQuery = query.toLowerCase();

    // Check each word against our verb taxonomy
    const words = normalizedQuery.split(/\s+/);

    for (const word of words) {
      // Direct verb check
      if (this.isKnownVerb(word)) {
        verbs.push(word);
      }

      // Check for imperative forms (common in commands)
      // "debug this", "fix the error", "create a test"
      const imperativePatterns = [
        /^(debug|fix|create|write|test|run|explain|analyze)/,
        /(ing)$/  // Gerunds: debugging, testing, creating
      ];

      for (const pattern of imperativePatterns) {
        if (pattern.test(word) && !verbs.includes(word)) {
          const baseVerb = this.getBaseVerb(word);
          if (baseVerb) verbs.push(baseVerb);
        }
      }
    }

    // Also check for verb phrases
    const verbPhrases = [
      'figure out', 'work out', 'sort out', 'find out',
      'set up', 'clean up', 'follow up',
      'break down', 'write down', 'track down'
    ];

    for (const phrase of verbPhrases) {
      if (normalizedQuery.includes(phrase)) {
        // Map phrases to base verbs
        const baseVerb = this.mapPhraseToVerb(phrase);
        if (baseVerb && !verbs.includes(baseVerb)) {
          verbs.push(baseVerb);
        }
      }
    }

    // Include custom verbs from config
    for (const customVerb of Object.keys(this.config.customVerbs || {})) {
      if (normalizedQuery.includes(customVerb) && !verbs.includes(customVerb)) {
        verbs.push(customVerb);
      }
    }

    logger.debug('Extracted verbs from query', { query, verbs });
    return verbs;
  }

  /**
   * Check if a word is a known verb
   */
  private isKnownVerb(word: string): boolean {
    for (const verbs of Object.values(VERB_TAXONOMY)) {
      if (verbs.includes(word)) return true;
    }
    return false;
  }

  /**
   * Get base form of a verb (remove -ing, -ed, etc.)
   */
  private getBaseVerb(word: string): string | null {
    // Handle common verb endings
    const transformations: [RegExp, string][] = [
      [/ing$/, ''],      // debugging -> debug
      [/ying$/, 'y'],    // applying -> apply
      [/ied$/, 'y'],     // simplified -> simplify
      [/ed$/, ''],       // created -> create
      [/ted$/, 't'],     // started -> start
      [/ses$/, 's'],     // analyses -> analyse
      [/zes$/, 'ze'],    // analyzes -> analyze
      [/ves$/, 've'],    // improves -> improve
    ];

    for (const [pattern, replacement] of transformations) {
      if (pattern.test(word)) {
        const base = word.replace(pattern, replacement);
        if (this.isKnownVerb(base)) return base;
      }
    }

    // Check if it's already a base verb
    if (this.isKnownVerb(word)) return word;

    return null;
  }

  /**
   * Map verb phrases to base verbs
   */
  private mapPhraseToVerb(phrase: string): string | null {
    const phraseMap: Record<string, string> = {
      'figure out': 'solve',
      'work out': 'solve',
      'sort out': 'fix',
      'find out': 'discover',
      'set up': 'configure',
      'clean up': 'refactor',
      'follow up': 'track',
      'break down': 'analyze',
      'write down': 'document',
      'track down': 'find'
    };

    return phraseMap[phrase] || null;
  }

  /**
   * Get elements that match a specific verb
   */
  public async getElementsForVerb(verb: string): Promise<ElementMatch[]> {
    // Check cache first
    if (this.verbCache.has(verb)) {
      return this.verbCache.get(verb)!;
    }

    const elements: ElementMatch[] = [];
    const index = await this.indexManager.getIndex();

    // 1. Check explicit verb mappings in action_triggers
    if (index.action_triggers[verb]) {
      for (const elementName of index.action_triggers[verb]) {
        elements.push({
          name: elementName,
          type: this.findElementType(elementName, index),
          confidence: 0.9,  // High confidence for explicit mappings
          source: 'explicit'
        });
      }
    }

    // 2. Check element actions for this verb
    for (const [type, typeElements] of Object.entries(index.elements)) {
      for (const [name, element] of Object.entries(typeElements)) {
        if (element.actions) {
          for (const action of Object.values(element.actions)) {
            if (action.verb === verb) {
              const existing = elements.find(e => e.name === name);
              if (!existing) {
                elements.push({
                  name,
                  type,
                  confidence: action.confidence || 0.7,
                  source: 'explicit'
                });
              }
            }
          }
        }
      }
    }

    // 3. Check synonyms if enabled
    if (this.config.includeSynonyms) {
      const synonyms = this.getSynonyms(verb);
      for (const synonym of synonyms) {
        if (synonym !== verb) {
          const synonymElements = await this.getElementsForVerb(synonym);
          for (const elem of synonymElements) {
            const existing = elements.find(e => e.name === elem.name);
            if (!existing) {
              elements.push({
                ...elem,
                confidence: elem.confidence * 0.8, // Lower confidence for synonyms
                source: 'inferred'
              });
            }
          }
        }
      }
    }

    // 4. Infer from element names (e.g., "debug-detective" -> "debug")
    for (const [type, typeElements] of Object.entries(index.elements)) {
      for (const [name, element] of Object.entries(typeElements)) {
        const elementNameLower = name.toLowerCase();
        if (elementNameLower.includes(verb) ||
            elementNameLower.includes(this.getBaseVerb(verb) || verb)) {
          const existing = elements.find(e => e.name === name);
          if (!existing) {
            elements.push({
              name,
              type,
              confidence: 0.6,  // Medium confidence for name-based
              source: 'name-based'
            });
          }
        }
      }
    }

    // 5. Infer from descriptions
    for (const [type, typeElements] of Object.entries(index.elements)) {
      for (const [name, element] of Object.entries(typeElements)) {
        if (element.core.description) {
          const descLower = element.core.description.toLowerCase();
          if (descLower.includes(verb) || descLower.includes(this.getBaseVerb(verb) || verb)) {
            const existing = elements.find(e => e.name === name);
            if (!existing) {
              elements.push({
                name,
                type,
                confidence: 0.4,  // Lower confidence for description-based
                source: 'description-based'
              });
            }
          }
        }
      }
    }

    // Filter by confidence threshold
    const filtered = elements.filter(e => e.confidence >= this.config.confidenceThreshold!);

    // Sort by confidence (highest first)
    filtered.sort((a, b) => b.confidence - a.confidence);

    // Limit results
    const limited = filtered.slice(0, this.config.maxElementsPerVerb);

    // Cache the results
    this.verbCache.set(verb, limited);

    return limited;
  }

  /**
   * Find element type by name
   */
  private findElementType(elementName: string, index: any): string {
    for (const [type, elements] of Object.entries(index.elements)) {
      if ((elements as any)[elementName]) {
        return type;
      }
    }
    return 'unknown';
  }

  /**
   * Get synonyms for a verb
   */
  private getSynonyms(verb: string): string[] {
    for (const [category, verbs] of Object.entries(VERB_TAXONOMY)) {
      if (verbs.includes(verb)) {
        return verbs;
      }
    }
    return [verb];
  }

  /**
   * Get verb category
   */
  public getVerbCategory(verb: string): string | null {
    for (const [category, verbs] of Object.entries(VERB_TAXONOMY)) {
      if (verbs.includes(verb)) {
        return category;
      }
    }
    return null;
  }

  /**
   * Process a query and get all verb matches
   */
  public async processQuery(query: string): Promise<VerbMatch[]> {
    const verbs = this.extractVerbs(query);
    const matches: VerbMatch[] = [];

    for (const verb of verbs) {
      const elements = await this.getElementsForVerb(verb);
      if (elements.length > 0) {
        matches.push({
          verb,
          elements,
          category: this.getVerbCategory(verb) || undefined
        });
      }
    }

    logger.info('Processed query for verb triggers', {
      query,
      verbsFound: verbs.length,
      matchesFound: matches.length
    });

    return matches;
  }

  /**
   * Add custom verb mapping
   */
  public addCustomVerb(verb: string, elements: string[]): void {
    if (!this.config.customVerbs) {
      this.config.customVerbs = {};
    }
    this.config.customVerbs[verb] = elements;

    // Clear cache for this verb
    this.verbCache.delete(verb);

    logger.debug('Added custom verb mapping', { verb, elements });
  }

  /**
   * Clear verb cache (useful after index updates)
   */
  public clearCache(): void {
    this.verbCache.clear();
    logger.debug('Verb cache cleared');
  }

  /**
   * Get all verbs that map to a specific element
   */
  public async getVerbsForElement(elementName: string): Promise<string[]> {
    const index = await this.indexManager.getIndex();
    const verbs: string[] = [];

    // Check action_triggers
    for (const [verb, elements] of Object.entries(index.action_triggers)) {
      if (elements.includes(elementName)) {
        verbs.push(verb);
      }
    }

    // Check element's own actions
    for (const typeElements of Object.values(index.elements)) {
      const element = (typeElements as any)[elementName];
      if (element?.actions) {
        for (const action of Object.values(element.actions)) {
          const actionVerb = (action as any).verb;
          if (actionVerb && !verbs.includes(actionVerb)) {
            verbs.push(actionVerb);
          }
        }
      }
    }

    // Check name-based inference
    const elementNameLower = elementName.toLowerCase();
    for (const verbList of Object.values(VERB_TAXONOMY)) {
      for (const verb of verbList) {
        if (elementNameLower.includes(verb) && !verbs.includes(verb)) {
          verbs.push(verb);
        }
      }
    }

    return verbs;
  }

  /**
   * Generate suggested verbs for an element based on its type and name
   */
  public suggestVerbsForElement(element: ElementDefinition): string[] {
    const suggestions: string[] = [];
    const name = element.core.name.toLowerCase();
    const type = element.core.type;

    // Type-based suggestions
    switch (type) {
      case 'personas':
        if (name.includes('debug')) {
          suggestions.push('debug', 'fix', 'troubleshoot');
        }
        if (name.includes('creative') || name.includes('writer')) {
          suggestions.push('write', 'create', 'compose');
        }
        if (name.includes('analyst')) {
          suggestions.push('analyze', 'examine', 'investigate');
        }
        if (name.includes('explain')) {
          suggestions.push('explain', 'teach', 'simplify');
        }
        break;

      case 'memories':
        suggestions.push('remember', 'recall', 'retrieve');
        if (name.includes('session')) {
          suggestions.push('review', 'find');
        }
        break;

      case 'skills':
        suggestions.push('use', 'apply', 'execute');
        break;

      case 'templates':
        suggestions.push('create', 'generate', 'fill');
        break;

      case 'agents':
        suggestions.push('run', 'execute', 'activate');
        break;
    }

    // Name-based suggestions
    for (const [category, verbs] of Object.entries(VERB_TAXONOMY)) {
      for (const verb of verbs) {
        if (name.includes(verb) && !suggestions.includes(verb)) {
          suggestions.push(verb);
        }
      }
    }

    return [...new Set(suggestions)];  // Remove duplicates
  }
}