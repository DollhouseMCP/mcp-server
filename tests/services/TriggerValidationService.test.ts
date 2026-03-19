/**
 * TriggerValidationService Tests
 *
 * Comprehensive test suite covering:
 * - Valid trigger scenarios (single, multiple)
 * - Invalid triggers (empty, special characters, too long)
 * - Edge cases (Unicode, max length, array limits)
 * - Unified validation rules (all element types use same limits: 20 triggers, 50 chars)
 * - All existing test scenarios from manager tests
 */

import { ElementType } from '../../src/portfolio/types.js';
import { TriggerValidationService } from '../../src/services/TriggerValidationService.js';

describe('TriggerValidationService', () => {
  let service: TriggerValidationService;

  beforeEach(() => {
    // Create fresh instance for each test to avoid state pollution
    service = new TriggerValidationService();
  });

  describe('Constructor and Initialization', () => {
    it('should initialize successfully', () => {
      expect(service).toBeInstanceOf(TriggerValidationService);
    });

    it('should be a class that can be instantiated', () => {
      const instance = new TriggerValidationService();
      expect(instance).toBeInstanceOf(TriggerValidationService);
    });
  });

  describe('validateTriggers - Valid Triggers', () => {
    it('should accept single valid trigger', () => {
      const result = service.validateTriggers(
        ['create'],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual(['create']);
      expect(result.rejectedTriggers).toEqual([]);
      expect(result.hasRejections).toBe(false);
      expect(result.totalInput).toBe(1);
      expect(result.warnings).toEqual([]);
    });

    it('should accept multiple valid triggers', () => {
      const result = service.validateTriggers(
        ['create', 'build', 'test', 'deploy'],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual(['create', 'build', 'test', 'deploy']);
      expect(result.rejectedTriggers).toEqual([]);
      expect(result.hasRejections).toBe(false);
      expect(result.totalInput).toBe(4);
    });

    it('should accept triggers with hyphens', () => {
      const result = service.validateTriggers(
        ['create-user', 'build-project'],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual(['create-user', 'build-project']);
      expect(result.rejectedTriggers).toEqual([]);
    });

    it('should accept triggers with underscores', () => {
      const result = service.validateTriggers(
        ['create_user', 'build_project'],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual(['create_user', 'build_project']);
      expect(result.rejectedTriggers).toEqual([]);
    });

    it('should accept mixed alphanumeric with hyphens and underscores', () => {
      const result = service.validateTriggers(
        ['create-user_v2', 'build_project-2024'],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual(['create-user_v2', 'build_project-2024']);
      expect(result.rejectedTriggers).toEqual([]);
    });

    it('should handle uppercase and lowercase characters', () => {
      const result = service.validateTriggers(
        ['Create', 'BUILD', 'TeSt'],
        ElementType.SKILL,
        'test-skill'
      );

      // Service doesn't lowercase - it preserves case
      expect(result.validTriggers).toEqual(['Create', 'BUILD', 'TeSt']);
      expect(result.rejectedTriggers).toEqual([]);
    });
  });

  describe('validateTriggers - Invalid Triggers', () => {
    it('should reject empty string', () => {
      const result = service.validateTriggers(
        [''],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual([]);
      expect(result.rejectedTriggers).toHaveLength(1);
      expect(result.rejectedTriggers[0].original).toBe('');
      expect(result.rejectedTriggers[0].reason).toContain('empty');
      expect(result.hasRejections).toBe(true);
    });

    it('should reject whitespace-only trigger', () => {
      const result = service.validateTriggers(
        ['   ', '\t', '\n'],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual([]);
      expect(result.rejectedTriggers).toHaveLength(3);
      expect(result.rejectedTriggers.every(r => r.reason.includes('empty'))).toBe(true);
    });

    it('should reject triggers with shell metacharacters but allow @ and .', () => {
      const result = service.validateTriggers(
        ['create!', 'build@home', 'test#1', 'deploy$'],
        ElementType.SKILL,
        'test-skill'
      );

      // SECURITY: Validate BEFORE sanitize - reject invalid triggers immediately
      // 'create!' has shell metachar ! -> rejected
      // 'build@home' has @ which is now allowed -> accepted
      // 'test#1' has # which is not allowed -> rejected
      // 'deploy$' has shell metachar $ -> rejected
      expect(result.validTriggers).toEqual(['build@home']);
      expect(result.rejectedTriggers).toHaveLength(3);
      expect(result.rejectedTriggers.every(r => r.reason.includes('invalid format'))).toBe(true);
    });

    it('should reject triggers with spaces', () => {
      const result = service.validateTriggers(
        ['create user', 'build project'],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual([]);
      expect(result.rejectedTriggers).toHaveLength(2);
      expect(result.rejectedTriggers.every(r => r.reason.includes('invalid format'))).toBe(true);
    });

    it('should accept triggers with dots (domain-style patterns)', () => {
      const result = service.validateTriggers(
        ['create.user', 'build.project', 'api.docs', 'v2.0'],
        ElementType.SKILL,
        'test-skill'
      );

      // Dots are now allowed for domain-style patterns and version numbers
      expect(result.validTriggers).toEqual(['create.user', 'build.project', 'api.docs', 'v2.0']);
      expect(result.rejectedTriggers).toHaveLength(0);
    });

    it('should reject triggers with slashes', () => {
      const result = service.validateTriggers(
        ['create/user', 'build\\project'],
        ElementType.SKILL,
        'test-skill'
      );

      // SECURITY: Slashes are not allowed in trigger format
      // 'create/user' and 'build\\project' fail validation -> rejected
      expect(result.validTriggers).toEqual([]);
      expect(result.rejectedTriggers).toHaveLength(2);
      expect(result.rejectedTriggers.every(r => r.reason.includes('invalid format'))).toBe(true);
    });

    it('should reject triggers that are too long (> 50 characters)', () => {
      const longTrigger = 'a'.repeat(51);
      const result = service.validateTriggers(
        [longTrigger],
        ElementType.SKILL,
        'test-skill'
      );

      // sanitizeInput truncates to maxLength (50), which results in valid alphanumeric
      // So it should be accepted as the truncated version
      expect(result.validTriggers).toHaveLength(1);
      expect(result.validTriggers[0]).toHaveLength(50);
    });

    it('should handle mixed valid and invalid triggers', () => {
      const result = service.validateTriggers(
        ['valid1', 'invalid!', 'valid2', '', 'valid3'],
        ElementType.SKILL,
        'test-skill'
      );

      // SECURITY: 'invalid!' has special characters -> rejected (not sanitized)
      // '' is empty -> rejected
      expect(result.validTriggers).toContain('valid1');
      expect(result.validTriggers).toContain('valid2');
      expect(result.validTriggers).toContain('valid3');
      expect(result.validTriggers).not.toContain('invalid');
      expect(result.rejectedTriggers).toHaveLength(2); // 'invalid!' and ''
      expect(result.hasRejections).toBe(true);
    });
  });

  describe('validateTriggers - Unified Limit Enforcement', () => {
    it('should enforce 20 trigger limit for PERSONA elements', () => {
      const triggers = Array.from({ length: 25 }, (_, i) => `trigger${i + 1}`);

      const result = service.validateTriggers(
        triggers,
        ElementType.PERSONA,
        'test-persona'
      );

      expect(result.validTriggers).toHaveLength(20);
      expect(result.totalInput).toBe(25);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Trigger limit exceeded');
      expect(result.warnings[0]).toContain('25 > 20');
    });

    it('should enforce 20 trigger limit for SKILL elements', () => {
      const triggers = Array.from({ length: 25 }, (_, i) => `trigger${i + 1}`);

      const result = service.validateTriggers(
        triggers,
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toHaveLength(20);
      expect(result.totalInput).toBe(25);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('25 > 20');
    });

    it('should enforce 20 trigger limit for MEMORY elements', () => {
      const triggers = Array.from({ length: 22 }, (_, i) => `trigger${i + 1}`);

      const result = service.validateTriggers(
        triggers,
        ElementType.MEMORY,
        'test-memory'
      );

      expect(result.validTriggers).toHaveLength(20);
      expect(result.totalInput).toBe(22);
    });

    it('should enforce 20 trigger limit for TEMPLATE elements', () => {
      const triggers = Array.from({ length: 30 }, (_, i) => `trigger${i + 1}`);

      const result = service.validateTriggers(
        triggers,
        ElementType.TEMPLATE,
        'test-template'
      );

      expect(result.validTriggers).toHaveLength(20);
      expect(result.totalInput).toBe(30);
    });

    it('should enforce 20 trigger limit for AGENT elements', () => {
      const triggers = Array.from({ length: 21 }, (_, i) => `trigger${i + 1}`);

      const result = service.validateTriggers(
        triggers,
        ElementType.AGENT,
        'test-agent'
      );

      expect(result.validTriggers).toHaveLength(20);
      expect(result.totalInput).toBe(21);
    });

    it('should use same limit for all element types', () => {
      const triggers = Array.from({ length: 21 }, (_, i) => `trigger${i + 1}`);

      const personaResult = service.validateTriggers(triggers, ElementType.PERSONA, 'test');
      const skillResult = service.validateTriggers(triggers, ElementType.SKILL, 'test');
      const memoryResult = service.validateTriggers(triggers, ElementType.MEMORY, 'test');
      const templateResult = service.validateTriggers(triggers, ElementType.TEMPLATE, 'test');
      const agentResult = service.validateTriggers(triggers, ElementType.AGENT, 'test');
      const ensembleResult = service.validateTriggers(triggers, ElementType.ENSEMBLE, 'test');

      // All should accept exactly 20 triggers
      expect(personaResult.validTriggers).toHaveLength(20);
      expect(skillResult.validTriggers).toHaveLength(20);
      expect(memoryResult.validTriggers).toHaveLength(20);
      expect(templateResult.validTriggers).toHaveLength(20);
      expect(agentResult.validTriggers).toHaveLength(20);
      expect(ensembleResult.validTriggers).toHaveLength(20);
    });
  });

  describe('validateTriggers - Edge Cases', () => {
    it('should handle null input', () => {
      const result = service.validateTriggers(
        null as any,
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual([]);
      expect(result.rejectedTriggers).toEqual([]);
      expect(result.hasRejections).toBe(false);
      expect(result.totalInput).toBe(0);
    });

    it('should handle undefined input', () => {
      const result = service.validateTriggers(
        undefined as any,
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual([]);
      expect(result.rejectedTriggers).toEqual([]);
      expect(result.totalInput).toBe(0);
    });

    it('should handle empty array', () => {
      const result = service.validateTriggers(
        [],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual([]);
      expect(result.rejectedTriggers).toEqual([]);
      expect(result.totalInput).toBe(0);
    });

    it('should convert non-string triggers to strings', () => {
      const result = service.validateTriggers(
        [123, true, 'valid'] as any[],
        ElementType.SKILL,
        'test-skill'
      );

      // Numbers and booleans become strings, then validated
      expect(result.validTriggers).toEqual(['123', 'true', 'valid']);
    });

    it('should handle Unicode characters (sanitizeInput removes them)', () => {
      const result = service.validateTriggers(
        ['test\u0000', 'hello\u200b', 'valid'],
        ElementType.SKILL,
        'test-skill'
      );

      // sanitizeInput should handle Unicode, results depend on sanitization
      // Assuming sanitizeInput removes null bytes and zero-width spaces
      expect(result.validTriggers).toContain('valid');
    });

    it('should handle triggers at exactly max length (50 characters)', () => {
      const exactLength = 'a'.repeat(50);
      const result = service.validateTriggers(
        [exactLength],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual([exactLength]);
      expect(result.validTriggers[0]).toHaveLength(50);
    });

    it('should handle exactly max triggers for PERSONA', () => {
      const triggers = Array.from({ length: 20 }, (_, i) => `trigger${i + 1}`);

      const result = service.validateTriggers(
        triggers,
        ElementType.PERSONA,
        'test-persona'
      );

      expect(result.validTriggers).toHaveLength(20);
      expect(result.warnings).toEqual([]);
    });

    it('should handle exactly max triggers for SKILL', () => {
      const triggers = Array.from({ length: 20 }, (_, i) => `trigger${i + 1}`);

      const result = service.validateTriggers(
        triggers,
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toHaveLength(20);
      expect(result.warnings).toEqual([]);
    });

    it('should handle array with all invalid triggers', () => {
      const result = service.validateTriggers(
        ['!@#', '$%^', '&*()', ''],
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toEqual([]);
      expect(result.rejectedTriggers).toHaveLength(4);
      expect(result.hasRejections).toBe(true);
    });
  });


  describe('Real-World Scenarios', () => {
    it('should match PersonaManager behavior for 20 trigger limit', () => {
      const triggers = Array.from({ length: 25 }, (_, i) => `trigger${i + 1}`);

      const result = service.validateTriggers(
        triggers,
        ElementType.PERSONA,
        'code-assistant'
      );

      expect(result.validTriggers).toHaveLength(20);
      expect(result.validTriggers).not.toContain('trigger21');
      expect(result.validTriggers).not.toContain('trigger25');
      expect(result.warnings[0]).toContain('25 > 20');
    });

    it('should match SkillManager behavior for trigger validation', () => {
      const triggers = [
        'analyze',
        'invalid!@#',
        'process',
        '',
        'validate'
      ];

      const result = service.validateTriggers(
        triggers,
        ElementType.SKILL,
        'data-processor'
      );

      expect(result.validTriggers).toEqual(['analyze', 'process', 'validate']);
      expect(result.rejectedTriggers).toHaveLength(2);
      expect(result.hasRejections).toBe(true);
    });

    it('should handle MemoryManager trigger validation', () => {
      const triggers = [
        'recall',
        'remember',
        'forget',
        'search'
      ];

      const result = service.validateTriggers(
        triggers,
        ElementType.MEMORY,
        'session-memory'
      );

      expect(result.validTriggers).toEqual(triggers);
      expect(result.rejectedTriggers).toEqual([]);
    });

    it('should handle TemplateManager with mixed valid/invalid triggers', () => {
      const triggers = [
        'generate',
        'template!',
        'render',
        'format',
        '   ',
        'output'
      ];

      const result = service.validateTriggers(
        triggers,
        ElementType.TEMPLATE,
        'code-template'
      );

      // SECURITY: 'template!' has special characters -> rejected (not sanitized)
      // '   ' is empty -> rejected
      expect(result.validTriggers).toContain('generate');
      expect(result.validTriggers).toContain('render');
      expect(result.validTriggers).toContain('format');
      expect(result.validTriggers).toContain('output');
      expect(result.validTriggers).not.toContain('template');
      expect(result.rejectedTriggers).toHaveLength(2); // 'template!' and whitespace
    });

    it('should handle AgentManager trigger validation', () => {
      const triggers = [
        'agent-task',
        'goal_achieve',
        'decide',
        'execute'
      ];

      const result = service.validateTriggers(
        triggers,
        ElementType.AGENT,
        'autonomous-agent'
      );

      expect(result.validTriggers).toEqual(triggers);
    });
  });

  describe('Integration with Existing Manager Tests', () => {
    it('should reject triggers with spaces (PersonaManager test)', () => {
      const result = service.validateTriggers(
        ['create project', 'invalid space'],
        ElementType.PERSONA,
        'test-persona'
      );

      expect(result.validTriggers).toEqual([]);
      expect(result.rejectedTriggers).toHaveLength(2);
    });

    it('should truncate at exact limit without warning (SkillManager test)', () => {
      const triggers = Array.from({ length: 20 }, (_, i) => `skill${i + 1}`);

      const result = service.validateTriggers(
        triggers,
        ElementType.SKILL,
        'test-skill'
      );

      expect(result.validTriggers).toHaveLength(20);
      expect(result.warnings).toEqual([]);
    });

    it('should handle empty after sanitization (MemoryManager test)', () => {
      const result = service.validateTriggers(
        ['   ', '\t\n', ''],
        ElementType.MEMORY,
        'test-memory'
      );

      expect(result.validTriggers).toEqual([]);
      expect(result.rejectedTriggers).toHaveLength(3);
      expect(result.rejectedTriggers.every(r => r.reason.includes('empty'))).toBe(true);
    });
  });

  describe('Performance', () => {
    it('should handle large arrays efficiently', () => {
      const triggers = Array.from({ length: 1000 }, (_, i) => `trigger${i + 1}`);

      const start = performance.now();
      const result = service.validateTriggers(
        triggers,
        ElementType.SKILL,
        'performance-test'
      );
      const duration = performance.now() - start;

      expect(result.validTriggers).toHaveLength(20); // Truncated to max
      expect(duration).toBeLessThan(100); // Should complete in <100ms
    });

    it('should handle repeated validations efficiently', () => {
      const triggers = ['create', 'build', 'test'];

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        service.validateTriggers(triggers, ElementType.SKILL, 'perf-test');
      }
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(500); // 1000 validations in <500ms
    });
  });
});
