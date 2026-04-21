/**
 * Tests for ForkOnEditStrategy — fork-on-edit for shared elements.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ForkOnEditStrategy } from '../../../../src/collection/shared-pool/ForkOnEditStrategy.js';
import type { ForkContext } from '../../../../src/collection/shared-pool/ForkOnEditStrategy.js';
import type { IProvenanceStore } from '../../../../src/collection/shared-pool/IProvenanceStore.js';

describe('ForkOnEditStrategy', () => {
  let tmpDir: string;
  let sharedDir: string;
  let userDir: string;
  let mockStore: jest.Mocked<IProvenanceStore>;
  let strategy: ForkOnEditStrategy;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-edit-test-'));
    sharedDir = path.join(tmpDir, 'shared');
    userDir = path.join(tmpDir, 'user', 'portfolio', 'personas');

    await fs.mkdir(path.join(sharedDir, 'personas'), { recursive: true });
    await fs.mkdir(userDir, { recursive: true });

    mockStore = {
      lookup: jest.fn<IProvenanceStore['lookup']>(),
      findByElementId: jest.fn<IProvenanceStore['findByElementId']>(),
      save: jest.fn<IProvenanceStore['save']>().mockResolvedValue(undefined),
      update: jest.fn<IProvenanceStore['update']>().mockResolvedValue(undefined),
      listByOrigin: jest.fn<IProvenanceStore['listByOrigin']>(),
    };

    strategy = new ForkOnEditStrategy(mockStore, sharedDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeSharedElement(name: string): ForkContext {
    const filePath = path.join(sharedDir, 'personas', `${name}.md`);
    return {
      element: {
        metadata: { name },
        id: `shared-${name}`,
        getFilePath: () => filePath,
        rawContent: `---\nname: ${name}\n---\nShared content`,
      },
      elementType: 'personas',
      userElementDir: userDir,
    };
  }

  function makeUserElement(name: string): ForkContext {
    const filePath = path.join(userDir, `${name}.md`);
    return {
      element: {
        metadata: { name },
        id: `user-${name}`,
        getFilePath: () => filePath,
        rawContent: `---\nname: ${name}\n---\nUser content`,
      },
      elementType: 'personas',
      userElementDir: userDir,
    };
  }

  describe('evaluateAndFork — user-owned element', () => {
    it('returns forked: false for user-owned elements', async () => {
      const ctx = makeUserElement('my-persona');
      const result = await strategy.evaluateAndFork(ctx);

      expect(result.forked).toBe(false);
      expect(mockStore.save).not.toHaveBeenCalled();
    });

    it('returns forked: false when element has no file path', async () => {
      const ctx: ForkContext = {
        element: { metadata: { name: 'no-path' } },
        elementType: 'personas',
        userElementDir: userDir,
        };
      const result = await strategy.evaluateAndFork(ctx);
      expect(result.forked).toBe(false);
    });
  });

  describe('evaluateAndFork — shared element', () => {
    it('forks a shared element to the user portfolio', async () => {
      const ctx = makeSharedElement('code-reviewer');
      // Write the shared file so it can be read
      await fs.writeFile(
        path.join(sharedDir, 'personas', 'code-reviewer.md'),
        '---\nname: code-reviewer\n---\nShared content',
      );

      const result = await strategy.evaluateAndFork(ctx);

      expect(result.forked).toBe(true);
      if (result.forked) {
        expect(result.forkedElementPath).toBe(path.join(userDir, 'code-reviewer.md'));
        expect(result.originalElementId).toBe('shared-code-reviewer');
      }
    });

    it('copies content to the user portfolio directory', async () => {
      const ctx = makeSharedElement('tech-writer');

      const result = await strategy.evaluateAndFork(ctx);
      expect(result.forked).toBe(true);

      const forkedContent = await fs.readFile(path.join(userDir, 'tech-writer.md'), 'utf-8');
      expect(forkedContent).toContain('name: tech-writer');
      expect(forkedContent).toContain('Shared content');
    });

    it('saves a provenance record with origin=fork', async () => {
      const ctx = makeSharedElement('helper');

      await strategy.evaluateAndFork(ctx);

      expect(mockStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: 'fork',
          forkedFrom: 'shared-helper',
          elementId: 'personas/helper.md',
        }),
      );
    });

    it('provenance record has non-empty content hash', async () => {
      const ctx = makeSharedElement('hashed');

      await strategy.evaluateAndFork(ctx);

      const savedRecord = (mockStore.save as jest.Mock).mock.calls[0][0];
      expect(savedRecord.contentHash).toHaveLength(64);
      expect(savedRecord.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('uses rawContent from element when available', async () => {
      const ctx = makeSharedElement('from-memory');
      ctx.element.rawContent = '---\nname: from-memory\n---\nIn-memory content';

      const result = await strategy.evaluateAndFork(ctx);
      expect(result.forked).toBe(true);

      const forkedContent = await fs.readFile(path.join(userDir, 'from-memory.md'), 'utf-8');
      expect(forkedContent).toContain('In-memory content');
    });

    it('creates user directory if it does not exist', async () => {
      const deepUserDir = path.join(tmpDir, 'deep', 'nested', 'user', 'personas');
      const ctx = makeSharedElement('deep-fork');
      ctx.userElementDir = deepUserDir;

      const result = await strategy.evaluateAndFork(ctx);
      expect(result.forked).toBe(true);

      const exists = await fs.access(deepUserDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('falls back to update if provenance save fails (re-fork)', async () => {
      mockStore.save.mockRejectedValueOnce(new Error('already exists'));

      const ctx = makeSharedElement('re-fork');
      await strategy.evaluateAndFork(ctx);

      expect(mockStore.update).toHaveBeenCalled();
    });

    it('no .tmp files left behind', async () => {
      const ctx = makeSharedElement('clean');
      await strategy.evaluateAndFork(ctx);

      const files = await fs.readdir(userDir);
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('SYSTEM_USER_UUID', () => {
    it('exposes the well-known UUID for DB-mode callers', () => {
      expect(ForkOnEditStrategy.SYSTEM_USER_UUID).toBe('00000000-0000-0000-0000-000000000001');
    });
  });
});
