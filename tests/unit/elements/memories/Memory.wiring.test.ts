/**
 * Unit tests for Memory deferred wiring (Issue #1948).
 *
 * Verifies that Memory.setRootMemoryManager and MemoryManager.setRetentionPolicyService
 * are called during container preparePortfolio().
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Note: Do NOT mock SecurityMonitor — DollhouseContainer constructor instantiates it

const { Memory } = await import('../../../../src/elements/memories/Memory.js');
const { DollhouseContainer } = await import('../../../../src/di/Container.js');

describe('Memory deferred wiring (Issue #1948)', () => {
  let testDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    originalEnv = {
      DOLLHOUSE_PORTFOLIO_DIR: process.env.DOLLHOUSE_PORTFOLIO_DIR,
    };
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-wiring-test-'));
    // Create required subdirectories
    await fs.mkdir(path.join(testDir, 'memories'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'personas'), { recursive: true });
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Reset Memory static state for test isolation
    // Use internal access since resetResolvers is a no-op now
    (Memory as any)._rootMemoryManagerRef = undefined;
  });

  afterEach(async () => {
    process.env.DOLLHOUSE_PORTFOLIO_DIR = originalEnv.DOLLHOUSE_PORTFOLIO_DIR;
    (Memory as any)._rootMemoryManagerRef = undefined;
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should set root memory manager after preparePortfolio()', async () => {
    expect((Memory as any)._rootMemoryManagerRef).toBeUndefined();

    const container = new DollhouseContainer();
    await container.preparePortfolio();

    // After preparePortfolio, the root memory manager should be set
    expect((Memory as any)._rootMemoryManagerRef).toBeDefined();

    await container.dispose();
  });

  it('should wire retention policy service on MemoryManager after preparePortfolio()', async () => {
    const container = new DollhouseContainer();
    await container.preparePortfolio();

    // MemoryManager should have retention policy service set
    const memoryManager = container.resolve('MemoryManager') as any;
    expect(memoryManager._retentionPolicyService).toBeDefined();

    await container.dispose();
  });
});
