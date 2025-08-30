#!/usr/bin/env node

/**
 * Build README files from modular chunks
 * This script combines markdown chunks into complete README files
 * for different targets (NPM, GitHub, etc.)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const CONFIG_PATH = path.join(__dirname, '..', 'docs', 'readme', 'config.json');
const README_DIR = path.join(__dirname, '..', 'docs', 'readme');

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
 * Log with color
 */
function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Load and parse the configuration file
 */
async function loadConfig() {
  try {
    const configContent = await fs.readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(configContent);
  } catch (error) {
    throw new Error(`Failed to load config: ${error.message}`);
  }
}

/**
 * Load a chunk file
 */
async function loadChunk(chunkName, chunkDirectory) {
  const chunkPath = path.join(README_DIR, chunkDirectory, `${chunkName}.md`);
  try {
    const content = await fs.readFile(chunkPath, 'utf-8');
    return content.trim();
  } catch (error) {
    // Chunk might be optional or not yet created
    log(`  ⚠️  Chunk not found: ${chunkName}.md`, 'yellow');
    return null;
  }
}

/**
 * Build a README for a specific target
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
  
  // Write output file
  const outputPath = path.join(README_DIR, targetConfig.output);
  await fs.writeFile(outputPath, readmeContent, 'utf-8');
  
  // Get file size
  const stats = await fs.stat(outputPath);
  const sizeKB = (stats.size / 1024).toFixed(1);
  
  log(`  ✓ Written to: ${targetConfig.output} (${sizeKB} KB)`, 'green');
  log(`  ✓ Combined ${chunks.length} chunks`, 'green');
  
  return { success: true, chunks: chunks.length, size: sizeKB };
}

/**
 * Main build process
 */
async function main() {
  log('\n📚 DollhouseMCP README Builder', 'bright');
  log('================================\n');
  
  try {
    // Load configuration
    log('Loading configuration...', 'blue');
    const config = await loadConfig();
    log('✓ Configuration loaded', 'green');
    
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