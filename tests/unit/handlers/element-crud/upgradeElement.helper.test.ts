import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const { upgradeElement } = await import('../../../../src/handlers/element-crud/upgradeElement.js');
import type { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';

/**
 * Helper to extract text from MCP response format
 */
function getText(result: any): string {
  return result?.content?.[0]?.text || '';
}

describe('upgradeElement helper', () => {
  let mockContext: ElementCrudContext;

  // Factory for mock elements with v1 or v2 format
  function makeElement(opts: {
    name?: string;
    instructions?: string;
    content?: string;
    filename?: string;
  }) {
    return {
      metadata: { name: opts.name || 'test-element' },
      instructions: opts.instructions || '',
      content: opts.content || '',
      filename: opts.filename || 'test-element.md',
    };
  }

  function makeManager(element: any = null) {
    return {
      list: jest.fn().mockResolvedValue(element ? [element] : []),
      load: jest.fn().mockResolvedValue(element),
      save: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    mockContext = {
      skillManager: makeManager(),
      templateManager: makeManager(),
      agentManager: makeManager(),
      memoryManager: makeManager(),
      personaManager: makeManager(),
      ensembleManager: makeManager(),
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      getPersonaIndicator: jest.fn().mockReturnValue(''),
    } as any;
  });

  describe('input validation', () => {
    it('should return error when name is missing', async () => {
      const result = await upgradeElement(mockContext, {
        name: '',
        type: 'persona',
      });
      expect(getText(result)).toContain('Missing required parameter');
    });

    it('should return error for invalid element type', async () => {
      const result = await upgradeElement(mockContext, {
        name: 'test',
        type: 'invalid-type',
      });
      expect(getText(result)).toContain('Invalid element type');
    });

    it('should throw when element is not found', async () => {
      mockContext.personaManager = makeManager(null) as any;

      await expect(
        upgradeElement(mockContext, { name: 'nonexistent', type: 'persona' })
      ).rejects.toThrow();
    });
  });

  describe('v1 body mapping (getV1BodyMapping)', () => {
    it('should map persona body text to instructions', async () => {
      const element = makeElement({
        name: 'TestPersona',
        instructions: 'Be helpful and kind.',
        content: '',
        filename: 'test-persona.md',
      });
      mockContext.personaManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'TestPersona',
        type: 'persona',
      });

      const text = getText(result);
      expect(text).toContain('Upgraded');
      expect(text).toContain('v2 dual-field format');
      // Save should have been called
      expect((mockContext.personaManager as any).save).toHaveBeenCalled();
    });

    it('should map skill body text to instructions', async () => {
      const element = makeElement({
        name: 'TestSkill',
        instructions: 'Analyze code systematically.',
        content: '',
        filename: 'test-skill.md',
      });
      mockContext.skillManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'TestSkill',
        type: 'skill',
      });

      expect(getText(result)).toContain('Upgraded');
      expect((mockContext.skillManager as any).save).toHaveBeenCalled();
    });

    it('should map agent body text to instructions', async () => {
      const element = makeElement({
        name: 'TestAgent',
        instructions: 'Execute goals methodically.',
        content: '',
        filename: 'test-agent.md',
      });
      mockContext.agentManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'TestAgent',
        type: 'agent',
      });

      expect(getText(result)).toContain('Upgraded');
    });

    it('should map template body text to content', async () => {
      const element = makeElement({
        name: 'TestTemplate',
        instructions: '',
        content: '## Bug Report\n\n**Summary:** {{summary}}',
        filename: 'test-template.md',
      });
      mockContext.templateManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'TestTemplate',
        type: 'template',
      });

      expect(getText(result)).toContain('Upgraded');
    });

    it('should map ensemble body text to content', async () => {
      const element = makeElement({
        name: 'TestEnsemble',
        instructions: '',
        content: 'Documentation for this ensemble.',
        filename: 'test-ensemble.md',
      });
      mockContext.ensembleManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'TestEnsemble',
        type: 'ensemble',
      });

      expect(getText(result)).toContain('Upgraded');
    });
  });

  describe('v2 format detection (isV2Format)', () => {
    it('should detect v2 persona (has both instructions and content)', async () => {
      const element = makeElement({
        name: 'V2Persona',
        instructions: 'You ARE a security expert.',
        content: '## Reference\n- OWASP Top 10',
        filename: 'v2-persona.md',
      });
      mockContext.personaManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'V2Persona',
        type: 'persona',
      });

      expect(getText(result)).toContain('already in v2');
    });

    it('should detect v2 template (has instructions populated)', async () => {
      const element = makeElement({
        name: 'V2Template',
        instructions: 'Render all sections.',
        content: '## Template\n{{summary}}',
        filename: 'v2-template.md',
      });
      mockContext.templateManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'V2Template',
        type: 'template',
      });

      expect(getText(result)).toContain('already in v2');
    });

    it('should NOT detect v1 persona as v2 (instructions only, no content)', async () => {
      const element = makeElement({
        name: 'V1Persona',
        instructions: 'Be helpful.',
        content: '',
        filename: 'v1-persona.md',
      });
      mockContext.personaManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'V1Persona',
        type: 'persona',
      });

      // Should upgrade, not report as already v2
      expect(getText(result)).toContain('Upgraded');
    });
  });

  describe('dry_run mode', () => {
    it('should preview upgrade without saving', async () => {
      const element = makeElement({
        name: 'DryRunPersona',
        instructions: 'Be kind.',
        content: '',
        filename: 'dry-run.md',
      });
      mockContext.personaManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'DryRunPersona',
        type: 'persona',
        dry_run: true,
      });

      const text = getText(result);
      // Should show preview, not save
      expect(text).toMatch(/no field changes needed|Dry run/i);
      expect((mockContext.personaManager as any).save).not.toHaveBeenCalled();
    });

    it('should show field changes in dry_run when overrides differ', async () => {
      const element = makeElement({
        name: 'OverridePersona',
        instructions: 'Old instructions.',
        content: '',
        filename: 'override.md',
      });
      mockContext.personaManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'OverridePersona',
        type: 'persona',
        dry_run: true,
        instructions_override: 'New behavioral directives.',
      });

      const text = getText(result);
      expect(text).toContain('Dry run');
      expect(text).toContain('instructions');
      expect((mockContext.personaManager as any).save).not.toHaveBeenCalled();
    });
  });

  describe('override parameters', () => {
    it('should use instructions_override when provided', async () => {
      const element = makeElement({
        name: 'OverrideTest',
        instructions: 'Original.',
        content: '',
        filename: 'override-test.md',
      });
      mockContext.skillManager = makeManager(element) as any;

      await upgradeElement(mockContext, {
        name: 'OverrideTest',
        type: 'skill',
        instructions_override: 'Custom instructions.',
      });

      const savedElement = (mockContext.skillManager as any).save.mock.calls[0][0];
      expect(savedElement.instructions).toBe('Custom instructions.');
    });

    it('should use content_override when provided', async () => {
      const element = makeElement({
        name: 'ContentOverride',
        instructions: '',
        content: 'Original content.',
        filename: 'content-override.md',
      });
      mockContext.templateManager = makeManager(element) as any;

      await upgradeElement(mockContext, {
        name: 'ContentOverride',
        type: 'template',
        content_override: 'New reference material.',
      });

      const savedElement = (mockContext.templateManager as any).save.mock.calls[0][0];
      expect(savedElement.content).toBe('New reference material.');
    });

    it('should allow overrides on already-v2 elements', async () => {
      const element = makeElement({
        name: 'V2Override',
        instructions: 'Existing instructions.',
        content: 'Existing content.',
        filename: 'v2-override.md',
      });
      mockContext.personaManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'V2Override',
        type: 'persona',
        instructions_override: 'Updated instructions.',
      });

      // Should save despite being v2 — overrides force re-save
      expect(getText(result)).toContain('Upgraded');
      expect((mockContext.personaManager as any).save).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return error when save fails', async () => {
      const element = makeElement({
        name: 'SaveFail',
        instructions: 'Some text.',
        content: '',
        filename: 'save-fail.md',
      });
      const manager = makeManager(element);
      manager.save.mockRejectedValue(new Error('Disk full'));
      mockContext.personaManager = manager as any;

      const result = await upgradeElement(mockContext, {
        name: 'SaveFail',
        type: 'persona',
      });

      expect(getText(result)).toContain('Failed to save');
      expect(getText(result)).toContain('Disk full');
    });

    it('should return error when filename cannot be determined', async () => {
      const element = {
        metadata: { name: 'NoFile' },
        instructions: 'Text.',
        content: '',
        filename: '',
      };
      mockContext.skillManager = makeManager(element) as any;

      const result = await upgradeElement(mockContext, {
        name: 'NoFile',
        type: 'skill',
      });

      expect(getText(result)).toContain('Cannot determine file path');
    });
  });
});
