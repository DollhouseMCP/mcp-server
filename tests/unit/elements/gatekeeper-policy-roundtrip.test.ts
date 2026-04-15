/**
 * Round-trip tests for gatekeeper policy on all element types (Issue #524)
 *
 * Verifies that gatekeeper policies survive serialize → deserialize for each
 * element type. This is the core requirement: YAML front matter with a
 * `gatekeeper` block must be preserved through the full lifecycle.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { PersonaElement } from '../../../src/persona/PersonaElement.js';
import { Skill } from '../../../src/elements/skills/Skill.js';
import { Template } from '../../../src/elements/templates/Template.js';
import * as yaml from 'js-yaml';
import { createTestMetadataService } from '../../helpers/di-mocks.js';
import type { MetadataService } from '../../../src/services/MetadataService.js';
import type { ElementGatekeeperPolicy } from '../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { getGatekeeperDiagnostics, sanitizeGatekeeperPolicy } from '../../../src/handlers/mcp-aql/policies/ElementPolicies.js';

let metadataService: MetadataService;

beforeAll(() => {
  metadataService = createTestMetadataService();
});

const SAMPLE_POLICY: ElementGatekeeperPolicy = {
  deny: ['delete_element'],
  confirm: ['edit_element'],
  allow: ['list_elements', 'get_element'],
};

describe('Gatekeeper policy round-trip (Issue #524)', () => {
  describe('PersonaElement', () => {
    it('should preserve gatekeeper policy through serialize/deserialize', () => {
      const persona = new PersonaElement(
        {
          name: 'Policy Persona',
          description: 'A persona with gatekeeper policy',
          gatekeeper: SAMPLE_POLICY,
        },
        'You are a helpful persona.',
        '',
        metadataService,
      );

      // Serialize to markdown with YAML frontmatter
      const serialized = persona.serialize();

      // Verify gatekeeper appears in frontmatter
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).toBeTruthy();
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      expect(frontmatter.gatekeeper).toBeDefined();
      expect(frontmatter.gatekeeper.deny).toEqual(['delete_element']);

      // Deserialize back
      const restored = new PersonaElement(
        { name: 'placeholder', description: '' },
        '',
        '',
        metadataService,
      );
      restored.deserialize(serialized);

      // Verify gatekeeper survived
      expect(restored.metadata.gatekeeper).toBeDefined();
      expect(restored.metadata.gatekeeper!.deny).toEqual(['delete_element']);
      expect(restored.metadata.gatekeeper!.confirm).toEqual(['edit_element']);
      expect(restored.metadata.gatekeeper!.allow).toEqual(['list_elements', 'get_element']);
    });

    it('should handle persona without gatekeeper policy', () => {
      const persona = new PersonaElement(
        { name: 'No Policy', description: 'No gatekeeper' },
        'Content',
        '',
        metadataService,
      );

      const serialized = persona.serialize();
      const restored = new PersonaElement(
        { name: 'placeholder', description: '' },
        '',
        '',
        metadataService,
      );
      restored.deserialize(serialized);

      expect(restored.metadata.gatekeeper).toBeUndefined();
    });
  });

  describe('Skill', () => {
    it('should preserve gatekeeper policy in metadata', () => {
      const skill = new Skill(
        {
          name: 'Policy Skill',
          description: 'A skill with gatekeeper policy',
          gatekeeper: SAMPLE_POLICY,
        },
        'Do things skillfully.',
        metadataService,
      );

      // Verify gatekeeper is in metadata
      expect(skill.metadata.gatekeeper).toBeDefined();
      expect(skill.metadata.gatekeeper!.deny).toEqual(['delete_element']);

      // Serialize to markdown — skill uses BaseElement.serialize() which
      // spreads ...this.metadata into frontmatter
      const serialized = skill.serialize();
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).toBeTruthy();
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      expect(frontmatter.gatekeeper).toBeDefined();
      expect(frontmatter.gatekeeper.deny).toEqual(['delete_element']);
    });
  });

  describe('Template', () => {
    it('should preserve gatekeeper policy in metadata', () => {
      const template = new Template(
        {
          name: 'Policy Template',
          description: 'A template with gatekeeper policy',
          gatekeeper: SAMPLE_POLICY,
        },
        'Template content: {{ variable }}',
        metadataService,
      );

      // Verify gatekeeper is in metadata
      expect(template.metadata.gatekeeper).toBeDefined();
      expect(template.metadata.gatekeeper!.deny).toEqual(['delete_element']);

      // Serialize to markdown
      const serialized = template.serialize();
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).toBeTruthy();
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      expect(frontmatter.gatekeeper).toBeDefined();
      expect(frontmatter.gatekeeper.deny).toEqual(['delete_element']);
    });
  });

  describe('IElementMetadata base interface', () => {
    it('should accept gatekeeper on the base interface', () => {
      // TypeScript compilation test — gatekeeper is valid on IElementMetadata
      const metadata: import('../../../src/types/elements/IElement.js').IElementMetadata = {
        name: 'Test',
        description: 'Test',
        gatekeeper: SAMPLE_POLICY,
      };
      expect(metadata.gatekeeper).toBeDefined();
      expect(metadata.gatekeeper!.deny).toEqual(['delete_element']);
    });
  });

  describe('sanitizeGatekeeperPolicy', () => {
    it('should validate and return a well-formed policy', () => {
      const result = sanitizeGatekeeperPolicy(
        { deny: ['delete_element'], allow: ['list_elements'] },
        'test-element',
        'persona',
      );
      expect(result).toBeDefined();
      expect(result!.deny).toEqual(['delete_element']);
      expect(result!.allow).toEqual(['list_elements']);
    });

    it('should return undefined for falsy input', () => {
      expect(sanitizeGatekeeperPolicy(undefined, 'x', 'persona')).toBeUndefined();
      expect(sanitizeGatekeeperPolicy(null, 'x', 'persona')).toBeUndefined();
      expect(sanitizeGatekeeperPolicy('', 'x', 'persona')).toBeUndefined();
    });

    it('should strip malformed policy and return undefined', () => {
      // deny must be an array of strings, not a number
      const result = sanitizeGatekeeperPolicy(
        { deny: 42 },
        'bad-element',
        'skill',
      );
      expect(result).toBeUndefined();
    });

    it('should attach diagnostics to metadata targets for malformed policies', () => {
      const metadata: Record<string, unknown> = {};

      const result = sanitizeGatekeeperPolicy(
        { deny: 42 },
        'bad-element',
        'skill',
        metadata,
      );

      expect(result).toBeUndefined();
      expect(getGatekeeperDiagnostics(metadata)).toEqual({
        valid: false,
        enforceable: false,
        message: expect.stringContaining('Fix:'),
      });
      expect(getGatekeeperDiagnostics(metadata)?.message).toContain('Use YAML arrays of strings');
    });

    it('should clear diagnostics when the policy is later valid', () => {
      const metadata: Record<string, unknown> = {};

      sanitizeGatekeeperPolicy({ deny: 42 }, 'bad-element', 'skill', metadata);
      expect(getGatekeeperDiagnostics(metadata)).toBeDefined();

      const result = sanitizeGatekeeperPolicy(
        { deny: ['delete_element'] },
        'good-element',
        'skill',
        metadata,
      );

      expect(result).toBeDefined();
      expect(getGatekeeperDiagnostics(metadata)).toBeUndefined();
    });

    it('should validate scopeRestrictions', () => {
      const result = sanitizeGatekeeperPolicy(
        {
          deny: ['delete_element'],
          scopeRestrictions: { allowedTypes: ['persona', 'skill'] },
        },
        'scoped-element',
        'template',
      );
      expect(result).toBeDefined();
      expect(result!.scopeRestrictions?.allowedTypes).toEqual(['persona', 'skill']);
    });
  });

  describe('transient diagnostics', () => {
    it('should not serialize gatekeeper diagnostics into frontmatter', () => {
      const skill = new Skill(
        {
          name: 'Transient Diagnostics Skill',
          description: 'A skill with runtime-only diagnostics',
          gatekeeperDiagnostics: {
            valid: false,
            enforceable: false,
            message: 'Malformed gatekeeper policy',
          },
        } as any,
        'Do things skillfully.',
        metadataService,
      );

      const serialized = skill.serialize();
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).toBeTruthy();
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      expect(frontmatter.gatekeeperDiagnostics).toBeUndefined();
    });
  });
});
