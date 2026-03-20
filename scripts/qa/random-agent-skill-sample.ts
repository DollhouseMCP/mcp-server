import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  AgentSkillConverter,
  type AgentSkillStructure,
} from '../../src/converters/AgentSkillConverter.js';

type SampleResult = {
  skillDir: string;
  strictSafeStatus: 'ok' | 'blocked' | 'error';
  warnSafeStatus: 'ok' | 'error';
  roundtripStatus: 'ok' | 'error';
  warningCount: number;
  strictMessage?: string;
  errorMessage?: string;
};

const DEFAULT_ROOTS = [
  '/tmp/agent-skill-sources/github-copilot-for-azure/plugin/skills',
  '/tmp/agent-skill-sources/vercel-labs-skills/skills',
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.7z',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.bin',
  '.exe', '.dll', '.so', '.dylib',
]);

function parseArg(name: string): string | undefined {
  const index = process.argv.findIndex(arg => arg === name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function parseNumberArg(name: string, fallback: number): number {
  const value = parseArg(name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function makeRng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

async function collectSkillDirs(root: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) {
      results.push(current);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      stack.push(path.join(current, entry.name));
    }
  }

  return results;
}

async function readDirectoryFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const relPath = path.relative(root, absolutePath).replaceAll(path.sep, '/');
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        files[relPath] = `@binary-link ./${relPath}`;
        continue;
      }

      try {
        files[relPath] = await fs.readFile(absolutePath, 'utf8');
      } catch {
        files[relPath] = `@binary-link ./${relPath}`;
      }
    }
  }

  return files;
}

async function buildAgentSkill(skillDir: string): Promise<AgentSkillStructure> {
  const skillPath = path.join(skillDir, 'SKILL.md');
  const agentSkill: AgentSkillStructure = {
    'SKILL.md': await fs.readFile(skillPath, 'utf8'),
  };

  const entries = await fs.readdir(skillDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'SKILL.md' || entry.name.startsWith('.')) {
      continue;
    }
    const absolutePath = path.join(skillDir, entry.name);
    if (entry.isDirectory()) {
      agentSkill[`${entry.name}/`] = await readDirectoryFiles(absolutePath);
      continue;
    }
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        agentSkill[entry.name] = `@binary-link ./${entry.name}`;
      } else {
        agentSkill[entry.name] = await fs.readFile(absolutePath, 'utf8');
      }
    }
  }

  return agentSkill;
}

async function runSample(skillDir: string, converter: AgentSkillConverter): Promise<SampleResult> {
  const agentSkill = await buildAgentSkill(skillDir);
  let strictSafeStatus: SampleResult['strictSafeStatus'] = 'ok';
  let strictMessage: string | undefined;
  let warningCount = 0;

  try {
    converter.convert({
      direction: 'agent_to_dollhouse',
      path_mode: 'safe',
      security_mode: 'strict',
      agent_skill: agentSkill,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    strictSafeStatus = msg.includes('Strict security mode blocked conversion') ? 'blocked' : 'error';
    strictMessage = msg;
  }

  try {
    const toDollhouse = converter.convert({
      direction: 'agent_to_dollhouse',
      path_mode: 'safe',
      security_mode: 'warn',
      agent_skill: agentSkill,
    });
    warningCount = toDollhouse.report.warnings.length;

    const toAgent = converter.convert({
      direction: 'dollhouse_to_agent',
      path_mode: 'safe',
      dollhouse: toDollhouse.dollhouse,
      roundtrip_state: toDollhouse.roundtrip_state,
      prefer_roundtrip_state: true,
    });

    if (!toAgent.agent_skill || !toAgent.agent_skill['SKILL.md']) {
      return {
        skillDir,
        strictSafeStatus,
        warnSafeStatus: 'error',
        roundtripStatus: 'error',
        warningCount,
        strictMessage,
        errorMessage: 'Reverse conversion did not produce SKILL.md',
      };
    }

    return {
      skillDir,
      strictSafeStatus,
      warnSafeStatus: 'ok',
      roundtripStatus: 'ok',
      warningCount,
      strictMessage,
    };
  } catch (error) {
    return {
      skillDir,
      strictSafeStatus,
      warnSafeStatus: 'error',
      roundtripStatus: 'error',
      warningCount,
      strictMessage,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const rootsArg = parseArg('--roots');
  const sampleSize = parseNumberArg('--sample', 20);
  const seed = parseNumberArg('--seed', 20260307);
  const roots = (rootsArg ? rootsArg.split(',') : DEFAULT_ROOTS).map(item => item.trim()).filter(Boolean);

  const availableRoots: string[] = [];
  for (const root of roots) {
    if (await pathExists(root)) {
      availableRoots.push(root);
    }
  }

  if (availableRoots.length === 0) {
    console.error('No sample roots available. Pass --roots with at least one valid directory.');
    process.exit(1);
  }

  const allSkillDirs: string[] = [];
  for (const root of availableRoots) {
    const dirs = await collectSkillDirs(root);
    allSkillDirs.push(...dirs);
  }

  if (allSkillDirs.length === 0) {
    console.error('No SKILL.md directories found in provided roots.');
    process.exit(1);
  }

  const rng = makeRng(seed);
  const sampled = [...allSkillDirs]
    .sort((a, b) => a.localeCompare(b))
    .map(dir => ({ dir, score: rng() }))
    .sort((a, b) => a.score - b.score)
    .slice(0, Math.min(sampleSize, allSkillDirs.length))
    .map(item => item.dir);

  const converter = new AgentSkillConverter();
  const results: SampleResult[] = [];
  for (const skillDir of sampled) {
    results.push(await runSample(skillDir, converter));
  }

  const strictOk = results.filter(item => item.strictSafeStatus === 'ok').length;
  const strictBlocked = results.filter(item => item.strictSafeStatus === 'blocked').length;
  const strictError = results.filter(item => item.strictSafeStatus === 'error').length;
  const warnOk = results.filter(item => item.warnSafeStatus === 'ok').length;
  const warnError = results.filter(item => item.warnSafeStatus === 'error').length;
  const roundtripOk = results.filter(item => item.roundtripStatus === 'ok').length;
  const roundtripError = results.filter(item => item.roundtripStatus === 'error').length;
  const totalWarnings = results.reduce((sum, item) => sum + item.warningCount, 0);

  console.log(JSON.stringify({
    seed,
    sampleSizeRequested: sampleSize,
    sampleSizeActual: sampled.length,
    roots: availableRoots,
    totals: {
      strictOk,
      strictBlocked,
      strictError,
      warnOk,
      warnError,
      roundtripOk,
      roundtripError,
      totalWarnings,
      avgWarningsPerSample: Number((totalWarnings / sampled.length).toFixed(2)),
    },
    failures: results
      .filter(item => item.warnSafeStatus === 'error' || item.roundtripStatus === 'error' || item.strictSafeStatus === 'error')
      .map(item => ({
        skillDir: item.skillDir,
        strictSafeStatus: item.strictSafeStatus,
        warnSafeStatus: item.warnSafeStatus,
        roundtripStatus: item.roundtripStatus,
        strictMessage: item.strictMessage,
        errorMessage: item.errorMessage,
      })),
    strictBlocks: results
      .filter(item => item.strictSafeStatus === 'blocked')
      .map(item => ({
        skillDir: item.skillDir,
        strictMessage: item.strictMessage,
      })),
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
