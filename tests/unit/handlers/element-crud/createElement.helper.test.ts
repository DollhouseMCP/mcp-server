import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const { createElement } = await import('../../../../src/handlers/element-crud/createElement.js');
const { ElementType } = await import('../../../../src/portfolio/PortfolioManager.js');
const { SECURITY_LIMITS } = await import('../../../../src/security/constants.js');
import type { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';

describe('createElement helper', () => {
  let mockContext: ElementCrudContext;

  beforeEach(() => {
    mockContext = {
      skillManager: {
        create: jest.fn().mockResolvedValue({
          metadata: { name: 'test-skill' },
        }),
      },
      templateManager: {
        create: jest.fn().mockResolvedValue({
          metadata: { name: 'test-template' },
        }),
      },
      agentManager: {
        create: jest.fn().mockResolvedValue({
          success: true,
          message: 'Agent created',
        }),
      },
      memoryManager: {
        create: jest.fn().mockImplementation(async (metadata) => {
          // Return a mock Memory object with the expected interface
          return {
            metadata: { name: metadata.name, description: metadata.description, ...metadata },
            retentionDays: metadata.retentionDays,
            addEntry: jest.fn().mockResolvedValue(undefined),
          };
        }),
      },
      personaManager: {
        // v2: Unified create() method (legacy createPersona removed)
        create: jest.fn().mockResolvedValue({
          metadata: { name: 'test-persona' },
        }),
      },
      ensembleManager: {
        create: jest.fn().mockResolvedValue({
          metadata: { name: 'test-ensemble' },
        }),
      },
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      getPersonaIndicator: jest.fn().mockReturnValue(''),
    } as any;
  });

  describe('type validation', () => {
    it('should return error for invalid element type', async () => {
      const result = await createElement(mockContext, {
        name: 'test',
        type: 'invalid-type',
        description: 'Test description',
      });

      expect(result.content[0].text).toContain('❌ Invalid element type');
      expect(result.content[0].text).toContain('invalid-type');
    });

    it('should accept valid element type: skills', async () => {
      const result = await createElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        description: 'Test skill',
      });

      expect(mockContext.skillManager.create).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-skill');
    });

    it('should accept valid element type: templates', async () => {
      const result = await createElement(mockContext, {
        name: 'test-template',
        type: ElementType.TEMPLATE,
        description: 'Test template',
      });

      expect(mockContext.templateManager.create).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should accept valid element type: agents', async () => {
      const result = await createElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        description: 'Test agent',
      });

      expect(mockContext.agentManager.create).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should accept valid element type: memories', async () => {
      const result = await createElement(mockContext, {
        name: 'test-memory',
        type: ElementType.MEMORY,
        description: 'Test memory',
      });

      expect(mockContext.memoryManager.create).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should accept valid element type: ensembles', async () => {
      const result = await createElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Test ensemble',
      });

      expect(mockContext.ensembleManager.create).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-ensemble');
    });
  });

  describe('input validation and sanitization', () => {
    it('should sanitize name input', async () => {
      const result = await createElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        description: 'Description',
      });

      expect(mockContext.skillManager.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.any(String),
          description: expect.any(String),
        })
      );
      expect(result.content[0].text).toContain('✅');
    });

    it('should sanitize description input', async () => {
      await createElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        description: '<script>alert("xss")</script>',
      });

      const call = (mockContext.skillManager.create as jest.Mock).mock.calls[0][0];
      expect(call.description).not.toContain('<script>');
    });

    it('should preserve long descriptions when creating elements', async () => {
      const longDescription = 'Long-form skill description. '.repeat(80);

      await createElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        description: longDescription,
      });

      const call = (mockContext.skillManager.create as jest.Mock).mock.calls[0][0];
      expect(call.description).toBe(longDescription.trim());
      expect(call.description.length).toBeGreaterThan(500);
    });

    it('should reject descriptions that exceed the YAML frontmatter safety limit', async () => {
      const result = await createElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        description: 'a'.repeat(SECURITY_LIMITS.MAX_YAML_LENGTH + 1),
      });

      expect(result.content[0].text).toContain('❌ Description too large');
      expect(result.content[0].text).toContain('input.description');
      expect(mockContext.skillManager.create).not.toHaveBeenCalled();
    });

    it('should sanitize metadata to remove dangerous properties', async () => {
      const metadata = {
        description: 'safe',
        nested: {
          __proto__: { polluted: true },
          safe: 'value',
        },
        __proto__: { hacked: true },
      };

      await createElement(mockContext, {
        name: 'example',
        type: ElementType.SKILL,
        description: 'desc',
        metadata,
      });

      const call = (mockContext.skillManager.create as jest.Mock).mock.calls[0][0];
      expect(call).toHaveProperty('nested.safe', 'value');
      expect(Object.hasOwn(call, '__proto__')).toBe(false);
      expect(Object.hasOwn(call.nested, '__proto__')).toBe(false);
    });

    it('should reject top-level externalRestrictions during create', async () => {
      const result = await createElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        description: 'Test skill',
        metadata: { description: 'safe metadata' },
        externalRestrictions: {
          description: 'misnested',
          denyPatterns: ['Bash:rm *'],
        },
      } as any);

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Gatekeeper policy validation failed');
      expect(result.content[0].text).toContain('externalRestrictions must be nested');
      expect(mockContext.skillManager.create).not.toHaveBeenCalled();
    });

    it('should reject gatekeeper.externalRestrictions without description during create', async () => {
      const result = await createElement(mockContext, {
        name: 'test-skill',
        type: ElementType.SKILL,
        description: 'Test skill',
        metadata: {
          gatekeeper: {
            externalRestrictions: {
              denyPatterns: ['Bash:rm *'],
            },
          },
        },
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('externalRestrictions.description is required');
      expect(mockContext.skillManager.create).not.toHaveBeenCalled();
    });

    it('should reject content that is too large', async () => {
      const largeContent = 'a'.repeat(10 * 1024 * 1024 + 1); // > 10MB

      const result = await createElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        description: 'desc',
        content: largeContent,
      });

      expect(result.content[0].text).toContain('❌ Content too large');
      expect(mockContext.skillManager.create).not.toHaveBeenCalled();
    });

    it('should accept content within size limits', async () => {
      const validContent = 'a'.repeat(1000); // Well within limits

      const result = await createElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        description: 'desc',
        content: validContent,
      });

      expect(result.content[0].text).toContain('✅');
      expect(mockContext.skillManager.create).toHaveBeenCalled();
    });
  });

  describe('skill creation', () => {
    it('should create skill with all parameters', async () => {
      const result = await createElement(mockContext, {
        name: 'code-review',
        type: ElementType.SKILL,
        description: 'Reviews code for quality',
        content: 'Skill implementation',
        metadata: { complexity: 'intermediate' },
      });

      expect(mockContext.skillManager.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.any(String),
          content: 'Skill implementation',
          complexity: 'intermediate',
        })
      );
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-skill');
    });

    it('should create skill without content', async () => {
      const result = await createElement(mockContext, {
        name: 'minimal-skill',
        type: ElementType.SKILL,
        description: 'Minimal skill',
      });

      expect(mockContext.skillManager.create).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '',
        })
      );
      expect(result.content[0].text).toContain('✅');
    });
  });

  describe('template creation', () => {
    it('should create template with metadata routed through the metadata field', async () => {
      const result = await createElement(mockContext, {
        name: 'email-template',
        type: ElementType.TEMPLATE,
        description: 'Email template',
        content: 'Dear {{name}}, ...',
        metadata: {
          category: 'email',
          variables: [{ name: 'name', type: 'string', required: true }],
        },
      });

      expect(mockContext.templateManager.create).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Dear {{name}}, ...',
          metadata: {
            category: 'email',
            variables: [{ name: 'name', type: 'string', required: true }],
          },
        }),
      );
      expect(result.content[0].text).toContain('✅');
    });
  });

  describe('agent creation', () => {
    it('should create agent successfully', async () => {
      const result = await createElement(mockContext, {
        name: 'research-agent',
        type: ElementType.AGENT,
        description: 'Research assistant',
        content: 'Agent instructions',
        metadata: { specializations: ['research'] },
      });

      // Issue #722: content goes to metadata.content (body), not 3rd arg (instructions)
      expect(mockContext.agentManager.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        '',
        expect.objectContaining({
          specializations: ['research'],
          content: 'Agent instructions',
        })
      );
      expect(result.content[0].text).toContain('✅');
    });

    it('should handle agent creation failure', async () => {
      mockContext.agentManager.create = jest.fn().mockResolvedValue({
        success: false,
        message: 'Agent creation failed',
      });

      const result = await createElement(mockContext, {
        name: 'test-agent',
        type: ElementType.AGENT,
        description: 'Test',
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Agent creation failed');
    });

    // Issue #602 resolved: 'instructions' is now a first-class dual-field alongside 'content'
    describe('Issue #602 - dual-field instructions + content', () => {
      it('should accept instructions field for agents', async () => {
        const result = await createElement(mockContext, {
          name: 'confused-agent',
          type: ElementType.AGENT,
          description: 'Agent created with instructions',
          instructions: 'goal: Do the thing\nsteps:\n  - Step one',
        });

        expect(mockContext.agentManager.create).toHaveBeenCalled();
        expect(result.content[0].text).toContain('✅');
      });

      it('should accept instructions field for personas', async () => {
        const result = await createElement(mockContext, {
          name: 'confused-persona',
          type: ElementType.PERSONA,
          description: 'Persona created with instructions',
          instructions: 'Be helpful and concise.',
        });

        expect(mockContext.personaManager.create).toHaveBeenCalled();
        expect(result.content[0].text).toContain('✅');
      });

      it('should accept instructions field for skills', async () => {
        const result = await createElement(mockContext, {
          name: 'confused-skill',
          type: ElementType.SKILL,
          description: 'Skill with instructions',
          instructions: 'Review code carefully.',
        });

        expect(mockContext.skillManager.create).toHaveBeenCalled();
        expect(result.content[0].text).toContain('✅');
      });

      it('should pass empty string when neither content nor instructions provided for agents', async () => {
        const result = await createElement(mockContext, {
          name: 'empty-agent',
          type: ElementType.AGENT,
          description: 'Agent with no content fields',
        });

        expect(mockContext.agentManager.create).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          '',
          expect.any(Object)
        );
        expect(result.content[0].text).toContain('✅');
      });

      it('should pass both instructions and content to agent when both provided', async () => {
        await createElement(mockContext, {
          name: 'dual-agent',
          type: ElementType.AGENT,
          description: 'Agent with both fields',
          instructions: 'Execute goals methodically.',
          content: 'Reference: OWASP Top 10 guidelines.',
        });

        // 3rd arg = instructions (behavioral directives)
        expect(mockContext.agentManager.create).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          'Execute goals methodically.',
          expect.objectContaining({ content: 'Reference: OWASP Top 10 guidelines.' })
        );
      });

      it('should route content to body when only content provided (Issue #722)', async () => {
        await createElement(mockContext, {
          name: 'content-only-agent',
          type: ElementType.AGENT,
          description: 'Agent with only content',
          content: 'Reference material for the agent.',
        });

        // Issue #722: content goes to metadata.content (body), instructions defaults to ''
        expect(mockContext.agentManager.create).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          '',
          expect.objectContaining({ content: 'Reference material for the agent.' })
        );
      });

      it('should pass instructions to memory create', async () => {
        await createElement(mockContext, {
          name: 'memory-with-instructions',
          type: ElementType.MEMORY,
          description: 'Memory with directives',
          instructions: 'Always verify entries before surfacing.',
          content: 'Initial entry.',
        });

        const call = (mockContext.memoryManager.create as jest.Mock).mock.calls[0][0];
        expect(call.instructions).toBe('Always verify entries before surfacing.');
        expect(call.content).toBe('Initial entry.');
      });

      it('should pass instructions and content to ensemble create', async () => {
        await createElement(mockContext, {
          name: 'ensemble-with-fields',
          type: ElementType.ENSEMBLE,
          description: 'Ensemble with both fields',
          instructions: 'Orchestrate in priority order.',
          content: 'Documentation for this ensemble.',
        });

        const call = (mockContext.ensembleManager.create as jest.Mock).mock.calls[0][0];
        expect(call.instructions).toBe('Orchestrate in priority order.');
        expect(call.content).toBe('Documentation for this ensemble.');
      });

      it('should pass instructions to template create', async () => {
        await createElement(mockContext, {
          name: 'template-with-instructions',
          type: ElementType.TEMPLATE,
          description: 'Template with rendering directives',
          instructions: 'Render all sections. Never omit required fields.',
          content: '## Report\n\n**Summary:** {{summary}}',
        });

        const call = (mockContext.templateManager.create as jest.Mock).mock.calls[0][0];
        expect(call.instructions).toBe('Render all sections. Never omit required fields.');
        expect(call.content).toBe('## Report\n\n**Summary:** {{summary}}');
      });
    });
  });

  describe('memory creation', () => {
    it('should create memory with metadata', async () => {
      const result = await createElement(mockContext, {
        name: 'project-context',
        type: ElementType.MEMORY,
        description: 'Project information',
        content: 'Memory content',
        metadata: { tags: ['project'], retentionDays: 90 },
      });

      expect(mockContext.memoryManager.create).toHaveBeenCalled();
      const createCall = (mockContext.memoryManager.create as jest.Mock).mock.calls[0][0];

      // Verify memory metadata passed to create()
      expect(createCall).toMatchObject({
        name: 'project-context',
        description: 'Project information',
        tags: ['project'],
        retentionDays: 90,
        content: 'Memory content',
      });

      expect(result.content[0].text).toContain('✅');
    });

    it('should create memory without content', async () => {
      const result = await createElement(mockContext, {
        name: 'simple-memory',
        type: ElementType.MEMORY,
        description: 'Simple memory',
      });

      expect(mockContext.memoryManager.create).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });
  });

  describe('error handling', () => {
    it('should handle skill manager creation errors', async () => {
      mockContext.skillManager.create = jest.fn().mockImplementation(async () => {
        throw new Error('Creation failed');
      });

      const result = await createElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        description: 'Test',
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Creation failed');
    });

    it('should handle template manager creation errors', async () => {
      mockContext.templateManager.create = jest.fn().mockImplementation(async () => {
        throw new Error('Template error');
      });

      const result = await createElement(mockContext, {
        name: 'test',
        type: ElementType.TEMPLATE,
        description: 'Test',
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Template error');
    });

    it('should handle memory creation errors', async () => {
      mockContext.memoryManager.create = jest.fn().mockImplementation(async () => {
        throw new Error('Save failed');
      });

      const result = await createElement(mockContext, {
        name: 'test',
        type: ElementType.MEMORY,
        description: 'Test',
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Save failed');
    });
  });

  // FIX: Issue #281 - Persona now uses unified create() method like other element types
  // Issue #602: Personas use 'content' field at the API layer (like all other element types)
  describe('persona creation', () => {
    it('should create persona with content and metadata overrides', async () => {
      const bodyText = 'Instructions that exceed the minimum length requirement for personas.';

      mockContext.personaManager.create = jest.fn().mockResolvedValue({
        metadata: { name: 'persona-name', category: 'Professional', triggers: ['alpha', 'beta'] },
      });

      const result = await createElement(mockContext, {
        name: 'persona-name',
        type: ElementType.PERSONA,
        description: 'Persona description',
        content: bodyText,
        metadata: {
          category: 'Professional',
          triggers: ['alpha', 'beta'],
        },
      });

      expect(mockContext.personaManager.create).toHaveBeenCalled();
      const createCall = (mockContext.personaManager.create as jest.Mock).mock.calls[0][0];
      expect(createCall.name).toBe('persona-name');
      expect(createCall.content).toBe(bodyText);
      expect(createCall.category).toBe('Professional');
      expect(createCall.triggers).toEqual(['alpha', 'beta']);
      expect(result.content[0].text).toContain('✅');
    });

    it('should require persona content (behavioral instructions)', async () => {
      mockContext.personaManager.create = jest.fn().mockImplementation(async () => {
        throw new Error("Persona instructions are required to create 'persona-name'.");
      });

      const result = await createElement(mockContext, {
        name: 'persona-name',
        type: ElementType.PERSONA,
        description: 'Persona description',
        content: '   ',
      });

      expect(result.content[0].text).toContain('Persona instructions are required');
    });
  });

  describe('ensemble creation', () => {
    it('should create ensemble with minimal metadata', async () => {
      const result = await createElement(mockContext, {
        name: 'code-review-team',
        type: ElementType.ENSEMBLE,
        description: 'Team for code reviews',
      });

      expect(mockContext.ensembleManager.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'code-review-team',
          description: 'Team for code reviews',
        })
      );
      expect(result.content[0].text).toContain('✅');
      expect(result.content[0].text).toContain('test-ensemble');
    });

    it('should create ensemble with elements array', async () => {
      const elements = [
        {
          name: 'code-reviewer',
          type: 'agent',
          role: 'primary',
          priority: 80,
          activation: 'always',
        },
        {
          name: 'jest-testing',
          type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'on-demand',
        },
      ];

      const result = await createElement(mockContext, {
        name: 'review-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Review team',
        metadata: { elements },
      });

      const call = (mockContext.ensembleManager.create as jest.Mock).mock.calls[0][0];
      expect(call.elements).toEqual(elements);
      expect(result.content[0].text).toContain('✅');
    });

    it('should delegate conflictResolution defaults to manager', async () => {
      const result = await createElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Test',
      });

      // Handler no longer sets defaults — manager handles them in create()
      expect(mockContext.ensembleManager.create).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should respect custom conflictResolution strategy', async () => {
      const result = await createElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Test',
        metadata: {
          conflictResolution: 'priority',
        },
      });

      const call = (mockContext.ensembleManager.create as jest.Mock).mock.calls[0][0];
      expect(call.conflictResolution).toBe('priority');
      expect(result.content[0].text).toContain('✅');
    });

    it('should pass snake_case conflictResolution parameter to manager', async () => {
      const result = await createElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Test',
        metadata: {
          conflict_resolution: 'merge',
        },
      });

      const call = (mockContext.ensembleManager.create as jest.Mock).mock.calls[0][0];
      // Handler passes snake_case through; manager normalizes in create()
      expect(call.conflict_resolution).toBe('merge');
      expect(result.content[0].text).toContain('✅');
    });

    it('should delegate activationStrategy defaults to manager', async () => {
      const result = await createElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Test',
      });

      // Handler no longer sets defaults — manager handles them in create()
      expect(mockContext.ensembleManager.create).toHaveBeenCalled();
      expect(result.content[0].text).toContain('✅');
    });

    it('should respect custom activationStrategy', async () => {
      const result = await createElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Test',
        metadata: {
          activationStrategy: 'priority',
        },
      });

      const call = (mockContext.ensembleManager.create as jest.Mock).mock.calls[0][0];
      expect(call.activationStrategy).toBe('priority');
      expect(result.content[0].text).toContain('✅');
    });

    it('should pass snake_case activationStrategy parameter to manager', async () => {
      const result = await createElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Test',
        metadata: {
          activation_strategy: 'lazy',
        },
      });

      const call = (mockContext.ensembleManager.create as jest.Mock).mock.calls[0][0];
      // Handler passes snake_case through; manager normalizes in create()
      expect(call.activation_strategy).toBe('lazy');
      expect(result.content[0].text).toContain('✅');
    });

    it('should handle ensemble creation errors', async () => {
      mockContext.ensembleManager.create = jest.fn().mockImplementation(async () => {
        throw new Error('Invalid conflict resolution strategy');
      });

      const result = await createElement(mockContext, {
        name: 'test-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Test',
      });

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Invalid conflict resolution strategy');
    });

    it('should pass through all ensemble metadata', async () => {
      const metadata = {
        activationStrategy: 'all',
        conflictResolution: 'error',
        contextSharing: 'full',
        allowNested: true,
        maxNestingDepth: 3,
        elements: [
          {
            name: 'agent-1',
            type: 'agent',
            role: 'primary',
            priority: 90,
            activation: 'always',
          },
        ],
      };

      await createElement(mockContext, {
        name: 'complex-ensemble',
        type: ElementType.ENSEMBLE,
        description: 'Complex ensemble',
        metadata,
      });

      const call = (mockContext.ensembleManager.create as jest.Mock).mock.calls[0][0];
      expect(call).toMatchObject(metadata);
    });
  });

  describe('initialization', () => {
    it('should call ensureInitialized', async () => {
      await createElement(mockContext, {
        name: 'test',
        type: ElementType.SKILL,
        description: 'Test',
      });

      expect(mockContext.ensureInitialized).toHaveBeenCalled();
    });
  });
});
