#!/usr/bin/env node

/**
 * Single source of truth for counting MCP tools
 * Run this script to get the current accurate count of MCP tools
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOOLS_DIR = path.join(__dirname, '..', 'src', 'server', 'tools');
const EXCLUDE_FILES = ['ToolRegistry.ts', 'index.ts'];

// Tool categories for detailed breakdown
const categories = {
  'AuthTools.ts': 'Authentication',
  'BuildInfoTools.ts': 'Build Information',
  'CollectionTools.ts': 'Collection Management',
  'ConfigTools.ts': 'Configuration',
  'ElementTools.ts': 'Element Management',
  'PersonaTools.ts': 'Persona Import/Export',
  'PortfolioTools.ts': 'Portfolio Management',
  'UserTools.ts': 'User Management'
};

function countToolsInFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  // Match both single and double quotes for tool names
  const matches = content.match(/name:\s*["'][\w_]+["']/g);
  return matches ? matches.length : 0;
}

function getToolNames(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  // Extract actual tool names
  const matches = content.match(/name:\s*["']([\w_]+)["']/g);
  if (!matches) return [];
  
  return matches.map(match => {
    const nameMatch = match.match(/name:\s*["']([\w_]+)["']/);
    return nameMatch ? nameMatch[1] : null;
  }).filter(Boolean);
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('                    MCP TOOLS COUNT REPORT                     ');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

let totalCount = 0;
const toolsByCategory = {};

// Read all TypeScript files in the tools directory
const files = fs.readdirSync(TOOLS_DIR)
  .filter(file => file.endsWith('.ts') && !EXCLUDE_FILES.includes(file))
  .sort();

console.log('📊 BREAKDOWN BY CATEGORY:');
console.log('─────────────────────────────────────────────────────────────');

files.forEach(file => {
  const filePath = path.join(TOOLS_DIR, file);
  const count = countToolsInFile(filePath);
  const tools = getToolNames(filePath);
  const category = categories[file] || file.replace('.ts', '');
  
  toolsByCategory[category] = tools;
  totalCount += count;
  
  console.log(`\n${category}:`);
  console.log(`  Count: ${count}`);
  if (tools.length > 0) {
    console.log(`  Tools:`);
    tools.forEach(tool => console.log(`    • ${tool}`));
  }
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`🎯 TOTAL MCP TOOLS: ${totalCount}`);
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// Output for easy copying to documentation
console.log('📝 FOR DOCUMENTATION:');
console.log(`- Update all references to: "${totalCount} MCP Tools"`);
console.log(`- Last verified: ${new Date().toISOString().split('T')[0]}`);
console.log();

// Export count for use in other scripts
if (process.argv.includes('--json')) {
  console.log('\n📋 JSON OUTPUT:');
  console.log(JSON.stringify({
    total: totalCount,
    categories: Object.keys(toolsByCategory).reduce((acc, category) => {
      acc[category] = {
        count: toolsByCategory[category].length,
        tools: toolsByCategory[category]
      };
      return acc;
    }, {}),
    lastUpdated: new Date().toISOString()
  }, null, 2));
}

// Return exit code 0 for success
process.exit(0);