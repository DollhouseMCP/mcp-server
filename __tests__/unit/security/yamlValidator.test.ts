import { describe, test, expect, beforeEach } from '@jest/globals';
import { YamlValidator } from '../../../src/security/yamlValidator.js';

describe('YamlValidator', () => {
  beforeEach(() => {
    // Reset DOMPurify cache before each test
    YamlValidator.resetCache();
  });

  describe('parsePersonaMetadataSafely', () => {
    test('should parse valid YAML content', () => {
      const validYaml = `
name: Test Persona
description: A test persona description
version: 1.0.0
category: educational
`;
      const result = YamlValidator.parsePersonaMetadataSafely(validYaml);
      expect(result.name).toBe('Test Persona');
      expect(result.description).toBe('A test persona description');
      expect(result.version).toBe('1.0.0');
      expect(result.category).toBe('educational');
    });

    test('should throw on empty content', () => {
      expect(() => YamlValidator.parsePersonaMetadataSafely('')).toThrow('YAML content must be a non-empty string');
      expect(() => YamlValidator.parsePersonaMetadataSafely(null as any)).toThrow('YAML content must be a non-empty string');
    });

    test('should throw on content exceeding size limit', () => {
      const largeContent = 'a'.repeat(50001);
      expect(() => YamlValidator.parsePersonaMetadataSafely(largeContent)).toThrow('YAML content too large');
    });

    test('should throw on dangerous YAML tags', () => {
      const dangerousYaml1 = 'name: !!js/function "alert()"';
      expect(() => YamlValidator.parsePersonaMetadataSafely(dangerousYaml1)).toThrow('Dangerous YAML tags detected');
      
      const dangerousYaml2 = 'name: !!python/object/apply:os.system ["ls"]';
      expect(() => YamlValidator.parsePersonaMetadataSafely(dangerousYaml2)).toThrow('Dangerous YAML tags detected');
    });

    test('should throw on YAML bomb attempts', () => {
      const yamlBomb = `
a: &a ["a", "a", "a"]
b: &b [*a, *a, *a]
c: &c [*b, *b, *b]
d: &d [*c, *c, *c]
e: &e [*d, *d, *d]
f: &f [*e, *e, *e]
g: &g [*f, *f, *f]
h: &h [*g, *g, *g]
i: &i [*h, *h, *h]
j: &j [*i, *i, *i]
k: &k [*j, *j, *j]
`;
      expect(() => YamlValidator.parsePersonaMetadataSafely(yamlBomb)).toThrow('Potential YAML bomb detected');
    });

    test('should sanitize HTML/XSS content using DOMPurify', () => {
      const xssYaml = `
name: <script>alert('XSS')</script>Test
description: <iframe src="evil.com"></iframe>Description<img src=x onerror=alert(1)>
author: <style>body{display:none}</style>Author
`;
      const result = YamlValidator.parsePersonaMetadataSafely(xssYaml);
      
      // DOMPurify should remove all HTML tags completely
      expect(result.name).toBe('Test');
      expect(result.description).toBe('Description');
      expect(result.author).toBe('Author');
      
      // Ensure no HTML tags remain
      expect(result.name).not.toContain('<');
      expect(result.description).not.toContain('<');
      expect(result.author).not.toContain('<');
    });

    test('should remove command injection patterns', () => {
      const commandInjectionYaml = `
name: Test \`rm -rf /\` Name
description: Test $(whoami) Description
author: Test \${USER} Author
`;
      const result = YamlValidator.parsePersonaMetadataSafely(commandInjectionYaml);
      
      // Command injection patterns should be removed
      expect(result.name).toBe('Test  Name');
      expect(result.description).toBe('Test  Description');
      expect(result.author).toBe('Test  Author');
      
      // Ensure no command patterns remain
      expect(result.name).not.toContain('`');
      expect(result.description).not.toContain('$(');
      expect(result.author).not.toContain('${');
    });

    test('should handle edge cases in sanitization', () => {
      const edgeCaseYaml = `
name: Test</script >Name
description: Test<script  >alert(1)</script>Description
`;
      const result = YamlValidator.parsePersonaMetadataSafely(edgeCaseYaml);
      
      // DOMPurify should handle these edge cases correctly
      expect(result.name).toBe('TestName');
      expect(result.description).toBe('TestDescription');
    });

    test('should normalize whitespace and remove hex escapes', () => {
      const whitespaceYaml = `
name: Test\\x00Name\\x00
description: Test\\x41\\u0042
author:   Trimmed   
`;
      const result = YamlValidator.parsePersonaMetadataSafely(whitespaceYaml);
      
      // Hex and unicode escapes should be removed by sanitization
      expect(result.name).toBe('TestName');
      expect(result.description).toBe('Test');
      // Extra whitespace should be trimmed
      expect(result.author).toBe('Trimmed');
    });

    test('should validate against schema', () => {
      const invalidYaml = `
name: 
description: Valid description
version: not-a-version
`;
      expect(() => YamlValidator.parsePersonaMetadataSafely(invalidYaml))
        .toThrow('Invalid persona metadata');
    });

    test('should handle arrays in triggers field', () => {
      const yamlWithTriggers = `
name: Test Persona
description: Test description
triggers:
  - <script>alert(1)</script>trigger1
  - trigger2$(whoami)
  - normal_trigger
`;
      const result = YamlValidator.parsePersonaMetadataSafely(yamlWithTriggers);
      
      expect(result.triggers).toHaveLength(3);
      expect(result.triggers[0]).toBe('trigger1');
      expect(result.triggers[1]).toBe('trigger2');
      expect(result.triggers[2]).toBe('normal_trigger');
    });
  });

  describe('resetCache', () => {
    test('should allow cache reset', () => {
      // Parse something to initialize cache
      const yaml = 'name: Test\ndescription: Test';
      YamlValidator.parsePersonaMetadataSafely(yaml);
      
      // Reset should not throw
      expect(() => YamlValidator.resetCache()).not.toThrow();
      
      // Should still work after reset
      const result = YamlValidator.parsePersonaMetadataSafely(yaml);
      expect(result.name).toBe('Test');
    });
  });
});