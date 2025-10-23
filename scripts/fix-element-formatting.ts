#!/usr/bin/env ts-node
/**
 * Fix Element File Formatting
 *
 * Fixes element files (skills, personas, templates, agents) that have their markdown
 * content stored as single long lines without proper newlines.
 *
 * Issue: #1387
 *
 * Usage:
 *   npx ts-node scripts/fix-element-formatting.ts --dry-run  # Preview changes
 *   npx ts-node scripts/fix-element-formatting.ts            # Apply changes
 */

import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';

interface ProcessingStats {
  fixed: number;
  skipped: number;
  errors: number;
}

/**
 * Check if a file needs formatting based on average line length
 */
function needsFormatting(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Find the content section (after frontmatter)
    let inFrontmatter = false;
    let frontmatterEnd = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        if (!inFrontmatter) {
          inFrontmatter = true;
        } else {
          frontmatterEnd = i;
          break;
        }
      }
    }

    if (frontmatterEnd === -1) return false; // No frontmatter found

    // Check content section only
    const contentLines = lines.slice(frontmatterEnd + 1);
    const contentText = contentLines.join('\n').trim();

    if (contentText.length === 0) return false; // No content

    const contentLineCount = contentLines.filter(l => l.trim()).length;
    if (contentLineCount === 0) return false;

    // If average line length > 200, needs formatting
    const avgLineLength = contentText.length / contentLineCount;
    return avgLineLength > 200;
  } catch (error) {
    return false;
  }
}

/**
 * Format markdown content by adding proper newlines
 *
 * The content is typically one long line with headers, code blocks, etc. all smashed together.
 * Example: "Skill## PurposeAutomated workflow...### 1. Content Ingestion..."
 */
function formatMarkdownContent(content: string): string {
  if (!content || content.length === 0) {
    return content;
  }

  let formatted = content;

  // Step 1: Add newlines before markdown headers (# ## ### ####)
  // Pattern: non-whitespace followed immediately by # (header marker)
  formatted = formatted.replaceAll(/([^\s\n])(#{1,6}\s)/g, '$1\n\n$2');

  // Step 1b: Add newlines after header text when followed by capital letter
  // Pattern: header followed by capital letter with no newline (e.g., "## PurposeAutomated")
  formatted = formatted.replaceAll(/(#{1,6}\s+[^\n]+[a-z])([A-Z][a-z])/g, '$1\n\n$2');

  // Step 2: Add newlines before code blocks
  // Pattern: word or punctuation followed immediately by ```
  formatted = formatted.replaceAll(/([^\s\n])(```)/g, '$1\n\n$2');

  // Step 3: Add newlines after code block closings
  // Pattern: ``` followed by a word (not on new line)
  formatted = formatted.replaceAll(/(```)\s*([a-zA-Z])/g, '$1\n\n$2');

  // Step 4: Fix code block language labels (e.g., "Pipelineyaml" -> "Pipeline\n\nyaml")
  formatted = formatted.replaceAll(/([a-z])(yaml|json|javascript|typescript|python|bash|sh|ruby|go|rust|java|cpp|c\+\+)/gi, '$1\n\n$2');

  // Step 5: Fix bullet/numbered lists
  // Pattern: word/period followed by list marker
  formatted = formatted.replaceAll(/([^\s\n])\s*([-*]\s+[a-zA-Z])/g, '$1\n\n$2');
  formatted = formatted.replaceAll(/([^\s\n])\s*(\d+\.\s+[a-zA-Z])/g, '$1\n\n$2');

  // Step 6: Reduce excessive newlines (max 2 consecutive)
  formatted = formatted.replaceAll(/\n{3,}/g, '\n\n');

  // Step 7: Ensure proper spacing around colons in YAML-like structures
  // But don't add too many newlines
  formatted = formatted.replaceAll(/:\s{2,}/g, ':\n  ');

  // Step 8: Ensure single trailing newline
  formatted = formatted.trim() + '\n';

  return formatted;
}

/**
 * Process an individual element file
 */
function processFile(filePath: string, dryRun: boolean): boolean {
  try {
    // Check if file needs formatting
    if (!needsFormatting(filePath)) {
      return false;
    }

    // Read and split into frontmatter and content
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    let frontmatterStart = -1;
    let frontmatterEnd = -1;
    let inFrontmatter = false;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        if (!inFrontmatter) {
          frontmatterStart = i;
          inFrontmatter = true;
        } else {
          frontmatterEnd = i;
          break;
        }
      }
    }

    if (frontmatterStart === -1 || frontmatterEnd === -1) {
      console.log(`  ⚠️  No valid frontmatter: ${path.basename(filePath)}`);
      return false;
    }

    // Extract frontmatter and content
    const frontmatterLines = lines.slice(frontmatterStart, frontmatterEnd + 1);
    const contentLines = lines.slice(frontmatterEnd + 1);
    const contentText = contentLines.join('\n').trim();

    // Format the content
    const formattedContent = formatMarkdownContent(contentText);

    // Check if anything actually changed
    if (formattedContent === contentText) {
      return false;
    }

    // Reconstruct the file
    const newContent = frontmatterLines.join('\n') + '\n' + formattedContent;

    if (!dryRun) {
      fs.writeFileSync(filePath, newContent, 'utf-8');
    }

    return true;
  } catch (error) {
    console.error(`  ❌ Error: ${path.basename(filePath)} - ${error}`);
    return false;
  }
}

/**
 * Process all files in a directory
 */
function processDirectory(dirPath: string, dryRun: boolean): ProcessingStats {
  const stats: ProcessingStats = { fixed: 0, skipped: 0, errors: 0 };

  if (!fs.existsSync(dirPath)) {
    return stats;
  }

  const files = fs.readdirSync(dirPath)
    .filter((f: string) => f.endsWith('.md'))
    .sort();

  console.log(`\n📁 ${path.basename(dirPath)} (${files.length} files)`);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    try {
      const wasFixed = processFile(filePath, dryRun);
      if (wasFixed) {
        console.log(`  ✅ ${file}`);
        stats.fixed++;
      } else {
        stats.skipped++;
      }
    } catch (error) {
      console.error(`  ❌ ${file}`);
      stats.errors++;
    }
  }

  return stats;
}

/**
 * Main execution
 */
function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const portfolioPath = path.join(process.env.HOME || '', '.dollhouse/portfolio');

  console.log('═'.repeat(60));
  console.log('🔧 Element File Formatter - Issue #1387');
  console.log('═'.repeat(60));

  if (dryRun) {
    console.log('\n🔍 DRY RUN MODE - No files will be modified');
  }

  if (!fs.existsSync(portfolioPath)) {
    console.error(`\n❌ Portfolio directory not found: ${portfolioPath}`);
    process.exit(1);
  }

  const elementTypes = ['skills', 'personas', 'templates', 'agents'];
  const totalStats: ProcessingStats = { fixed: 0, skipped: 0, errors: 0 };

  for (const type of elementTypes) {
    const dirPath = path.join(portfolioPath, type);
    const stats = processDirectory(dirPath, dryRun);
    totalStats.fixed += stats.fixed;
    totalStats.skipped += stats.skipped;
    totalStats.errors += stats.errors;
  }

  console.log('\n' + '═'.repeat(60));
  console.log('📊 Summary');
  console.log('═'.repeat(60));
  console.log(`✅ Fixed:   ${totalStats.fixed} files`);
  console.log(`⏭️  Skipped: ${totalStats.skipped} files (already formatted)`);
  console.log(`❌ Errors:  ${totalStats.errors} files`);

  if (dryRun && totalStats.fixed > 0) {
    console.log('\n💡 Run without --dry-run to apply changes');
  } else if (!dryRun && totalStats.fixed > 0) {
    console.log('\n✨ Files have been formatted successfully!');
  }

  console.log('═'.repeat(60));
}

main();
