#!/usr/bin/env node

/**
 * Generate version information at build time
 * This creates a TypeScript file with embedded version info
 * so the application can know its version even when installed via npm
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read package.json
const packagePath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

// Determine build type from environment or default
const buildType = process.env.BUILD_TYPE || 'git';

// Generate TypeScript content
const versionContent = `/**
 * Auto-generated file - DO NOT EDIT
 * Generated at build time by scripts/generate-version.js
 */

export const PACKAGE_VERSION = '${pkg.version}';
export const BUILD_TIMESTAMP = '${new Date().toISOString()}';
export const BUILD_TYPE: 'npm' | 'git' = '${buildType}';
export const PACKAGE_NAME = '${pkg.name}';
`;

// Ensure target directory exists
const targetDir = path.join(__dirname, '..', 'src', 'generated');
fs.mkdirSync(targetDir, { recursive: true });

// Write the file
const targetPath = path.join(targetDir, 'version.ts');
fs.writeFileSync(targetPath, versionContent);

console.log(`✅ Generated version info: v${pkg.version} (${buildType} build)`);