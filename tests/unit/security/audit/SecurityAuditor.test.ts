/**
 * Security Auditor Tests
 */

import { describe, expect, beforeEach, afterEach, jest, test } from '@jest/globals';
import { SecurityAuditor } from '../../../../src/security/audit/SecurityAuditor.js';
import type { SecurityAuditConfig } from '../../../../src/security/audit/types.js';
import type { IFileOperationsService } from '../../../../src/services/FileOperationsService.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Stats } from 'fs';
import { VULNERABLE_PATTERNS } from '../../../fixtures/testCredentials.js';

/**
 * Create a mock FileOperationsService for testing
 */
function createMockFileOperationsService(): jest.Mocked<IFileOperationsService> {
  return {
    readFile: jest.fn().mockResolvedValue(''),
    readElementFile: jest.fn().mockResolvedValue(''),
    writeFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    createDirectory: jest.fn().mockResolvedValue(undefined),
    listDirectory: jest.fn().mockResolvedValue([]),
    listDirectoryWithTypes: jest.fn().mockResolvedValue([]),
    renameFile: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    stat: jest.fn().mockResolvedValue({} as Stats),
    resolvePath: jest.fn().mockImplementation((relativePath: string, baseDirectory: string) =>
      path.resolve(baseDirectory, relativePath)
    ),
    validatePath: jest.fn().mockReturnValue(true),
    createFileExclusive: jest.fn().mockResolvedValue(true),
    copyFile: jest.fn().mockResolvedValue(undefined),
    chmod: jest.fn().mockResolvedValue(undefined),
    appendFile: jest.fn().mockResolvedValue(undefined)
  };
}

describe('SecurityAuditor', () => {
  let tempDir: string;
  let auditor: SecurityAuditor;
  let mockFileOperations: jest.Mocked<IFileOperationsService>;

  beforeEach(async () => {
    // Create temp directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'security-audit-test-'));

    // Create mock file operations service
    mockFileOperations = createMockFileOperationsService();

    // Create test config
    const config: SecurityAuditConfig = {
      enabled: true,
      scanners: {
        code: {
          enabled: true,
          rules: ['OWASP-Top-10', 'CWE-Top-25', 'DollhouseMCP-Security'],
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
        failOnSeverity: 'info'
      }
    };

    auditor = new SecurityAuditor(config, mockFileOperations);
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });

    // Reset all mocks
    jest.resetAllMocks();
  });

  describe('Basic Functionality', () => {
    test('should create auditor with default config', async () => {
      const defaultConfig = await SecurityAuditor.getDefaultConfig(mockFileOperations);
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
    // Create a special auditor that doesn't fail the build for these tests
    let detectAuditor: SecurityAuditor;

    beforeEach(() => {
      const detectConfig: SecurityAuditConfig = {
        ...auditor['config'],
        reporting: {
          ...auditor['config'].reporting,
          failOnSeverity: 'critical' as any // Use 'critical' but we'll override the check
        }
      };
      // Create auditor but override shouldFailBuild to always return false
      detectAuditor = new SecurityAuditor(detectConfig, mockFileOperations);
      (detectAuditor as any).shouldFailBuild = () => false;
    });

    test('should detect hardcoded secrets', async () => {
      const vulnerableCode = `
        const apiKey = "${VULNERABLE_PATTERNS.REALISTIC_API_KEY}";
        const password = "${VULNERABLE_PATTERNS.REALISTIC_PASSWORD}";
      `;

      await fs.writeFile(
        path.join(tempDir, 'vulnerable.js'),
        vulnerableCode
      );

      const result = await detectAuditor.audit(tempDir);

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

      const result = await detectAuditor.audit(tempDir);

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

      const result = await detectAuditor.audit(tempDir);

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

      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f =>
        f.ruleId === 'OWASP-A03-003' && f.severity === 'high'
      )).toBe(true);
    });
  });

  describe('DollhouseMCP Specific Rules', () => {
    // Use the same detectAuditor that doesn't fail the build
    let detectAuditor: SecurityAuditor;

    beforeEach(() => {
      const detectConfig: SecurityAuditConfig = {
        ...auditor['config'],
        reporting: {
          ...auditor['config'].reporting,
          failOnSeverity: 'critical' as any
        }
      };
      detectAuditor = new SecurityAuditor(detectConfig, mockFileOperations);
      (detectAuditor as any).shouldFailBuild = () => false;
    });

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
        path.join(tempDir, 'mcp-handler.ts'),
        code
      );

      const result = await detectAuditor.audit(tempDir);

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
        path.join(tempDir, 'input-handler.ts'),
        code
      );

      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-004' && f.message.includes('Unicode')
      )).toBe(true);
    });

    test('should detect security calls in template literals with expressions', async () => {
      // Test that authenticate() calls inside template literals are detected
      // even when they contain ${} expressions
      const code = `
        export async function loginUser(userId: string) {
          // This should trigger DMCP-SEC-006 because authenticate() is called
          // without logging, even though it's in a template literal
          const result = await authenticate(\`user-\${userId}\`);
          return result;
        }
      `;

      await fs.writeFile(
        path.join(tempDir, 'auth-handler.ts'),
        code
      );

      const result = await detectAuditor.audit(tempDir);

      // Should detect the authenticate() call
      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-006' && f.message.includes('Security operation without audit logging')
      )).toBe(true);
    });

    test('should detect validate() calls in template literals', async () => {
      const code = `
        export function validateInput(data: any) {
          const msg = \`Validating \${validate(data)}\`;
          return msg;
        }
      `;

      await fs.writeFile(
        path.join(tempDir, 'validator.ts'),
        code
      );

      const result = await detectAuditor.audit(tempDir);

      // Should detect the validate() call
      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-006' && f.message.includes('Security operation without audit logging')
      )).toBe(true);
    });
  });

  describe('Suppression Rules', () => {
    test('should suppress findings based on configuration', async () => {
      const configWithSuppression: SecurityAuditConfig = {
        ...await SecurityAuditor.getDefaultConfig(mockFileOperations),
        suppressions: [{
          rule: 'OWASP-A01-001',
          file: '*',
          reason: 'Test suppression'
        }]
      };

      const auditorWithSuppression = new SecurityAuditor(configWithSuppression, mockFileOperations);

      const code = `const apiKey = "sk-1234567890abcdef1234567890abcdef";`;
      await fs.writeFile(path.join(tempDir, 'suppressed.js'), code);

      const result = await auditorWithSuppression.audit(tempDir);

      expect(result.findings.some(f => f.ruleId === 'OWASP-A01-001')).toBe(false);
    });
  });

  describe('Build Failure Logic', () => {
    test('should fail build on critical findings', async () => {
      const code = `const password = "${VULNERABLE_PATTERNS.HARDCODED_SECRET}";`;
      await fs.writeFile(path.join(tempDir, 'critical.js'), code);

      await expect(auditor.audit(tempDir)).rejects.toThrow(/Security audit failed/);
    });

    test('should not fail build on low severity findings', async () => {
      const configLowSeverity: SecurityAuditConfig = {
        ...await SecurityAuditor.getDefaultConfig(mockFileOperations),
        reporting: {
          ...(await SecurityAuditor.getDefaultConfig(mockFileOperations)).reporting,
          failOnSeverity: 'critical'
        }
      };

      const auditorLow = new SecurityAuditor(configLowSeverity, mockFileOperations);

      // Create a file that would only trigger low-severity issues
      const code = `
        function securityOperation() {
          // Missing logging for security operation
          const result = sanitize(userInput);
          return result;
        }
      `;
      await fs.writeFile(path.join(tempDir, 'auth-handler.js'), code);

      const result = await auditorLow.audit(tempDir);
      expect(result.findings.length).toBeGreaterThan(0);
      // Should not throw
    });
  });

  describe('Report Generation', () => {
    test('should call writeFile for markdown report', async () => {
      const configWithMarkdown: SecurityAuditConfig = {
        enabled: true,
        scanners: {
          code: {
            enabled: true,
            rules: ['OWASP-Top-10', 'CWE-Top-25', 'DollhouseMCP-Security'],
            exclude: ['node_modules/**']
          },
          dependencies: {
            enabled: false,
            severityThreshold: 'high',
            checkLicenses: false
          },
          configuration: {
            enabled: false,
            checkFiles: []
          }
        },
        reporting: {
          formats: ['markdown'],
          createIssues: false,
          commentOnPr: false,
          failOnSeverity: 'critical'
        }
      };

      const markdownAuditor = new SecurityAuditor(configWithMarkdown, mockFileOperations);
      (markdownAuditor as any).shouldFailBuild = () => false;

      await markdownAuditor.audit(tempDir);

      expect(mockFileOperations.writeFile).toHaveBeenCalledWith(
        'security-audit-report.md',
        expect.any(String),
        expect.objectContaining({ source: 'SecurityAuditor.generateReports' })
      );
    });

    test('should call writeFile for JSON report', async () => {
      const configWithJson: SecurityAuditConfig = {
        enabled: true,
        scanners: {
          code: {
            enabled: true,
            rules: ['OWASP-Top-10', 'CWE-Top-25', 'DollhouseMCP-Security'],
            exclude: ['node_modules/**']
          },
          dependencies: {
            enabled: false,
            severityThreshold: 'high',
            checkLicenses: false
          },
          configuration: {
            enabled: false,
            checkFiles: []
          }
        },
        reporting: {
          formats: ['json'],
          createIssues: false,
          commentOnPr: false,
          failOnSeverity: 'critical'
        }
      };

      const jsonAuditor = new SecurityAuditor(configWithJson, mockFileOperations);
      (jsonAuditor as any).shouldFailBuild = () => false;

      await jsonAuditor.audit(tempDir);

      expect(mockFileOperations.writeFile).toHaveBeenCalledWith(
        'security-audit-report.json',
        expect.any(String),
        expect.objectContaining({ source: 'SecurityAuditor.generateReports' })
      );
    });
  });

  describe('Default Config Loading', () => {
    test('should use fileOperations to check for suppressions file', async () => {
      mockFileOperations.exists.mockResolvedValue(true);
      mockFileOperations.readFile.mockResolvedValue(JSON.stringify({
        suppressions: [
          { rule: 'TEST-001', file: 'test.js', reason: 'Test' }
        ]
      }));

      const config = await SecurityAuditor.getDefaultConfig(mockFileOperations);

      expect(mockFileOperations.exists).toHaveBeenCalled();
      expect(mockFileOperations.readFile).toHaveBeenCalled();
      expect(config.suppressions).toBeDefined();
      expect(config.suppressions!.some(s => s.rule === 'TEST-001')).toBe(true);
    });

    test('should handle missing suppressions file gracefully', async () => {
      mockFileOperations.exists.mockResolvedValue(false);

      const config = await SecurityAuditor.getDefaultConfig(mockFileOperations);

      expect(mockFileOperations.exists).toHaveBeenCalled();
      expect(mockFileOperations.readFile).not.toHaveBeenCalled();
      expect(config.enabled).toBe(true);
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
      // Since the files don't have findings, scannedFiles will be 0 (unique files with findings)
      // But we should have scanned the files
      expect(duration).toBeGreaterThan(0);
      expect(result.findings).toBeDefined();
    });
  });
});
