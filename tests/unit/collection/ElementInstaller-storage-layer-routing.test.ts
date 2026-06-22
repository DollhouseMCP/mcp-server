/**
 * Regression: `install_collection_content` must route writes through the
 * injected IStorageLayerFactory in DB mode, NOT directly to the filesystem.
 *
 * Without this fix, collection installs in DB-mode deployments succeed at
 * the filesystem level (often on tmpfs in containerized deployments) but
 * never reach Postgres — installs vanish on every container restart.
 *
 * The fix branches on whether the wired IStorageLayerFactory produces a
 * writable (database-backed) layer for the element type. If it does,
 * writeContent() persists through the storage layer. If not (filesystem
 * mode or no factory wired), the legacy atomicWriteFile path is used.
 *
 * Caught live during Phase 4.5 PoC verification on 2026-05-12.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ElementInstaller } from '../../../src/collection/ElementInstaller.js';
import { GitHubClient } from '../../../src/collection/GitHubClient.js';
import { UnifiedIndexManager } from '../../../src/portfolio/UnifiedIndexManager.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
import type {
  IWritableStorageLayer,
  ElementWriteMetadata,
  WriteContentOptions,
} from '../../../src/storage/IStorageLayer.js';
import type { IStorageLayerFactory } from '../../../src/storage/IStorageLayerFactory.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';

describe('ElementInstaller — storage-layer routing in DB mode', () => {
  let installer: ElementInstaller;
  let mockGitHubClient: jest.Mocked<GitHubClient>;
  let mockUnifiedIndexManager: jest.Mocked<UnifiedIndexManager>;
  let mockStorageLayer: jest.Mocked<IWritableStorageLayer>;
  let mockStorageLayerFactory: IStorageLayerFactory;
  let testPortfolioDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };

    testPortfolioDir = path.join(os.tmpdir(), `installer-routing-${Date.now()}`);
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testPortfolioDir;
    await Promise.all([
      fs.mkdir(path.join(testPortfolioDir, 'personas'), { recursive: true }),
      fs.mkdir(path.join(testPortfolioDir, 'skills'), { recursive: true }),
    ]);

    mockGitHubClient = {
      fetchFromGitHub: jest.fn(),
    } as unknown as jest.Mocked<GitHubClient>;

    mockUnifiedIndexManager = {
      search: jest.fn(),
    } as unknown as jest.Mocked<UnifiedIndexManager>;

    // Writable storage layer mock — the smoking gun for "did the fix route
    // through this path or did it write to disk?". writeContent returns a
    // synthetic UUID like the real DatabaseStorageLayer does.
    mockStorageLayer = {
      // IStorageLayer surface (read-side stubs — not exercised here)
      scan: jest.fn(),
      hasCompletedScan: jest.fn(() => true),
      notifySaved: jest.fn(),
      notifyDeleted: jest.fn(),
      invalidate: jest.fn(),
      clear: jest.fn(),
      // IWritableStorageLayer surface — the bug fix's contract
      writeContent: jest.fn(
        async (
          _elementType: string,
          _name: string,
          _content: string,
          _metadata: ElementWriteMetadata,
          _options?: WriteContentOptions,
        ) => '00000000-0000-0000-0000-000000000001',
      ),
      deleteContent: jest.fn(),
      readContent: jest.fn(),
    } as unknown as jest.Mocked<IWritableStorageLayer>;

    mockStorageLayerFactory = {
      createForElement: jest.fn(() => mockStorageLayer),
    };

    const mockPortfolioManager = {
      getElementDir: jest.fn((elementType: ElementType) => {
        return path.join(testPortfolioDir, elementType);
      }),
    } as unknown as Parameters<typeof ElementInstaller.prototype.constructor>[1]['portfolioManager'];

    const fileOperationsService = createTestFileOperationsService();

    installer = new ElementInstaller(mockGitHubClient, {
      portfolioManager: mockPortfolioManager,
      unifiedIndexManager: mockUnifiedIndexManager,
      fileOperations: fileOperationsService,
      storageLayerFactory: mockStorageLayerFactory,
    });
  });

  afterEach(async () => {
    Object.assign(process.env, originalEnv);
    try {
      await fs.rm(testPortfolioDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('routes collection install through IWritableStorageLayer.writeContent when factory is wired (DB mode)', async () => {
    const collectionPath = 'library/personas/category/test-routed-persona.md';
    const personaBody = `---
name: "Test Routed Persona"
description: "Verifies install routes through the storage layer"
author: "test-author"
version: "1.0.0"
category: "test"
---
# Test Routed Persona

A persona for verifying that install_collection_content routes through the
injected IWritableStorageLayer in DB mode instead of writing to disk.`;

    mockGitHubClient.fetchFromGitHub.mockResolvedValueOnce({
      type: 'file',
      content: Buffer.from(personaBody).toString('base64'),
      size: personaBody.length,
    });

    const result = await installer.installContent(collectionPath);

    // Install reported success
    expect(result.success).toBe(true);

    // The factory produced a layer for the right element type
    expect(mockStorageLayerFactory.createForElement).toHaveBeenCalledWith(
      ElementType.PERSONA,
      expect.objectContaining({
        elementDir: path.join(testPortfolioDir, ElementType.PERSONA),
      }),
    );

    // writeContent was invoked with the validated content + metadata
    expect(mockStorageLayer.writeContent).toHaveBeenCalledTimes(1);
    const [elementType, name, content, metadata, options] =
      mockStorageLayer.writeContent.mock.calls[0];
    expect(elementType).toBe(ElementType.PERSONA);
    expect(name).toBe('Test Routed Persona');
    expect(content).toContain('A persona for verifying');
    expect(metadata).toEqual(
      expect.objectContaining({
        author: 'test-author',
        version: '1.0.0',
        description: 'Verifies install routes through the storage layer',
      }),
    );
    // Exclusive: true mirrors the legacy "fail if already exists" contract.
    expect(options?.exclusive).toBe(true);

    // Filesystem must NOT have been written to — the whole point of the fix.
    const personaFile = path.join(testPortfolioDir, 'personas', 'test-routed-persona.md');
    await expect(fs.access(personaFile)).rejects.toThrow();
  });

  it('falls back to filesystem write when no storage-layer factory is wired (filesystem mode)', async () => {
    const fileOperationsService = createTestFileOperationsService();
    const mockPortfolioManager = {
      getElementDir: jest.fn((elementType: ElementType) => path.join(testPortfolioDir, elementType)),
    } as unknown as Parameters<typeof ElementInstaller.prototype.constructor>[1]['portfolioManager'];

    const fsInstaller = new ElementInstaller(mockGitHubClient, {
      portfolioManager: mockPortfolioManager,
      unifiedIndexManager: mockUnifiedIndexManager,
      fileOperations: fileOperationsService,
      // intentionally no storageLayerFactory — filesystem mode
    });

    const collectionPath = 'library/personas/category/test-fs-persona.md';
    const personaBody = `---
name: "Test FS Persona"
description: "Verifies filesystem fallback when no factory wired"
author: "test-author"
version: "1.0.0"
category: "test"
---
# Test FS Persona`;

    mockGitHubClient.fetchFromGitHub.mockResolvedValueOnce({
      type: 'file',
      content: Buffer.from(personaBody).toString('base64'),
      size: personaBody.length,
    });

    const result = await fsInstaller.installContent(collectionPath);

    expect(result.success).toBe(true);

    // The new storage-layer was not reachable, so no factory call happened.
    // (mockStorageLayerFactory is local to the outer describe's installer —
    // the inner fsInstaller has no factory at all.)
    expect(mockStorageLayer.writeContent).not.toHaveBeenCalled();

    // Filesystem WAS written to — this is the legacy path that the fix
    // explicitly preserves for filesystem-mode operators.
    const personaFile = path.join(testPortfolioDir, 'personas', 'test-fs-persona.md');
    await expect(fs.access(personaFile)).resolves.toBeUndefined();
    const written = await fs.readFile(personaFile, 'utf-8');
    expect(written).toContain('Test FS Persona');
  });

  it('falls back to filesystem write when factory produces a non-writable layer', async () => {
    // Simulates a filesystem-backed factory that returns a non-IWritableStorageLayer.
    const nonWritableLayer = {
      scan: jest.fn(),
      hasCompletedScan: jest.fn(() => true),
      notifySaved: jest.fn(),
      notifyDeleted: jest.fn(),
      invalidate: jest.fn(),
      clear: jest.fn(),
      // intentionally no writeContent — so isWritableStorageLayer() returns false
    };
    const filesystemFactory: IStorageLayerFactory = {
      createForElement: jest.fn(() => nonWritableLayer as unknown as import('../../../src/storage/IStorageLayer.js').IStorageLayer),
    };

    const fileOperationsService = createTestFileOperationsService();
    const mockPortfolioManager = {
      getElementDir: jest.fn((elementType: ElementType) => path.join(testPortfolioDir, elementType)),
    } as unknown as Parameters<typeof ElementInstaller.prototype.constructor>[1]['portfolioManager'];

    const fsInstaller = new ElementInstaller(mockGitHubClient, {
      portfolioManager: mockPortfolioManager,
      unifiedIndexManager: mockUnifiedIndexManager,
      fileOperations: fileOperationsService,
      storageLayerFactory: filesystemFactory,
    });

    const collectionPath = 'library/personas/category/test-nonwritable-persona.md';
    const personaBody = `---
name: "Test NonWritable Persona"
description: "Verifies fallback when factory returns non-writable layer"
author: "test-author"
version: "1.0.0"
category: "test"
---
# Test NonWritable Persona`;

    mockGitHubClient.fetchFromGitHub.mockResolvedValueOnce({
      type: 'file',
      content: Buffer.from(personaBody).toString('base64'),
      size: personaBody.length,
    });

    const result = await fsInstaller.installContent(collectionPath);

    expect(result.success).toBe(true);

    // The factory was consulted but its layer was non-writable, so the
    // install fell through to the filesystem path.
    expect(filesystemFactory.createForElement).toHaveBeenCalled();
    const personaFile = path.join(testPortfolioDir, 'personas', 'test-nonwritable-persona.md');
    await expect(fs.access(personaFile)).resolves.toBeUndefined();
  });
});
