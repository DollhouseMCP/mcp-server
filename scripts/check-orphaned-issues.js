#!/usr/bin/env node

/**
 * Check for orphaned issues that were resolved but never closed
 *
 * This script checks all open issues to see if they were referenced
 * in merged PRs or release notes, indicating they should be closed.
 *
 * SECURITY FIXES (DMCP-SEC-002):
 * - Uses spawnSync instead of execSync to prevent command injection
 * - Resolves gh path at startup to prevent PATH injection
 * - Validates all issue numbers before use
 * - Uses array-based arguments instead of string interpolation
 */

import { spawnSync, execFileSync } from 'node:child_process';

// FIX: Resolve gh path at startup to prevent PATH injection (DMCP-SEC-002)
// CRITICAL: Using PATH-based command execution is vulnerable to PATH manipulation
let GH_PATH;
try {
  // Try to find gh in PATH using 'which' (unix) or 'where' (windows)
  const whichCommand = process.platform === 'win32' ? 'where' : 'which';
  GH_PATH = execFileSync(whichCommand, ['gh'], { encoding: 'utf-8' }).trim().split('\n')[0];

  if (!GH_PATH || GH_PATH.length === 0) {
    throw new Error('gh command not found');
  }
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Error: GitHub CLI (gh) is not installed or not in PATH: ${errorMsg}`);
  console.error('Please install gh: https://cli.github.com/');
  process.exit(1);
}

/**
 * Execute gh command safely using array arguments and absolute path
 *
 * FIX: Prevents command injection by using spawnSync with array args (DMCP-SEC-002)
 */
function executeGhCommand(args) {
  const result = spawnSync(GH_PATH, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024 // 10MB buffer
  });

  if (result.error) {
    throw new Error(`Command failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Command exited with status ${result.status}: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Validate issue number is a positive integer
 */
function validateIssueNumber(issueNum) {
  const num = Number(issueNum);
  return Number.isInteger(num) && num > 0 && num < 100000;
}

/**
 * Get all open issues
 */
function getAllOpenIssues() {
  const result = executeGhCommand([
    'issue',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,createdAt',
    '--limit',
    '1000'
  ]);
  return JSON.parse(result).sort((a, b) => a.number - b.number);
}

/**
 * Check if an issue is mentioned in any merged PR
 *
 * FIX: Uses safe array-based search query (DMCP-SEC-002)
 * Previously: Used string interpolation - command injection risk
 * Now: Validates issue number and uses safe search syntax
 */
function isIssueMentionedInMergedPRs(issueNumber) {
  // Validate issue number before use
  if (!validateIssueNumber(issueNumber)) {
    console.error(`Warning: Invalid issue number ${issueNumber}, skipping`);
    return null;
  }

  try {
    // Safe: Issue number is validated, search query uses fixed format
    const searchQuery = `#${issueNumber} in:body OR #${issueNumber} in:title`;
    const result = executeGhCommand([
      'pr',
      'list',
      '--state',
      'merged',
      '--search',
      searchQuery,
      '--json',
      'number,title,state',
      '--limit',
      '5'
    ]);
    const prs = JSON.parse(result);
    return prs.length > 0 ? prs : null;
  } catch {
    return null;
  }
}

/**
 * Check if an issue is mentioned in release notes
 *
 * FIX: Uses safe command execution (DMCP-SEC-002)
 */
function isIssueInReleaseNotes(issueNumber) {
  // Validate issue number before use
  if (!validateIssueNumber(issueNumber)) {
    return null;
  }

  try {
    const result = executeGhCommand([
      'release',
      'list',
      '--limit',
      '100',
      '--json',
      'tagName,body'
    ]);
    const releases = JSON.parse(result);

    for (const release of releases) {
      // Safe: Using includes() with validated issue number
      if (release.body && release.body.includes(`#${issueNumber}`)) {
        return release.tagName;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('🔍 Checking for orphaned issues...\n');

  const allIssues = getAllOpenIssues();
  console.log(`Found ${allIssues.length} open issues\n`);

  const orphanedIssues = [];
  let checked = 0;

  for (const issue of allIssues) {
    checked++;

    if (checked % 10 === 0) {
      process.stdout.write(`\rChecked ${checked}/${allIssues.length}...`);
    }

    // Check merged PRs
    const mentionedInPRs = isIssueMentionedInMergedPRs(issue.number);

    // Check release notes
    const mentionedInRelease = isIssueInReleaseNotes(issue.number);

    if (mentionedInPRs || mentionedInRelease) {
      orphanedIssues.push({
        number: issue.number,
        title: issue.title,
        createdAt: issue.createdAt,
        prs: mentionedInPRs,
        release: mentionedInRelease
      });
    }
  }

  console.log(`\n\n📊 Results:\n`);
  console.log(`Total checked: ${checked}`);
  console.log(`Orphaned issues found: ${orphanedIssues.length}\n`);

  if (orphanedIssues.length > 0) {
    console.log('🔴 Orphaned Issues:\n');
    for (const issue of orphanedIssues) {
      console.log(`#${issue.number}: ${issue.title}`);
      console.log(`  Created: ${issue.createdAt.substring(0, 10)}`);
      if (issue.prs) {
        // FIX: Avoid nested template literals (S4624)
        const prNumbers = issue.prs.map(pr => '#' + pr.number).join(', ');
        console.log(`  Mentioned in PRs: ${prNumbers}`);
      }
      if (issue.release) {
        console.log(`  Mentioned in release: ${issue.release}`);
      }
      console.log();
    }

    console.log('\n💡 To close these issues, run:');
    console.log('node scripts/close-orphaned-issues.js\n');
  } else {
    console.log('✅ No orphaned issues found!\n');
  }
}

// FIX: Use top-level await instead of promise chain (S7785)
try {
  await main();
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
