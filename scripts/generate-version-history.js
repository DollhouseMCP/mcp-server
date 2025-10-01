#!/usr/bin/env node

/**
 * Generate version history for README from CHANGELOG.md
 *
 * This script reads the CHANGELOG.md file and generates a version history
 * chunk for the README that includes only recent versions (configurable).
 *
 * The CHANGELOG.md is the source of truth with complete history.
 * The README version history is a curated subset for user visibility.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  // Path to source CHANGELOG.md
  changelogPath: path.join(__dirname, '..', 'CHANGELOG.md'),

  // Output path for README chunk
  outputPath: path.join(__dirname, '..', 'docs', 'readme', 'chunks', '11-changelog-full.md'),

  // Minimum version to include (inclusive)
  minVersion: '1.6.0',

  // Maximum number of versions to include (null for unlimited)
  maxVersions: null,

  // Whether to include pre-release versions
  includePreRelease: false
};

/**
 * Parse a version string to compare versions
 */
function parseVersion(versionStr) {
  const match = versionStr.match(/(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
  if (!match) return null;

  return {
    major: Number.parseInt(match[1]),
    minor: Number.parseInt(match[2]),
    patch: Number.parseInt(match[3]),
    preRelease: match[4] || null,
    original: versionStr
  };
}

/**
 * Compare two version objects
 */
function compareVersions(v1, v2) {
  if (v1.major !== v2.major) return v2.major - v1.major;
  if (v1.minor !== v2.minor) return v2.minor - v1.minor;
  if (v1.patch !== v2.patch) return v2.patch - v1.patch;

  // Pre-release versions come before release versions
  if (v1.preRelease && !v2.preRelease) return 1;
  if (!v1.preRelease && v2.preRelease) return -1;
  if (v1.preRelease && v2.preRelease) {
    return v1.preRelease.localeCompare(v2.preRelease);
  }

  return 0;
}

/**
 * Check if a version should be included based on config
 */
function shouldIncludeVersion(version) {
  if (!CONFIG.includePreRelease && version.preRelease) {
    return false;
  }

  if (CONFIG.minVersion) {
    const minVer = parseVersion(CONFIG.minVersion);
    if (compareVersions(version, minVer) > 0) {
      return false; // version is older than minimum
    }
  }

  return true;
}

/**
 * Parse CHANGELOG.md and extract version entries
 */
async function parseChangelog() {
  const content = await fs.readFile(CONFIG.changelogPath, 'utf-8');
  const lines = content.split('\n');

  const versions = [];
  let currentVersion = null;
  let currentContent = [];
  let inVersion = false;

  for (const line of lines) {
    // Check for version header (## [1.9.9] - 2025-09-22)
    const versionMatch = line.match(/^##\s+\[([^\]]+)\]\s+-\s+(.+)$/);

    if (versionMatch) {
      // Save previous version if exists
      if (currentVersion && currentContent.length > 0) {
        const parsedVersion = parseVersion(currentVersion.version);
        if (parsedVersion && shouldIncludeVersion(parsedVersion)) {
          versions.push({
            ...currentVersion,
            content: currentContent.join('\n').trim(),
            parsed: parsedVersion
          });
        }
      }

      // Start new version
      currentVersion = {
        version: versionMatch[1],
        date: versionMatch[2]
      };
      currentContent = [];
      inVersion = true;
    } else if (inVersion) {
      // Skip the # Changelog header
      if (line.startsWith('# ')) {
        continue;
      }
      currentContent.push(line);
    }
  }

  // Don't forget the last version
  if (currentVersion && currentContent.length > 0) {
    const parsedVersion = parseVersion(currentVersion.version);
    if (parsedVersion && shouldIncludeVersion(parsedVersion)) {
      versions.push({
        ...currentVersion,
        content: currentContent.join('\n').trim(),
        parsed: parsedVersion
      });
    }
  }

  // Sort versions (newest first)
  versions.sort((a, b) => compareVersions(a.parsed, b.parsed));

  // Limit number of versions if configured
  if (CONFIG.maxVersions && versions.length > CONFIG.maxVersions) {
    return versions.slice(0, CONFIG.maxVersions);
  }

  return versions;
}

/**
 * Format version content for README
 */
function formatVersionForReadme(version) {
  const lines = [];

  // Add version header
  lines.push(`### v${version.version} - ${version.date}`);
  lines.push('');

  // Process content - convert from CHANGELOG format to README format
  const contentLines = version.content.split('\n');
  let currentSection = '';
  let inList = false;

  for (const line of contentLines) {
    // Section headers (### Added, ### Fixed, etc.)
    if (line.startsWith('### ')) {
      currentSection = line.substring(4).trim();

      // Format section header for README
      if (currentSection === 'Added' || currentSection === 'Features') {
        lines.push('#### ✨ Features');
      } else if (currentSection === 'Fixed' || currentSection === 'Bug Fixes') {
        lines.push('#### 🔧 Fixed');
      } else if (currentSection === 'Security') {
        lines.push('#### 🔒 Security');
      } else if (currentSection === 'Changed' || currentSection === 'Improved') {
        lines.push('#### 🔄 Changed');
      } else if (currentSection === 'Deprecated') {
        lines.push('#### ⚠️ Deprecated');
      } else if (currentSection === 'Removed') {
        lines.push('#### 🗑️ Removed');
      } else {
        lines.push(`#### ${currentSection}`);
      }
      inList = false;
    }
    // List items
    else if (line.startsWith('- ')) {
      if (!inList) {
        inList = true;
      }
      lines.push(line);
    }
    // Sub-list items or continuation
    else if (line.startsWith('  ')) {
      lines.push(line);
    }
    // Other content
    else if (line.trim()) {
      lines.push(line);
    }
    // Blank lines
    else if (inList) {
      lines.push('');
      inList = false;
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate the README version history chunk
 */
async function generateVersionHistory() {
  console.log('📚 Generating README version history from CHANGELOG.md...\n');

  try {
    // Parse changelog
    const versions = await parseChangelog();
    console.log(`Found ${versions.length} versions matching criteria\n`);

    // Generate README content
    const lines = [];

    // Add header
    lines.push('## 🏷️ Version History');
    lines.push('');

    // Add each version
    for (const version of versions) {
      console.log(`  ✓ Including v${version.version}`);
      lines.push(formatVersionForReadme(version));
    }

    // Add footer
    lines.push('For complete release history prior to v' + CONFIG.minVersion +
               ', see the [GitHub Releases](https://github.com/DollhouseMCP/mcp-server/releases) page.');

    // Write output
    const output = lines.join('\n');
    await fs.writeFile(CONFIG.outputPath, output, 'utf-8');

    console.log(`\n✅ Generated version history to ${CONFIG.outputPath}`);
    console.log(`   Included versions from v${versions[versions.length - 1].version} to v${versions[0].version}`);

    return true;
  } catch (error) {
    console.error('❌ Error generating version history:', error);
    return false;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateVersionHistory().then(success => {
    process.exit(success ? 0 : 1);
  });
}

export { generateVersionHistory, parseChangelog };