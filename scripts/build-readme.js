#!/usr/bin/env node

/**
 * Build README files from modular chunks
 * This script combines markdown chunks into complete README files
 * for different targets (NPM, GitHub, etc.)
 * 
 * @fileoverview Modular README builder for DollhouseMCP
 * @author DollhouseMCP Team
 * @version 1.0.0
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths - use absolute paths for safety
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'docs', 'readme', 'config.json');
const README_DIR = path.join(PROJECT_ROOT, 'docs', 'readme');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m'
};

/**
 * Log a message with color formatting
 * @param {string} message - The message to log
 * @param {string} [color='reset'] - The color to use (from colors object)
 */
function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Load and parse the configuration file
 * @returns {Promise<Object>} The parsed configuration object
 * @throws {Error} If config file cannot be loaded or parsed
 */
async function loadConfig() {
  try {
    // Check if config file exists
    await fs.access(CONFIG_PATH, fs.constants.F_OK);
    
    const configContent = await fs.readFile(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(configContent);
    
    // Validate config structure
    if (!config.versions || typeof config.versions !== 'object') {
      throw new Error('Invalid config: missing or invalid "versions" property');
    }
    
    if (!config.chunkDirectory || typeof config.chunkDirectory !== 'string') {
      throw new Error('Invalid config: missing or invalid "chunkDirectory" property');
    }
    
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Configuration file not found at: ${CONFIG_PATH}`);
    }
    throw new Error(`Failed to load config: ${error.message}`);
  }
}

/**
 * Load a chunk file and validate its content
 * @param {string} chunkName - The name of the chunk (without .md extension)
 * @param {string} chunkDirectory - The directory containing chunks
 * @returns {Promise<string|null>} The chunk content or null if not found
 */
async function loadChunk(chunkName, chunkDirectory) {
  // SECURITY FIX: Sanitize chunk name to prevent path traversal
  // Remove any path separators and parent directory references
  const sanitizedChunkName = chunkName
    .replaceAll(/[\/\\]/g, '_')  // Replace path separators with underscore
    .replaceAll('..', '_')    // Replace parent directory references
    .replace(/^\./, '_');     // Replace leading dots
  
  const chunkPath = path.join(README_DIR, chunkDirectory, `${sanitizedChunkName}.md`);
  
  // SECURITY FIX: Verify the resolved path is within the expected directory
  const resolvedPath = path.resolve(chunkPath);
  const expectedDir = path.resolve(path.join(README_DIR, chunkDirectory));
  if (!resolvedPath.startsWith(expectedDir)) {
    throw new Error(`Security: Path traversal attempt detected for chunk: ${chunkName}`);
  }
  
  try {
    // Check if file exists first
    await fs.access(chunkPath, fs.constants.F_OK | fs.constants.R_OK);
    
    const content = await fs.readFile(chunkPath, 'utf-8');
    
    // Validate chunk content
    if (content.length === 0) {
      log(`  ⚠️  Chunk is empty: ${chunkName}.md`, 'yellow');
      return null;
    }
    
    // Basic markdown validation - check for obvious issues
    if (content.includes('```') && (content.match(/```/g).length % 2 !== 0)) {
      log(`  ⚠️  Unclosed code block in: ${chunkName}.md`, 'yellow');
    }
    
    return content.trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      log(`  ⚠️  Chunk not found: ${chunkName}.md`, 'yellow');
    } else if (error.code === 'EACCES') {
      log(`  ❌  Permission denied reading: ${chunkName}.md`, 'red');
    } else {
      log(`  ❌  Error reading chunk ${chunkName}.md: ${error.message}`, 'red');
    }
    return null;
  }
}

/**
 * Build a README for a specific target
 * @param {string} target - The target name (e.g., 'npm', 'github')
 * @param {Object} targetConfig - Configuration for this target
 * @param {Object} config - Global configuration
 * @returns {Promise<Object>} Build result with success status and statistics
 */
async function buildReadme(target, targetConfig, config) {
  log(`\nBuilding ${target} README...`, 'blue');
  log(`  Description: ${targetConfig.description}`);
  
  const chunks = [];
  const missingChunks = [];
  
  // Load all chunks
  for (const chunkName of targetConfig.chunks) {
    const content = await loadChunk(chunkName, config.chunkDirectory);
    if (content) {
      chunks.push(content);
      log(`  ✓ Loaded: ${chunkName}.md`, 'green');
    } else {
      missingChunks.push(chunkName);
    }
  }
  
  if (missingChunks.length > 0) {
    log(`  Missing chunks: ${missingChunks.join(', ')}`, 'yellow');
  }
  
  // Combine chunks with separator
  const separator = config.separator || '\n\n';
  const readmeContent = chunks.join(separator);
  
  // Resolve output path (handle relative paths safely)
  const outputPath = path.resolve(README_DIR, targetConfig.output);
  
  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  try {
    await fs.mkdir(outputDir, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to create output directory: ${error.message}`);
  }
  
  // Write output file with error handling
  try {
    await fs.writeFile(outputPath, readmeContent, 'utf-8');
  } catch (error) {
    if (error.code === 'EACCES') {
      throw new Error(`Permission denied writing to: ${outputPath}`);
    }
    throw new Error(`Failed to write README: ${error.message}`);
  }
  
  // Get file size
  const stats = await fs.stat(outputPath);
  const sizeKB = (stats.size / 1024).toFixed(1);
  
  log(`  ✓ Written to: ${targetConfig.output} (${sizeKB} KB)`, 'green');
  log(`  ✓ Combined ${chunks.length} chunks`, 'green');
  
  return { success: true, chunks: chunks.length, size: sizeKB };
}

/**
 * Main build process
 * Orchestrates the entire README building workflow
 * @returns {Promise<void>}
 */
async function main() {
  log('\n📚 DollhouseMCP README Builder', 'bright');
  log('================================\n');
  
  try {
    // Validate environment
    try {
      await fs.access(README_DIR, fs.constants.F_OK | fs.constants.R_OK);
    } catch (error) {
      throw new Error(`README directory not accessible: ${README_DIR}`);
    }
    
    // Load configuration
    log('Loading configuration...', 'blue');
    const config = await loadConfig();
    log('✓ Configuration loaded and validated', 'green');
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    const targetArg = args.find(arg => arg.startsWith('--target='));
    const specificTarget = targetArg ? targetArg.split('=')[1] : null;
    
    // Determine which targets to build
    const targetsToBuild = specificTarget 
      ? { [specificTarget]: config.versions[specificTarget] }
      : config.versions;
    
    if (specificTarget && !config.versions[specificTarget]) {
      throw new Error(`Unknown target: ${specificTarget}`);
    }
    
    // Build each target
    const results = {};
    for (const [target, targetConfig] of Object.entries(targetsToBuild)) {
      results[target] = await buildReadme(target, targetConfig, config);
    }
    
    // Summary
    log('\n📊 Build Summary', 'bright');
    log('================\n');
    for (const [target, result] of Object.entries(results)) {
      log(`${target}: ${result.chunks} chunks, ${result.size} KB`, 'green');
    }
    
    log('\n✨ Build complete!', 'bright');
    
    // Provide next steps
    log('\n📋 Next Steps:', 'blue');
    log('1. Review generated README files in docs/readme/');
    log('2. Copy README.npm.md to README.md for NPM publishing');
    log('3. Use README.github.md for GitHub repository');
    
  } catch (error) {
    log(`\n❌ Error: ${error.message}`, 'red');
    process.exit(1);
  }
}

// Run the builder
main().catch(error => {
  log(`\n❌ Unexpected error: ${error.message}`, 'red');
  process.exit(1);
});