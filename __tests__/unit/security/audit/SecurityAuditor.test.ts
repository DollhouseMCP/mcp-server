/**
 * Security Auditor Tests
 */

import { SecurityAuditor } from '../../../../src/security/audit/SecurityAuditor.js';
import type { SecurityAuditConfig } from '../../../../src/security/audit/types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('SecurityAuditor', () => {
  let tempDir: string;
  let auditor: SecurityAuditor;

  beforeEach(async () => {
    // Create temp directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'security-audit-test-'));
    
    // Create test config
    const config: SecurityAuditConfig = {
      enabled: true,
      scanners: {
        code: {
          enabled: true,
          rules: ['OWASP-Top-10', 'DollhouseMCP-Security'],
          exclude: ['node_modules/**']
        },
        dependencies: {
          enabled: false, // Disable for unit tests
          severityThreshold: 'high',
          checkLicenses: false
        },
        configuration: {
          enabled: false, // Disable for unit tests
          checkFiles: []
        }
      },
      reporting: {
        formats: ['console'],
        createIssues: false,
        commentOnPr: false,
        failOnSeverity: 'critical'
      }
    };
    
    auditor = new SecurityAuditor(config);
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('Basic Functionality', () => {
    test('should create auditor with default config', () => {
      const defaultConfig = SecurityAuditor.getDefaultConfig();
      expect(defaultConfig.enabled).toBe(true);
      expect(defaultConfig.scanners.code.enabled).toBe(true);
      expect(defaultConfig.scanners.dependencies.enabled).toBe(true);
    });

    test('should run audit on empty directory', async () => {
      const result = await auditor.audit(tempDir);
      
      expect(result.findings).toEqual([]);
      expect(result.summary.total).toBe(0);
      expect(result.duration).toBeGreaterThan(0);
    });
  });

  describe('Vulnerability Detection', () => {
    test('should detect hardcoded secrets', async () => {
      const vulnerableCode = `
        const apiKey = "sk-1234567890abcdef1234567890abcdef";
        const password = "super_secret_password_123";
      `;
      
      await fs.writeFile(
        path.join(tempDir, 'vulnerable.js'),
        vulnerableCode
      );
      
      const result = await auditor.audit(tempDir);
      
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings.some(f => f.ruleId === 'OWASP-A01-001')).toBe(true);
      expect(result.summary.bySeverity.critical).toBeGreaterThan(0);
    });

    test('should detect SQL injection', async () => {
      const vulnerableCode = `
        const query = "SELECT * FROM users WHERE id = " + userId;
        db.query(query);
      `;
      
      await fs.writeFile(
        path.join(tempDir, 'sql-injection.js'),
        vulnerableCode
      );
      
      const result = await auditor.audit(tempDir);
      
      expect(result.findings.some(f => 
        f.ruleId === 'CWE-89-001' && f.severity === 'critical'
      )).toBe(true);
    });

    test('should detect command injection', async () => {
      const vulnerableCode = `
        const exec = require('child_process').exec;
        exec('ls ' + userInput);
      `;
      
      await fs.writeFile(
        path.join(tempDir, 'command-injection.js'),
        vulnerableCode
      );
      
      const result = await auditor.audit(tempDir);
      
      expect(result.findings.some(f => 
        f.ruleId === 'OWASP-A03-002' && f.severity === 'critical'
      )).toBe(true);
    });

    test('should detect path traversal', async () => {
      const vulnerableCode = `
        const fs = require('fs');
        const content = fs.readFileSync('../../../' + filename);
      `;
      
      await fs.writeFile(
        path.join(tempDir, 'path-traversal.js'),
        vulnerableCode
      );
      
      const result = await auditor.audit(tempDir);
      
      expect(result.findings.some(f => 
        f.ruleId === 'OWASP-A03-003' && f.severity === 'high'
      )).toBe(true);
    });
  });

  describe('DollhouseMCP Specific Rules', () => {
    test('should detect missing rate limiting', async () => {
      const code = `
        export const myTool = {
          name: 'dangerous_tool',
          handle: async (request) => {
            // No rate limiting!
            return processRequest(request);
          }
        };
      `;
      
      await fs.writeFile(
        path.join(tempDir, 'mcp-tool.ts'),
        code
      );
      
      const result = await auditor.audit(tempDir);
      
      expect(result.findings.some(f => 
        f.ruleId === 'DMCP-SEC-003' && f.message.includes('rate limiting')
      )).toBe(true);
    });

    test('should detect missing Unicode validation', async () => {
      const code = `
        function processUserInput(request) {
          const content = request.body.content;
          // Process content without Unicode validation
          return content.toUpperCase();
        }
      `;
      
      await fs.writeFile(
        path.join(tempDir, 'unicode-bypass.ts'),
        code
      );
      
      const result = await auditor.audit(tempDir);
      
      expect(result.findings.some(f => 
        f.ruleId === 'DMCP-SEC-004' && f.message.includes('Unicode')
      )).toBe(true);
    });
  });

  describe('Suppression Rules', () => {
    test('should suppress findings based on configuration', async () => {
      const configWithSuppression: SecurityAuditConfig = {
        ...SecurityAuditor.getDefaultConfig(),
        suppressions: [{
          rule: 'OWASP-A01-001',
          file: '*',
          reason: 'Test suppression'
        }]
      };
      
      const auditorWithSuppression = new SecurityAuditor(configWithSuppression);
      
      const code = `const apiKey = "sk-1234567890abcdef1234567890abcdef";`;
      await fs.writeFile(path.join(tempDir, 'suppressed.js'), code);
      
      const result = await auditorWithSuppression.audit(tempDir);
      
      expect(result.findings.some(f => f.ruleId === 'OWASP-A01-001')).toBe(false);
    });
  });

  describe('Build Failure Logic', () => {
    test('should fail build on critical findings', async () => {
      const code = `const password = "hardcoded_password_123";`;
      await fs.writeFile(path.join(tempDir, 'critical.js'), code);
      
      await expect(auditor.audit(tempDir)).rejects.toThrow(/Security audit failed/);
    });

    test('should not fail build on low severity findings', async () => {
      const configLowSeverity: SecurityAuditConfig = {
        ...SecurityAuditor.getDefaultConfig(),
        reporting: {
          ...SecurityAuditor.getDefaultConfig().reporting,
          failOnSeverity: 'critical'
        }
      };
      
      const auditorLow = new SecurityAuditor(configLowSeverity);
      
      // Create a file that would only trigger low-severity issues
      const code = `
        function securityOperation() {
          // Missing logging
          authenticate(user);
        }
      `;
      await fs.writeFile(path.join(tempDir, 'low-severity.js'), code);
      
      const result = await auditorLow.audit(tempDir);
      expect(result.findings.length).toBeGreaterThan(0);
      // Should not throw
    });
  });

  describe('Performance', () => {
    test('should complete scan within reasonable time', async () => {
      // Create multiple test files
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(
          path.join(tempDir, `file${i}.js`),
          `// Test file ${i}\nconst data = process(input);`
        );
      }
      
      const startTime = Date.now();
      const result = await auditor.audit(tempDir);
      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(5000); // Should complete in < 5 seconds
      expect(result.scannedFiles).toBeGreaterThanOrEqual(10);
    });
  });
});