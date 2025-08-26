#!/usr/bin/env node

/**
 * Smart Version Update Script
 * 
 * Updates version numbers throughout the codebase while preserving:
 * - Version history sections
 * - Changelog entries
 * - Example/documentation that shouldn't change
 * 
 * Usage:
 *   npm run update:version -- 1.6.5
 *   npm run update:version -- 1.6.5 --notes "Added portfolio sync fix"
 *   npm run update:version -- 1.6.5 --dry-run
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { glob } from 'glob';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const newVersion = args[0];
const isDryRun = args.includes('--dry-run');
const notesIndex = args.indexOf('--notes');
const releaseNotes = notesIndex !== -1 && args[notesIndex + 1] ? args[notesIndex + 1] : '';

if (!newVersion || !newVersion.match(/^\d+\.\d+\.\d+(-[\w\.]+)?$/)) {
  console.error('❌ Please provide a valid semantic version (e.g., 1.6.5 or 1.6.5-beta.1)');
  console.error('Usage: npm run update:version -- <version> [--notes "Release notes"] [--dry-run]');
  process.exit(1);
}

// Get current version from package.json
const packageJsonPath = path.join(path.dirname(__dirname), 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const currentVersion = packageJson.version;

if (currentVersion === newVersion) {
  console.log(`ℹ️  Version is already ${newVersion}`);
  process.exit(0);
}

console.log(`\n🔄 Updating version from ${currentVersion} to ${newVersion}`);
if (isDryRun) {
  console.log('🧪 DRY RUN MODE - No files will be changed\n');
}

// Configuration for files to update
const updateConfigs = [
  {
    name: 'package.json',
    pattern: /"version":\s*"[^"]+"/,
    replacement: `"version": "${newVersion}"`,
    required: true
  },
  {
    name: 'package-lock.json',
    pattern: /"version":\s*"[^"]+"/,
    replacement: `"version": "${newVersion}"`,
    multiple: true, // Update all occurrences
    required: true
  },
  {
    name: 'README.md',
    updates: [
      {
        // Update version badge
        pattern: /\[Version-v[\d\.]+(-[\w\.]+)?-/g,
        replacement: `[Version-v${newVersion}-`
      },
      {
        // Update current version mentions (but not in history/changelog)
        pattern: new RegExp(`\\bv?${currentVersion.replace(/\./g, '\\.')}\\b`, 'g'),
        replacement: (match) => match.startsWith('v') ? `v${newVersion}` : newVersion,
        // Skip if line contains certain keywords
        skipLines: /changelog|history|previous|released|was |fixed in|since|before|after|from [\d\.]+ to|migrat|v[\d\.]+ \(/i
      },
      {
        // Update installation instructions
        pattern: /@dollhousemcp\/mcp-server@[\d\.]+(-[\w\.]+)?/g,
        replacement: `@dollhousemcp/mcp-server@${newVersion}`
      }
    ]
  },
  {
    name: 'CHANGELOG.md',
    updates: [
      {
        // Add new version entry at the top (after the header)
        pattern: /(# Changelog\n+)/,
        replacement: `$1## [${newVersion}] - ${new Date().toISOString().split('T')[0]}${releaseNotes ? `\n\n${releaseNotes}` : '\n\n- Version bump'}\n\n`,
        once: true // Only replace first occurrence
      }
    ]
  },
  {
    name: 'src/constants/version.ts',
    pattern: /export const VERSION = "[^"]+"/,
    replacement: `export const VERSION = "${newVersion}"`,
    createIfMissing: true,
    defaultContent: `// Auto-generated version constant
export const VERSION = "${newVersion}";
export const BUILD_DATE = "${new Date().toISOString()}";
`,
    optional: true
  },
  {
    name: 'docs/**/*.md',
    glob: true,
    updates: [
      {
        // Update version references in documentation
        pattern: new RegExp(`(?:Version|v)\\s*${currentVersion.replace(/\./g, '\\.')}\\b`, 'g'),
        replacement: (match) => match.replace(currentVersion, newVersion),
        // Skip historical references
        skipLines: /changelog|history|previous|released|deprecated|legacy|old version|upgrade from|PR #|Issue #|commit|merged/i
      }
    ]
  },
  {
    name: 'docker-compose.yml',
    pattern: new RegExp(`dollhousemcp/mcp-server:${currentVersion.replace(/\./g, '\\.')}`, 'g'),
    replacement: `dollhousemcp/mcp-server:${newVersion}`,
    optional: true // Don't fail if file doesn't exist
  },
  {
    name: 'Dockerfile',
    updates: [
      {
        // Update LABEL version
        pattern: /LABEL version="[\d\.]+(-[\w\.]+)?"/,
        replacement: `LABEL version="${newVersion}"`
      }
    ],
    optional: true
  }
];

// Helper function to update a single file
function updateFile(filePath, config) {
  try {
    const fullPath = path.join(path.dirname(__dirname), filePath);
    
    if (!fs.existsSync(fullPath)) {
      if (config.createIfMissing && config.defaultContent) {
        if (!isDryRun) {
          // Create directory if needed
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(fullPath, config.defaultContent);
        }
        console.log(`  ✅ Created ${filePath}`);
        return true;
      } else if (config.optional) {
        return false;
      } else if (config.required) {
        console.error(`  ❌ Required file not found: ${filePath}`);
        return false;
      }
      return false;
    }

    let content = fs.readFileSync(fullPath, 'utf-8');
    const originalContent = content;
    let changesMade = false;

    if (config.updates) {
      // Multiple update patterns for this file
      for (const update of config.updates) {
        if (update.skipLines) {
          // Process line by line for selective updates
          const lines = content.split('\n');
          const updatedLines = lines.map(line => {
            if (update.skipLines.test(line)) {
              return line; // Skip this line
            }
            if (typeof update.replacement === 'function') {
              return line.replace(update.pattern, update.replacement);
            }
            return line.replace(update.pattern, update.replacement);
          });
          content = updatedLines.join('\n');
        } else if (update.requireContext) {
          // Only replace if context matches
          const lines = content.split('\n');
          const updatedLines = lines.map(line => {
            if (update.requireContext.test(line)) {
              return line.replace(update.pattern, update.replacement);
            }
            return line;
          });
          content = updatedLines.join('\n');
        } else if (update.once) {
          // Replace only first occurrence
          content = content.replace(update.pattern, update.replacement);
        } else {
          // Standard replacement
          if (typeof update.replacement === 'function') {
            content = content.replace(update.pattern, update.replacement);
          } else {
            content = content.replace(update.pattern, update.replacement);
          }
        }
      }
    } else if (config.pattern) {
      // Single pattern update
      if (config.multiple) {
        content = content.replace(new RegExp(config.pattern, 'g'), config.replacement);
      } else {
        content = content.replace(config.pattern, config.replacement);
      }
    }

    changesMade = content !== originalContent;

    if (changesMade) {
      if (!isDryRun) {
        fs.writeFileSync(fullPath, content);
      }
      console.log(`  ✅ Updated ${filePath}`);
      return true;
    } else {
      console.log(`  ⏭️  No changes needed in ${filePath}`);
      return false;
    }
  } catch (error) {
    console.error(`  ❌ Error updating ${filePath}: ${error.message}`);
    return false;
  }
}

// Helper function to handle glob patterns
async function handleGlobPattern(pattern, config) {
  const basePath = path.dirname(__dirname);
  const fullPattern = path.join(basePath, pattern);
  const files = await glob(fullPattern);
  let updated = 0;
  
  for (const file of files) {
    const relativePath = path.relative(basePath, file);
    if (updateFile(relativePath, config)) {
      updated++;
    }
  }
  
  return updated;
}

// Main update process
async function main() {
  let totalUpdated = 0;
  let totalErrors = 0;

  for (const config of updateConfigs) {
    if (config.glob) {
      const updated = await handleGlobPattern(config.name, config);
      totalUpdated += updated;
    } else {
      if (updateFile(config.name, config)) {
        totalUpdated++;
      } else if (config.required && !fs.existsSync(path.join(path.dirname(__dirname), config.name))) {
        totalErrors++;
      }
    }
  }

  console.log('\n' + '='.repeat(60));

  if (totalErrors > 0) {
    console.log(`❌ Version update failed with ${totalErrors} errors`);
    process.exit(1);
  }

  if (isDryRun) {
    console.log(`🧪 DRY RUN COMPLETE: Would update ${totalUpdated} files`);
    console.log(`Run without --dry-run to apply changes`);
  } else {
    console.log(`✅ Version updated to ${newVersion} in ${totalUpdated} files`);
    
    // Update package-lock.json properly using npm
    console.log('\n📦 Updating package-lock.json with npm...');
    try {
      execSync('npm install --package-lock-only', { stdio: 'inherit', cwd: path.dirname(__dirname) });
    } catch (error) {
      console.error('⚠️  Failed to update package-lock.json with npm');
    }
    
    // Generate version file if script exists
    const versionScriptPath = path.join(path.dirname(__dirname), 'scripts/generate-version.js');
    if (fs.existsSync(versionScriptPath)) {
      console.log('\n🏗️  Generating version info...');
      try {
        execSync('node scripts/generate-version.js', { stdio: 'inherit', cwd: path.dirname(__dirname) });
      } catch (error) {
        console.error('⚠️  Failed to generate version info');
      }
    }
    
    console.log('\n📝 Next steps:');
    console.log(`  1. Review the changes: git diff`);
    console.log(`  2. Update CHANGELOG.md with detailed release notes`);
    console.log(`  3. Commit: git add -A && git commit -m "chore: bump version to ${newVersion}"`);
    console.log(`  4. Tag the release: git tag v${newVersion}`);
    console.log(`  5. Push: git push && git push --tags`);
  }
}

// Run the main process
main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});