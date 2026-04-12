/**
 * AgentElementValidator Tests
 *
 * Comprehensive test suite covering agent-specific validation:
 * - V2.0 goal validation (template, parameters, successCriteria)
 * - Goal template/parameter consistency checking
 * - Activates configuration validation
 * - Tools configuration validation
 * - System prompt validation
 * - Autonomy configuration validation
 * - V1.x legacy field validation with deprecation warnings
 * - V1 to V2 migration suggestions
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { AgentElementValidator } from '../../../../src/services/validation/AgentElementValidator.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { SECURITY_LIMITS } from '../../../../src/security/constants.js';

jest.mock('../../../../src/services/validation/ValidationService.js');
jest.mock('../../../../src/services/validation/TriggerValidationService.js');
jest.mock('../../../../src/services/MetadataService.js');

describe('AgentElementValidator', () => {
  let validator: AgentElementValidator;
  let mockValidationService: jest.Mocked<ValidationService>;
  let mockTriggerService: jest.Mocked<TriggerValidationService>;
  let mockMetadataService: jest.Mocked<MetadataService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockValidationService = {
      validateAndSanitizeInput: jest.fn().mockReturnValue({
        isValid: true,
        sanitizedValue: 'sanitized',
        errors: undefined,
        warnings: []
      }),
      validateContent: jest.fn().mockReturnValue({
        isValid: true,
        sanitizedContent: 'content',
        detectedPatterns: []
      }),
      validateCategory: jest.fn().mockReturnValue({
        isValid: true,
        sanitizedValue: 'automation',
        errors: undefined
      })
    } as unknown as jest.Mocked<ValidationService>;

    mockTriggerService = {
      validateTriggers: jest.fn().mockReturnValue({
        validTriggers: ['automate'],
        rejectedTriggers: [],
        hasRejections: false,
        totalInput: 1,
        warnings: []
      })
    } as unknown as jest.Mocked<TriggerValidationService>;

    mockMetadataService = {} as jest.Mocked<MetadataService>;

    validator = new AgentElementValidator(
      mockValidationService,
      mockTriggerService,
      mockMetadataService
    );
  });

  describe('Constructor', () => {
    it('should initialize with AGENT element type', () => {
      expect(validator.elementType).toBe(ElementType.AGENT);
    });
  });

  describe('validateCreate', () => {
    describe('V2.0 Goal Validation (OPTIONAL for V1 compatibility)', () => {
      it('should allow agents without goal field (V1 compatibility)', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions that are long enough'
        };

        const result = await validator.validateCreate(data);

        // V1 agents without goal should be valid
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should reject whitespace-only content', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: '   '
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Content is too short (minimum 10 characters)');
      });

      it('should reject content exceeding the maximum allowed length', async () => {
        mockValidationService.validateContent.mockReturnValueOnce({
          isValid: false,
          sanitizedContent: 'x'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 1),
          detectedPatterns: [
            `Content exceeds maximum length of ${SECURITY_LIMITS.MAX_CONTENT_LENGTH} characters after normalization`
          ]
        });

        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'x'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 1)
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('exceeds maximum length') || e.includes('Content validation failed'))).toBe(true);
      });

      it('should reject non-object goal', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: 'invalid goal string'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Goal must be an object'))).toBe(true);
      });

      it('should require goal.template', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            parameters: []
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required 'template' field"))).toBe(true);
      });

      it('should require goal.parameters', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Deploy {service} to {environment}'
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required 'parameters' field"))).toBe(true);
      });

      it('should accept valid goal configuration', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Deploy {service} to {environment}',
            parameters: [
              { name: 'service', type: 'string', required: true },
              { name: 'environment', type: 'string', required: true }
            ]
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should validate goal template is non-empty string', async () => {
        // Calls: 1) content field (pass), 2) goal.template (return empty)
        mockValidationService.validateContent
          .mockReturnValueOnce({ isValid: true, sanitizedContent: 'Agent instructions', detectedPatterns: [] })
          .mockReturnValueOnce({ isValid: true, sanitizedContent: '', detectedPatterns: [] });

        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: '',
            parameters: []
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('cannot be empty'))).toBe(true);
      });

      it('should enforce maximum template length', async () => {
        // Mock validateContent to fail for content exceeding max length
        mockValidationService.validateContent.mockReturnValueOnce({
          isValid: false,
          sanitizedContent: 'x'.repeat(1001),
          detectedPatterns: ['Content exceeds maximum length of 1000 characters after normalization']
        });

        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'x'.repeat(1001),
            parameters: []
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('exceeds maximum length') || e.includes('failed content validation'))).toBe(true);
      });

      it('should validate goal template content security', async () => {
        // Configure mock to reject malicious content
        mockValidationService.validateContent.mockReturnValueOnce({
          isValid: false,
          sanitizedContent: '',
          detectedPatterns: ['Potential injection pattern detected']
        });

        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Execute ${malicious_code}',
            parameters: []
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('injection pattern'))).toBe(true);
        expect(mockValidationService.validateContent).toHaveBeenCalledWith(
          'Execute ${malicious_code}',
          expect.objectContaining({ maxLength: 1000 })
        );
      });

      it('should call validateContent for valid goal templates', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete the task: {task_name}',
            parameters: [{ name: 'task_name', type: 'string', required: true }]
          }
        };

        await validator.validateCreate(data);

        // Verify validateContent was called for the template
        expect(mockValidationService.validateContent).toHaveBeenCalledWith(
          'Complete the task: {task_name}',
          expect.objectContaining({ maxLength: 1000 })
        );
      });

      it('should accept optional successCriteria', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: [],
            successCriteria: ['Task completed successfully', 'No errors']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should validate successCriteria is string array', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: [],
            successCriteria: 'not an array'
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be an array of strings'))).toBe(true);
      });
    });

    describe('Goal Parameter Validation', () => {
      it('should validate parameter has required fields', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Deploy {service}',
            parameters: [
              { name: 'service' } // missing type and required
            ]
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("missing required 'type' field"))).toBe(true);
        expect(result.errors.some(e => e.includes("missing required 'required' field"))).toBe(true);
      });

      it('should validate parameter type is valid', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Deploy {service}',
            parameters: [
              { name: 'service', type: 'invalid', required: true }
            ]
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('invalid type') && e.includes('string, number, boolean'))).toBe(true);
      });

      it('should detect duplicate parameter names', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Deploy {service}',
            parameters: [
              { name: 'service', type: 'string', required: true },
              { name: 'service', type: 'string', required: true }
            ]
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Duplicate parameter name'))).toBe(true);
      });

      it('should warn about template placeholders not in parameters', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Deploy {service} to {environment}',
            parameters: [
              { name: 'service', type: 'string', required: true }
              // missing 'environment'
            ]
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('environment') && w.includes('not defined'))).toBe(true);
      });

      it('should warn about parameters not used in template', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Deploy {service}',
            parameters: [
              { name: 'service', type: 'string', required: true },
              { name: 'unused', type: 'string', required: false }
            ]
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('unused') && w.includes('not used in template'))).toBe(true);
      });

      it('should warn about default value type mismatch', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Process {count}',
            parameters: [
              { name: 'count', type: 'number', required: false, default: 'not a number' }
            ]
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('type mismatch'))).toBe(true);
      });

      it('should accept valid parameter with description and default', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Deploy {service}',
            parameters: [
              {
                name: 'service',
                type: 'string',
                required: false,
                description: 'Service to deploy',
                default: 'api'
              }
            ]
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });
    });

    describe('V2.0 Activates Validation (OPTIONAL)', () => {
      it('should accept valid activates configuration', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          activates: {
            personas: ['persona1', 'persona2'],
            skills: ['skill1'],
            memories: ['memory1']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject non-object activates', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          activates: 'invalid'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Activates must be an object'))).toBe(true);
      });

      it('should validate activates values are string arrays', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          activates: {
            personas: 'not an array'
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be an array of strings'))).toBe(true);
      });

      it('should warn about unknown element types', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          activates: {
            unknown_type: ['element1']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('Unknown element type'))).toBe(true);
      });

      it('should warn about empty element names', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          activates: {
            personas: ['persona1', '']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('is empty'))).toBe(true);
      });
    });

    describe('V2.0 Tools Validation (OPTIONAL)', () => {
      it('should accept valid tools configuration', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          tools: {
            allowed: ['file_read', 'file_write'],
            denied: ['system_exec']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should require allowed field if tools defined', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          tools: {
            denied: ['system_exec']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes("must include 'allowed' array"))).toBe(true);
      });

      it('should reject non-object tools', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          tools: 'invalid'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Tools must be an object'))).toBe(true);
      });

      it('should warn if tool appears in both allowed and denied', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          tools: {
            allowed: ['file_read', 'file_write'],
            denied: ['file_write']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('both allowed and denied'))).toBe(true);
      });
    });

    describe('V2.0 System Prompt Validation (OPTIONAL)', () => {
      it('should accept valid system prompt', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          systemPrompt: 'You are a helpful deployment assistant.'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject non-string system prompt', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          systemPrompt: 123
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be a string'))).toBe(true);
      });

      it('should reject empty system prompt', async () => {
        // Calls: 1) content field, 2) goal.template, 3) systemPrompt
        mockValidationService.validateContent
          .mockReturnValueOnce({ isValid: true, sanitizedContent: 'Agent instructions', detectedPatterns: [] })
          .mockReturnValueOnce({ isValid: true, sanitizedContent: 'Complete task', detectedPatterns: [] })
          .mockReturnValueOnce({ isValid: true, sanitizedContent: '', detectedPatterns: [] });

        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          systemPrompt: ''
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('cannot be empty'))).toBe(true);
      });

      it('should reject system prompt exceeding max length', async () => {
        // Calls: 1) content field, 2) goal.template, 3) systemPrompt (fails)
        mockValidationService.validateContent
          .mockReturnValueOnce({ isValid: true, sanitizedContent: 'Agent instructions', detectedPatterns: [] })
          .mockReturnValueOnce({ isValid: true, sanitizedContent: 'Complete task', detectedPatterns: [] })
          .mockReturnValueOnce({
            isValid: false,
            sanitizedContent: 'x'.repeat(10001),
            detectedPatterns: ['Content exceeds maximum length of 10000 characters after normalization']
          });

        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          systemPrompt: 'x'.repeat(10001)
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('exceeds maximum length') || e.includes('failed validation'))).toBe(true);
      });

      it('should warn about very long system prompts', async () => {
        const longContent = 'x'.repeat(5001);
        // Calls: 1) content field, 2) goal.template, 3) systemPrompt (returns long content)
        mockValidationService.validateContent
          .mockReturnValueOnce({ isValid: true, sanitizedContent: 'Agent instructions', detectedPatterns: [] })
          .mockReturnValueOnce({ isValid: true, sanitizedContent: 'Complete task', detectedPatterns: [] })
          .mockReturnValueOnce({ isValid: true, sanitizedContent: longContent, detectedPatterns: [] });

        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          systemPrompt: longContent
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('very long'))).toBe(true);
      });

      it('should validate system prompt content security', async () => {
        mockValidationService.validateContent.mockReturnValueOnce({
          isValid: false,
          sanitizedContent: '',
          detectedPatterns: ['malicious pattern']
        });

        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          systemPrompt: 'malicious content'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('malicious pattern'))).toBe(true);
      });
    });

    describe('V2.0 Autonomy Validation (OPTIONAL)', () => {
      it('should accept valid autonomy configuration', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          autonomy: {
            riskTolerance: 'moderate',
            maxAutonomousSteps: 10,
            requiresApproval: ['deploy_*', 'delete_*'],
            autoApprove: ['read_*']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should reject non-object autonomy', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          autonomy: 'invalid'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Autonomy must be an object'))).toBe(true);
      });

      it('should validate riskTolerance enum', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          autonomy: {
            riskTolerance: 'invalid'
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid risk tolerance'))).toBe(true);
      });

      it('should validate maxAutonomousSteps is non-negative integer', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          autonomy: {
            maxAutonomousSteps: -1
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('must be non-negative'))).toBe(true);
      });

      it('should accept maxAutonomousSteps of 0 (unlimited)', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          autonomy: {
            maxAutonomousSteps: 0
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
      });

      it('should warn about exact match conflicts between requiresApproval and autoApprove', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          autonomy: {
            requiresApproval: ['deploy_prod'],
            autoApprove: ['deploy_prod']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('exact match'))).toBe(true);
        expect(result.warnings.some(w => w.includes('requiresApproval takes precedence'))).toBe(true);
      });

      it('should warn about glob pattern conflicts (specific matches glob)', async () => {
        // deploy_prod matches the pattern deploy_*
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          autonomy: {
            requiresApproval: ['deploy_*'],
            autoApprove: ['deploy_prod', 'deploy_staging']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        // Should warn about both specific patterns matching the glob
        expect(result.warnings.length).toBeGreaterThanOrEqual(2);
        expect(result.warnings.some(w => w.includes('deploy_prod') && w.includes('deploy_*'))).toBe(true);
        expect(result.warnings.some(w => w.includes('deploy_staging') && w.includes('deploy_*'))).toBe(true);
      });

      it('should warn about glob pattern conflicts (glob in autoApprove)', async () => {
        // deploy_prod matches the pattern deploy_*
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          autonomy: {
            requiresApproval: ['deploy_prod'],
            autoApprove: ['deploy_*']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('deploy_prod') && w.includes('deploy_*'))).toBe(true);
        expect(result.warnings.some(w => w.includes('requiresApproval takes precedence'))).toBe(true);
      });

      it('should not warn when patterns do not overlap', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          autonomy: {
            requiresApproval: ['deploy_*', 'delete_*'],
            autoApprove: ['read_*', 'list_*']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        // Should not have any conflict warnings (only suggestions)
        const conflictWarnings = result.warnings.filter(w =>
          w.includes('requiresApproval') && w.includes('autoApprove')
        );
        expect(conflictWarnings).toHaveLength(0);
      });
    });

    describe('V1.x Legacy Field Validation', () => {
      it('should warn about deprecated decisionFramework', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          decisionFramework: 'rule_based'
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('decisionFramework') && w.includes('deprecated'))).toBe(true);
      });

      it('should warn about deprecated learningEnabled', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          learningEnabled: true
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('learningEnabled') && w.includes('deprecated'))).toBe(true);
      });

      it('should warn about deprecated ruleEngineConfig', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          ruleEngineConfig: {}
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('ruleEngineConfig') && w.includes('deprecated'))).toBe(true);
      });

      it('should validate but warn about deprecated maxConcurrentGoals', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          },
          maxConcurrentGoals: 5
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.warnings.some(w => w.includes('maxConcurrentGoals') && w.includes('deprecated'))).toBe(true);
      });

      it('should suggest migration for V1 agents', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          decisionFramework: 'rule_based',
          specializations: ['deployment']
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions).toBeDefined();
        expect(result.suggestions!.some(s => s.includes('V1.x agent') && s.includes('migrating'))).toBe(true);
      });
    });

    describe('V2.0 Suggestions', () => {
      it('should suggest adding activates if missing', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions).toBeDefined();
        expect(result.suggestions!.some(s => s.includes('activates'))).toBe(true);
      });

      it('should suggest adding tools if missing', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions).toBeDefined();
        expect(result.suggestions!.some(s => s.includes('tools'))).toBe(true);
      });

      it('should suggest adding systemPrompt if missing', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions).toBeDefined();
        expect(result.suggestions!.some(s => s.includes('systemPrompt'))).toBe(true);
      });

      it('should suggest adding autonomy if missing', async () => {
        const data = {
          name: 'Test Agent',
          description: 'A test agent',
          content: 'Agent instructions',
          goal: {
            template: 'Complete task',
            parameters: []
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.suggestions).toBeDefined();
        expect(result.suggestions!.some(s => s.includes('autonomy'))).toBe(true);
      });
    });

    describe('Complete V2.0 Agent', () => {
      it('should validate complete V2.0 agent without errors', async () => {
        const data = {
          name: 'Complete Agent',
          description: 'A fully configured V2.0 agent',
          content: 'Comprehensive agent instructions with detailed guidance',
          goal: {
            template: 'Deploy {service} to {environment} with {replicas} replicas',
            parameters: [
              {
                name: 'service',
                type: 'string',
                required: true,
                description: 'The service to deploy'
              },
              {
                name: 'environment',
                type: 'string',
                required: true,
                description: 'Target environment'
              },
              {
                name: 'replicas',
                type: 'number',
                required: false,
                description: 'Number of replicas',
                default: 3
              }
            ],
            successCriteria: [
              'Service is running',
              'Health checks passing',
              'All replicas online'
            ]
          },
          activates: {
            personas: ['devops-engineer'],
            skills: ['kubernetes-deploy', 'health-check'],
            memories: ['deployment-history']
          },
          tools: {
            allowed: ['kubectl', 'curl', 'file_read'],
            denied: ['rm', 'delete_all']
          },
          systemPrompt: 'You are an expert DevOps engineer focused on safe, reliable deployments.',
          autonomy: {
            riskTolerance: 'moderate',
            maxAutonomousSteps: 20,
            requiresApproval: ['deploy_production_*', 'scale_down_*'],
            autoApprove: ['health_check_*', 'read_*']
          }
        };

        const result = await validator.validateCreate(data);

        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });
  });
});
