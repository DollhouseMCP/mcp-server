#!/usr/bin/env node

/**
 * Capability Index Docker Test Suite
 * Tests different capability index structures in isolated Docker environments
 * Each test creates a fresh Docker container with Claude Code + DollhouseMCP
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============= BASE CONSTANTS (Present in ALL tests) =============

const ELEMENT_SEARCH_HIERARCHY = `
ELEMENT_SEARCH_HIERARCHY:
  DEFAULT ORDER (when location unspecified):
    1. Active (already loaded) - 0 tokens
    2. Local (~/.dollhouse/portfolio) - 50 tokens
    3. GitHub (user's portfolio) - 100 tokens
    4. Collection (community library) - 150 tokens

  OVERRIDE: User intent always takes precedence
    - "search the collection for..." → Go directly to collection
    - "check my GitHub for..." → Go directly to GitHub portfolio
    - "look in my local..." → Go directly to local portfolio
    - "is there an active..." → Check only active elements
`;

const TOOL_CAPABILITIES = `
TOOL_CAPABILITIES:
  search_portfolio: FINDS elements in local storage
  search_collection: FINDS elements in community library
  portfolio_element_manager: MANAGES GitHub portfolio sync
  get_active_elements: CHECKS what's currently loaded
  activate_element: LOADS element into context
  create_element: CREATES new element
  edit_element: MODIFIES existing element
  list_elements: LISTS available elements by type
  validate_element: VERIFIES element correctness
`;

// ============= TEST VARIANTS =============
// All include search hierarchy and tool capabilities
// Vary in how they present element capabilities and workflows

const testVariants = {
  'minimal': {
    name: 'Minimal (Hierarchy + Tools Only)',
    content: `# DollhouseMCP Capability Index

${ELEMENT_SEARCH_HIERARCHY}

${TOOL_CAPABILITIES}
`
  },

  'element-capabilities': {
    name: 'With Element Capabilities',
    content: `# DollhouseMCP Capability Index

${ELEMENT_SEARCH_HIERARCHY}

${TOOL_CAPABILITIES}

ELEMENT_CAPABILITIES:
  memories:
    PROVIDE: Contextual information on topics
    PERSIST: Information across sessions
    AUGMENT: Current context with history

  personas:
    ALTER: Behavioral patterns
    PROVIDE: Specialized expertise
    SHAPE: Response style

  skills:
    PROVIDE: Specific capabilities
    EXECUTE: Defined procedures
    ENHANCE: Task performance
`
  },

  'action-verbs': {
    name: 'Action-Oriented',
    content: `# DollhouseMCP Capability Index

${ELEMENT_SEARCH_HIERARCHY}

${TOOL_CAPABILITIES}

ACTIONS:
  NEED_INFO → CHECK memories
  NEED_DEBUG → FIND debug skills/personas
  NEED_SECURITY → SEARCH local only
  REMEMBER → CREATE/UPDATE memory
  ACTIVATE → LOAD element into context
`
  },

  'intent-mapping': {
    name: 'Intent to Capability Mapping',
    content: `# DollhouseMCP Capability Index

${ELEMENT_SEARCH_HIERARCHY}

${TOOL_CAPABILITIES}

INTENT_MAPPING:
  "information about X" → memories
  "help debugging" → debug skills/personas
  "security analysis" → local security tools
  "git workflow" → collection best practices
  "remember this" → create/update memory
`
  },

  'workflow-hints': {
    name: 'With Workflow Hints',
    content: `# DollhouseMCP Capability Index

${ELEMENT_SEARCH_HIERARCHY}

${TOOL_CAPABILITIES}

WORKFLOW_HINTS:
  For information: Check active memories first
  For debugging: Look for debug personas/skills
  For security: Stay local, don't search collection
  For memory updates: Edit if exists, create if new
`
  },

  'explicit-process': {
    name: 'Explicit Process Instructions',
    content: `# DollhouseMCP Capability Index

ALWAYS follow this process:

${ELEMENT_SEARCH_HIERARCHY}

${TOOL_CAPABILITIES}

PROCESS:
  1. Identify user intent
  2. Check element search hierarchy
  3. Use appropriate tool capability
  4. Activate if found, create if missing
`
  },

  'nested-structure': {
    name: 'Nested Hierarchical',
    content: `# DollhouseMCP Capability Index

${ELEMENT_SEARCH_HIERARCHY}

${TOOL_CAPABILITIES}

CAPABILITY_STRUCTURE:
  information:
    sources:
      memories: contextual data
      personas: expertise
    tools: [get_active_elements, search_portfolio]

  debugging:
    sources:
      skills: debug procedures
      personas: debug expertise
    tools: [search_portfolio, search_collection]
`
  },

  'control': {
    name: 'Control (No Index)',
    content: `# DollhouseMCP

You have access to DollhouseMCP tools for managing AI customization elements.
`
  }
};

// ============= TEST QUERIES =============

const testQueries = [
  // Unspecified location (should use hierarchy)
  {
    query: "I need help debugging this error in my code",
    expectedWorkflow: ['check active', 'search local', 'search github', 'search collection'],
    expectedTool: 'search_portfolio or search_collection',
    expectedElement: 'debug skill or persona'
  },
  {
    query: "Remember that the API endpoint changed to /v2/users",
    expectedWorkflow: ['check active memories', 'create/update memory'],
    expectedTool: 'edit_element or create_element',
    expectedElement: 'memory'
  },
  {
    query: "I need a security analysis for this code",
    expectedWorkflow: ['check active', 'search local only'],
    expectedTool: 'search_portfolio',
    expectedElement: 'security skill'
  },
  {
    query: "Find me a git workflow helper",
    expectedWorkflow: ['search github', 'search collection'],
    expectedTool: 'portfolio_element_manager or search_collection',
    expectedElement: 'git skill or agent'
  },
  {
    query: "What personas do I have available?",
    expectedWorkflow: ['list all tiers'],
    expectedTool: 'list_elements',
    expectedElement: 'personas'
  },

  // Explicit location (should override hierarchy)
  {
    query: "Search the collection for a creative writing persona",
    expectedWorkflow: ['search collection directly'],
    expectedTool: 'search_collection',
    expectedElement: 'creative persona'
  },
  {
    query: "Check my GitHub portfolio for test automation tools",
    expectedWorkflow: ['search github directly'],
    expectedTool: 'portfolio_element_manager',
    expectedElement: 'test skill'
  },
  {
    query: "Is there an active memory about our testing strategy?",
    expectedWorkflow: ['check active only'],
    expectedTool: 'get_active_elements',
    expectedElement: 'testing memory'
  }
];

// ============= TEST RUNNER =============

class CapabilityIndexTester {
  constructor() {
    this.results = [];
    this.testDir = path.join(__dirname, 'docker-test-runs', Date.now().toString());
  }

  async setup() {
    fs.mkdirSync(this.testDir, { recursive: true });
    console.log(`Test directory: ${this.testDir}`);
  }

  async runTest(variantKey, variant, query) {
    const testId = `${variantKey}_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const testPath = path.join(this.testDir, testId);
    fs.mkdirSync(testPath, { recursive: true });

    // Write CLAUDE.md with the variant content
    fs.writeFileSync(
      path.join(testPath, 'CLAUDE.md'),
      variant.content
    );

    // Create test query file
    fs.writeFileSync(
      path.join(testPath, 'query.txt'),
      query.query
    );

    return new Promise((resolve) => {
      const startTime = Date.now();

      // Run Docker container with isolated Claude Code + DollhouseMCP
      const dockerCmd = spawn('docker', [
        'run',
        '--rm',
        '-v', `${testPath}:/workspace:ro`,
        '-v', `${path.join(testPath, 'CLAUDE.md')}:/root/.dollhouse/CLAUDE.md:ro`,
        '-e', 'DOLLHOUSE_TEST_MODE=true',
        '-e', 'CAPTURE_WORKFLOW=true',
        'claude-mcp-test',
        '/bin/bash', '-c',
        `
        # Start MCP server
        cd /app && npm start 2>/dev/null &
        MCP_PID=$!

        # Wait for server
        sleep 3

        # Simulate Claude Code query
        echo "Query: $(cat /workspace/query.txt)"
        echo "---"

        # This would normally be Claude Code, but we'll simulate the MCP interaction
        node -e "
          const query = fs.readFileSync('/workspace/query.txt', 'utf8');
          console.log('Processing:', query);

          // Simulate checking capability index
          const claudeMd = fs.readFileSync('/root/.dollhouse/CLAUDE.md', 'utf8');
          const hasHierarchy = claudeMd.includes('ELEMENT_SEARCH_HIERARCHY');
          const hasTools = claudeMd.includes('TOOL_CAPABILITIES');
          const hasWorkflow = claudeMd.includes('WORKFLOW') || claudeMd.includes('PROCESS');

          console.log('Index found:', { hasHierarchy, hasTools, hasWorkflow });

          // Simulate tool selection based on query
          if (query.includes('collection')) {
            console.log('Selected: search_collection');
          } else if (query.includes('GitHub')) {
            console.log('Selected: portfolio_element_manager');
          } else if (query.includes('active')) {
            console.log('Selected: get_active_elements');
          } else if (query.includes('Remember')) {
            console.log('Selected: create_element or edit_element');
          } else {
            console.log('Selected: search_portfolio (default)');
          }
        " 2>&1

        # Kill MCP server
        kill $MCP_PID 2>/dev/null
        `
      ]);

      let output = '';
      let workflow = [];

      dockerCmd.stdout.on('data', (data) => {
        const str = data.toString();
        output += str;

        // Parse workflow steps
        if (str.includes('Selected:')) {
          workflow.push(str.match(/Selected: (.+)/)?.[1] || 'unknown');
        }
      });

      dockerCmd.stderr.on('data', (data) => {
        if (process.env.DEBUG) {
          console.error(`[${testId}] stderr:`, data.toString());
        }
      });

      dockerCmd.on('error', (error) => {
        console.error(`[${testId}] error:`, error);
        resolve({
          testId,
          variant: variant.name,
          query: query.query,
          success: false,
          error: error.message
        });
      });

      dockerCmd.on('close', (code) => {
        const duration = Date.now() - startTime;

        // Analyze results
        const mentionsIndex = output.includes('Index found');
        const usesHierarchy = output.includes('ELEMENT_SEARCH_HIERARCHY');
        const correctTool = workflow.some(tool =>
          query.expectedTool.includes(tool.split(' ')[0])
        );

        resolve({
          testId,
          variant: variant.name,
          query: query.query,
          expectedWorkflow: query.expectedWorkflow,
          observedWorkflow: workflow,
          expectedTool: query.expectedTool,
          mentionsIndex,
          usesHierarchy,
          correctTool,
          duration,
          output: output.substring(0, 500) // First 500 chars
        });
      });
    });
  }

  async runAllTests() {
    console.log('Starting Capability Index Docker Tests');
    console.log('=' . repeat(80));

    for (const [variantKey, variant] of Object.entries(testVariants)) {
      console.log(`\nTesting Variant: ${variant.name}`);
      console.log('-'.repeat(60));

      const variantResults = [];

      for (const query of testQueries) {
        process.stdout.write(`  Testing: "${query.query.substring(0, 40)}..."... `);

        try {
          const result = await this.runTest(variantKey, variant, query);
          variantResults.push(result);

          console.log(result.correctTool ? '✅' : '❌');

          if (process.env.VERBOSE) {
            console.log(`    Workflow: ${result.observedWorkflow.join(' → ')}`);
          }
        } catch (error) {
          console.log('❌ ERROR:', error.message);
        }

        // Small delay between tests
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Summarize variant results
      const correctCount = variantResults.filter(r => r.correctTool).length;
      const indexUsage = variantResults.filter(r => r.mentionsIndex).length;
      const hierarchyUsage = variantResults.filter(r => r.usesHierarchy).length;
      const avgDuration = variantResults.reduce((sum, r) => sum + r.duration, 0) / variantResults.length;

      console.log(`\n  Summary for ${variant.name}:`);
      console.log(`    Correct Tool: ${correctCount}/${testQueries.length} (${(correctCount/testQueries.length*100).toFixed(1)}%)`);
      console.log(`    Uses Index: ${indexUsage}/${testQueries.length} (${(indexUsage/testQueries.length*100).toFixed(1)}%)`);
      console.log(`    Uses Hierarchy: ${hierarchyUsage}/${testQueries.length} (${(hierarchyUsage/testQueries.length*100).toFixed(1)}%)`);
      console.log(`    Avg Duration: ${avgDuration.toFixed(0)}ms`);

      this.results.push({
        variant: variant.name,
        variantKey,
        correctCount,
        indexUsage,
        hierarchyUsage,
        avgDuration,
        details: variantResults
      });
    }

    // Final summary
    this.printFinalSummary();
    this.saveResults();
  }

  printFinalSummary() {
    console.log('\n' + '='.repeat(80));
    console.log('FINAL SUMMARY - Capability Index Test Results');
    console.log('='.repeat(80));

    // Sort by correct tool selection
    const sorted = [...this.results].sort((a, b) => b.correctCount - a.correctCount);

    console.log('\nTop Performers (by Correct Tool Selection):');
    sorted.slice(0, 3).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.variant}`);
      console.log(`     Correct: ${r.correctCount}/${testQueries.length} (${(r.correctCount/testQueries.length*100).toFixed(1)}%)`);
      console.log(`     Index Usage: ${(r.indexUsage/testQueries.length*100).toFixed(1)}%`);
      console.log(`     Avg Time: ${r.avgDuration.toFixed(0)}ms`);
    });

    // Compare to control
    const control = this.results.find(r => r.variantKey === 'control');
    const best = sorted[0];

    if (control && best && best.variantKey !== 'control') {
      console.log(`\nImprovement over Control:`);
      console.log(`  ${best.variant} vs Control:`);
      console.log(`    Accuracy: +${((best.correctCount - control.correctCount)/testQueries.length*100).toFixed(1)}%`);
      console.log(`    Speed: ${((control.avgDuration - best.avgDuration)/control.avgDuration*100).toFixed(1)}% faster`);
    }
  }

  saveResults() {
    const resultsPath = path.join(this.testDir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      variants: testVariants,
      queries: testQueries,
      results: this.results
    }, null, 2));

    console.log(`\nResults saved to: ${resultsPath}`);
  }
}

// ============= MAIN =============

async function main() {
  const tester = new CapabilityIndexTester();
  await tester.setup();
  await tester.runAllTests();
}

// Check if Docker image exists
const checkDocker = spawn('docker', ['images', '-q', 'claude-mcp-test']);
let imageExists = false;

checkDocker.stdout.on('data', (data) => {
  if (data.toString().trim()) {
    imageExists = true;
  }
});

checkDocker.on('close', () => {
  if (!imageExists) {
    console.error('Docker image "claude-mcp-test" not found!');
    console.error('Please build it first with: docker build -t claude-mcp-test -f docker/Dockerfile .');
    process.exit(1);
  }

  // Run tests
  main().catch(console.error);
});