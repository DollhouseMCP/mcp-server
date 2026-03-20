import { SecurityAuditor } from './dist/security/audit/index.js';
import { FileOperationsService } from './dist/services/FileOperationsService.js';
import { FileLockManager } from './dist/security/fileLockManager.js';

async function runAudit() {
  // Create FileOperationsService for config loading
  const fileLockManager = new FileLockManager();
  const fileOperations = new FileOperationsService(fileLockManager);

  const config = await SecurityAuditor.getDefaultConfig(fileOperations);
  
  // Adjust config for CI
  config.reporting.formats = ['console', 'markdown', 'json'];
  config.reporting.createIssues = false;
  config.reporting.commentOnPr = false;
  
  const auditor = new SecurityAuditor(config, fileOperations);
  
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
