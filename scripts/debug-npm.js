#!/usr/bin/env node

// Debug script to test NPM package installation
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.error('=== DollhouseMCP NPM Debug ===');
console.error('__dirname:', __dirname);
console.error('process.cwd():', process.cwd());
console.error('process.argv:', process.argv);

// Check for data directories
const possiblePaths = [
  join(__dirname, '../data'),
  join(__dirname, '../../data'),
  join(process.cwd(), 'data'),
  '/usr/local/lib/node_modules/@dollhousemcp/mcp-server/data',
  '/opt/homebrew/lib/node_modules/@dollhousemcp/mcp-server/data'
];

console.error('\nChecking for data directories:');
for (const path of possiblePaths) {
  const exists = existsSync(path);
  console.error(`${path}: ${exists ? 'EXISTS' : 'NOT FOUND'}`);
  if (exists) {
    try {
      const contents = readdirSync(path);
      console.error(`  Contents: ${contents.join(', ')}`);
    } catch (e) {
      console.error(`  Error reading: ${e.message}`);
    }
  }
}

// Check NODE_PATH
console.error('\nNODE_PATH:', process.env.NODE_PATH || 'Not set');

// Check npm global path
console.error('\nChecking npm global installation:');
try {
  const { execSync } = await import('child_process');
  const npmRoot = execSync('npm root -g').toString().trim();
  console.error('npm global root:', npmRoot);
  
  const mcpPath = join(npmRoot, '@dollhousemcp/mcp-server');
  console.error(`MCP package path: ${mcpPath}`);
  console.error(`Exists: ${existsSync(mcpPath)}`);
  
  if (existsSync(mcpPath)) {
    const packageContents = readdirSync(mcpPath);
    console.error('Package contents:', packageContents.join(', '));
    
    const dataPath = join(mcpPath, 'data');
    console.error(`\nData directory: ${dataPath}`);
    console.error(`Exists: ${existsSync(dataPath)}`);
    
    if (existsSync(dataPath)) {
      const dataContents = readdirSync(dataPath);
      console.error('Data contents:', dataContents.join(', '));
    }
  }
} catch (e) {
  console.error('Error checking npm paths:', e.message);
}

console.error('\n=== End Debug ===\n');

// Now try to actually start the server
console.error('Attempting to start server...\n');
import('../dist/index.js');