/**
 * Security Testing Infrastructure for DollhouseMCP
 * 
 * Provides comprehensive security testing to prevent vulnerabilities
 * and ensure rapid validation of security patches.
 */

export { SecurityTestFramework, SecurityTestOptions, SecurityTestSuite } from './framework/SecurityTestFramework.js';
export { RapidSecurityTesting, SecurityTestResult, preCommitSecurityCheck } from './framework/RapidSecurityTesting.js';

/**
 * Security Test Categories
 * 
 * CRITICAL: Must pass before any release
 * - Command injection
 * - Path traversal
 * - YAML deserialization
 * - Authentication bypass
 * 
 * HIGH: Should pass before release
 * - Input validation
 * - Token security
 * - Rate limiting
 * - SSRF protection
 * 
 * MEDIUM: Good to have
 * - Error handling
 * - Logging security
 * - Session management
 */
export const SECURITY_TEST_CATEGORIES = {
  CRITICAL: [
    'Command Injection Prevention',
    'Path Traversal Prevention',
    'YAML Deserialization Safety',
    'Authentication and Authorization'
  ],
  HIGH: [
    'Input Validation',
    'Token Security',
    'Rate Limiting',
    'SSRF Prevention'
  ],
  MEDIUM: [
    'Error Message Security',
    'Logging Security',
    'Session Management'
  ]
};

/**
 * Run all security tests
 */
export async function runAllSecurityTests(): Promise<{
  passed: boolean;
  report: string;
  duration: number;
}> {
  const { SecurityTestFramework } = await import('./framework/SecurityTestFramework.js');
  const start = Date.now();
  
  const result = await SecurityTestFramework.runSecuritySuite({
    category: 'all',
    parallel: true
  });
  
  const duration = Date.now() - start;
  const passed = result.failed === 0;
  
  const report = `
# Security Test Report

## Summary
- Total Tests: ${result.passed + result.failed}
- Passed: ${result.passed}
- Failed: ${result.failed}
- Duration: ${duration}ms
- Status: ${passed ? '✅ SECURE' : '❌ VULNERABLE'}

## Categories Tested
- CRITICAL: Command Injection, Path Traversal, YAML Safety
- HIGH: Input Validation, Token Security, Rate Limiting
- MEDIUM: Error Handling, Logging Security

## Recommendation
${passed ? 'System is secure and ready for deployment.' : 'Security vulnerabilities detected. Fix before deployment.'}
`;
  
  return { passed, report, duration };
}

/**
 * Run rapid security check for CI/CD
 */
export async function runRapidSecurityCheck(): Promise<boolean> {
  const { RapidSecurityTesting } = await import('./framework/RapidSecurityTesting.js');
  const tester = new RapidSecurityTesting();
  const results = await tester.runCriticalTests();
  
  const failed = results.filter(r => !r.passed);
  if (failed.length > 0) {
    console.error('❌ Critical security issues found:');
    failed.forEach(r => {
      console.error(`  - ${r.test}: ${r.error}`);
    });
    return false;
  }
  
  console.log('✅ All critical security tests passed');
  return true;
}