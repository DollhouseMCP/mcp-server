#!/usr/bin/env node

/**
 * Capability Index Empirical Test
 * Uses existing DollhouseMCP Docker infrastructure
 * Tests different index structures with actual MCP server
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test variations as MCP elements
const variations = {
  'cascade-top': {
    name: 'Cascade at Top',
    hypothesis: 'Best performance - triggers in high attention zone',
    systemPrompt: `CAPABILITY_TRIGGERS:
  debug → debug-detective
  error → debug-detective
  git → git-manager
  issue → github-issue-creator

When a trigger matches, respond: "SELECTED: [capability-name]"`
  },

  'cascade-bottom': {
    name: 'Cascade at Bottom',
    hypothesis: 'Worse - triggers in low attention zone',
    systemPrompt: `You are an AI assistant. Help with requests.

[500 tokens of other context...]

CAPABILITY_TRIGGERS:
  debug → debug-detective
  error → debug-detective
  git → git-manager
  issue → github-issue-creator`
  },

  'nested': {
    name: 'Nested Structure',
    hypothesis: 'Poor - requires traversal',
    systemPrompt: `capabilities:
  development:
    debugging:
      debug-detective: ["debug", "error"]
    version_control:
      git-manager: ["git", "commit"]`
  },

  'flat': {
    name: 'Flat List',
    hypothesis: 'Moderate - simple but verbose',
    systemPrompt: `Available:
- debug-detective (debug, error)
- git-manager (git, commit)
- github-issue-creator (issue, github)

Select: "SELECTED: [name]"`
  },

  'action-verbs': {
    name: 'Action Verbs',
    hypothesis: 'Better - action language',
    systemPrompt: `ACTIONS:
  NEED_DEBUG → USE debug-detective
  NEED_COMMIT → USE git-manager
  CREATE_ISSUE → USE github-issue-creator`
  },

  'control': {
    name: 'Control (No Structure)',
    hypothesis: 'Worst - no guidance',
    systemPrompt: `Tools: debug-detective, git-manager, github-issue-creator`
  }
};

const testQueries = [
  { query: "Help me debug this error", expected: "debug-detective" },
  { query: "Fix this bug", expected: "debug-detective" },
  { query: "Create a git commit", expected: "git-manager" },
  { query: "Open a GitHub issue", expected: "github-issue-creator" },
  { query: "The app is crashing", expected: "debug-detective" }
];

class CapabilityIndexTester {
  constructor() {
    this.results = [];
    this.testDir = path.join(__dirname, '../test-temp/capability-index');
    this.resultsDir = path.join(__dirname, '../test/experiments/results');
  }

  async setup() {
    // Create test directories
    fs.mkdirSync(this.testDir, { recursive: true });
    fs.mkdirSync(this.resultsDir, { recursive: true });

    // Create test personas for each variation
    for (const [id, variation] of Object.entries(variations)) {
      const personaFile = path.join(this.testDir, `${id}.md`);
      const content = `---
name: Test Variation ${id}
type: persona
version: 1.0.0
---

# ${variation.name}

${variation.systemPrompt}`;

      fs.writeFileSync(personaFile, content);
    }
  }

  async runDockerTest(variationId, query) {
    return new Promise((resolve) => {
      const startTime = Date.now();

      // Build Docker command
      const dockerCmd = spawn('docker', [
        'run',
        '--rm',
        '-v', `${this.testDir}:/test-personas:ro`,
        '-e', 'DOLLHOUSE_TEST_MODE=true',
        '-e', `ACTIVE_PERSONA=${variationId}`,
        'dollhousemcp:latest',
        'node', '-e',
        `
        const { DollhouseMCPServer } = require('./dist');
        const server = new DollhouseMCPServer();

        // Load test variation
        server.loadPersona('/test-personas/${variationId}.md');

        // Send query
        const response = server.processQuery('${query.query}');

        // Extract selection
        const match = response.match(/SELECTED: ([\\w-]+)/);
        const selected = match ? match[1] : null;

        console.log(JSON.stringify({
          variation: '${variationId}',
          query: '${query.query}',
          selected: selected,
          expected: '${query.expected}',
          correct: selected === '${query.expected}'
        }));
        `
      ]);

      let output = '';

      dockerCmd.stdout.on('data', (data) => {
        output += data.toString();
      });

      dockerCmd.stderr.on('data', (data) => {
        console.error(`Docker stderr: ${data}`);
      });

      dockerCmd.on('close', (code) => {
        try {
          const result = JSON.parse(output.trim());
          result.duration = Date.now() - startTime;
          result.exitCode = code;
          resolve(result);
        } catch (e) {
          resolve({
            variation: variationId,
            error: 'Failed to parse output',
            output: output,
            duration: Date.now() - startTime,
            exitCode: code
          });
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        dockerCmd.kill();
        resolve({
          variation: variationId,
          error: 'Timeout',
          duration: 10000
        });
      }, 10000);
    });
  }

  async runAllTests() {
    console.log('🔬 Capability Index Docker Tests');
    console.log('================================\n');

    await this.setup();

    for (const [variationId, variation] of Object.entries(variations)) {
      console.log(`\nTesting: ${variation.name}`);
      console.log(`Hypothesis: ${variation.hypothesis}`);
      console.log('-'.repeat(50));

      const variationResults = [];
      let correct = 0;

      for (const query of testQueries) {
        process.stdout.write(`  "${query.query}"... `);

        const result = await this.runDockerTest(variationId, query);
        variationResults.push(result);

        if (result.correct) {
          correct++;
          console.log('✅');
        } else if (result.error) {
          console.log(`❌ (${result.error})`);
        } else {
          console.log(`❌ (got: ${result.selected})`);
        }

        // Brief pause between containers
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      const accuracy = (correct / testQueries.length) * 100;

      this.results.push({
        variation: variationId,
        name: variation.name,
        hypothesis: variation.hypothesis,
        accuracy: accuracy,
        correct: correct,
        total: testQueries.length,
        tests: variationResults
      });

      console.log(`\nAccuracy: ${accuracy.toFixed(1)}% (${correct}/${testQueries.length})`);
    }

    this.generateReport();
  }

  generateReport() {
    console.log('\n\n📊 EMPIRICAL RESULTS');
    console.log('='.repeat(60));

    // Sort by accuracy
    const sorted = [...this.results].sort((a, b) => b.accuracy - a.accuracy);

    for (let i = 0; i < sorted.length; i++) {
      const result = sorted[i];
      console.log(`\n${i + 1}. ${result.name}`);
      console.log(`   Accuracy: ${result.accuracy.toFixed(1)}%`);
      console.log(`   Hypothesis: ${result.hypothesis}`);

      if (i === 0) {
        console.log('   🏆 WINNER');
      }
    }

    // Calculate effects
    const cascadeTop = this.results.find(r => r.variation === 'cascade-top');
    const cascadeBottom = this.results.find(r => r.variation === 'cascade-bottom');

    if (cascadeTop && cascadeBottom) {
      const positionEffect = cascadeTop.accuracy - cascadeBottom.accuracy;
      console.log(`\n🎯 Position Effect: ${positionEffect.toFixed(1)}%`);
    }

    // Save results
    const timestamp = Date.now();
    const filename = path.join(this.resultsDir, `capability_index_${timestamp}.json`);
    fs.writeFileSync(filename, JSON.stringify(this.results, null, 2));

    console.log(`\n💾 Results saved to: ${filename}`);

    // Cleanup
    this.cleanup();
  }

  cleanup() {
    // Remove test personas
    fs.rmSync(this.testDir, { recursive: true, force: true });
  }
}

// Run tests
const tester = new CapabilityIndexTester();
tester.runAllTests().catch(console.error);

export { CapabilityIndexTester };