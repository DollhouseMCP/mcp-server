/**
 * Verification test: Proves the storage layer reduces disk I/O.
 *
 * Demonstrates that list() only hits disk when files actually change,
 * and that listSummaries() avoids full element parsing entirely.
 */

import path from 'path';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import type { IStorageBackend } from '../../../src/storage/IStorageBackend.js';
import type { StorageItemMetadata } from '../../../src/storage/types.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';

function makeMeta(relPath: string, mtimeMs: number): StorageItemMetadata {
  return { relativePath: relPath, absolutePath: `/elements/${relPath}`, mtimeMs, sizeBytes: 256 };
}

function makeContent(name: string): string {
  return `---\nname: ${name}\ndescription: Description of ${name}\nversion: 1.0.0\nauthor: test\ntags:\n  - test\n---\n\n# ${name}\n\nInstructions for ${name}.`;
}

describe('Storage Layer I/O Reduction', () => {
  let backend: IStorageBackend;
  let layer: ElementStorageLayer;
  let callCounts: Record<string, number>;

  beforeEach(() => {
    callCounts = { listFiles: 0, statMany: 0, readFile: 0, directoryExists: 0 };

    backend = {
      listFiles: jest.fn<any>().mockImplementation(async () => {
        callCounts.listFiles++;
        return ['persona-a.md', 'persona-b.md', 'persona-c.md'];
      }),
      stat: jest.fn<any>().mockImplementation(async (absPath: string) => {
        return makeMeta(path.basename(absPath), 1000);
      }),
      statMany: jest.fn<any>().mockImplementation(async (_dir: string, paths: string[]) => {
        callCounts.statMany++;
        const map = new Map<string, StorageItemMetadata>();
        for (const p of paths) {
          map.set(p, makeMeta(p, 1000)); // stable mtime
        }
        return map;
      }),
      readFile: jest.fn<any>().mockImplementation(async (absPath: string) => {
        callCounts.readFile++;
        const name = path.basename(absPath, '.md');
        return makeContent(name);
      }),
      directoryExists: jest.fn<any>().mockImplementation(async () => {
        callCounts.directoryExists++;
        return true;
      }),
    };

    layer = new ElementStorageLayer({} as FileOperationsService, {
      elementDir: '/elements',
      fileExtension: '.md',
      scanCooldownMs: 100, // short cooldown for testing
      storageBackend: backend,
    });
  });

  it('first scan reads all files (cold start)', async () => {
    await layer.scan();

    expect(callCounts.listFiles).toBe(1);
    expect(callCounts.statMany).toBe(1);
    expect(callCounts.readFile).toBe(3); // one per file
    expect(callCounts.directoryExists).toBe(1);
  });

  it('second scan within cooldown does ZERO disk I/O', async () => {
    await layer.scan(); // cold start
    const before = { ...callCounts };

    await layer.scan(); // within cooldown

    // NO additional disk calls
    expect(callCounts.listFiles).toBe(before.listFiles);
    expect(callCounts.statMany).toBe(before.statMany);
    expect(callCounts.readFile).toBe(before.readFile);
    expect(callCounts.directoryExists).toBe(before.directoryExists);
  });

  it('scan after cooldown re-checks but skips unchanged files', async () => {
    await layer.scan(); // cold start
    const afterColdStart = { ...callCounts };

    // Wait for cooldown
    await new Promise(resolve => setTimeout(resolve, 120));

    await layer.scan(); // second scan — same mtimes

    // Did list + stat (to check mtimes) but NO readFile (nothing changed)
    expect(callCounts.listFiles).toBe(afterColdStart.listFiles + 1);
    expect(callCounts.statMany).toBe(afterColdStart.statMany + 1);
    expect(callCounts.readFile).toBe(afterColdStart.readFile); // ZERO additional reads!
  });

  it('only re-reads files whose mtime changed', async () => {
    await layer.scan(); // cold start: reads all 3 files
    expect(callCounts.readFile).toBe(3);

    await new Promise(resolve => setTimeout(resolve, 120));

    // Now persona-b has a new mtime (was modified)
    (backend.statMany as jest.Mock<any>).mockImplementation(async (_dir: string, paths: string[]) => {
      callCounts.statMany++;
      const map = new Map<string, StorageItemMetadata>();
      for (const p of paths) {
        const mtime = p === 'persona-b.md' ? 9999 : 1000; // only b changed
        map.set(p, makeMeta(p, mtime));
      }
      return map;
    });

    await layer.scan();

    // Only persona-b was re-read (1 additional read, not 3)
    expect(callCounts.readFile).toBe(4); // 3 from cold start + 1 for modified file
  });

  it('listSummaries returns metadata without loading full elements', async () => {
    const summaries = await layer.listSummaries();

    expect(summaries).toHaveLength(3);
    expect(summaries.map(s => s.name).sort()).toEqual(['persona-a', 'persona-b', 'persona-c']);

    // Verify each summary has the expected metadata
    for (const s of summaries) {
      expect(s.description).toContain('Description of');
      expect(s.version).toBe('1.0.0');
      expect(s.tags).toEqual(['test']);
    }

    // Key insight: readFile was called 3 times (for frontmatter extraction)
    // but NO full element parsing/construction happened — that's the savings
    expect(callCounts.readFile).toBe(3);
  });

  it('getPathByName provides O(1) lookup after scan', async () => {
    await layer.scan();
    const readsBefore = callCounts.readFile;

    // O(1) lookups — no disk I/O at all
    expect(layer.getPathByName('persona-a')).toBe('persona-a.md');
    expect(layer.getPathByName('persona-b')).toBe('persona-b.md');
    expect(layer.getPathByName('PERSONA-C')).toBe('persona-c.md'); // case-insensitive

    // Zero additional reads
    expect(callCounts.readFile).toBe(readsBefore);
  });

  it('notifySaved updates index without full rescan', async () => {
    await layer.scan();
    const scanCalls = callCounts.listFiles;

    // Simulate save notification
    (backend.stat as jest.Mock<any>).mockResolvedValue(makeMeta('new-element.md', 5000));
    (backend.readFile as jest.Mock<any>).mockResolvedValue(makeContent('New Element'));

    await layer.notifySaved('new-element.md', '/elements/new-element.md');

    // Index updated without a full rescan
    expect(layer.getPathByName('New Element')).toBe('new-element.md');
    expect(callCounts.listFiles).toBe(scanCalls); // no additional listFiles call
  });
});
