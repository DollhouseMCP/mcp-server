/**
 * Unit coverage for `persistElementViaFactory`, the shared storage-routing
 * helper used by ElementInstaller, PortfolioPullHandler, and
 * PortfolioSyncManager to honor DOLLHOUSE_STORAGE_BACKEND=database.
 *
 * Without this helper (or its predecessor inline branches), DB-mode
 * deployments saw installs/pulls/syncs land on the per-user portfolio
 * directory only — typically tmpfs in containerized deployments — so the
 * writes vanished on every restart.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { persistElementViaFactory } from '../../../src/storage/persistElementViaFactory.js';
import type { IStorageLayerFactory, FileStorageOptions } from '../../../src/storage/IStorageLayerFactory.js';
import type {
  IStorageLayer,
  IWritableStorageLayer,
} from '../../../src/storage/IStorageLayer.js';

function makeWritableLayer(): jest.Mocked<IWritableStorageLayer> {
  return {
    scan: jest.fn(),
    hasCompletedScan: jest.fn(() => true),
    notifySaved: jest.fn(),
    notifyDeleted: jest.fn(),
    invalidate: jest.fn(),
    clear: jest.fn(),
    writeContent: jest.fn(async () => '00000000-0000-0000-0000-000000000000'),
    deleteContent: jest.fn(),
    readContent: jest.fn(),
  } as unknown as jest.Mocked<IWritableStorageLayer>;
}

function makeReadOnlyLayer(): IStorageLayer {
  return {
    scan: jest.fn(),
    hasCompletedScan: jest.fn(() => true),
    notifySaved: jest.fn(),
    notifyDeleted: jest.fn(),
    invalidate: jest.fn(),
    clear: jest.fn(),
    // intentionally no writeContent — non-writable (filesystem backend mock)
  } as unknown as IStorageLayer;
}

const FILE_OPTIONS: FileStorageOptions = {
  elementDir: '/tmp/test-element-dir', // NOSONAR — opaque test fixture; factory mocked, no real fs writes
  fileExtension: '.md',
  scanCooldownMs: 0,
};

describe('persistElementViaFactory', () => {
  it('returns false when no factory is provided (caller falls back to filesystem)', async () => {
    const result = await persistElementViaFactory(
      undefined,
      'personas',
      'TestPersona',
      '---\nname: TestPersona\n---\nbody',
      FILE_OPTIONS,
    );
    expect(result).toBe(false);
  });

  it('returns false when the factory produces a non-writable layer (filesystem mode)', async () => {
    const factory: IStorageLayerFactory = {
      createForElement: jest.fn(() => makeReadOnlyLayer()),
    };
    const result = await persistElementViaFactory(
      factory,
      'personas',
      'TestPersona',
      '---\nname: TestPersona\n---\nbody',
      FILE_OPTIONS,
    );
    expect(result).toBe(false);
    expect(factory.createForElement).toHaveBeenCalledWith('personas', FILE_OPTIONS);
  });

  it('writes through the layer and returns true when factory produces a writable layer (DB mode)', async () => {
    const writableLayer = makeWritableLayer();
    const factory: IStorageLayerFactory = {
      createForElement: jest.fn(() => writableLayer),
    };
    const content = '---\nname: TestPersona\nauthor: alice\nversion: 1.0.0\n---\nbody';
    const result = await persistElementViaFactory(
      factory,
      'personas',
      'TestPersona',
      content,
      FILE_OPTIONS,
      { exclusive: true, elementLabel: 'Persona' },
    );
    expect(result).toBe(true);
    expect(writableLayer.writeContent).toHaveBeenCalledTimes(1);
    const [elementType, name, gotContent, _metadata, options] =
      writableLayer.writeContent.mock.calls[0];
    expect(elementType).toBe('personas');
    expect(name).toBe('TestPersona');
    expect(gotContent).toBe(content);
    expect(options?.exclusive).toBe(true);
    expect(options?.elementLabel).toBe('Persona');
  });

  it('propagates exceptions thrown by the storage layer (caller decides handling)', async () => {
    const writableLayer = makeWritableLayer();
    writableLayer.writeContent.mockRejectedValueOnce(new Error('boom'));
    const factory: IStorageLayerFactory = {
      createForElement: jest.fn(() => writableLayer),
    };
    await expect(
      persistElementViaFactory(
        factory,
        'personas',
        'TestPersona',
        '---\nname: TestPersona\n---\nbody',
        FILE_OPTIONS,
      ),
    ).rejects.toThrow('boom');
  });
});
