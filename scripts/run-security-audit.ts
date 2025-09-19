#!/usr/bin/env ts-node

/**
 * Local Security Audit Runner
 * 
 * This script runs the security audit locally and generates private reports.
 * Reports are automatically gitignored to keep security findings private.
 * 
 * Usage:
 *   npm run security:audit                    # Run audit without failing
 *   npm run security:audit -- --json          # Output JSON report
 *   npm run security:audit -- --markdown      # Output Markdown report (default)
 *   npm run security:audit -- --verbose       # Show all findings in console
 *   npm run security:audit -- --fail-on-critical  # Exit 1 if critical issues found
 *   npm run security:audit -- --fail-on-high      # Exit 1 if high/critical issues found
 * 
 * Multiple options can be combined:
 *   npm run security:audit -- --verbose --fail-on-high
 */

import { SecurityAuditor } from '../src/security/audit/SecurityAuditor.js';
import { ConsoleReporter } from '../src/security/audit/reporters/ConsoleReporter.js';
import { MarkdownReporter } from '../src/security/audit/reporters/MarkdownReporter.js';
import { JsonReporter } from '../src/security/audit/reporters/JsonReporter.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function runSecurityAudit() {
  console.log('🔒 Running Security Audit...\n');

  const args = process.argv.slice(2);
  const outputJson = args.includes('--json');
  const outputMarkdown = args.includes('--markdown') || !outputJson;
  const verbose = args.includes('--verbose');

  // Get default config and customize
  const config = SecurityAuditor.getDefaultConfig();
  
  // Customize configuration
  config.scanners.code.exclude = [
    'node_modules/**',
    'dist/**',
    'coverage/**',
    '.git/**',
    '**/*.test.ts',
    '**/*.spec.ts',
    '__tests__/**',
    'security-audit-report.*',
    '.security-audit/**'
  ];
  
  // Load suppressions from file if it exists
  const suppressionsPath = path.join(projectRoot, '.security-suppressions.json');
  let customSuppressions: any[] = [];
  try {
    const suppressionsContent = await fs.readFile(suppressionsPath, 'utf-8');
    const suppressionsData = JSON.parse(suppressionsContent);
    // Convert relative paths to absolute paths for matching
    customSuppressions = (suppressionsData.suppressions || []).map((suppression: any) => ({
      ...suppression,
      file: suppression.file?.startsWith('/')
        ? suppression.file
        : path.join(projectRoot, suppression.file)
    }));
  } catch (error) {
    // Suppressions file doesn't exist or is invalid - that's OK
  }

  // Add suppressions for test files and custom suppressions
  config.suppressions = [
    {
      rule: 'CWE-89-001',
      file: '__tests__/**/*',
      reason: 'Test files may contain security test patterns'
    },
    {
      rule: 'OWASP-A03-003',
      file: '__tests__/**/*',
      reason: 'Test files may test path traversal scenarios'
    },
    ...customSuppressions
  ];
  
  // Configure fail behavior based on command line args
  const failOnCritical = args.includes('--fail-on-critical');
  const failOnHigh = args.includes('--fail-on-high');
  
  if (failOnCritical) {
    config.reporting.failOnSeverity = 'critical';
  } else if (failOnHigh) {
    config.reporting.failOnSeverity = 'high';
  } else {
    config.reporting.failOnSeverity = 'none';
  }

  const auditor = new SecurityAuditor(config);
  
  try {
    // Run audit
    const startTime = Date.now();
    const result = await auditor.audit(projectRoot);
    const duration = Date.now() - startTime;

    // Console output already shown by SecurityAuditor
    // Just need to generate the detailed reports

    // Generate detailed reports
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const reportsDir = path.join(projectRoot, '.security-audit');
    await fs.mkdir(reportsDir, { recursive: true });

    if (outputMarkdown) {
      const markdownReporter = new MarkdownReporter(result);
      const markdownReport = markdownReporter.generate();
      
      // Save timestamped report
      const markdownPath = path.join(reportsDir, `security-audit-${timestamp}.md`);
      await fs.writeFile(markdownPath, markdownReport);
      
      // Also save as latest
      const latestMarkdownPath = path.join(projectRoot, 'security-audit-report.md');
      await fs.writeFile(latestMarkdownPath, markdownReport);
      
      console.log(`\n📄 Markdown report saved to:`);
      console.log(`   - ${path.relative(projectRoot, latestMarkdownPath)} (latest)`);
      console.log(`   - ${path.relative(projectRoot, markdownPath)} (timestamped)`);
    }

    if (outputJson) {
      const jsonReporter = new JsonReporter(result);
      const jsonReport = jsonReporter.generate();
      
      // Save timestamped report
      const jsonPath = path.join(reportsDir, `security-audit-${timestamp}.json`);
      await fs.writeFile(jsonPath, jsonReport);
      
      // Also save as latest
      const latestJsonPath = path.join(projectRoot, 'security-audit-report.json');
      await fs.writeFile(latestJsonPath, jsonReport);
      
      console.log(`\n📊 JSON report saved to:`);
      console.log(`   - ${path.relative(projectRoot, latestJsonPath)} (latest)`);
      console.log(`   - ${path.relative(projectRoot, jsonPath)} (timestamped)`);
    }

    // Create summary report
    const summaryPath = path.join(reportsDir, `security-audit-summary-${timestamp}.md`);
    const summary = `# Security Audit Summary
Generated: ${new Date().toLocaleString()}
Duration: ${duration}ms

## Overview
- Total Findings: ${result.findings.length}
- Files Scanned: ${result.scannedFiles}
- Audit Duration: ${result.duration}ms

## Findings by Severity
- 🔴 Critical: ${result.summary.bySeverity.critical}
- 🟠 High: ${result.summary.bySeverity.high}
- 🟡 Medium: ${result.summary.bySeverity.medium}
- 🟢 Low: ${result.summary.bySeverity.low}
- ℹ️ Info: ${result.summary.bySeverity.info}

## Top Issues
${result.findings.slice(0, 10).map(f => 
  `- **${f.ruleId}**: ${f.message} (${f.file}:${f.line || '?'})`
).join('\n')}

## Notes
- All reports are saved in \`.security-audit/\` directory
- Reports are automatically excluded from git
- Run with \`--verbose\` for more details
- Use \`--json\` for machine-readable output
`;
    await fs.writeFile(summaryPath, summary);

    console.log(`\n📋 Summary saved to: ${path.relative(projectRoot, summaryPath)}`);
    console.log('\n✅ Security audit complete!');
    
    // Show quick stats
    console.log('\n📊 Quick Stats:');
    console.log(`   - Scan duration: ${duration}ms`);
    console.log(`   - Total findings: ${result.findings.length}`);
    console.log(`   - Critical/High: ${result.summary.bySeverity.critical + result.summary.bySeverity.high}`);
    
    if (!verbose && result.findings.length > 20) {
      console.log('\n💡 Tip: Run with --verbose to see all findings in console');
    }

    // Exit with error code based on configuration
    if (config.reporting.failOnSeverity === 'critical' && result.summary.bySeverity.critical > 0) {
      console.log('\n⚠️  Critical severity issues found!');
      process.exit(1);
    } else if (config.reporting.failOnSeverity === 'high' && 
               (result.summary.bySeverity.critical > 0 || result.summary.bySeverity.high > 0)) {
      console.log('\n⚠️  Critical or high severity issues found!');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Security audit failed:', error);
    process.exit(1);
  }
}

// Run the audit
runSecurityAudit().catch(console.error);