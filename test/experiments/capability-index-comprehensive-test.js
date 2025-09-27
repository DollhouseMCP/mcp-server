#!/usr/bin/env node

/**
 * Comprehensive Capability Index Test
 * Tests all variables: structure, position, pre-prompts, MCP injection
 * Uses REAL DollhouseMCP elements that exist in the system
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============= TEST VARIABLES =============

// 1. INDEX STRUCTURES (using MCP tools that are ALWAYS available)
const indexStructures = {
  'cascade-top': {
    name: 'Cascade at Top',
    content: `CAPABILITY_INDEX:
  debug → search_portfolio + "debug"
  error → search_collection + "error handling"
  security → search_collection + "security"
  persona → list_elements + "personas"
  memory → list_elements + "memories"
  install → install_collection_content

When you need a capability, check the index FIRST.`
  },

  'cascade-bottom': {
    name: 'Cascade at Bottom',
    content: `You are Claude Code with DollhouseMCP.

[500 tokens of context...]

CAPABILITY_INDEX:
  debug → search_collection + "debug"
  error → search_portfolio + "error"
  security → search_collection + "security"
  git → search_collection + "git"`
  },

  'nested': {
    name: 'Nested Structure',
    content: `capabilities:
  development:
    debugging:
      tools: [search_portfolio, search_collection]
      query: ["debug", "error", "troubleshoot"]
    security:
      tools: [search_collection]
      query: ["security", "vulnerability"]
  workflow:
    git: [search_collection with "git"]
    personas: [list_elements with "personas"]`
  },

  'flat': {
    name: 'Flat List',
    content: `Available DollhouseMCP Tools:
- search_portfolio: search your local elements
- search_collection: search community elements
- list_elements: list available elements by type
- install_collection_content: install from collection
- activate_element: activate a persona or skill`
  },

  'action-verbs': {
    name: 'Action Verbs',
    content: `ACTIONS → MCP_TOOLS:
  NEED_DEBUG → USE search_collection("debug")
  FOUND_ERROR → USE search_portfolio("error")
  CHECK_SECURITY → USE search_collection("security")
  LIST_PERSONAS → USE list_elements("personas")
  ACTIVATE_FOUND → USE activate_element(name)`
  },

  'none': {
    name: 'No Index (Control)',
    content: ''
  }
};

// 2. CLAUDE.MD PRE-PROMPTS
const claudeMdPrompts = {
  'explicit': {
    name: 'Explicit Instructions',
    content: `# CRITICAL: Capability Index Usage

ALWAYS follow this process:
1. Check the CAPABILITY_INDEX first
2. Select the appropriate DollhouseMCP element
3. Activate it using mcp__dollhousemcp-production__activate_element
4. Explain your selection

The capability index maps tasks to DollhouseMCP elements.`
  },

  'suggestive': {
    name: 'Suggestive Guidance',
    content: `# Working with DollhouseMCP

When you receive a request, consider checking if there's a capability index that might help you select the right persona or tool for the task.`
  },

  'embedded': {
    name: 'Embedded in Context',
    content: `# Project Context

This project uses DollhouseMCP for AI customization. Elements are indexed for quick selection based on task requirements.`
  },

  'none': {
    name: 'No Pre-prompt',
    content: ''
  }
};

// 3. MCP INJECTION STRATEGIES
const mcpInjections = {
  'system': {
    name: 'System Message Injection',
    strategy: 'Add to MCP server initialization',
    content: `SYSTEM: Capability index loaded. Check index before element activation.`
  },

  'tool-description': {
    name: 'Tool Description Enhancement',
    strategy: 'Modify activate_element tool description',
    content: `This tool activates DollhouseMCP elements. ALWAYS check capability index first for guidance.`
  },

  'response-prefix': {
    name: 'Response Prefix',
    strategy: 'Prefix first MCP response',
    content: `[Capability index available for element selection]`
  },

  'none': {
    name: 'No Injection',
    content: ''
  }
};

// 4. TEST QUERIES
const testQueries = [
  {
    query: "Help me debug this error",
    expected: ["search_collection", "search_portfolio", "debug"],
    category: "debugging"
  },
  {
    query: "Find a security analysis persona",
    expected: ["search_collection", "security", "search_portfolio"],
    category: "security"
  },
  {
    query: "Show me available personas",
    expected: ["list_elements", "personas"],
    category: "list"
  },
  {
    query: "I need a git workflow helper",
    expected: ["search_collection", "git", "install_collection_content"],
    category: "git"
  },
  {
    query: "Store this information for later",
    expected: ["create_element", "memories", "list_elements"],
    category: "memory"
  }
];

// ============= TEST IMPLEMENTATION =============

class CapabilityIndexComprehensiveTester {
  constructor() {
    this.results = [];
    this.testDir = path.join(__dirname, 'test-runs');
    this.resultsDir = path.join(__dirname, 'results');
    this.sessionId = Date.now();
  }

  async setup() {
    fs.mkdirSync(this.testDir, { recursive: true });
    fs.mkdirSync(this.resultsDir, { recursive: true });
    fs.mkdirSync(path.join(this.testDir, `session_${this.sessionId}`), { recursive: true });
  }

  createTestConfiguration(indexType, claudeMdType, mcpType) {
    const testId = `${indexType}_${claudeMdType}_${mcpType}_${Date.now()}`;
    const testPath = path.join(this.testDir, `session_${this.sessionId}`, testId);
    fs.mkdirSync(testPath, { recursive: true });

    // Create CLAUDE.md with pre-prompt and index
    const claudeMdContent = `${claudeMdPrompts[claudeMdType].content}

## Capability Index

${indexStructures[indexType].content}
`;

    fs.writeFileSync(
      path.join(testPath, 'CLAUDE.md'),
      claudeMdContent
    );

    // Create MCP injection config
    const mcpConfig = {
      injection: mcpInjections[mcpType].content,
      strategy: mcpInjections[mcpType].strategy
    };

    fs.writeFileSync(
      path.join(testPath, 'mcp-config.json'),
      JSON.stringify(mcpConfig, null, 2)
    );

    return { testId, testPath };
  }

  async runDockerTest(testConfig, query) {
    const { testId, testPath } = testConfig;

    return new Promise((resolve) => {
      const startTime = Date.now();

      // Docker command to run Claude Code with DollhouseMCP
      const dockerCmd = spawn('docker', [
        'run',
        '--rm',
        '-v', `${testPath}:/workspace:ro`,
        '-v', `${testPath}/CLAUDE.md:/root/.claude/CLAUDE.md:ro`,
        '-e', 'DOLLHOUSE_TEST_MODE=true',
        'claude-mcp-test',
        '/bin/bash', '-c',
        `
        # Start DollhouseMCP server
        dollhousemcp-server &
        MCP_PID=$!

        # Wait for server to be ready
        sleep 2

        # Send query to Claude Code
        echo '${query.query}' | claude-code --capture-tokens

        # Kill MCP server
        kill $MCP_PID
        `
      ]);

      let output = '';
      let tokenCapture = '';

      dockerCmd.stdout.on('data', (data) => {
        output += data.toString();
        // Capture token generation stream
        if (data.toString().includes('TOKEN:')) {
          tokenCapture += data.toString();
        }
      });

      dockerCmd.stderr.on('data', (data) => {
        console.error(`[${testId}] stderr:`, data.toString());
      });

      dockerCmd.on('close', (code) => {
        const duration = Date.now() - startTime;

        // Parse response for element selection
        const selectedElements = this.parseSelection(output);
        const mentionsIndex = output.toLowerCase().includes('capability') &&
                             output.toLowerCase().includes('index');
        const usesIndex = this.detectIndexUsage(output, tokenCapture);

        // Check if correct element was selected
        const correct = query.expected.some(exp =>
          selectedElements.some(sel => sel.includes(exp))
        );

        resolve({
          testId,
          query: query.query,
          expected: query.expected,
          selected: selectedElements,
          correct,
          mentionsIndex,
          usesIndex,
          duration,
          tokenCount: this.countTokens(output),
          tokenPath: tokenCapture,
          fullOutput: output.substring(0, 1000) // First 1000 chars
        });
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        dockerCmd.kill();
        resolve({
          testId,
          error: 'Timeout',
          duration: 30000
        });
      }, 30000);
    });
  }

  parseSelection(output) {
    const selections = [];

    // Look for activate_element calls
    const activateMatches = output.matchAll(/activate_element.*?name.*?["']([^"']+)["']/g);
    for (const match of activateMatches) {
      selections.push(match[1]);
    }

    // Look for explicit mentions
    const mentionPatterns = [
      /I'll use ([a-z-]+)/gi,
      /activating ([a-z-]+)/gi,
      /selected: ([a-z-]+)/gi
    ];

    for (const pattern of mentionPatterns) {
      const matches = output.matchAll(pattern);
      for (const match of matches) {
        selections.push(match[1]);
      }
    }

    return selections;
  }

  detectIndexUsage(output, tokenCapture) {
    // Indicators that the index was actually used
    const indicators = [
      'checking the capability index',
      'according to the index',
      'the index suggests',
      'capability index maps',
      'CAPABILITY_INDEX',
      'cascade',
      '→'
    ];

    return indicators.some(ind =>
      output.toLowerCase().includes(ind.toLowerCase())
    );
  }

  countTokens(text) {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  async runAllTests() {
    console.log('🔬 Comprehensive Capability Index Testing');
    console.log('=========================================\n');

    await this.setup();

    const totalCombinations = Object.keys(indexStructures).length *
                             Object.keys(claudeMdPrompts).length *
                             Object.keys(mcpInjections).length;

    console.log(`Testing ${totalCombinations} combinations\n`);

    let testNum = 0;

    // Test all combinations
    for (const [indexType, indexConfig] of Object.entries(indexStructures)) {
      for (const [claudeMdType, claudeMdConfig] of Object.entries(claudeMdPrompts)) {
        for (const [mcpType, mcpConfig] of Object.entries(mcpInjections)) {
          testNum++;

          const combinationName = `${indexConfig.name} + ${claudeMdConfig.name} + ${mcpConfig.name}`;
          console.log(`\n[${testNum}/${totalCombinations}] ${combinationName}`);
          console.log('-'.repeat(60));

          const testConfig = this.createTestConfiguration(indexType, claudeMdType, mcpType);
          const combinationResults = [];

          for (const query of testQueries) {
            process.stdout.write(`  "${query.query.substring(0, 30)}..."... `);

            const result = await this.runDockerTest(testConfig, query);
            combinationResults.push(result);

            if (result.error) {
              console.log(`❌ ${result.error}`);
            } else if (result.correct) {
              console.log(`✅ ${result.selected[0] || 'none'} ${result.usesIndex ? '(via index)' : ''}`);
            } else {
              console.log(`❌ ${result.selected[0] || 'none'} (expected: ${query.expected[0]})`);
            }

            // Brief pause between tests
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          // Calculate metrics for this combination
          const metrics = this.calculateMetrics(combinationResults);

          this.results.push({
            combination: `${indexType}_${claudeMdType}_${mcpType}`,
            indexType,
            claudeMdType,
            mcpType,
            metrics,
            tests: combinationResults
          });

          console.log(`\n  Accuracy: ${metrics.accuracy.toFixed(1)}%`);
          console.log(`  Index Usage: ${metrics.indexUsageRate.toFixed(1)}%`);
          console.log(`  Avg Tokens: ${metrics.avgTokens.toFixed(0)}`);
        }
      }
    }

    this.generateReport();
  }

  calculateMetrics(results) {
    const correct = results.filter(r => r.correct && !r.error).length;
    const total = results.length;
    const usedIndex = results.filter(r => r.usesIndex).length;
    const mentionedIndex = results.filter(r => r.mentionsIndex).length;
    const avgTokens = results.reduce((sum, r) => sum + (r.tokenCount || 0), 0) / total;
    const avgDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0) / total;

    return {
      accuracy: (correct / total) * 100,
      correctCount: correct,
      totalCount: total,
      indexUsageRate: (usedIndex / total) * 100,
      indexMentionRate: (mentionedIndex / total) * 100,
      avgTokens,
      avgDuration
    };
  }

  generateReport() {
    console.log('\n\n' + '='.repeat(80));
    console.log('📊 COMPREHENSIVE TEST RESULTS');
    console.log('='.repeat(80));

    // Sort by accuracy
    const sorted = [...this.results].sort((a, b) =>
      b.metrics.accuracy - a.metrics.accuracy
    );

    console.log('\n🏆 TOP 10 CONFIGURATIONS:');
    console.log('-'.repeat(60));

    for (let i = 0; i < Math.min(10, sorted.length); i++) {
      const result = sorted[i];
      console.log(`\n${i + 1}. ${result.combination}`);
      console.log(`   Index: ${indexStructures[result.indexType].name}`);
      console.log(`   Pre-prompt: ${claudeMdPrompts[result.claudeMdType].name}`);
      console.log(`   MCP: ${mcpInjections[result.mcpType].name}`);
      console.log(`   Accuracy: ${result.metrics.accuracy.toFixed(1)}%`);
      console.log(`   Index Usage: ${result.metrics.indexUsageRate.toFixed(1)}%`);
      console.log(`   Tokens: ${result.metrics.avgTokens.toFixed(0)}`);
    }

    // Analyze effects of each variable
    console.log('\n\n📈 VARIABLE EFFECTS:');
    console.log('-'.repeat(60));

    // Index structure effect
    console.log('\nIndex Structure Impact:');
    for (const indexType of Object.keys(indexStructures)) {
      const relevantResults = this.results.filter(r => r.indexType === indexType);
      const avgAccuracy = relevantResults.reduce((sum, r) => sum + r.metrics.accuracy, 0) / relevantResults.length;
      const avgUsage = relevantResults.reduce((sum, r) => sum + r.metrics.indexUsageRate, 0) / relevantResults.length;
      console.log(`  ${indexStructures[indexType].name}: ${avgAccuracy.toFixed(1)}% accuracy, ${avgUsage.toFixed(1)}% usage`);
    }

    // Pre-prompt effect
    console.log('\nCLAUDE.md Pre-prompt Impact:');
    for (const claudeMdType of Object.keys(claudeMdPrompts)) {
      const relevantResults = this.results.filter(r => r.claudeMdType === claudeMdType);
      const avgAccuracy = relevantResults.reduce((sum, r) => sum + r.metrics.accuracy, 0) / relevantResults.length;
      const avgUsage = relevantResults.reduce((sum, r) => sum + r.metrics.indexUsageRate, 0) / relevantResults.length;
      console.log(`  ${claudeMdPrompts[claudeMdType].name}: ${avgAccuracy.toFixed(1)}% accuracy, ${avgUsage.toFixed(1)}% usage`);
    }

    // MCP injection effect
    console.log('\nMCP Injection Impact:');
    for (const mcpType of Object.keys(mcpInjections)) {
      const relevantResults = this.results.filter(r => r.mcpType === mcpType);
      const avgAccuracy = relevantResults.reduce((sum, r) => sum + r.metrics.accuracy, 0) / relevantResults.length;
      const avgUsage = relevantResults.reduce((sum, r) => sum + r.metrics.indexUsageRate, 0) / relevantResults.length;
      console.log(`  ${mcpInjections[mcpType].name}: ${avgAccuracy.toFixed(1)}% accuracy, ${avgUsage.toFixed(1)}% usage`);
    }

    // Save detailed results
    const filename = path.join(this.resultsDir, `comprehensive_${this.sessionId}.json`);
    fs.writeFileSync(filename, JSON.stringify({
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      totalCombinations: this.results.length,
      testQueries,
      results: this.results
    }, null, 2));

    console.log(`\n\n💾 Detailed results saved to: ${filename}`);

    // Key findings
    console.log('\n\n🔍 KEY FINDINGS:');
    console.log('-'.repeat(60));

    const bestConfig = sorted[0];
    console.log(`\nBest Configuration:`);
    console.log(`  ${bestConfig.combination}`);
    console.log(`  Achieves ${bestConfig.metrics.accuracy.toFixed(1)}% accuracy`);
    console.log(`  Uses index ${bestConfig.metrics.indexUsageRate.toFixed(1)}% of the time`);

    // Check if explicit instructions help
    const explicitResults = this.results.filter(r => r.claudeMdType === 'explicit');
    const noneResults = this.results.filter(r => r.claudeMdType === 'none');

    if (explicitResults.length && noneResults.length) {
      const explicitAvg = explicitResults.reduce((sum, r) => sum + r.metrics.accuracy, 0) / explicitResults.length;
      const noneAvg = noneResults.reduce((sum, r) => sum + r.metrics.accuracy, 0) / noneResults.length;
      const improvement = explicitAvg - noneAvg;

      console.log(`\nExplicit instructions improve accuracy by ${improvement.toFixed(1)}%`);
    }

    this.cleanup();
  }

  cleanup() {
    // Clean up test directories
    fs.rmSync(path.join(this.testDir, `session_${this.sessionId}`), { recursive: true, force: true });
  }
}

// Run the comprehensive test
const tester = new CapabilityIndexComprehensiveTester();
tester.runAllTests().catch(console.error);

export { CapabilityIndexComprehensiveTester };