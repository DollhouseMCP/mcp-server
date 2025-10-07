#!/usr/bin/env node

/**
 * Release Issue Verification Script
 *
 * Verifies that all issues mentioned in a release are properly closed.
 * Can be run manually for historical cleanup or automatically via GitHub Actions.
 *
 * Usage:
 *   node scripts/verify-release-issues.js --pr 1238
 *   node scripts/verify-release-issues.js --tag v1.9.16
 *   node scripts/verify-release-issues.js --pr 1238 --close
 *
 * Options:
 *   --pr <number>      - Release PR number
 *   --tag <version>    - Release tag (e.g., v1.9.16)
 *   --close            - Actually close issues (dry-run by default)
 *   --verbose          - Show detailed output
 */

import { spawnSync, execFileSync } from 'child_process';
import { resolve } from 'path';

// FIX: Resolve gh path at startup to prevent PATH injection (DMCP-SEC-001)
// CRITICAL: Using PATH-based command execution is vulnerable to PATH manipulation
// Previously: Used 'gh' command name, relying on PATH lookup at each call
// Now: Resolve absolute path once at startup, use fixed path for all calls
let GH_PATH;
try {
  // Try to find gh in PATH using 'which' (unix) or 'where' (windows)
  const whichCommand = process.platform === 'win32' ? 'where' : 'which';
  GH_PATH = execFileSync(whichCommand, ['gh'], { encoding: 'utf-8' }).trim().split('\n')[0];

  if (!GH_PATH || GH_PATH.length === 0) {
    throw new Error('gh command not found');
  }
} catch (error) {
  console.error('Error: GitHub CLI (gh) is not installed or not in PATH');
  console.error('Please install gh: https://cli.github.com/');
  process.exit(1);
}

// Parse command line arguments
const args = process.argv.slice(2);
const prNumber = args.includes('--pr') ? args[args.indexOf('--pr') + 1] : null;
const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : null;
const shouldClose = args.includes('--close');
const verbose = args.includes('--verbose');

if (!prNumber && !tag) {
  console.error('Error: Must provide either --pr <number> or --tag <version>');
  console.error('Usage: node scripts/verify-release-issues.js --pr 1238 [--close] [--verbose]');
  process.exit(1);
}

// FIX: Input validation to prevent command injection (DMCP-SEC-001)
// CRITICAL: Validate all inputs before using in commands
// Previously: Used execSync with string interpolation (command injection risk)
// Now: Using spawnSync with validated array arguments (safe)

// Validate PR number is a positive integer
if (prNumber) {
  const prNum = Number(prNumber);
  if (!Number.isInteger(prNum) || prNum <= 0) {
    console.error(`Error: Invalid PR number "${prNumber}". Must be a positive integer.`);
    process.exit(1);
  }
}

// Validate tag follows expected format (v1.2.3 or v1.2.3-pre)
if (tag) {
  const tagPattern = /^v\d+\.\d+\.\d+(-[a-z0-9]+)?$/i;
  if (!tagPattern.test(tag)) {
    console.error(`Error: Invalid tag format "${tag}". Expected format: v1.9.16 or v1.9.16-pre`);
    process.exit(1);
  }
}

/**
 * Validate issue number is a positive integer
 *
 * FIX: Added validation for extracted issue numbers (DMCP-SEC-001)
 * Previously: Issue numbers from release notes were used without validation
 * Now: All issue numbers are validated before use
 */
function validateIssueNumber(issueNum) {
  const num = Number(issueNum);
  return Number.isInteger(num) && num > 0 && num < 100000; // Reasonable upper bound
}

/**
 * Execute gh command safely using array arguments and absolute path
 *
 * FIX: Multiple security improvements (DMCP-SEC-001)
 * CRITICAL FIXES:
 * 1. Changed from execSync to spawnSync - prevents command injection
 * 2. Uses absolute path instead of PATH lookup - prevents PATH injection
 * 3. Array-based arguments - prevents shell injection
 *
 * Previously:
 * - Used string interpolation with shell commands - vulnerable to injection
 * - Relied on PATH environment variable - vulnerable to PATH manipulation
 *
 * Now:
 * - Uses spawnSync with array arguments - safe from command injection
 * - Uses absolute path resolved at startup - safe from PATH injection
 *
 * SECURITY:
 * - All inputs MUST be validated before being passed to this function
 * - PR numbers must be positive integers
 * - Tags must match v1.2.3 format
 * - Issue numbers must be positive integers
 * - Uses GH_PATH (absolute path) to prevent PATH-based attacks
 * - Uses array-based arguments to prevent shell injection
 */
function gh(args) {
  try {
    const result = spawnSync(GH_PATH, args, {
      encoding: 'utf-8',
      env: process.env // Inherit environment but use fixed GH_PATH
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(result.stderr || 'Command failed');
    }

    return result.stdout.trim();
  } catch (error) {
    console.error(`Error executing: ${GH_PATH} ${args.join(' ')}`);
    console.error(error.message);
    process.exit(1);
  }
}

/**
 * Extract issue numbers from text
 * Matches: #123, Issue #123, Fixes #123, PR #123, etc.
 */
function extractIssueNumbers(text) {
  const issuePattern = /#(\d+)/g;
  const matches = text.matchAll(issuePattern);
  const issueNumbers = new Set();

  for (const match of matches) {
    issueNumbers.add(match[1]);
  }

  return Array.from(issueNumbers).sort((a, b) => Number(a) - Number(b));
}

/**
 * Get release PR body
 *
 * FIX: Using array arguments (DMCP-SEC-001)
 */
function getReleasePR(prNum) {
  const prData = gh(['pr', 'view', String(prNum), '--json', 'number,title,body,mergedAt']);
  return JSON.parse(prData);
}

/**
 * Get release notes from tag
 *
 * FIX: Using array arguments (DMCP-SEC-001)
 */
function getReleaseNotes(tagName) {
  try {
    const releaseData = gh(['release', 'view', tagName, '--json', 'name,body,tagName']);
    return JSON.parse(releaseData);
  } catch {
    console.error(`Release tag ${tagName} not found`);
    process.exit(1);
  }
}

/**
 * Get issue status
 *
 * FIX: Using array arguments and validating issue number (DMCP-SEC-001)
 */
function getIssueStatus(issueNumber) {
  // Validate issue number before use
  if (!validateIssueNumber(issueNumber)) {
    console.error(`Invalid issue number: ${issueNumber}`);
    return null;
  }

  try {
    const issueData = gh(['issue', 'view', String(issueNumber), '--json', 'number,title,state,closedAt']);
    return JSON.parse(issueData);
  } catch {
    return null; // Issue doesn't exist or is from another repo
  }
}

/**
 * Close an issue with a reference
 *
 * FIX: Using array arguments to prevent injection (DMCP-SEC-001)
 * CRITICAL: Message is now passed as separate argument, not interpolated into command
 * Previously: String interpolation in shell command - vulnerable to injection
 * Now: Array-based arguments with proper escaping - safe from injection
 */
function closeIssue(issueNumber, reference) {
  // Validate issue number before use
  if (!validateIssueNumber(issueNumber)) {
    console.error(`Invalid issue number: ${issueNumber}`);
    return false;
  }

  const message = `Closing as completed in ${reference}.`;

  try {
    gh(['issue', 'close', String(issueNumber), '--comment', message]);
    return true;
  } catch (error) {
    console.error(`Failed to close #${issueNumber}: ${error.message}`);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  console.log('🔍 Release Issue Verification\n');

  // Get release content
  let releaseContent;
  let reference;

  if (prNumber) {
    console.log(`Checking release PR #${prNumber}...`);
    const prData = getReleasePR(prNumber);
    releaseContent = `${prData.title}\n\n${prData.body}`;
    reference = `PR #${prNumber}`;

    if (!prData.mergedAt) {
      console.warn(`⚠️  Warning: PR #${prNumber} is not merged yet\n`);
    }
  } else {
    console.log(`Checking release tag ${tag}...`);
    const releaseData = getReleaseNotes(tag);
    releaseContent = `${releaseData.name}\n\n${releaseData.body}`;
    reference = tag;
  }

  // Extract issue numbers
  const extractedIssues = extractIssueNumbers(releaseContent);

  // FIX: Validate extracted issue numbers (DMCP-SEC-001)
  // Previously: Used extracted numbers without validation
  // Now: Filter to only valid issue numbers
  const issueNumbers = extractedIssues.filter(num => {
    if (!validateIssueNumber(num)) {
      if (verbose) {
        console.log(`⚠️  Skipping invalid issue reference: #${num}`);
      }
      return false;
    }
    return true;
  });

  if (issueNumbers.length === 0) {
    console.log('✅ No valid issues referenced in release notes');
    return;
  }

  console.log(`Found ${issueNumbers.length} issue references: ${issueNumbers.map(n => `#${n}`).join(', ')}\n`);

  // Check each issue
  const results = {
    closed: [],
    open: [],
    notFound: []
  };

  for (const issueNum of issueNumbers) {
    const issue = getIssueStatus(issueNum);

    if (!issue) {
      results.notFound.push(issueNum);
      if (verbose) {
        console.log(`#${issueNum}: Not found (may be from another repo or invalid)`);
      }
      continue;
    }

    if (issue.state === 'CLOSED') {
      results.closed.push(issueNum);
      if (verbose) {
        console.log(`✅ #${issueNum}: ${issue.title} (already closed)`);
      }
    } else {
      results.open.push(issueNum);
      console.log(`⚠️  #${issueNum}: ${issue.title} (OPEN - should be closed)`);
    }
  }

  // Summary
  console.log('\n📊 Summary:');
  console.log(`  ✅ Already closed: ${results.closed.length}`);
  console.log(`  ⚠️  Still open: ${results.open.length}`);
  console.log(`  ❓ Not found: ${results.notFound.length}`);

  // Close open issues if requested
  if (results.open.length > 0) {
    console.log('\n📝 Open Issues:');
    for (const issueNum of results.open) {
      const issue = getIssueStatus(issueNum);
      console.log(`  #${issueNum}: ${issue.title}`);
    }

    if (shouldClose) {
      console.log('\n🔒 Closing open issues...');
      let closedCount = 0;

      for (const issueNum of results.open) {
        if (closeIssue(issueNum, reference)) {
          console.log(`  ✅ Closed #${issueNum}`);
          closedCount++;
        } else {
          console.log(`  ❌ Failed to close #${issueNum}`);
        }
      }

      console.log(`\n✅ Closed ${closedCount} of ${results.open.length} issues`);
    } else {
      console.log('\n💡 Run with --close to automatically close these issues');
    }
  } else {
    console.log('\n✅ All referenced issues are properly closed!');
  }

  // Exit with error if there are open issues and we didn't close them
  if (results.open.length > 0 && !shouldClose) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
