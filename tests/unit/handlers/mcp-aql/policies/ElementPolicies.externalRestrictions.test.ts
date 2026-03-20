/**
 * Unit tests for ElementPolicies externalRestrictions validation (Issue #625 Phase 2)
 *
 * Tests parseElementPolicy() validation of externalRestrictions structure,
 * including description, denyPatterns, and allowPatterns.
 */

import { describe, it, expect } from '@jest/globals';
import { parseElementPolicy } from '../../../../../src/handlers/mcp-aql/policies/ElementPolicies.js';
import { MAX_GLOB_PATTERN_LENGTH } from '../../../../../src/utils/patternMatcher.js';

describe('parseElementPolicy — externalRestrictions (Phase 2)', () => {
  it('should parse valid externalRestrictions with both patterns', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          description: 'Restrict tool access',
          denyPatterns: ['Bash:rm*'],
          allowPatterns: ['Bash:git*', 'Edit*'],
        },
      },
    };
    const policy = parseElementPolicy(metadata);
    expect(policy).toBeDefined();
    expect(policy!.externalRestrictions).toEqual({
      description: 'Restrict tool access',
      denyPatterns: ['Bash:rm*'],
      allowPatterns: ['Bash:git*', 'Edit*'],
    });
  });

  it('should parse externalRestrictions with denyPatterns only', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          description: 'Deny-only mode',
          denyPatterns: ['Bash:rm*'],
        },
      },
    };
    const policy = parseElementPolicy(metadata);
    expect(policy!.externalRestrictions).toEqual({
      description: 'Deny-only mode',
      denyPatterns: ['Bash:rm*'],
      allowPatterns: undefined,
    });
  });

  it('should parse externalRestrictions with allowPatterns only', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          description: 'Allow-only mode',
          allowPatterns: ['Bash:git*'],
        },
      },
    };
    const policy = parseElementPolicy(metadata);
    expect(policy!.externalRestrictions).toEqual({
      description: 'Allow-only mode',
      denyPatterns: undefined,
      allowPatterns: ['Bash:git*'],
    });
  });

  it('should throw when description is missing', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          denyPatterns: ['Bash:rm*'],
        },
      },
    };
    expect(() => parseElementPolicy(metadata)).toThrow('description is required');
  });

  it('should throw when description is non-string', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          description: 123,
          denyPatterns: ['Bash:rm*'],
        },
      },
    };
    expect(() => parseElementPolicy(metadata)).toThrow('description is required');
  });

  it('should throw when description is empty string', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          description: '',
          denyPatterns: ['Bash:rm*'],
        },
      },
    };
    expect(() => parseElementPolicy(metadata)).toThrow('description is required');
  });

  it('should throw when externalRestrictions is not an object', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: 'invalid',
      },
    };
    expect(() => parseElementPolicy(metadata)).toThrow('externalRestrictions must be an object');
  });

  it('should throw when patterns are not arrays', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          description: 'Test',
          denyPatterns: 'not-an-array',
        },
      },
    };
    expect(() => parseElementPolicy(metadata)).toThrow('denyPatterns must be an array');
  });

  it('should throw when allowPatterns are not arrays', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          description: 'Test',
          allowPatterns: { pattern: 'Bash*' },
        },
      },
    };
    expect(() => parseElementPolicy(metadata)).toThrow('allowPatterns must be an array');
  });

  it('should throw when patterns contain non-string items', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          description: 'Test',
          denyPatterns: ['Bash:rm*', 123],
        },
      },
    };
    expect(() => parseElementPolicy(metadata)).toThrow('denyPatterns must contain only strings');
  });

  it('should throw when pattern is empty string', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          description: 'Test',
          allowPatterns: ['Bash:git*', ''],
        },
      },
    };
    expect(() => parseElementPolicy(metadata)).toThrow('empty pattern string');
  });

  it('should throw when pattern exceeds max length', () => {
    const metadata = {
      gatekeeper: {
        externalRestrictions: {
          description: 'Test',
          denyPatterns: ['x'.repeat(MAX_GLOB_PATTERN_LENGTH + 1)],
        },
      },
    };
    expect(() => parseElementPolicy(metadata)).toThrow('exceeds maximum length');
  });

  it('should return undefined when no gatekeeper policy', () => {
    const metadata = { name: 'test' };
    const policy = parseElementPolicy(metadata);
    expect(policy).toBeUndefined();
  });

  it('should preserve other policy fields alongside externalRestrictions', () => {
    const metadata = {
      gatekeeper: {
        allow: ['list_elements'],
        deny: ['delete_element'],
        externalRestrictions: {
          description: 'Test',
          denyPatterns: ['Bash:rm*'],
        },
      },
    };
    const policy = parseElementPolicy(metadata);
    expect(policy!.allow).toEqual(['list_elements']);
    expect(policy!.deny).toEqual(['delete_element']);
    expect(policy!.externalRestrictions).toBeDefined();
  });

  describe('approvalPolicy validation (Phase 3)', () => {
    it('should parse valid approvalPolicy', () => {
      const metadata = {
        gatekeeper: {
          externalRestrictions: {
            description: 'With approval',
            approvalPolicy: {
              requireApproval: ['moderate', 'dangerous'],
              defaultScope: 'single',
              ttlSeconds: 120,
            },
          },
        },
      };
      const policy = parseElementPolicy(metadata);
      expect(policy!.externalRestrictions!.approvalPolicy).toEqual({
        requireApproval: ['moderate', 'dangerous'],
        defaultScope: 'single',
        ttlSeconds: 120,
      });
    });

    it('should parse approvalPolicy with only requireApproval', () => {
      const metadata = {
        gatekeeper: {
          externalRestrictions: {
            description: 'Minimal approval',
            approvalPolicy: {
              requireApproval: ['dangerous'],
            },
          },
        },
      };
      const policy = parseElementPolicy(metadata);
      expect(policy!.externalRestrictions!.approvalPolicy).toEqual({
        requireApproval: ['dangerous'],
        defaultScope: undefined,
        ttlSeconds: undefined,
      });
    });

    it('should reject invalid requireApproval values', () => {
      const metadata = {
        gatekeeper: {
          externalRestrictions: {
            description: 'Bad approval',
            approvalPolicy: {
              requireApproval: ['safe'],
            },
          },
        },
      };
      expect(() => parseElementPolicy(metadata)).toThrow('invalid value "safe"');
    });

    it('should reject non-array requireApproval', () => {
      const metadata = {
        gatekeeper: {
          externalRestrictions: {
            description: 'Bad approval',
            approvalPolicy: {
              requireApproval: 'dangerous',
            },
          },
        },
      };
      expect(() => parseElementPolicy(metadata)).toThrow('must be an array');
    });

    it('should reject invalid defaultScope', () => {
      const metadata = {
        gatekeeper: {
          externalRestrictions: {
            description: 'Bad scope',
            approvalPolicy: {
              defaultScope: 'global',
            },
          },
        },
      };
      expect(() => parseElementPolicy(metadata)).toThrow('must be "single" or "tool_session"');
    });

    it('should reject ttlSeconds below minimum (30)', () => {
      const metadata = {
        gatekeeper: {
          externalRestrictions: {
            description: 'Low TTL',
            approvalPolicy: {
              ttlSeconds: 10,
            },
          },
        },
      };
      expect(() => parseElementPolicy(metadata)).toThrow('must be between 30 and 3600');
    });

    it('should reject ttlSeconds above maximum (3600)', () => {
      const metadata = {
        gatekeeper: {
          externalRestrictions: {
            description: 'High TTL',
            approvalPolicy: {
              ttlSeconds: 7200,
            },
          },
        },
      };
      expect(() => parseElementPolicy(metadata)).toThrow('must be between 30 and 3600');
    });

    it('should reject non-object approvalPolicy', () => {
      const metadata = {
        gatekeeper: {
          externalRestrictions: {
            description: 'Bad type',
            approvalPolicy: 'should be object',
          },
        },
      };
      expect(() => parseElementPolicy(metadata)).toThrow('must be an object');
    });

    it('should allow externalRestrictions without approvalPolicy', () => {
      const metadata = {
        gatekeeper: {
          externalRestrictions: {
            description: 'No approval policy',
            denyPatterns: ['Bash:rm*'],
          },
        },
      };
      const policy = parseElementPolicy(metadata);
      expect(policy!.externalRestrictions!.approvalPolicy).toBeUndefined();
    });
  });
});
