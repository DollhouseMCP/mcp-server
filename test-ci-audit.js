import { SecurityAuditor } from './dist/security/audit/index.js';

async function runAudit() {
  const config = SecurityAuditor.getDefaultConfig();
  
  // Adjust config for CI
  config.reporting.formats = ['console', 'markdown', 'json'];
  config.reporting.createIssues = false;
  config.reporting.commentOnPr = false;
  
  const auditor = new SecurityAuditor(config);
  
  try {
    const result = await auditor.audit();
    console.log('Total findings:', result.summary.total);
    console.log('Critical:', result.summary.critical);
    console.log('Medium:', result.summary.medium);
    
    // Show findings for test-element-lifecycle.js
    const testFindings = result.findings.filter(f => 
      f.file && f.file.includes('test-element-lifecycle')
    );
    
    if (testFindings.length > 0) {
      console.log('\nFindings for test-element-lifecycle.js:');
      testFindings.forEach(f => {
        console.log(`  - ${f.ruleId}: ${f.message}`);
        console.log(`    File: ${f.file}`);
      });
    }
  } catch (error) {
    console.error('Audit failed:', error);
  }
}

runAudit();
