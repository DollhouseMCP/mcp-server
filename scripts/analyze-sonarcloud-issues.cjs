#!/usr/bin/env node

/**
 * Analyze SonarCloud issues and create actionable cleanup strategy
 */

const fs = require('fs');
const path = require('path');

// Load the issue data
const data = JSON.parse(fs.readFileSync('sonarcloud-issues.json', 'utf-8'));

// Categories for analysis
const analysis = {
  blocker: {
    vulnerabilities: [],
    bugs: [],
    codeSmells: []
  },
  critical: {
    vulnerabilities: [],
    bugs: [],
    codeSmells: []
  },
  major: {
    vulnerabilities: [],
    bugs: [],
    codeSmells: []
  },
  byRule: {},
  byFile: {},
  fixablePatterns: {
    githubActions: [],
    alwaysReturnsSame: [],
    cognitiveComplexity: [],
    deadCode: [],
    duplicatedBlocks: [],
    forOfLoops: [],
    missingAwait: [],
    typeAssertions: []
  }
};

// Process each issue
for (const issue of data.issues) {
  const file = issue.component.replace('DollhouseMCP_mcp-server:', '');

  // Categorize by severity and type
  const severityLevel = issue.severity.toLowerCase();
  const issueType = issue.type === 'CODE_SMELL' ? 'codeSmells' :
                    issue.type === 'BUG' ? 'bugs' : 'vulnerabilities';

  if (analysis[severityLevel] && analysis[severityLevel][issueType]) {
    analysis[severityLevel][issueType].push({
      key: issue.key,
      file,
      line: issue.line,
      rule: issue.rule,
      message: issue.message
    });
  }

  // Count by rule
  if (!analysis.byRule[issue.rule]) {
    analysis.byRule[issue.rule] = {
      count: 0,
      severity: issue.severity,
      type: issue.type,
      examples: []
    };
  }
  analysis.byRule[issue.rule].count++;
  if (analysis.byRule[issue.rule].examples.length < 3) {
    analysis.byRule[issue.rule].examples.push({
      file,
      line: issue.line,
      message: issue.message?.substring(0, 100)
    });
  }

  // Count by file
  if (!analysis.byFile[file]) {
    analysis.byFile[file] = {
      total: 0,
      blocker: 0,
      critical: 0,
      major: 0,
      minor: 0
    };
  }
  analysis.byFile[file].total++;
  analysis.byFile[file][severityLevel] = (analysis.byFile[file][severityLevel] || 0) + 1;

  // Identify fixable patterns
  if (issue.rule === 'githubactions:S7630') {
    analysis.fixablePatterns.githubActions.push({ file, line: issue.line, key: issue.key });
  } else if (issue.rule === 'typescript:S3516') {
    analysis.fixablePatterns.alwaysReturnsSame.push({ file, line: issue.line, key: issue.key });
  } else if (issue.message?.includes('Cognitive Complexity')) {
    analysis.fixablePatterns.cognitiveComplexity.push({ file, line: issue.line, key: issue.key });
  } else if (issue.rule === 'typescript:S1854' || issue.message?.includes('dead code')) {
    analysis.fixablePatterns.deadCode.push({ file, line: issue.line, key: issue.key });
  } else if (issue.rule === 'common-js:DuplicatedBlocks') {
    analysis.fixablePatterns.duplicatedBlocks.push({ file, line: issue.line, key: issue.key });
  } else if (issue.rule === 'typescript:S6481') {
    analysis.fixablePatterns.forOfLoops.push({ file, line: issue.line, key: issue.key });
  } else if (issue.message?.includes('await')) {
    analysis.fixablePatterns.missingAwait.push({ file, line: issue.line, key: issue.key });
  } else if (issue.rule === 'typescript:S4325' || issue.message?.includes('type assertion')) {
    analysis.fixablePatterns.typeAssertions.push({ file, line: issue.line, key: issue.key });
  }
}

// Generate report
console.log('# SonarCloud Issue Analysis Report\n');
console.log(`Generated: ${new Date().toISOString()}\n`);

console.log('## Executive Summary\n');
console.log(`- **Total Issues**: ${data.issues.length}`);
console.log(`- **BLOCKER**: ${analysis.blocker.vulnerabilities.length + analysis.blocker.bugs.length + analysis.blocker.codeSmells.length}`);
console.log(`- **CRITICAL**: ${analysis.critical.vulnerabilities.length + analysis.critical.bugs.length + analysis.critical.codeSmells.length}`);
console.log(`- **MAJOR**: ${analysis.major.vulnerabilities.length + analysis.major.bugs.length + analysis.major.codeSmells.length}\n`);

console.log('## BLOCKER Issues (Must Fix)\n');
console.log(`### Vulnerabilities (${analysis.blocker.vulnerabilities.length})`);
for (const vuln of analysis.blocker.vulnerabilities) {
  console.log(`- [ ] ${vuln.file}:${vuln.line} - ${vuln.message?.substring(0, 80)}`);
}

console.log(`\n### Bugs (${analysis.blocker.bugs.length})`);
for (const bug of analysis.blocker.bugs) {
  console.log(`- [ ] ${bug.file}:${bug.line} - ${bug.message?.substring(0, 80)}`);
}

console.log(`\n### Code Smells (${analysis.blocker.codeSmells.length})`);
for (const smell of analysis.blocker.codeSmells) {
  console.log(`- [ ] ${smell.file}:${smell.line} - ${smell.message?.substring(0, 80)}`);
}

console.log('\n## Top Rules by Count\n');
const topRules = Object.entries(analysis.byRule)
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 15);

for (const [rule, data] of topRules) {
  console.log(`### ${rule} (${data.count} issues, ${data.severity})`);
  console.log(`Type: ${data.type}`);
  if (data.examples.length > 0) {
    console.log('Examples:');
    for (const ex of data.examples) {
      console.log(`  - ${ex.file}:${ex.line}`);
    }
  }
  console.log();
}

console.log('## Files with Most Issues\n');
const topFiles = Object.entries(analysis.byFile)
  .sort((a, b) => b[1].total - a[1].total)
  .slice(0, 10);

for (const [file, counts] of topFiles) {
  console.log(`### ${file}`);
  console.log(`Total: ${counts.total} (BLOCKER: ${counts.blocker}, CRITICAL: ${counts.critical}, MAJOR: ${counts.major}, MINOR: ${counts.minor})`);
}

console.log('\n## Fixable Pattern Groups\n');

console.log(`### GitHub Actions Command Injection (${analysis.fixablePatterns.githubActions.length} issues)`);
console.log('Pattern: Use environment variables instead of direct interpolation in run blocks\n');

console.log(`### Functions Always Return Same Value (${analysis.fixablePatterns.alwaysReturnsSame.length} issues)`);
console.log('Pattern: Either make configurable or remove return value\n');

console.log(`### High Cognitive Complexity (${analysis.fixablePatterns.cognitiveComplexity.length} issues)`);
console.log('Pattern: Extract methods, reduce nesting, simplify conditionals\n');

console.log(`### Dead Code (${analysis.fixablePatterns.deadCode.length} issues)`);
console.log('Pattern: Remove unreachable/unused code\n');

console.log(`### Duplicated Blocks (${analysis.fixablePatterns.duplicatedBlocks.length} issues)`);
console.log('Pattern: Extract common code to shared functions\n');

console.log(`### Use for...of Loops (${analysis.fixablePatterns.forOfLoops.length} issues)`);
console.log('Pattern: Replace forEach with for...of for better performance\n');

// Generate actionable strategy
console.log('\n## Recommended Cleanup Strategy\n');
console.log('### Phase 1: Critical Security & Reliability (1-2 hours)');
console.log('1. Fix GitHub Actions command injection vulnerabilities (13 issues)');
console.log('2. Fix "always returns same value" bugs (2 issues)');
console.log('3. Document intentional example token in SECURITY_AUDIT.md');
console.log();

console.log('### Phase 2: Code Quality Quick Wins (2-3 hours)');
console.log('1. Replace forEach with for...of in non-performance-critical code');
console.log('2. Remove obvious dead code');
console.log('3. Fix simple type assertions');
console.log();

console.log('### Phase 3: Refactoring (4-6 hours)');
console.log('1. Reduce cognitive complexity in top offenders');
console.log('2. Extract duplicated test code to helpers');
console.log('3. Consolidate similar validation logic');
console.log();

console.log('### Phase 4: Documentation & Suppression');
console.log('1. Mark test-specific patterns as won\'t fix');
console.log('2. Document architectural decisions for complex methods');
console.log('3. Add inline suppressions for intentional patterns');

// Save detailed analysis
const outputPath = 'sonarcloud-analysis.json';
fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2));
console.log(`\n✓ Detailed analysis saved to ${outputPath}`);