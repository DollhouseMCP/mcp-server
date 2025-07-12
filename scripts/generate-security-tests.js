#!/usr/bin/env node

/**
 * Security Test Generator
 * Generates security test templates for new MCP tools
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
const toolName = args[0];

if (!toolName) {
  console.error('Usage: node generate-security-tests.js <tool-name>');
  process.exit(1);
}

const testTemplate = `import { describe, test, expect } from '@jest/globals';
import { SecurityTestFramework } from '../framework/SecurityTestFramework.js';
import { DollhouseMCPServer } from '../../../src/index.js';

describe('${toolName} Security Tests', () => {
  let server: DollhouseMCPServer;
  
  beforeAll(() => {
    server = new DollhouseMCPServer();
  });
  
  describe('Input Validation', () => {
    test('should validate required parameters', async () => {
      const result = await server.callTool({
        params: {
          name: '${toolName}',
          arguments: {} // Missing required params
        }
      } as any);
      
      expect(result.content[0].text).toMatch(/required|missing|invalid/i);
    });
    
    test('should reject oversized inputs', async () => {
      const largeInput = 'x'.repeat(1024 * 1024); // 1MB
      
      const result = await server.callTool({
        params: {
          name: '${toolName}',
          arguments: {
            // Add tool-specific large input
            input: largeInput
          }
        }
      } as any);
      
      expect(result.content[0].text).toMatch(/too large|size limit/i);
    });
  });
  
  describe('Injection Prevention', () => {
    test('should prevent command injection', async () => {
      await SecurityTestFramework.testPayloadRejection(
        async (payload) => {
          return server.callTool({
            params: {
              name: '${toolName}',
              arguments: {
                // Add tool-specific injection point
                input: payload
              }
            }
          } as any);
        },
        'commandInjection'
      );
    });
    
    test('should prevent path traversal', async () => {
      await SecurityTestFramework.testPayloadRejection(
        async (payload) => {
          return server.callTool({
            params: {
              name: '${toolName}',
              arguments: {
                // Add tool-specific path parameter
                path: payload
              }
            }
          } as any);
        },
        'pathTraversal'
      );
    });
  });
  
  describe('Error Handling', () => {
    test('should not expose sensitive information in errors', async () => {
      // Set up sensitive data
      process.env.SENSITIVE_KEY = 'secret-value-12345';
      
      try {
        // Trigger an error
        await server.callTool({
          params: {
            name: '${toolName}',
            arguments: {
              // Add invalid arguments to trigger error
              invalid: true
            }
          }
        } as any);
      } catch (error) {
        expect(error.message).not.toContain('secret-value-12345');
        expect(error.stack).not.toContain('secret-value-12345');
      }
      
      delete process.env.SENSITIVE_KEY;
    });
  });
});
`;

const outputPath = join(
  process.cwd(),
  '__tests__',
  'security',
  'tests',
  `${toolName}-security.test.ts`
);

if (existsSync(outputPath)) {
  console.error(`❌ Test file already exists: ${outputPath}`);
  process.exit(1);
}

writeFileSync(outputPath, testTemplate);
console.log(`✅ Generated security test template: ${outputPath}`);
console.log(`\nNext steps:`);
console.log(`1. Edit the test file to add tool-specific parameters`);
console.log(`2. Run: npm run security:all`);
console.log(`3. Ensure all tests pass before committing`);