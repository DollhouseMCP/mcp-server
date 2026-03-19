import { describe, it, expect } from '@jest/globals';
import {
  AgentSkillConverter,
  type AgentSkillStructure,
} from '../../src/converters/AgentSkillConverter.js';

function buildLargeAgentSkill(fileCount: number, bytesPerFile: number): AgentSkillStructure {
  const scripts: Record<string, string> = {};
  const references: Record<string, string> = {};
  const payload = 'x'.repeat(bytesPerFile);

  for (let idx = 0; idx < fileCount; idx += 1) {
    scripts[`script-${idx}.txt`] = payload;
    references[`ref-${idx}.md`] = `# Ref ${idx}\n\n${payload}`;
  }

  return {
    'SKILL.md': `---
name: perf-large-skill
description: Large conversion benchmark
---

Benchmark conversion behavior on large payloads.
`,
    'scripts/': scripts,
    'references/': references,
  };
}

describe('AgentSkillConverter Performance', () => {
  it('captures conversion metrics for large payloads', () => {
    const converter = new AgentSkillConverter();
    const largeSkill = buildLargeAgentSkill(400, 1024);

    const start = performance.now();
    const result = converter.convert({
      direction: 'agent_to_dollhouse',
      security_mode: 'warn',
      path_mode: 'safe',
      agent_skill: largeSkill,
    });
    const elapsedMs = performance.now() - start;

    expect(result.report.metrics).toBeDefined();
    expect((result.report.metrics?.inputTextBytes ?? 0) > 750_000).toBe(true);
    expect((result.report.metrics?.outputTextBytes ?? 0) > 750_000).toBe(true);
    expect((result.report.metrics?.durationMs ?? 0) > 0).toBe(true);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('keeps memory growth bounded across repeated large conversions', () => {
    const converter = new AgentSkillConverter();
    const largeSkill = buildLargeAgentSkill(300, 1024);
    const heapSamples: number[] = [];

    for (let run = 0; run < 12; run += 1) {
      const result = converter.convert({
        direction: 'agent_to_dollhouse',
        security_mode: 'warn',
        path_mode: 'safe',
        agent_skill: largeSkill,
      });
      heapSamples.push(result.report.metrics?.heapUsedBytes ?? 0);
    }

    const minHeap = Math.min(...heapSamples);
    const maxHeap = Math.max(...heapSamples);
    const heapSpread = maxHeap - minHeap;

    // Generous threshold to avoid flaky failures across environments.
    expect(heapSpread).toBeLessThan(256 * 1024 * 1024);
  });
});
