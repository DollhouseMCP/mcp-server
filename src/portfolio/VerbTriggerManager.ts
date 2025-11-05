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
import { EnhancedIndexManager, EnhancedIndex } from './EnhancedIndexManager.js';
import { ElementDefinition } from './EnhancedIndexManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

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
  private indexManager: EnhancedIndexManager | null = null;
  private verbCache: Map<string, ElementMatch[]> = new Map();
  private config: VerbTriggerConfig;

  private constructor(config: VerbTriggerConfig = {}) {
    // Don't initialize indexManager here to avoid circular dependency
    this.config = {
      confidenceThreshold: config.confidenceThreshold || 0.5,
      includeSynonyms: config.includeSynonyms !== false,
      maxElementsPerVerb: config.maxElementsPerVerb || 10,
      customVerbs: config.customVerbs || {}
    };

    logger.debug('VerbTriggerManager initialized', { config: this.config });
  }

  private getIndexManager(): EnhancedIndexManager {
    if (!this.indexManager) {
      this.indexManager = EnhancedIndexManager.getInstance();
    }
    return this.indexManager;
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
    // Unicode validation for security
    const validation = UnicodeValidator.normalize(query);
    if (validation.detectedIssues && validation.detectedIssues.length > 0) {
      SecurityMonitor.logSecurityEvent({
        type: 'UNICODE_VALIDATION_ERROR',
        severity: 'MEDIUM',
        source: 'VerbTriggerManager.extractVerbs',
        details: `Unicode issues in query: ${validation.detectedIssues.join(', ')}`
      });
    }

    const verbs: string[] = [];
    const normalizedQuery = validation.normalizedContent.toLowerCase();

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
      [/([bcdfghjklmnpqrstvwxyz])\1ing$/, '$1'],  // debugging -> debug, running -> run
      [/ing$/, ''],      // creating -> create, testing -> test
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
   * @param verb The verb to search for
   * @param index The index to search in (passed to avoid circular dependency)
   */
  public getElementsForVerb(verb: string, index: EnhancedIndex): ElementMatch[] {
    return this.getElementsForVerbInternal(verb, index, new Set());
  }

  /**
   * Internal version with visited tracking to prevent infinite recursion
   */
  private getElementsForVerbInternal(
    verb: string,
    index: EnhancedIndex,
    visited: Set<string>
  ): ElementMatch[] {
    // Check if we've already processed this verb (prevents infinite recursion)
    if (visited.has(verb)) {
      return [];
    }
    visited.add(verb);

    // Check cache first
    if (this.verbCache.has(verb)) {
      return this.verbCache.get(verb)!;
    }

    const elements: ElementMatch[] = [];

    // 1. Check custom verb mappings first (highest priority)
    if (this.config.customVerbs && this.config.customVerbs[verb]) {
      for (const elementName of this.config.customVerbs[verb]) {
        const elementType = this.findElementType(elementName, index);
        elements.push({
          name: elementName,
          type: elementType,
          confidence: 0.95,  // Very high confidence for custom mappings
          source: 'explicit'
        });
      }
    }

    // 2. Check explicit verb mappings in action_triggers
    if (index.action_triggers[verb]) {
      for (const elementName of index.action_triggers[verb]) {
        const elementType = this.findElementType(elementName, index);
        let confidence = 0.9; // Default for action_triggers

        // Try to get actual confidence from element.actions
        if (elementType !== 'unknown') {
          const element = index.elements[elementType]?.[elementName];
          if (element?.actions) {
            const actionDef = Object.values(element.actions).find(
              (a: any) => a.verb === verb
            );
            if (actionDef?.confidence !== undefined) {
              confidence = actionDef.confidence;
            }
          }
        }

        elements.push({
          name: elementName,
          type: elementType,
          confidence,  // Now uses actual confidence
          source: 'explicit'
        });
      }
    }

    // 3. Check element actions for this verb
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

    // 4. Check synonyms if enabled (with depth limit)
    if (this.config.includeSynonyms && visited.size < 5) {  // Max recursion depth of 5
      const synonyms = this.getSynonyms(verb);
      for (const synonym of synonyms) {
        if (synonym !== verb && !visited.has(synonym)) {
          // Pass the visited set to recursive calls
          const synonymElements = this.getElementsForVerbInternal(synonym, index, visited);
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

    // 5. Infer from element names (e.g., "debug-detective" -> "debug")
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

    // 6. Infer from descriptions
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

    // FIX: Proper audit logging for verb trigger operations
    // Previously: Used 'ELEMENT_CREATED' which was incorrect
    // Now: Using 'VERB_TRIGGERED' for operational observability
    if (limited.length > 0) {
      SecurityMonitor.logSecurityEvent({
        type: 'VERB_TRIGGERED' as any, // Cast needed until security types updated
        severity: 'LOW',
        source: 'VerbTriggerManager.getElementsForVerb',
        details: `Verb '${verb}' triggered, matched ${limited.length} elements`,
        metadata: {
          verb,
          elementCount: limited.length,
          topElement: limited[0]?.name,
          confidence: limited[0]?.confidence
        }
      });
    }

    return limited;
  }

  /**
   * Find element type by name
   */
  private findElementType(elementName: string, index: EnhancedIndex): string {
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
   * @param query The query to process
   * @param index The index to search in
   */
  public processQuery(query: string, index: EnhancedIndex): VerbMatch[] {
    const verbs = this.extractVerbs(query);
    const matches: VerbMatch[] = [];

    for (const verb of verbs) {
      const elements = this.getElementsForVerb(verb, index);
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
   * @param elementName The element to get verbs for
   * @param index The index to search in (passed to avoid circular dependency)
   */
  public getVerbsForElement(elementName: string, index: EnhancedIndex): string[] {
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