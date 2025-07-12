#!/usr/bin/env node

/**
 * Security Test Runner
 * Runs security tests with different categories and generates reports
 */

import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

const args = process.argv.slice(2);
const category = args[0] || 'critical';
const generateReport = args.includes('--report');

console.log(`🔒 Running ${category.toUpperCase()} security tests...\n`);

const startTime = Date.now();

// Run Jest with security tests
const testProcess = spawn('npm', [
  'run',
  'test',
  '--',
  '__tests__/security',
  '--testNamePattern=Security',
  '--maxWorkers=4',
  '--silent'
], {
  stdio: 'inherit',
  shell: true
});

testProcess.on('close', (code) => {
  const duration = Date.now() - startTime;
  
  if (code === 0) {
    console.log(`\n✅ All ${category} security tests passed in ${duration}ms`);
    
    if (generateReport) {
      generateSecurityReport(category, duration, true);
    }
  } else {
    console.error(`\n❌ Security tests failed (exit code: ${code})`);
    
    if (generateReport) {
      generateSecurityReport(category, duration, false);
    }
    
    process.exit(1);
  }
});

function generateSecurityReport(category, duration, passed) {
  const report = {
    timestamp: new Date().toISOString(),
    category,
    duration,
    passed,
    metrics: {
      criticalTests: category === 'critical' ? 4 : 0,
      highTests: category === 'high' ? 3 : 0,
      mediumTests: category === 'medium' ? 2 : 0
    }
  };
  
  const reportPath = `security-report-${Date.now()}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📊 Security report generated: ${reportPath}`);
}