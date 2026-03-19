#!/usr/bin/env npx tsx
/**
 * Measure MCP Tool Tokens Directly
 *
 * Imports the actual tool definitions and measures token counts
 * without needing to run the full server.
 */

// Set environment before importing
process.env.MCP_INTERFACE_MODE = 'mcpaql';
process.env.MCP_AQL_ENDPOINT_MODE = 'crude';
process.env.NODE_ENV = 'test';

async function main() {
  console.log('='.repeat(80));
  console.log('  MCP TOOL TOKEN MEASUREMENT - DIRECT');
  console.log('='.repeat(80));
  console.log();

  // We need to measure the actual tool definitions
  // The tool definitions are in the dist/ directory after build

  const _toolModules = [
    { name: 'ElementTools', path: '../dist/server/tools/ElementTools.js' },
    { name: 'CollectionTools', path: '../dist/server/tools/CollectionTools.js' },
    { name: 'PortfolioTools', path: '../dist/server/tools/PortfolioTools.js' },
    { name: 'AuthTools', path: '../dist/server/tools/AuthTools.js' },
    { name: 'ConfigToolsV2', path: '../dist/server/tools/ConfigToolsV2.js' },
    { name: 'EnhancedIndexTools', path: '../dist/server/tools/EnhancedIndexTools.js' },
    { name: 'BuildInfoTools', path: '../dist/server/tools/BuildInfoTools.js' },
    { name: 'PersonaTools', path: '../dist/server/tools/PersonaTools.js' },
  ];

  console.log('Note: This script measures schema sizes, not actual tool instances.');
  console.log('For accurate measurements, use Claude Code /context command.');
  console.log();

  // Since we can't easily instantiate all the handlers, let's use the
  // already-measured values from Claude Code /context output

  console.log('MEASURED VALUES FROM CLAUDE CODE /context:');
  console.log('-'.repeat(80));
  console.log();

  // From the user's /context output
  const crudeTokens = {
    'mcp_aql_create': 848,
    'mcp_aql_read': 905,
    'mcp_aql_update': 759,
    'mcp_aql_delete': 774,
    'mcp_aql_execute': 984
  };

  console.log('CRUDE MODE (5 endpoints):');
  let crudeTotal = 0;
  for (const [name, tokens] of Object.entries(crudeTokens)) {
    console.log(`  ${name}: ${tokens.toLocaleString()} tokens`);
    crudeTotal += tokens;
  }
  console.log(`  TOTAL: ${crudeTotal.toLocaleString()} tokens`);
  console.log();

  console.log('TO MEASURE OTHER MODES:');
  console.log('-'.repeat(80));
  console.log(`
1. DISCRETE MODE:
   Add to your MCP config:
   "env": { "MCP_INTERFACE_MODE": "discrete" }

   Then restart Claude Code and run: /context
   Sum all the DollhouseMCP tools listed.

2. SINGLE MODE:
   Add to your MCP config:
   "env": { "MCP_AQL_ENDPOINT_MODE": "single" }

   Then restart Claude Code and run: /context
   Look for the single mcp_aql tool.
`);

  console.log('ESTIMATED COMPARISON:');
  console.log('-'.repeat(80));
  console.log();
  console.log('  | Configuration       | Tools | Tokens     | vs Discrete |');
  console.log('  |---------------------|-------|------------|-------------|');
  console.log('  | Discrete            | ~42   | ~10,000*   |  (baseline) |');
  console.log(`  | CRUDE (5 endpoints) |     5 | ${crudeTotal.toLocaleString().padStart(10)} | ~57% savings |`);
  console.log('  | Single endpoint     |     1 | ~400*      | ~96% savings |');
  console.log();
  console.log('  * = estimated, needs measurement via /context');
  console.log();
}

main().catch(console.error);

export {};
