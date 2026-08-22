/**
 * Security Auditor Tests
 */

import { describe, expect, beforeEach, afterEach, jest, test } from '@jest/globals';
import {
  SecurityAuditor,
  SecurityAuditFailure,
} from '../../../../src/security/audit/SecurityAuditor.js';
import { CodeScanner } from '../../../../src/security/audit/scanners/CodeScanner.js';
import { SecurityRules } from '../../../../src/security/audit/rules/SecurityRules.js';
import { suppressions as sourceSuppressions } from '../../../../src/security/audit/config/suppressions.js';
import type {
  ScanResult,
  SecurityAuditConfig,
  SecurityScanner,
} from '../../../../src/security/audit/types.js';
import type { IFileOperationsService } from '../../../../src/services/FileOperationsService.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Stats } from 'fs';
import { VULNERABLE_PATTERNS } from '../../../fixtures/testCredentials.js';

function canonicalSuppressionPattern(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replaceAll(/\/+/g, '/')
    .replace(/^(?:\*\*\/)+/, '');
}

function isFirstPartySourceGlob(value: string): boolean {
  const canonical = canonicalSuppressionPattern(value);
  return canonical.startsWith('src/') && canonical.slice('src/'.length).includes('*');
}

function isBlanketVendorSuppression(value: string): boolean {
  const canonical = canonicalSuppressionPattern(value);
  return canonical.startsWith('src/web-console/ui/vendor/') && canonical.includes('*');
}

async function captureAuditFailure(audit: Promise<ScanResult>): Promise<SecurityAuditFailure> {
  try {
    await audit;
  } catch (error) {
    if (error instanceof SecurityAuditFailure) return error;
    throw error;
  }
  throw new Error('Expected security audit to fail');
}

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
      expect(defaultConfig.scanners.dependencies.severityThreshold).toBe('low');
      expect(defaultConfig.reporting.failOnSeverity).toBe('high');
    });

    test('default scan excludes only the recorded vendored bundles, not first-party console code', async () => {
      const defaultConfig = await SecurityAuditor.getDefaultConfig(mockFileOperations);
      expect(defaultConfig.scanners.code.exclude.filter(pattern =>
        pattern.startsWith('src/web-console/ui/vendor/'))).toEqual([
        'src/web-console/ui/vendor/purify.min.js',
        'src/web-console/ui/vendor/marked.min.js',
        'src/web-console/ui/vendor/js-yaml.min.js',
      ]);
      expect(sourceSuppressions.filter(suppression =>
        suppression.rule === '*' &&
        typeof suppression.file === 'string' &&
        isBlanketVendorSuppression(suppression.file))).toEqual([]);

      expect(isBlanketVendorSuppression('**/src/web-console/ui/vendor/**/*')).toBe(true);

      const vendorDir = path.join(tempDir, 'src', 'web-console', 'ui', 'vendor');
      const uiDir = path.dirname(vendorDir);
      await fs.mkdir(vendorDir, { recursive: true });
      const credentialPattern = 'const api_key = "not-a-real-but-secret-shaped-value";';
      await fs.writeFile(path.join(vendorDir, 'purify.min.js'), credentialPattern);
      await fs.writeFile(path.join(uiDir, 'app.js'), credentialPattern);

      const scanner = new CodeScanner(defaultConfig.scanners.code);
      const findings = await scanner.scan({ projectRoot: tempDir });

      const normalizedFindingPaths = findings.map(finding => finding.file?.replaceAll('\\', '/'));
      expect(normalizedFindingPaths.some(file => file?.endsWith('/ui/app.js'))).toBe(true);
      expect(normalizedFindingPaths.some(file => file?.endsWith('/vendor/purify.min.js'))).toBe(false);
    });

    test('custom audit policy does not suppress first-party source directories', async () => {
      const configPath = path.join(
        process.cwd(),
        'src',
        'security',
        'audit',
        'config',
        'security-suppressions.json',
      );
      const parsed: unknown = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const entries = (parsed as { suppressions: Array<{ file?: string }> }).suppressions;
      const productionDirectoryGlobs = entries.filter(
        ({ file }) => typeof file === 'string' && isFirstPartySourceGlob(file),
      );

      expect(productionDirectoryGlobs).toEqual([]);
      expect(isFirstPartySourceGlob('src\\web-console\\**\\*.ts')).toBe(true);
      expect(isFirstPartySourceGlob('**/**/src/web-console/**/*.ts')).toBe(true);
    });

    test('built-in audit policy does not suppress first-party source directories', () => {
      const broadFirstPartySuppressions = sourceSuppressions.filter(({ file }) => {
        if (typeof file !== 'string') return false;
        const canonical = canonicalSuppressionPattern(file);
        return isFirstPartySourceGlob(file) ||
          (canonical.startsWith('scripts/') && canonical.includes('*'));
      });

      expect(broadFirstPartySuppressions).toEqual([]);
    });

    test('built-in audit policy cannot suppress dependency or configuration findings by file type', () => {
      const blanketDataSuppressions = sourceSuppressions.filter(({ rule, file }) =>
        rule === '*' && typeof file === 'string' && [
          '**/*.json',
          '**/*.yml',
          '**/*.yaml',
          'package-lock.json',
        ].includes(file),
      );

      expect(blanketDataSuppressions).toEqual([]);
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

    test('should not combine unrelated name and handle data into an MCP tool finding', async () => {
      const code = `
        const file = { name: 'memory.yaml', handle: directoryEntry, path: 'memories/memory.yaml' };
        const first = { name: 'display-only' };
        const second = { handle: async () => true };
        const third = { name: 'conditional-data', handle: enabled ? directoryEntry : undefined };
        export function collect() { return [file, first, second]; }
      `;

      await fs.writeFile(path.join(tempDir, 'file-handles.ts'), code);
      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f => f.ruleId === 'DMCP-SEC-003')).toBe(false);
    });

    test('should detect a delegated callable MCP tool handler', async () => {
      const code = `
        const execute = async (request) => processRequest(request);
        export const myTool = { name: 'dangerous_tool', handle: execute };
      `;

      await fs.writeFile(path.join(tempDir, 'delegated-handler.ts'), code);
      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-003' && f.message.includes('rate limiting')
      )).toBe(true);
    });

    test('should detect an imported delegated MCP tool handler', async () => {
      const code = `
        import { execute } from './handler.js';
        export const myTool = { name: 'dangerous_tool', handle: execute };
      `;

      await fs.writeFile(path.join(tempDir, 'imported-handler.ts'), code);
      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-003' && f.message.includes('rate limiting')
      )).toBe(true);
    });

    test('should detect a namespace-imported delegated MCP tool handler', async () => {
      const code = `
        import * as handlers from './handlers.js';
        export const myTool = { name: 'dangerous_tool', handle: handlers.execute };
      `;

      await fs.writeFile(path.join(tempDir, 'namespace-handler.ts'), code);
      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-003' && f.message.includes('rate limiting')
      )).toBe(true);
    });

    test('should detect a locally delegated object-member MCP tool handler', async () => {
      const code = `
        const handlers = { execute: async (request) => processRequest(request) };
        export const myTool = { name: 'dangerous_tool', handle: handlers.execute };
      `;

      await fs.writeFile(path.join(tempDir, 'object-member-handler.ts'), code);
      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-003' && f.message.includes('rate limiting')
      )).toBe(true);
    });

    test.each([
      ['local class instance', `
        class ToolHandlers { execute(request) { return processRequest(request); } }
        const handlers = new ToolHandlers();
        export const myTool = { name: 'dangerous_tool', handle: handlers.execute };
      `],
      ['imported class instance', `
        import { ToolHandlers } from './handlers.js';
        const handlers = new ToolHandlers();
        export const myTool = { name: 'dangerous_tool', handle: handlers.execute };
      `],
      ['late-bound class instance', `
        class ToolHandlers { execute(request) { return processRequest(request); } }
        let handlers;
        handlers = new ToolHandlers();
        export const myTool = { name: 'dangerous_tool', handle: handlers.execute };
      `],
      ['aliased class instance', `
        class ToolHandlers { execute(request) { return processRequest(request); } }
        const instance = new ToolHandlers();
        const handlers = instance;
        export const myTool = { name: 'dangerous_tool', handle: handlers.execute };
      `],
      ['static class method', `
        class ToolHandlers { static execute(request) { return processRequest(request); } }
        export const myTool = { name: 'dangerous_tool', handle: ToolHandlers.execute };
      `],
      ['factory-created handler object', `
        const handlers = createToolHandlers();
        export const myTool = { name: 'dangerous_tool', handle: handlers.execute };
      `],
      ['this method', `
        class ToolOwner {
          execute(request) { return processRequest(request); }
          tool = { name: 'dangerous_tool', handle: this.execute };
        }
      `],
      ['nested this method', `
        class ToolOwner {
          handlers = { execute: (request) => processRequest(request) };
          tool = { name: 'dangerous_tool', handle: this.handlers.execute };
        }
      `],
      ['bracketed this method', `
        class ToolOwner {
          execute(request) { return processRequest(request); }
          tool = { name: 'dangerous_tool', handle: this['execute'] };
        }
      `],
      ['super method', `
        class BaseOwner { execute(request) { return processRequest(request); } }
        class ToolOwner extends BaseOwner {
          tool = { name: 'dangerous_tool', handle: super.execute };
        }
      `],
    ])('should detect a delegated MCP tool handler from a %s', async (label, code) => {
      await fs.writeFile(path.join(tempDir, `${label.replaceAll(' ', '-')}.ts`), code);
      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-003' && f.message.includes('rate limiting')
      )).toBe(true);
    });

    test.each([
      ['factory call', `
        function createHandler() { return async (request) => processRequest(request); }
        export const myTool = { name: 'dangerous_tool', handle: createHandler() };
      `],
      ['conditional callable', `
        const primary = async (request) => processRequest(request);
        const fallback = async (request) => fallbackRequest(request);
        export const myTool = { name: 'dangerous_tool', handle: enabled ? primary : fallback };
      `],
      ['conditionally enabled callable', `
        const execute = async (request) => processRequest(request);
        export const myTool = { name: 'dangerous_tool', handle: enabled ? execute : undefined };
      `],
      ['logical-and callable', `
        const execute = async (request) => processRequest(request);
        export const myTool = { name: 'dangerous_tool', handle: enabled && execute };
      `],
      ['logical-or callable', `
        const execute = async (request) => processRequest(request);
        export const myTool = { name: 'dangerous_tool', handle: configured || execute };
      `],
      ['nullish callable', `
        const execute = async (request) => processRequest(request);
        export const myTool = { name: 'dangerous_tool', handle: configured ?? execute };
      `],
      ['local bracket member', `
        const handlers = { execute: async (request) => processRequest(request) };
        export const myTool = { name: 'dangerous_tool', handle: handlers['execute'] };
      `],
      ['namespace bracket member', `
        import * as handlers from './handlers.js';
        export const myTool = { name: 'dangerous_tool', handle: handlers['execute'] };
      `],
    ])('should detect a delegated MCP tool handler from a %s', async (label, code) => {
      await fs.writeFile(path.join(tempDir, `${label.replaceAll(' ', '-')}.ts`), code);
      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-003' && f.message.includes('rate limiting')
      )).toBe(true);
    });

    test('should detect callable aliases and alias chains', async () => {
      const code = `
        const execute = async (request) => processRequest(request);
        const firstAlias = execute;
        const secondAlias = firstAlias;
        export const myTool = { name: 'dangerous_tool', handle: secondAlias };
      `;

      await fs.writeFile(path.join(tempDir, 'aliased-handler.ts'), code);
      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-003' && f.message.includes('rate limiting')
      )).toBe(true);
    });

    test('should detect shorthand callable object members', async () => {
      const code = `
        const execute = async (request) => processRequest(request);
        const handlers = { execute };
        export const myTool = { name: 'dangerous_tool', handle: handlers.execute };
      `;

      await fs.writeFile(path.join(tempDir, 'shorthand-member-handler.ts'), code);
      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f =>
        f.ruleId === 'DMCP-SEC-003' && f.message.includes('rate limiting')
      )).toBe(true);
    });

    test.each([
      ['late identifier assignment', `
        let execute;
        execute = async (request) => processRequest(request);
        export const myTool = { name: 'dangerous_tool', handle: execute };
      `],
      ['late alias assignment', `
        const execute = async (request) => processRequest(request);
        let alias;
        alias = execute;
        export const myTool = { name: 'dangerous_tool', handle: alias };
      `],
      ['late object-member assignment', `
        const handlers = {};
        handlers.execute = async (request) => processRequest(request);
        export const myTool = { name: 'dangerous_tool', handle: handlers.execute };
      `],
      ['late bracket-member assignment', `
        const handlers = {};
        handlers['execute'] = async (request) => processRequest(request);
        export const myTool = { name: 'dangerous_tool', handle: handlers['execute'] };
      `],
    ])('should detect a delegated MCP tool handler from a %s', async (label, code) => {
      await fs.writeFile(path.join(tempDir, `${label.replaceAll(' ', '-')}.ts`), code);
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

    test('should not treat generic content-shaped models as HTTP user-input boundaries', async () => {
      const code = `
        export interface RecordShape { content: string; params: string[] }
        export function serialize(record: RecordShape) { return record.content; }
      `;
      await fs.writeFile(path.join(tempDir, 'content-model.ts'), code);

      const result = await detectAuditor.audit(tempDir);

      expect(result.findings.some(f => f.ruleId === 'DMCP-SEC-004')).toBe(false);
    });

    test.each([
      ['dot access', 'const value = req.body;'],
      ['optional dot access', 'const value = request?.query;'],
      ['bracket access', "const value = req['params'];"],
      ['optional bracket access', 'const value = request?.["body"];'],
      ['destructuring', 'const { body } = req;'],
      ['aliased destructuring', 'const { query: rawQuery, params } = request;'],
      ['nested destructuring', 'const { body: { content } } = req;'],
      ['nested destructuring after another property', 'const { app: { name }, query: { search } } = request;'],
      ['quoted property destructuring', 'const { "body": rawBody } = req;'],
      ['computed property destructuring', "const { ['params']: rawParams } = request;"],
      ['commented destructuring', 'const { /* request payload */ body } = req;'],
      ['destructuring after braces in comments', 'const { app /* } */, query } = request;'],
      ['destructuring assignment', 'let body; ({ body } = req);'],
      ['nested destructuring assignment', '({ query: { search } } = request);'],
      ['real destructuring after malformed commented example', '// example: const {\nconst { params } = req;'],
      ['template expression access', 'const value = `${req.body}`;'],
      ['typed destructuring', 'const { body }: { body: string; query: string } = req;'],
    ])('should detect missing Unicode validation for %s', (_name, code) => {
      const unicodeRule = new SecurityRules()
        .getDollhouseMCPRules()
        .find(rule => rule.id === 'DMCP-SEC-004');

      expect(unicodeRule?.check?.(code).some(finding => finding.ruleId === 'DMCP-SEC-004')).toBe(true);
    });

    test.each([
      ['response destructuring', 'const { body } = response;'],
      ['similarly named object', 'const value = databaseRequest.query;'],
      ['generic body model', 'const value = record.body;'],
      ['unrelated property aliased to params', 'const { app: params } = req;'],
      ['nested unrelated property named body', 'const { app: { body } } = request;'],
      ['commented direct access', '// const value = req.body;'],
      ['quoted direct access', 'const example = "request.query";'],
      ['commented destructuring assignment', '// ({ body } = req);'],
      ['quoted destructuring assignment', 'const example = "({ params } = request)";'],
      ['regular expression literal', 'const matcher = /req.body/;'],
      ['quoted token in regex before real code', 'const matcher = /"request.query/; const value = record.body;'],
    ])('should not treat %s as an HTTP user-input boundary', (_name, code) => {
      const unicodeRule = new SecurityRules()
        .getDollhouseMCPRules()
        .find(rule => rule.id === 'DMCP-SEC-004');

      expect(unicodeRule?.check?.(code)).toEqual([]);
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
      const defaultConfig = await SecurityAuditor.getDefaultConfig(mockFileOperations);
      const configWithSuppression: SecurityAuditConfig = {
        ...defaultConfig,
        scanners: {
          ...defaultConfig.scanners,
          dependencies: { ...defaultConfig.scanners.dependencies, enabled: false },
          configuration: { ...defaultConfig.scanners.configuration, enabled: false },
        },
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

    test('should suppress configured glob patterns against absolute scanner paths', async () => {
      const defaultConfig = await SecurityAuditor.getDefaultConfig(mockFileOperations);
      const configWithSuppression: SecurityAuditConfig = {
        ...defaultConfig,
        scanners: {
          ...defaultConfig.scanners,
          dependencies: { ...defaultConfig.scanners.dependencies, enabled: false },
          configuration: { ...defaultConfig.scanners.configuration, enabled: false },
        },
        reporting: { ...defaultConfig.reporting, formats: [], failOnSeverity: 'critical' },
        suppressions: [{
          rule: 'DMCP-SEC-004',
          file: '**/src/feature/suppressed.ts',
          reason: 'Test glob suppression for an absolute scanner path',
        }],
      };
      const sourceDir = path.join(tempDir, 'src', 'feature');
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(
        path.join(sourceDir, 'suppressed.ts'),
        'export function handler(req: { body: string }) { return req.body; }',
      );

      const result = await new SecurityAuditor(configWithSuppression, mockFileOperations).audit(tempDir);

      expect(result.findings.some(f => f.ruleId === 'DMCP-SEC-004')).toBe(false);
    });
  });

  describe('Build Failure Logic', () => {
    test('should fail closed when an enabled scanner cannot complete', async () => {
      const failingScanner: SecurityScanner = {
        name: 'FailingScanner',
        isEnabled: () => true,
        scan: async () => {
          throw new Error('package-lock.json could not be parsed');
        },
      };
      (auditor as unknown as { scanners: SecurityScanner[] }).scanners = [failingScanner];

      const failure = await captureAuditFailure(auditor.audit(tempDir));

      expect(failure.message).toMatch(
        /Security audit failed closed: Scanner FailingScanner failed: package-lock\.json could not be parsed/,
      );
      expect(failure.result.errors).toContain(
        'Scanner FailingScanner failed: package-lock.json could not be parsed',
      );
    });

    test('should fail on a known dependency advisory below the global severity threshold', async () => {
      const advisoryScanner: SecurityScanner = {
        name: 'AdvisoryScanner',
        isEnabled: () => true,
        scan: async () => [{
          ruleId: 'DEPENDENCY-BODY-PARSER-LIMIT-DOS',
          severity: 'low',
          message: 'body-parser is vulnerable',
          file: 'package-lock.json',
          remediation: 'Wait for the approved dependency update.',
          confidence: 'high',
        }],
      };
      (auditor as unknown as { scanners: SecurityScanner[] }).scanners = [advisoryScanner];

      const failure = await captureAuditFailure(auditor.audit(tempDir));

      expect(failure.message).toMatch(/Security audit failed: 1 known dependency advisories found/);
      expect(failure.result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'DEPENDENCY-BODY-PARSER-LIMIT-DOS',
          severity: 'low',
        }),
      ]));
    });

    test('should fail build on critical findings', async () => {
      const code = `const password = "${VULNERABLE_PATTERNS.HARDCODED_SECRET}";`;
      await fs.writeFile(path.join(tempDir, 'critical.js'), code);

      await expect(auditor.audit(tempDir)).rejects.toThrow(/Security audit failed/);
    });

    test('should not fail build on low severity findings', async () => {
      const defaultConfig = await SecurityAuditor.getDefaultConfig(mockFileOperations);
      const configLowSeverity: SecurityAuditConfig = {
        ...defaultConfig,
        scanners: {
          ...defaultConfig.scanners,
          dependencies: { ...defaultConfig.scanners.dependencies, enabled: false },
          configuration: { ...defaultConfig.scanners.configuration, enabled: false },
        },
        reporting: {
          ...defaultConfig.reporting,
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
