import { logger } from '../../utils/logger.js';
import type { ElementDefinition } from '../types/IndexTypes.js';

export interface TriggerExtractionConfig {
  limits: {
    maxTriggersPerElement: number;
    maxTriggerLength: number;
    maxKeywordsToCheck: number;
  };
  verbPrefixes: Record<string, string[]>;
  verbSuffixes: string[];
  nounSuffixes: string[];
  telemetry: {
    enabled: boolean;
    sampleRate: number;
    metricsInterval: number;
  };
}

export interface TriggerExtractionPatterns {
  verbPrefixPattern: RegExp;
  verbSuffixPattern: RegExp;
  nounSuffixPattern: RegExp;
}

export interface TriggerExtractionResult {
  triggers: string[];
  extractedCount: number;
}

export interface ActionTriggerExtractorContext {
  getConfig: () => TriggerExtractionConfig;
  getPatterns: () => TriggerExtractionPatterns;
}

export class ActionTriggerExtractor {
  constructor(private readonly context: ActionTriggerExtractorContext) {}

  public extract(
    elementDef: ElementDefinition | null | undefined,
    elementName: string
  ): TriggerExtractionResult {
    if (!elementDef) {
      return { triggers: [], extractedCount: 0 };
    }

    const config = this.context.getConfig();
    const patterns = this.context.getPatterns();
    const elementTriggers = new Set<string>();

    this.extractFromSearchField(elementDef, elementName, elementTriggers, config);
    this.extractFromActions(elementDef, elementName, elementTriggers, config);
    this.extractFromKeywords(elementDef, elementName, elementTriggers, config, patterns);

    return {
      triggers: Array.from(elementTriggers),
      extractedCount: elementTriggers.size
    };
  }

  private extractFromSearchField(
    elementDef: ElementDefinition,
    elementName: string,
    elementTriggers: Set<string>,
    config: TriggerExtractionConfig
  ): void {
    if (!elementDef.search?.triggers) return;
    const triggerArray = this.normalizeToArray(elementDef.search.triggers);

    for (const trigger of triggerArray) {
      if (this.hasReachedTriggerLimit(elementTriggers, elementName, config)) {
        break;
      }

      const normalizedTrigger = this.normalizeTrigger(trigger, config);
      if (!normalizedTrigger) continue;

      elementTriggers.add(normalizedTrigger);
    }
  }

  private extractFromActions(
    elementDef: ElementDefinition,
    elementName: string,
    elementTriggers: Set<string>,
    config: TriggerExtractionConfig
  ): void {
    if (!elementDef.actions) return;

    for (const [actionKey, action] of Object.entries(elementDef.actions)) {
      if (this.hasReachedTriggerLimit(elementTriggers, elementName, config)) {
        break;
      }

      const verb = action.verb || actionKey;
      const normalizedVerb = this.normalizeTrigger(verb, config);
      if (!normalizedVerb) continue;

      elementTriggers.add(normalizedVerb);
    }
  }

  private extractFromKeywords(
    elementDef: ElementDefinition,
    elementName: string,
    elementTriggers: Set<string>,
    config: TriggerExtractionConfig,
    patterns: TriggerExtractionPatterns
  ): void {
    if (!elementDef.search?.keywords) return;

    const keywords = this.normalizeToArray(elementDef.search.keywords);
    const limit = Math.min(keywords.length, config.limits.maxKeywordsToCheck);

    for (let i = 0; i < limit; i++) {
      const keyword = keywords[i];
      if (this.hasReachedTriggerLimit(elementTriggers, elementName, config)) {
        break;
      }

      const normalizedKeyword = this.normalizeTrigger(keyword, config);
      if (!normalizedKeyword || !this.looksLikeVerb(normalizedKeyword, patterns)) {
        continue;
      }

      elementTriggers.add(normalizedKeyword);
    }
  }

  private normalizeToArray(value: any): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.filter(v => typeof v === 'string');
    }
    if (typeof value === 'string') {
      return [value];
    }
    return [];
  }

  private normalizeTrigger(trigger: any, config: TriggerExtractionConfig): string | null {
    if (typeof trigger !== 'string') return null;

    const normalized = trigger.trim().toLowerCase();
    if (!normalized ||
        normalized.length > config.limits.maxTriggerLength ||
        !/^[a-z][a-z-]*$/.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private hasReachedTriggerLimit(
    elementTriggers: Set<string>,
    elementName: string,
    config: TriggerExtractionConfig
  ): boolean {
    if (elementTriggers.size < config.limits.maxTriggersPerElement) {
      return false;
    }

    logger.warn('Trigger limit exceeded for element', {
      elementName,
      limit: config.limits.maxTriggersPerElement
    });
    return true;
  }

  private looksLikeVerb(word: string, patterns: TriggerExtractionPatterns): boolean {
    const lowerWord = word.toLowerCase();

    if (patterns.nounSuffixPattern.test(lowerWord)) {
      return false;
    }

    return patterns.verbPrefixPattern.test(lowerWord) ||
           patterns.verbSuffixPattern.test(lowerWord);
  }
}
