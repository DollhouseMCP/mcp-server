import { describe, it, expect } from '@jest/globals';
import { ActionTriggerExtractor } from '../../../../src/portfolio/enhanced-index/ActionTriggerExtractor.js';
import type {
  TriggerExtractionConfig,
  TriggerExtractionPatterns
} from '../../../../src/portfolio/enhanced-index/ActionTriggerExtractor.js';
import type { ElementDefinition } from '../../../../src/portfolio/types/IndexTypes.js';

const createExtractor = (
  overrideConfig?: Partial<TriggerExtractionConfig>
) => {
  const baseConfig: TriggerExtractionConfig = {
    limits: {
      maxTriggersPerElement: 10,
      maxTriggerLength: 50,
      maxKeywordsToCheck: 10
    },
    verbPrefixes: {
      default: ['debug', 'test', 'create']
    },
    verbSuffixes: ['ify', 'ize', 'ate'],
    nounSuffixes: ['tion', 'ment'],
    telemetry: {
      enabled: false,
      sampleRate: 0,
      metricsInterval: 1000
    }
  };

  const config: TriggerExtractionConfig = {
    ...baseConfig,
    ...overrideConfig,
    limits: {
      ...baseConfig.limits,
      ...overrideConfig?.limits
    },
    verbPrefixes: overrideConfig?.verbPrefixes ?? baseConfig.verbPrefixes,
    verbSuffixes: overrideConfig?.verbSuffixes ?? baseConfig.verbSuffixes,
    nounSuffixes: overrideConfig?.nounSuffixes ?? baseConfig.nounSuffixes,
    telemetry: overrideConfig?.telemetry ?? baseConfig.telemetry
  };

  const patterns: TriggerExtractionPatterns = {
    verbPrefixPattern: /^(debug|test|create)/,
    verbSuffixPattern: /(ify|ize|ate)$/,
    nounSuffixPattern: /(tion|ment)$/
  };

  return new ActionTriggerExtractor({
    getConfig: () => config,
    getPatterns: () => patterns
  });
};

describe('ActionTriggerExtractor', () => {
  it('extracts normalized triggers from search fields, actions, and keywords', () => {
    const extractor = createExtractor();
    const elementDef: ElementDefinition = {
      core: {
        name: 'Test Persona',
        type: 'personas'
      },
      search: {
        triggers: ['Debug', ' troubleshoot '],
        keywords: ['create', 'optimize']
      },
      actions: {
        fix: { verb: 'Fix', behavior: 'activate', confidence: 0.9 }
      }
    } as ElementDefinition;

    const result = extractor.extract(elementDef, 'test-persona');

    expect(new Set(result.triggers)).toEqual(new Set(['debug', 'troubleshoot', 'create', 'fix', 'optimize']));
    expect(result.extractedCount).toBe(5);
  });

  it('enforces trigger limits to prevent overload', () => {
    const extractor = createExtractor({
      limits: {
        maxTriggersPerElement: 2,
        maxTriggerLength: 50,
        maxKeywordsToCheck: 10
      }
    });

    const elementDef: ElementDefinition = {
      core: {
        name: 'Limit Persona',
        type: 'personas'
      },
      search: {
        triggers: ['debug', 'test', 'create']
      }
    } as ElementDefinition;

    const result = extractor.extract(elementDef, 'limit-persona');
    expect(result.triggers.length).toBe(2);
  });
});
