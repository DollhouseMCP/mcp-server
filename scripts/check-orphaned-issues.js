#!/usr/bin/env node

/**
 * Check for orphaned issues that were resolved but never closed
 *
 * This script checks all open issues to see if they were referenced
 * in merged PRs or release notes, indicating they should be closed.
 */

import { execSync } from 'node:child_process';

const BATCH_SIZE = 50;

/**
 * Get all open issues
 */
function getAllOpenIssues() {
  const result = execSync(
    'gh issue list --state open --json number,title,createdAt --limit 1000',
    { encoding: 'utf8' }
  );
  return JSON.parse(result).sort((a, b) => a.number - b.number);
}

/**
 * Check if an issue is mentioned in any merged PR
 */
function isIssueMentionedInMergedPRs(issueNumber) {
  try {
    const result = execSync(
      `gh pr list --state merged --search "#${issueNumber} in:body OR #${issueNumber} in:title" --json number,title,state --limit 5`,
      { encoding: 'utf8' }
    );
    const prs = JSON.parse(result);
    return prs.length > 0 ? prs : null;
  } catch {
    return null;
  }
}

/**
 * Check if an issue is mentioned in release notes
 */
function isIssueInReleaseNotes(issueNumber) {
  try {
    const result = execSync(
      `gh release list --limit 100 --json tagName,body`,
      { encoding: 'utf8' }
    );
    const releases = JSON.parse(result);

    for (const release of releases) {
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
        console.log(`  Mentioned in PRs: ${issue.prs.map(pr => `#${pr.number}`).join(', ')}`);
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

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
