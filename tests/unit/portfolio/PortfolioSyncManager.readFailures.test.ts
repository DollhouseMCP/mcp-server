import { describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PortfolioSyncManager } from '../../../src/portfolio/PortfolioSyncManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { ElementReadError } from '../../../src/elements/base/ElementReadError.js';
import { isContentRejection } from '../../../src/security/contentRejection.js';

const localPath = path.join(tmpdir(), 'sync-readable.md');
const content = '---\nname: readable\nversion: 1.0.0\n---\nHealthy definition content.';
const ioError = (code: string) => Object.assign(new Error(`Storage ${code}`), { code });

function fixture() {
  const files = {
    listDirectory: jest.fn(async () => ['readable.md']),
    readFile: jest.fn(async () => content),
    stat: jest.fn(async () => ({ mtime: new Date('2026-10-01') })),
    exists: jest.fn(async () => true), writeFile: jest.fn(),
  };
  const saveElement = jest.fn();
  const manager = new PortfolioSyncManager({
    configManager: { getConfig: () => ({ sync: { enabled: true, individual: { require_confirmation: false },
      bulk: { upload_enabled: true, require_preview: false }, privacy: { scan_for_secrets: false } } }) } as any,
    portfolioManager: { getElementPath: () => localPath, getElementDir: () => path.dirname(localPath) } as any,
    portfolioRepoManager: { saveElement, setToken: jest.fn() } as any,
    indexer: { getIndex: async () => ({ elements: new Map([[ElementType.SKILL,
      [{ name: 'readable', downloadUrl: 'https://example.invalid/readable.md' }]]]) }) } as any,
    fileOperations: files as any,
    tokenManager: { getGitHubTokenAsync: async () => 'test-token' } as any,
  });
  return { manager, files, saveElement };
}

describe('sync read failure distinctions', () => {
  it.each(['EACCES', 'EIO'])('refuses download before fetching or replacing unreadable local content (%s)', async code => {
    const { manager, files } = fixture();
    files.readFile.mockRejectedValue(ioError(code));
    const fetch = jest.spyOn(manager as any, 'fetchRemoteElementContent').mockResolvedValue(content);
    const persist = jest.spyOn(manager as any, 'persistDownloadedElement').mockResolvedValue(false);
    const result = await manager.handleSyncOperation({ operation: 'download', element_type: ElementType.SKILL,
      element_name: 'readable', confirm: true });
    expect(result.success).toBe(false);
    expect(result.message).toContain(code);
    expect(fetch).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  // Only ENOENT proves absence; a file where the directory should be (ENOTDIR) is a failed read.
  it.each(['ENOENT'])('treats a proven absent directory as empty (%s)', async code => {
    const { manager, files } = fixture();
    files.listDirectory.mockRejectedValue(ioError(code));
    const items: any[] = [];
    await manager['collectLocalElementsOfType'](ElementType.SKILL, items);
    expect(items).toEqual([]);
  });

  it.each(['EACCES', 'EIO', 'ENOTDIR'])('refuses failed directory discovery (%s)', async code => {
    const { manager, files } = fixture();
    files.listDirectory.mockRejectedValue(ioError(code));
    await expect(manager['collectLocalElementsOfType'](ElementType.SKILL, [])).rejects.toBeInstanceOf(ElementReadError);
  });

  it('returns absent local version only for a missing file', async () => {
    const { manager, files } = fixture();
    files.readFile.mockRejectedValue(ioError('ENOENT'));
    expect(await manager['loadLocalVersion'](localPath)).toEqual({ version: null, content: null });
  });

  it.each(['EACCES', 'EIO'])('refuses a failed local version read (%s)', async code => {
    const { manager, files } = fixture();
    files.readFile.mockRejectedValue(ioError(code));
    await expect(manager['loadLocalVersion'](localPath)).rejects.toBeInstanceOf(ElementReadError);
  });

  it('preserves marked parse rejection instead of absent metadata or version', async () => {
    const { manager, files } = fixture();
    const malformed = '---\nname: [unfinished\n---\n';
    files.readFile.mockResolvedValue(malformed);
    let refusal: unknown;
    try { manager['extractMetadata'](malformed); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(ElementReadError);
    expect(isContentRejection(refusal)).toBe(true);
    await expect(manager['loadLocalVersion'](localPath)).rejects.toBeInstanceOf(ElementReadError);
  });

  it.each(['ENOENT', 'EACCES', 'EIO'])('does not invent conflict modification time after stat failure (%s)', async code => {
    const { manager, files } = fixture();
    files.stat.mockRejectedValue(ioError(code));
    await expect(manager['buildConflictInfo']('readable', ElementType.SKILL, localPath, content,
      { version: '2.0.0', lastModified: '2026-10-02' } as any)).rejects.toBeInstanceOf(ElementReadError);
  });

  it.each(['compare', 'upload'] as const)('reports unreadable local content during %s without writing either side', async operation => {
    const { manager, files, saveElement } = fixture();
    files.readFile.mockRejectedValue(ioError('EIO'));
    const result = await manager.handleSyncOperation({ operation, element_type: ElementType.SKILL,
      element_name: 'readable', confirm: true });
    expect(result.success).toBe(false);
    expect(result.message).toContain('EIO');
    expect(result.message).not.toContain('not found');
    expect(saveElement).not.toHaveBeenCalled();
    expect(files.writeFile).not.toHaveBeenCalled();
  });
});
