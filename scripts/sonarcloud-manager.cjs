#!/usr/bin/env node

/**
 * SonarCloud Issue Management Script
 *
 * This script provides comprehensive management of SonarCloud issues including:
 * - Fetching and categorizing all issues
 * - Bulk triaging false positives and won't fix items
 * - Managing code duplication exclusions
 * - Generating reports and statistics
 */

const https = require('https');
const { execSync } = require('child_process');

// Configuration
const PROJECT_KEY = 'DollhouseMCP_mcp-server';
const SONARCLOUD_HOST = 'sonarcloud.io';

// Get token from macOS Keychain
function getToken() {
  try {
    // Use full path to security command to avoid PATH manipulation
    const token = execSync('/usr/bin/security find-generic-password -s "sonar_token2" -w 2>/dev/null', {
      encoding: 'utf-8'
    }).trim();
    return token;
  } catch (error) {
    console.error('Failed to get SonarCloud token from keychain');
    process.exit(1);
  }
}

// Make API request
function apiRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const token = getToken();

    const options = {
      hostname: SONARCLOUD_HOST,
      path: `/api${path}`,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        } else {
          reject(new Error(`API request failed: ${res.statusCode} - ${body}`));
        }
      });
    });

    req.on('error', reject);

    if (data && method === 'POST') {
      const formData = new URLSearchParams(data).toString();
      req.write(formData);
    }

    req.end();
  });
}

// Fetch all issues with pagination
async function fetchAllIssues(filters = {}) {
  const allIssues = [];
  let page = 1;
  let hasMore = true;

  const params = new URLSearchParams({
    projects: PROJECT_KEY,
    ps: 500,
    additionalFields: 'comments,actions,transitions',
    facets: 'severities,types,tags',
    ...filters
  });

  while (hasMore) {
    params.set('p', page);

    try {
      const response = await apiRequest('GET', `/issues/search?${params.toString()}`);
      allIssues.push(...response.issues);

      console.log(`Fetched page ${page}: ${response.issues.length} issues (total: ${allIssues.length})`);

      hasMore = response.issues.length === 500;
      page++;

      // Safety check to prevent infinite loops
      if (allIssues.length >= 10000) {
        console.warn('Reached 10,000 issue limit');
        break;
      }
    } catch (error) {
      console.error(`Failed to fetch page ${page}:`, error.message);
      break;
    }
  }

  return allIssues;
}

// Categorize issues
function categorizeIssues(issues) {
  const categories = {
    vulnerabilities: [],
    bugs: [],
    codeSmells: [],
    securityHotspots: [],
    byFile: {},
    bySeverity: {
      BLOCKER: [],
      CRITICAL: [],
      MAJOR: [],
      MINOR: [],
      INFO: []
    }
  };

  for (const issue of issues) {
    // By type
    switch (issue.type) {
      case 'VULNERABILITY':
        categories.vulnerabilities.push(issue);
        break;
      case 'BUG':
        categories.bugs.push(issue);
        break;
      case 'CODE_SMELL':
        categories.codeSmells.push(issue);
        break;
      case 'SECURITY_HOTSPOT':
        categories.securityHotspots.push(issue);
        break;
    }

    // By severity
    if (categories.bySeverity[issue.severity]) {
      categories.bySeverity[issue.severity].push(issue);
    }

    // By file
    const file = issue.component.replace(`${PROJECT_KEY}:`, '');
    if (!categories.byFile[file]) {
      categories.byFile[file] = [];
    }
    categories.byFile[file].push(issue);
  }

  return categories;
}

// Identify potential false positives
function identifyFalsePositives(issues) {
  const falsePositives = [];

  for (const issue of issues) {
    const file = issue.component.replace(`${PROJECT_KEY}:`, '');

    // Common false positive patterns
    if (
      // Test files with expected patterns
      (file.includes('test/') && issue.rule === 'typescript:S1854') || // Dead stores in tests
      (file.includes('suppressions.ts') && issue.type === 'CODE_SMELL') || // Suppression configs
      (file.includes('.spec.') && issue.rule === 'typescript:S2699') || // No assertions (may be integration tests)
      (file.includes('mock') && issue.severity === 'MINOR') || // Mock files
      (file.endsWith('.d.ts') && issue.type === 'CODE_SMELL') || // Type definitions

      // Known false positives from our codebase
      (issue.message && issue.message.includes('cognitive complexity') && issue.severity === 'MINOR') ||
      (issue.rule === 'typescript:S6481' && file.includes('test/')) || // Prefer for...of in tests is fine

      // Example tokens and documentation
      (issue.type === 'VULNERABILITY' && issue.message && issue.message.includes('example'))
    ) {
      falsePositives.push(issue);
    }
  }

  return falsePositives;
}

// Bulk transition issues
async function bulkTransition(issueKeys, transition, comment) {
  const chunks = [];
  for (let i = 0; i < issueKeys.length; i += 500) {
    chunks.push(issueKeys.slice(i, i + 500));
  }

  for (const [index, chunk] of chunks.entries()) {
    console.log(`Processing chunk ${index + 1}/${chunks.length} (${chunk.length} issues)`);

    try {
      await apiRequest('POST', '/issues/bulk_change', {
        issues: chunk.join(','),
        do_transition: transition,
        comment: comment
      });
      console.log(`✓ Transitioned ${chunk.length} issues to ${transition}`);
    } catch (error) {
      console.error(`✗ Failed to transition chunk ${index + 1}:`, error.message);
    }
  }
}

// Generate report
function generateReport(issues, categories, falsePositives) {
  console.log('\n' + '='.repeat(80));
  console.log('SONARCLOUD ISSUE REPORT');
  console.log('='.repeat(80));

  console.log('\n📊 SUMMARY');
  console.log(`Total Issues: ${issues.length}`);
  console.log(`├─ Vulnerabilities: ${categories.vulnerabilities.length}`);
  console.log(`├─ Bugs: ${categories.bugs.length}`);
  console.log(`├─ Code Smells: ${categories.codeSmells.length}`);
  console.log(`└─ Security Hotspots: ${categories.securityHotspots.length}`);

  console.log('\n⚠️  SEVERITY DISTRIBUTION');
  for (const [severity, severityIssues] of Object.entries(categories.bySeverity)) {
    if (severityIssues.length > 0) {
      console.log(`${severity}: ${severityIssues.length}`);
    }
  }

  console.log('\n📁 TOP FILES BY ISSUE COUNT');
  const topFiles = Object.entries(categories.byFile)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);

  for (const [file, fileIssues] of topFiles) {
    console.log(`${fileIssues.length.toString().padStart(4)} issues: ${file}`);
  }

  console.log('\n🎯 IDENTIFIED FALSE POSITIVES');
  console.log(`Found ${falsePositives.length} potential false positives`);

  if (falsePositives.length > 0 && falsePositives.length <= 10) {
    console.log('\nSample false positives:');
    for (const fp of falsePositives.slice(0, 5)) {
      const file = fp.component.replace(`${PROJECT_KEY}:`, '');
      console.log(`  - [${fp.rule}] ${file}: ${fp.message?.substring(0, 60)}...`);
    }
  }

  console.log('\n' + '='.repeat(80));
}

// Check quality gate status
async function checkQualityGate(pullRequest = null) {
  const params = new URLSearchParams({
    projectKey: PROJECT_KEY
  });

  if (pullRequest) {
    params.set('pullRequest', pullRequest);
  }

  try {
    const response = await apiRequest('GET', `/qualitygates/project_status?${params.toString()}`);
    return response.projectStatus;
  } catch (error) {
    console.error('Failed to check quality gate:', error.message);
    return null;
  }
}

// Main command handler
async function main() {
  const command = process.argv[2];

  console.log('🔍 SonarCloud Issue Manager');
  console.log(`Project: ${PROJECT_KEY}\n`);

  try {
    // Validate authentication
    const authResult = await apiRequest('GET', '/authentication/validate');
    if (!authResult.valid) {
      console.error('Authentication failed');
      process.exit(1);
    }
    console.log('✓ Authentication successful\n');

    switch (command) {
      case 'fetch':
      case 'report': {
        console.log('Fetching all issues...');
        const issues = await fetchAllIssues();
        const categories = categorizeIssues(issues);
        const falsePositives = identifyFalsePositives(issues);

        generateReport(issues, categories, falsePositives);

        // Save to file for further processing
        const fs = require('fs');
        const output = {
          timestamp: new Date().toISOString(),
          project: PROJECT_KEY,
          summary: {
            total: issues.length,
            vulnerabilities: categories.vulnerabilities.length,
            bugs: categories.bugs.length,
            codeSmells: categories.codeSmells.length,
            falsePositives: falsePositives.length
          },
          issues: issues,
          categories: categories,
          falsePositives: falsePositives
        };

        fs.writeFileSync('sonarcloud-issues.json', JSON.stringify(output, null, 2));
        console.log('\n✓ Full report saved to sonarcloud-issues.json');
        break;
      }

      case 'triage-fp': {
        console.log('Identifying and triaging false positives...');
        const issues = await fetchAllIssues();
        const falsePositives = identifyFalsePositives(issues);

        if (falsePositives.length === 0) {
          console.log('No false positives identified');
          break;
        }

        console.log(`Found ${falsePositives.length} potential false positives`);
        console.log('\nWould mark as false positive:');
        for (const fp of falsePositives.slice(0, 10)) {
          const file = fp.component.replace(`${PROJECT_KEY}:`, '');
          console.log(`  - [${fp.rule}] ${file}`);
        }

        if (process.argv[3] === '--apply') {
          const issueKeys = falsePositives.map(i => i.key);
          await bulkTransition(
            issueKeys,
            'falsepositive',
            'Automated triage: Common false positive pattern'
          );
        } else {
          console.log('\nRun with --apply to mark these as false positives');
        }
        break;
      }

      case 'quality-gate': {
        const pr = process.argv[3];
        const status = await checkQualityGate(pr);

        if (status) {
          console.log(`Quality Gate: ${status.status}`);

          if (status.conditions) {
            console.log('\nConditions:');
            for (const condition of status.conditions) {
              const symbol = condition.status === 'OK' ? '✓' : '✗';
              console.log(`${symbol} ${condition.metricKey}: ${condition.actualValue} (threshold: ${condition.errorThreshold})`);
            }
          }
        }
        break;
      }

      case 'duplication': {
        console.log('Analyzing duplication issues...');
        const issues = await fetchAllIssues({ types: 'CODE_SMELL' });

        const duplicationIssues = issues.filter(i =>
          i.rule === 'common-js:DuplicatedBlocks' ||
          i.message?.includes('duplicat')
        );

        console.log(`Found ${duplicationIssues.length} duplication issues`);

        const byFile = {};
        for (const issue of duplicationIssues) {
          const file = issue.component.replace(`${PROJECT_KEY}:`, '');
          if (!byFile[file]) byFile[file] = 0;
          byFile[file]++;
        }

        console.log('\nFiles with duplication:');
        for (const [file, count] of Object.entries(byFile)) {
          console.log(`  ${count} issues: ${file}`);
        }
        break;
      }

      default:
        console.log('Usage: node sonarcloud-manager.js <command> [options]');
        console.log('\nCommands:');
        console.log('  fetch/report     - Fetch all issues and generate report');
        console.log('  triage-fp        - Identify false positives (add --apply to mark)');
        console.log('  quality-gate [PR] - Check quality gate status');
        console.log('  duplication      - Analyze duplication issues');
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = {
  getToken,
  apiRequest,
  fetchAllIssues,
  categorizeIssues,
  identifyFalsePositives,
  bulkTransition,
  checkQualityGate
};