/**
 * Tests for V1→V2 Agent Converter
 *
 * @since v2.0.0 - Agent V2 Infrastructure
 */

import { jest } from '@jest/globals';
import {
  isV1Agent,
  convertV1ToV2,
} from '../../../../src/elements/agents/v1ToV2Converter.js';
import { logger } from '../../../../src/utils/logger.js';
import type { AgentMetadata, AgentMetadataV2 } from '../../../../src/elements/agents/types.js';

describe('v1ToV2Converter', () => {

  describe('isV1Agent', () => {
    it('should return true for agent without goal.template', () => {
      const v1Metadata: AgentMetadata = {
        name: 'test-agent',
        description: 'A test agent',
        decisionFramework: 'rule_based',
      };

      expect(isV1Agent(v1Metadata)).toBe(true);
    });

    it('should return true for agent with empty goal', () => {
      const metadata: Partial<AgentMetadataV2> = {
        name: 'test-agent',
        description: 'A test agent',
        goal: {} as any,
      };

      expect(isV1Agent(metadata as AgentMetadata)).toBe(true);
    });

    it('should return false for V2 agent with goal.template', () => {
      const v2Metadata: AgentMetadataV2 = {
        name: 'test-agent',
        description: 'A test agent',
        goal: {
          template: 'Execute: {objective}',
          parameters: [{ name: 'objective', type: 'string', required: true }],
        },
      };

      expect(isV1Agent(v2Metadata)).toBe(false);
    });

    it('should return false for V2 agent with successCriteria', () => {
      const v2Metadata: AgentMetadataV2 = {
        name: 'test-agent',
        description: 'A test agent',
        goal: {
          template: 'Review code in {repository}',
          parameters: [{ name: 'repository', type: 'string', required: true }],
          successCriteria: ['Code reviewed', 'Issues documented'],
        },
      };

      expect(isV1Agent(v2Metadata)).toBe(false);
    });
  });

  describe('convertV1ToV2', () => {
    it('should convert V1 agent with instructions to V2 format', () => {
      const v1Metadata: AgentMetadata = {
        name: 'task-runner',
        description: 'Runs tasks autonomously',
        decisionFramework: 'hybrid',
        riskTolerance: 'moderate',
      };
      const instructions = 'This agent executes tasks efficiently.';

      const result = convertV1ToV2(v1Metadata, instructions);

      expect(result.converted).toBe(true);
      expect(result.metadata.goal).toBeDefined();
      expect(result.metadata.goal!.template).toContain('{objective}');
      expect(result.metadata.goal!.parameters).toHaveLength(1);
      expect(result.metadata.goal!.parameters![0].name).toBe('objective');
      expect(result.metadata.goal!.parameters![0].required).toBe(true);
    });

    it('should preserve V1 fields in converted metadata', () => {
      const v1Metadata: AgentMetadata = {
        name: 'legacy-agent',
        description: 'A legacy agent',
        decisionFramework: 'rule_based',
        riskTolerance: 'conservative',
        learningEnabled: true,
        specializations: ['code-review', 'testing'],
        triggers: ['review', 'test'],
      };

      const result = convertV1ToV2(v1Metadata, 'Instructions here');

      expect(result.converted).toBe(true);
      expect(result.metadata.decisionFramework).toBe('rule_based');
      expect(result.metadata.riskTolerance).toBe('conservative');
      expect(result.metadata.learningEnabled).toBe(true);
      expect(result.metadata.specializations).toEqual(['code-review', 'testing']);
      expect(result.metadata.triggers).toEqual(['review', 'test']);
    });

    it('should generate deprecation warnings for V1 fields', () => {
      const v1Metadata: AgentMetadata = {
        name: 'old-agent',
        description: 'An old agent',
        decisionFramework: 'ml_based',
        learningEnabled: false,
        ruleEngineConfig: { rules: [] },
      };

      const result = convertV1ToV2(v1Metadata, 'Some instructions');

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('decisionFramework'))).toBe(true);
      expect(result.warnings.some(w => w.includes('learningEnabled'))).toBe(true);
      expect(result.warnings.some(w => w.includes('ruleEngineConfig'))).toBe(true);
    });

    it('should not convert already V2 agent', () => {
      const v2Metadata: AgentMetadataV2 = {
        name: 'v2-agent',
        description: 'A V2 agent',
        goal: {
          template: 'Do {task}',
          parameters: [{ name: 'task', type: 'string', required: true }],
        },
      };

      const result = convertV1ToV2(v2Metadata as AgentMetadata, 'Instructions');

      expect(result.converted).toBe(false);
      expect(result.warnings).toContain('Agent is already V2 format, no conversion needed');
    });

    it('should extract success criteria from instructions', () => {
      const v1Metadata: AgentMetadata = {
        name: 'criteria-agent',
        description: 'Agent with success criteria',
      };
      const instructions = `
This agent reviews code.

Success criteria:
- All files reviewed
- Issues documented
- PR approved
`;

      const result = convertV1ToV2(v1Metadata, instructions);

      expect(result.converted).toBe(true);
      expect(result.metadata.goal!.successCriteria).toBeDefined();
      expect(result.metadata.goal!.successCriteria!.length).toBe(3);
      expect(result.metadata.goal!.successCriteria).toContain('All files reviewed');
      expect(result.metadata.goal!.successCriteria).toContain('Issues documented');
      expect(result.metadata.goal!.successCriteria).toContain('PR approved');
    });

    it('should extract "completed when" statements', () => {
      const v1Metadata: AgentMetadata = {
        name: 'completion-agent',
        description: 'Agent with completion criteria',
      };
      const instructions = `
This agent builds projects.

Completed when: All tests pass
completed when: Documentation updated
`;

      const result = convertV1ToV2(v1Metadata, instructions);

      expect(result.converted).toBe(true);
      expect(result.metadata.goal!.successCriteria).toBeDefined();
      expect(result.metadata.goal!.successCriteria).toContain('All tests pass');
      expect(result.metadata.goal!.successCriteria).toContain('Documentation updated');
    });

    it('should use first line as context in goal template', () => {
      const v1Metadata: AgentMetadata = {
        name: 'context-agent',
        description: 'Agent with clear first line',
      };
      const instructions = 'Review pull requests for code quality';

      const result = convertV1ToV2(v1Metadata, instructions);

      expect(result.converted).toBe(true);
      expect(result.metadata.goal!.template).toContain('Review pull requests');
      expect(result.metadata.goal!.template).toContain('{objective}');
    });

    it('should handle empty instructions', () => {
      const v1Metadata: AgentMetadata = {
        name: 'empty-agent',
        description: 'Agent with no instructions',
      };

      const result = convertV1ToV2(v1Metadata, '');

      expect(result.converted).toBe(true);
      expect(result.metadata.goal!.template).toBe('Execute: {objective}');
    });

    it('should warn when no success criteria found', () => {
      const v1Metadata: AgentMetadata = {
        name: 'no-criteria-agent',
        description: 'Agent without criteria',
      };

      const result = convertV1ToV2(v1Metadata, 'Just do stuff');

      expect(result.converted).toBe(true);
      expect(result.warnings.some(w => w.includes('success criteria'))).toBe(true);
    });
  });

  describe('V1→V2 conversion logging (#373)', () => {
    const originalDebug = logger.debug;
    const originalInfo = logger.info;

    beforeEach(() => {
      logger.debug = jest.fn();
      logger.info = jest.fn();
    });

    afterEach(() => {
      logger.debug = originalDebug;
      logger.info = originalInfo;
    });

    it('should log debug with agent name for empty instructions fallback', () => {
      const metadata: AgentMetadata = { name: 'empty-agent', description: 'test' };
      convertV1ToV2(metadata, '');

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/\[empty-agent\].*empty instructions/)
      );
    });

    it('should log debug with agent name when goal header is extracted', () => {
      const metadata: AgentMetadata = { name: 'goal-agent', description: 'test' };
      convertV1ToV2(metadata, '# Goal: Review the codebase\nSome details');

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/\[goal-agent\].*extracted goal header/),
        expect.objectContaining({ goalLine: expect.any(String) })
      );
    });

    it('should log debug with agent name when first line is used as context', () => {
      const metadata: AgentMetadata = { name: 'first-line-agent', description: 'test' };
      convertV1ToV2(metadata, 'Review pull requests for code quality');

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/\[first-line-agent\].*using first line/),
        expect.objectContaining({ firstLine: expect.any(String) })
      );
    });

    it('should log debug with preview for generic template fallback (long first line)', () => {
      const metadata: AgentMetadata = { name: 'long-agent', description: 'test' };
      const longLine = 'A'.repeat(201);
      convertV1ToV2(metadata, longLine);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/\[long-agent\].*no extractable goal pattern/),
        expect.objectContaining({ instructionLength: expect.any(Number), preview: expect.any(String) })
      );
    });

    it('should log debug with agent name when no success criteria found', () => {
      const metadata: AgentMetadata = { name: 'no-criteria', description: 'test' };
      convertV1ToV2(metadata, 'Just do stuff');

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/\[no-criteria\].*no patterns found/),
        expect.objectContaining({ instructionLength: expect.any(Number) })
      );
    });

    it('should log debug with agent name when success criteria are extracted', () => {
      const metadata: AgentMetadata = { name: 'criteria-agent', description: 'test' };
      convertV1ToV2(metadata, 'Agent.\n\nSuccess criteria:\n- Tests pass\n- Docs updated');

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/\[criteria-agent\].*extracted 2 criteria/),
        expect.objectContaining({ criteria: expect.any(Array) })
      );
    });

    it('should include agent name and template in info log', () => {
      const metadata: AgentMetadata = { name: 'named-agent', description: 'test' };
      convertV1ToV2(metadata, 'Do things efficiently');

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/named-agent.*template=/),
        expect.objectContaining({
          agentName: 'named-agent',
          goalTemplate: expect.any(String),
        })
      );
    });

    it('should preserve existing {objective} placeholder in goal header without appending', () => {
      const metadata: AgentMetadata = { name: 'placeholder-agent', description: 'test' };
      const result = convertV1ToV2(metadata, '# Goal: Execute {objective} with care\nDetails...');

      expect(result.metadata.goal!.template).toBe('Execute {objective} with care');
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/\[placeholder-agent\].*extracted goal header/),
        expect.objectContaining({ goalLine: 'Execute {objective} with care' })
      );
    });
  });
});
