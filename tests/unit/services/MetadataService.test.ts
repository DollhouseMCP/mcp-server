/**
 * MetadataService - Unit Tests
 *
 * Tests for centralized metadata normalization and default value assignment.
 *
 * Test Coverage:
 * - normalizeMetadata() for all element types
 * - generateDefaultMetadata() for all element types
 * - assignUniqueId() edge cases
 * - getCurrentUser() fallback chain
 * - setCurrentUser() state management
 * - normalizeVersion() format handling
 * - generateDate() format options
 * - validateMetadata() validation rules
 */

import { MetadataService } from '../../../src/services/MetadataService.js';
import { ElementType } from '../../../src/portfolio/types.js';

describe('MetadataService', () => {
  let service: MetadataService;

  beforeEach(() => {
    service = new MetadataService();
    // Clear environment variable between tests
    delete process.env.DOLLHOUSE_USER;
  });

  describe('normalizeMetadata', () => {
    it('should apply base metadata defaults', () => {
      const result = service.normalizeMetadata(
        { name: 'Test Skill' },
        ElementType.SKILL
      );

      expect(result.name).toBe('Test Skill');
      expect(result.description).toBe('');
      expect(result.version).toBe('1.0.0');
      expect(result.author).toBeTruthy();  // Should have an author (anonymous or from env)
      expect(result.created).toBeTruthy();
      expect(result.modified).toBeTruthy();
      expect(result.unique_id).toBeTruthy();
      expect(result.type).toBe(ElementType.SKILL);
    });

    it('should normalize version format (1.0 → 1.0.0)', () => {
      const result = service.normalizeMetadata(
        { name: 'Test', version: '1.0' },
        ElementType.SKILL
      );

      expect(result.version).toBe('1.0.0');
    });

    it('should generate unique ID if missing', () => {
      const result = service.normalizeMetadata(
        { name: 'Test Skill' },
        ElementType.SKILL
      );

      expect(result.unique_id).toBeTruthy();
      expect(typeof result.unique_id).toBe('string');
    });

    it('should set current user as author', () => {
      service.setCurrentUser('testuser');
      const result = service.normalizeMetadata(
        { name: 'Test Skill' },
        ElementType.SKILL
      );

      expect(result.author).toBe('testuser');
    });

    it('should set creation date if missing', () => {
      const result = service.normalizeMetadata(
        { name: 'Test Skill' },
        ElementType.SKILL
      );

      expect(result.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);  // YYYY-MM-DD format
    });

    it('should preserve existing values when preserveExisting=true', () => {
      const existing = {
        name: 'Test Skill',
        version: '2.5.1',
        author: 'original-author',
        created: '2020-01-01',
        unique_id: 'original-id'
      };

      const result = service.normalizeMetadata(
        existing,
        ElementType.SKILL,
        { preserveExisting: true }
      );

      expect(result.version).toBe('2.5.1');
      expect(result.author).toBe('original-author');
      expect(result.created).toBe('2020-01-01');
      expect(result.unique_id).toBe('original-id');
    });

    it('should apply type-specific defaults (Skill)', () => {
      const result = service.normalizeMetadata(
        { name: 'Test Skill' },
        ElementType.SKILL,
        {
          typeDefaults: {
            category: 'coding',
            difficulty: 'intermediate'
          }
        }
      );

      expect((result as any).category).toBe('coding');
      expect((result as any).difficulty).toBe('intermediate');
    });

    it('should apply type-specific defaults (Persona)', () => {
      const result = service.normalizeMetadata(
        { name: 'Test Persona' },
        ElementType.PERSONA,
        {
          typeDefaults: {
            category: 'general',
            content_flags: ['user-created'],
            age_rating: 'all'
          }
        }
      );

      expect((result as any).category).toBe('general');
      expect((result as any).content_flags).toEqual(['user-created']);
      expect((result as any).age_rating).toBe('all');
    });

    it('should apply type-specific defaults (Template)', () => {
      const result = service.normalizeMetadata(
        { name: 'Test Template' },
        ElementType.TEMPLATE,
        {
          typeDefaults: {
            category: 'documentation',
            output_format: 'markdown',
            usage_count: 0
          }
        }
      );

      expect((result as any).category).toBe('documentation');
      expect((result as any).output_format).toBe('markdown');
      expect((result as any).usage_count).toBe(0);
    });

    it('should apply type-specific defaults (Agent)', () => {
      const result = service.normalizeMetadata(
        { name: 'Test Agent' },
        ElementType.AGENT,
        {
          typeDefaults: {
            maxConcurrentGoals: 5,
            decisionFramework: 'rational',
          }
        }
      );

      expect((result as any).maxConcurrentGoals).toBe(5);
      expect((result as any).decisionFramework).toBe('rational');
    });

    it('should apply type-specific defaults (Memory)', () => {
      const result = service.normalizeMetadata(
        { name: 'Test Memory' },
        ElementType.MEMORY,
        {
          typeDefaults: {
            storageBackend: 'filesystem',
            retentionDays: 30,
            privacyLevel: 'private',
            searchable: true
          }
        }
      );

      expect((result as any).storageBackend).toBe('filesystem');
      expect((result as any).retentionDays).toBe(30);
      expect((result as any).privacyLevel).toBe('private');
      expect((result as any).searchable).toBe(true);
    });

    it('should apply type-specific defaults (Ensemble)', () => {
      const result = service.normalizeMetadata(
        { name: 'Test Ensemble' },
        ElementType.ENSEMBLE,
        {
          typeDefaults: {
            activationStrategy: 'sequential',
            conflictResolution: 'priority',
            contextSharing: 'full'
          }
        }
      );

      expect((result as any).activationStrategy).toBe('sequential');
      expect((result as any).conflictResolution).toBe('priority');
      expect((result as any).contextSharing).toBe('full');
    });
  });

  describe('generateDefaultMetadata', () => {
    it('should generate defaults for Skill', () => {
      const defaults = service.generateDefaultMetadata(ElementType.SKILL);

      expect(defaults.name).toBe('Untitled Skill');
      expect(defaults.description).toBe('');
      expect(defaults.version).toBe('1.0.0');
      expect(defaults.author).toBeTruthy();
      expect(defaults.created).toBeTruthy();
      expect(defaults.modified).toBeTruthy();
      expect(defaults.type).toBe(ElementType.SKILL);
    });

    it('should generate defaults for Persona', () => {
      const defaults = service.generateDefaultMetadata(ElementType.PERSONA);
      expect(defaults.name).toBe('Untitled Persona');
    });

    it('should generate defaults for Template', () => {
      const defaults = service.generateDefaultMetadata(ElementType.TEMPLATE);
      expect(defaults.name).toBe('Untitled Template');
    });

    it('should generate defaults for Agent', () => {
      const defaults = service.generateDefaultMetadata(ElementType.AGENT);
      expect(defaults.name).toBe('Untitled Agent');
    });

    it('should generate defaults for Memory', () => {
      const defaults = service.generateDefaultMetadata(ElementType.MEMORY);
      expect(defaults.name).toBe('Untitled Memory');
    });

    it('should generate defaults for Ensemble', () => {
      const defaults = service.generateDefaultMetadata(ElementType.ENSEMBLE);
      expect(defaults.name).toBe('Untitled Ensemble');
    });

    it('should apply overrides to defaults', () => {
      const defaults = service.generateDefaultMetadata(
        ElementType.SKILL,
        { name: 'Custom Name', version: '2.0.0' }
      );

      expect(defaults.name).toBe('Custom Name');
      expect(defaults.version).toBe('2.0.0');
    });
  });

  describe('assignUniqueId', () => {
    it('should generate ID from name and author', () => {
      const id = service.assignUniqueId('My Skill', 'john');
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('should generate unique IDs even for same inputs (Issue #848)', () => {
      const id1 = service.assignUniqueId('My Skill', 'john');
      const id2 = service.assignUniqueId('My Skill', 'john');
      // IDs include random suffix — each call produces a unique ID
      expect(id1).not.toBe(id2);
      // But both should contain the name and author
      expect(id1).toContain('my-skill');
      expect(id1).toContain('john');
      expect(id2).toContain('my-skill');
      expect(id2).toContain('john');
    });

    it('should generate different IDs for different authors', () => {
      const id1 = service.assignUniqueId('My Skill', 'john');
      const id2 = service.assignUniqueId('My Skill', 'jane');
      expect(id1).not.toBe(id2);
      expect(id1).toContain('john');
      expect(id2).toContain('jane');
    });

    it('should handle empty name', () => {
      const id = service.assignUniqueId('', 'john');
      expect(id).toBeTruthy();
    });

    it('should handle empty author', () => {
      const id = service.assignUniqueId('My Skill', '');
      expect(id).toBeTruthy();
    });
  });

  describe('getCurrentUser', () => {
    it('should return service-level user if set', () => {
      service.setCurrentUser('john');
      expect(service.getCurrentUser()).toBe('john');
    });

    it('should return environment variable if service user not set', () => {
      process.env.DOLLHOUSE_USER = 'envuser';
      expect(service.getCurrentUser()).toBe('envuser');
    });

    it('should fall back to OS username when no explicit user or env var', () => {
      const user = service.getCurrentUser();
      expect(user).toBeTruthy();
      expect(typeof user).toBe('string');
      // Should resolve to OS username (not anonymous) on standard platforms
      expect(user.startsWith('anon-')).toBe(false);
    });

    it('should cache resolved user on subsequent calls', () => {
      const first = service.getCurrentUser();
      const second = service.getCurrentUser();
      expect(first).toBe(second);
    });

    it('should prefer service-level user over environment variable', () => {
      process.env.DOLLHOUSE_USER = 'envuser';
      service.setCurrentUser('serviceuser');
      expect(service.getCurrentUser()).toBe('serviceuser');
    });
  });

  describe('setCurrentUser', () => {
    it('should set current user', () => {
      service.setCurrentUser('john');
      expect(service.getCurrentUser()).toBe('john');
    });

    it('should clear current user when null', () => {
      service.setCurrentUser('john');
      service.setCurrentUser(null);
      // Should fall back to env var or anonymous
      expect(service.getCurrentUser()).not.toBe('john');
    });
  });

  describe('normalizeVersion', () => {
    it('should normalize 1.0 to 1.0.0', () => {
      expect(service.normalizeVersion('1.0')).toBe('1.0.0');
    });

    it('should normalize 2 to 2.0.0', () => {
      expect(service.normalizeVersion('2')).toBe('2.0.0');
    });

    it('should preserve 1.2.3', () => {
      expect(service.normalizeVersion('1.2.3')).toBe('1.2.3');
    });

    it('should preserve pre-release (1.0.0-beta)', () => {
      expect(service.normalizeVersion('1.0.0-beta')).toBe('1.0.0-beta');
    });

    it('should handle invalid versions gracefully', () => {
      // Should return as-is for invalid formats
      const result = service.normalizeVersion('invalid');
      expect(result).toBeTruthy();
    });
  });

  describe('generateDate', () => {
    it('should generate date-only format (YYYY-MM-DD)', () => {
      const date = service.generateDate('date-only');
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should generate full ISO 8601 format', () => {
      const datetime = service.generateDate('full');
      expect(datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should default to full format when no format specified', () => {
      const datetime = service.generateDate();
      expect(datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('validateMetadata', () => {
    it('should validate required fields', () => {
      const result = service.validateMetadata(
        {
          name: 'Test',
          description: 'A test',
          version: '1.0.0'
        },
        ElementType.SKILL
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject missing name', () => {
      const result = service.validateMetadata(
        {
          name: '',
          description: 'A test',
          version: '1.0.0'
        },
        ElementType.SKILL
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('name is required and must be a non-empty string');
    });

    it('should reject missing description', () => {
      const result = service.validateMetadata(
        {
          name: 'Test',
          version: '1.0.0'
        } as any,
        ElementType.SKILL
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('description is required (can be empty string)');
    });

    it('should reject missing version', () => {
      const result = service.validateMetadata(
        {
          name: 'Test',
          description: 'A test'
        } as any,
        ElementType.SKILL
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('version is required and must be a string');
    });

    it('should validate field types (author)', () => {
      const result = service.validateMetadata(
        {
          name: 'Test',
          description: 'A test',
          version: '1.0.0',
          author: 123 as any
        },
        ElementType.SKILL
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('author must be a string');
    });

    it('should validate field types (tags array)', () => {
      const result = service.validateMetadata(
        {
          name: 'Test',
          description: 'A test',
          version: '1.0.0',
          tags: 'not-an-array' as any
        },
        ElementType.SKILL
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('tags must be an array');
    });

    it('should validate field types (triggers array)', () => {
      const result = service.validateMetadata(
        {
          name: 'Test',
          description: 'A test',
          version: '1.0.0',
          triggers: 'not-an-array' as any
        },
        ElementType.SKILL
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('triggers must be an array');
    });

    it('should validate type matches element type', () => {
      const result = service.validateMetadata(
        {
          name: 'Test',
          description: 'A test',
          version: '1.0.0',
          type: ElementType.PERSONA
        },
        ElementType.SKILL
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(`type must match element type (expected: ${ElementType.SKILL}, got: ${ElementType.PERSONA})`);
    });

    it('should accept singular type label matching element type (Issue #755)', () => {
      const result = service.validateMetadata(
        {
          name: 'Test',
          description: 'A test',
          version: '1.0.0',
          type: 'skill'  // singular label for ElementType.SKILL ('skills')
        },
        ElementType.SKILL
      );

      expect(result.valid).toBe(true);
    });

    it('should reject mismatched singular type label', () => {
      const result = service.validateMetadata(
        {
          name: 'Test',
          description: 'A test',
          version: '1.0.0',
          type: 'agent'  // singular of 'agents', not 'skills'
        },
        ElementType.SKILL
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(`type must match element type (expected: ${ElementType.SKILL}, got: agent)`);
    });

    it('should accept empty description (but not undefined)', () => {
      const result = service.validateMetadata(
        {
          name: 'Test',
          description: '',
          version: '1.0.0'
        },
        ElementType.SKILL
      );

      expect(result.valid).toBe(true);
    });
  });
});
