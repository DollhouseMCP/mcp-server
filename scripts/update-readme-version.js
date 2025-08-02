#!/usr/bin/env node

/**
 * Script to update version numbers in README.md
 * Usage: node scripts/update-readme-version.js
 * 
 * This will read the version from package.json and update all references in README.md
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Read current version from package.json
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const currentVersion = packageJson.version;

console.log(`Updating README.md to version v${currentVersion}...`);

// Read README.md
const readmePath = join(rootDir, 'README.md');
let readme = readFileSync(readmePath, 'utf8');

// Patterns to update
const updates = [
  // Main version reference
  {
    pattern: /\*\*📦 Version\*\*: v\d+\.\d+\.\d+/g,
    replacement: `**📦 Version**: v${currentVersion}`
  },
  // Package.json reference in file structure
  {
    pattern: /├── package\.json\s+# Project config \(dollhousemcp v\d+\.\d+\.\d+\)/g,
    replacement: `├── package.json                 # Project config (dollhousemcp v${currentVersion})`
  },
  // Any "Current" version in changelog (remove "Current" from old versions)
  {
    pattern: /### v\d+\.\d+\.\d+ - .+ \(Current\)/g,
    replacement: (match) => match.replace(' (Current)', '')
  }
];

// Apply updates
updates.forEach(({ pattern, replacement }) => {
  const matches = readme.match(pattern);
  if (matches) {
    console.log(`Found ${matches.length} matches for pattern: ${pattern}`);
    readme = readme.replace(pattern, replacement);
  }
});

// Add (Current) to the new version in changelog if it exists
const changelogPattern = new RegExp(`(### v${currentVersion} - [^\\n]+)(?! \\(Current\\))`, 'g');
readme = readme.replace(changelogPattern, '$1 (Current)');

// Write updated README
writeFileSync(readmePath, readme);

console.log(`✅ README.md updated to v${currentVersion}`);

// Count tools and tests for reference
try {
  // This is a simple count - in production you might want to actually parse the TypeScript interface
  const interfaceContent = readFileSync(join(rootDir, 'src/server/types.ts'), 'utf8');
  const toolCount = (interfaceContent.match(/^\s*\w+\([^)]*\):\s*Promise<any>/gm) || []).length;
  console.log(`\n📊 Current counts for reference:`);
  console.log(`   Tools: ${toolCount}`);
  console.log(`   Tests: Run 'npm test' to get accurate count`);
  console.log(`\n💡 Don't forget to update these counts in README if they've changed!`);
} catch (e) {
  // Ignore if file structure changes
}