import { SecurityAuditor } from './dist/security/audit/index.js';
import fs from 'fs/promises';
import path from 'path';

async function runComprehensiveAudit() {
  const config = SecurityAuditor.getDefaultConfig();

  // Enable all scanners for comprehensive audit
  config.scanners.code.enabled = true;
  config.scanners.dependencies.enabled = true;
  config.scanners.configuration.enabled = true;
  config.reporting.formats = ['console', 'markdown', 'json'];
  config.reporting.verbose = true;

  const auditor = new SecurityAuditor(config);

  try {
    console.log('🔍 Starting Comprehensive Security Audit...\n');
    const result = await auditor.audit();

    // Generate comprehensive report
    const report = {
      timestamp: new Date().toISOString(),
      summary: result.summary,
      findings: result.findings,
      suppressed: result.suppressed || [],
      duration: result.duration,
      filesScanned: result.filesScanned
    };

    await fs.writeFile(
      'comprehensive-audit-result.json',
      JSON.stringify(report, null, 2)
    );

    // Summary output
    console.log('\n📊 Audit Summary:');
    console.log(`Total Findings: ${result.summary.total}`);
    console.log(`- Critical: ${result.summary.bySeverity?.critical || 0}`);
    console.log(`- High: ${result.summary.bySeverity?.high || 0}`);
    console.log(`- Medium: ${result.summary.bySeverity?.medium || 0}`);
    console.log(`- Low: ${result.summary.bySeverity?.low || 0}`);
    console.log(`- Info: ${result.summary.bySeverity?.info || 0}`);
    console.log(`\nFiles Scanned: ${result.filesScanned || 0}`);
    console.log(`Duration: ${result.duration}ms`);

    if (result.findings && result.findings.length > 0) {
      console.log('\n⚠️ Top Findings:');
      result.findings.slice(0, 5).forEach(f => {
        console.log(`  - [${f.severity.toUpperCase()}] ${f.message} (${f.ruleId})`);
        if (f.file) console.log(`    File: ${f.file}:${f.line || 0}`);
      });
    }

    process.exit(result.summary.bySeverity?.critical > 0 ? 1 : 0);
  } catch (error) {
    console.error('❌ Audit failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runComprehensiveAudit();