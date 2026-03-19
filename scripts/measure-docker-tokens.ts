#!/usr/bin/env npx tsx
/**
 * Measure MCP Tool Tokens via Docker
 *
 * Spawns the MCP server in Docker with different configurations
 * and measures actual tool token counts.
 */

import { spawn } from 'child_process';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: object;
}

interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: {
    tools?: ToolDefinition[];
    protocolVersion?: string;
    capabilities?: object;
    serverInfo?: object;
  };
  error?: {
    code: number;
    message: string;
  };
}

function estimateTokens(obj: object): number {
  const json = JSON.stringify(obj);
  return Math.ceil(json.length / 4);
}

// Valid configuration values - used for input validation to prevent command injection
const VALID_INTERFACE_MODES = ['mcpaql', 'discrete'] as const;
const VALID_ENDPOINT_MODES = ['crude', 'single', 'all'] as const;

type InterfaceMode = typeof VALID_INTERFACE_MODES[number];
type EndpointMode = typeof VALID_ENDPOINT_MODES[number];

async function measureConfig(
  interfaceMode: InterfaceMode,
  endpointMode: EndpointMode,
  label: string
): Promise<{ tools: ToolDefinition[]; totalTokens: number; perTool: Map<string, number> }> {
  // Validate inputs to prevent command injection (defense in depth)
  if (!VALID_INTERFACE_MODES.includes(interfaceMode)) {
    throw new Error(`Invalid interface mode: ${interfaceMode}. Must be one of: ${VALID_INTERFACE_MODES.join(', ')}`);
  }
  if (!VALID_ENDPOINT_MODES.includes(endpointMode)) {
    throw new Error(`Invalid endpoint mode: ${endpointMode}. Must be one of: ${VALID_ENDPOINT_MODES.join(', ')}`);
  }

  return new Promise((resolve, reject) => {
    console.log(`\nTesting: ${label}`);
    console.log(`  MCP_INTERFACE_MODE=${interfaceMode} MCP_AQL_ENDPOINT_MODE=${endpointMode}`);

    const docker = spawn('docker', [
      'run', '--rm', '-i',
      '-e', `MCP_INTERFACE_MODE=${interfaceMode}`,
      '-e', `MCP_AQL_ENDPOINT_MODE=${endpointMode}`,
      '-e', 'NODE_ENV=production',
      'dollhousemcp-token-test'
    ]);

    let stdout = '';
    let stderr = '';

    docker.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    docker.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Send MCP initialize request
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'token-measure', version: '1.0.0' }
      }
    }) + '\n';

    docker.stdin.write(initRequest);

    // Wait a bit then send tools/list
    setTimeout(() => {
      const listRequest = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      }) + '\n';
      docker.stdin.write(listRequest);

      // Give it time to respond then close
      setTimeout(() => {
        docker.stdin.end();
      }, 2000);
    }, 1000);

    docker.on('close', (_code) => {
      // Parse responses
      const lines = stdout.split('\n').filter(line => line.trim());
      let tools: ToolDefinition[] = [];

      for (const line of lines) {
        try {
          const response: MCPResponse = JSON.parse(line);
          if (response.result?.tools) {
            tools = response.result.tools;
          }
        } catch {
          // Skip non-JSON lines
        }
      }

      if (tools.length === 0) {
        console.log(`  ERROR: No tools found`);
        console.log(`  stdout: ${stdout.substring(0, 500)}`);
        console.log(`  stderr: ${stderr.substring(0, 500)}`);
        resolve({ tools: [], totalTokens: 0, perTool: new Map() });
        return;
      }

      // Calculate tokens
      const perTool = new Map<string, number>();
      let totalTokens = 0;

      for (const tool of tools) {
        const tokens = estimateTokens(tool);
        perTool.set(tool.name, tokens);
        totalTokens += tokens;
      }

      console.log(`  Tool count: ${tools.length}`);
      console.log(`  Total tokens: ${totalTokens.toLocaleString()}`);
      console.log(`  Tools:`);
      for (const [name, tokens] of perTool) {
        console.log(`    ${name}: ${tokens.toLocaleString()} tokens`);
      }

      resolve({ tools, totalTokens, perTool });
    });

    docker.on('error', (err) => {
      reject(err);
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      docker.kill();
      reject(new Error('Timeout'));
    }, 30000);
  });
}

async function main() {
  console.log('='.repeat(80));
  console.log('  MCP TOOL TOKEN MEASUREMENT - DOCKER');
  console.log('='.repeat(80));

  const results: Array<{
    label: string;
    interfaceMode: string;
    endpointMode: string;
    toolCount: number;
    totalTokens: number;
  }> = [];

  // Test CRUDE mode first (default)
  console.log('\n' + '='.repeat(80));
  console.log('  CONFIGURATION 1: CRUDE ENDPOINTS (5 tools)');
  console.log('  (Create, Read, Update, Delete, Execute)');
  console.log('='.repeat(80));

  try {
    const crude = await measureConfig('mcpaql', 'crude', 'MCP-AQL CRUDE (5 endpoints)');
    results.push({
      label: 'CRUDE (5 endpoints)',
      interfaceMode: 'mcpaql',
      endpointMode: 'crude',
      toolCount: crude.tools.length,
      totalTokens: crude.totalTokens
    });
  } catch (err) {
    console.log(`  ERROR: ${err}`);
  }

  // Test discrete mode
  console.log('\n' + '='.repeat(80));
  console.log('  CONFIGURATION 2: DISCRETE TOOLS');
  console.log('='.repeat(80));

  try {
    const discrete = await measureConfig('discrete', 'crude', 'Discrete (42+ individual tools)');
    results.push({
      label: 'Discrete',
      interfaceMode: 'discrete',
      endpointMode: 'crude',
      toolCount: discrete.tools.length,
      totalTokens: discrete.totalTokens
    });
  } catch (err) {
    console.log(`  ERROR: ${err}`);
  }

  // Test single endpoint mode
  console.log('\n' + '='.repeat(80));
  console.log('  CONFIGURATION 3: SINGLE ENDPOINT (1 tool)');
  console.log('='.repeat(80));

  try {
    const single = await measureConfig('mcpaql', 'single', 'MCP-AQL Single (1 endpoint)');
    results.push({
      label: 'Single endpoint',
      interfaceMode: 'mcpaql',
      endpointMode: 'single',
      toolCount: single.tools.length,
      totalTokens: single.totalTokens
    });
  } catch (err) {
    console.log(`  ERROR: ${err}`);
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('  SUMMARY');
  console.log('='.repeat(80));
  console.log('\n  | Configuration       | Tools | Tokens     | vs Discrete |');
  console.log('  |---------------------|-------|------------|-------------|');

  const discreteResult = results.find(r => r.label === 'Discrete');
  const discreteTokens = discreteResult?.totalTokens || 1;

  for (const result of results) {
    const savings = discreteResult
      ? Math.round((1 - result.totalTokens / discreteTokens) * 100)
      : 0;
    const savingsStr = result.label === 'Discrete' ? '(baseline)' : `${savings}% savings`;
    console.log(`  | ${result.label.padEnd(19)} | ${result.toolCount.toString().padStart(5)} | ${result.totalTokens.toLocaleString().padStart(10)} | ${savingsStr.padStart(11)} |`);
  }
  console.log();
}

main().catch(console.error);
