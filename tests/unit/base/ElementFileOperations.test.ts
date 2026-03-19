import { describe, it, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { ElementFileOperations } from '../../../src/elements/base/ElementFileOperations.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../../src/security/fileLockManager.js');
jest.mock('../../../src/security/securityMonitor.js');
jest.mock('../../../src/utils/logger.js');

describe('ElementFileOperations', () => {
  let tempDir: string;
  let fileOps: ElementFileOperations;
  let fileLockManager: FileLockManager;
  let readMock: jest.Mock<(filePath: string, options?: { encoding?: BufferEncoding }) => Promise<string | Buffer>>;
  let writeMock: jest.Mock<(filePath: string, content: string, options?: { encoding?: BufferEncoding }) => Promise<void>>;
  let securityEventMock: jest.Mock;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'element-file-ops-'));

    readMock = jest.fn<(filePath: string, options?: { encoding?: BufferEncoding }) => Promise<string | Buffer>>((filePath: string, options?: { encoding?: BufferEncoding }) =>
      fs.readFile(filePath, options)
    );
    writeMock = jest.fn<(filePath: string, content: string, options?: { encoding?: BufferEncoding }) => Promise<void>>((filePath: string, content: string, options?: { encoding?: BufferEncoding }) =>
      fs.writeFile(filePath, content, options)
    );
    securityEventMock = jest.fn();

    // Create a mock FileLockManager
    fileLockManager = new FileLockManager();
    fileLockManager.atomicReadFile = readMock as any;
    fileLockManager.atomicWriteFile = writeMock as any;

    // Create ElementFileOperations instance
    fileOps = new ElementFileOperations(fileLockManager);

    (SecurityMonitor as any).logSecurityEvent = securityEventMock;

    jest.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('readFileWithFrontmatter should parse metadata and content using sanitized path', async () => {
    const fileName = 'test.md';
    const filePath = 'test\x00.md';
    const fullPath = path.join(tempDir, fileName);
    const content = `---\nname: Sample\n---\n\nBody text`;

    await fs.writeFile(fullPath, content, 'utf-8');

    const result = await fileOps.readFileWithFrontmatter(filePath, tempDir);

    expect(result.metadata).toMatchObject({ name: 'Sample' });
    expect(result.content.trim()).toBe('Body text');
    expect(readMock).toHaveBeenCalledWith(fullPath, { encoding: 'utf-8' });
  });

  it('readFileWithFrontmatter should enforce maximum file size', async () => {
    const fullPath = path.join(tempDir, 'large.md');
    await fs.writeFile(fullPath, 'x'.repeat(20), 'utf-8');

    await expect(
      fileOps.readFileWithFrontmatter('large.md', tempDir, { maxSize: 10 })
    ).rejects.toThrow(/File too large/);
  });

  it('writeFileWithFrontmatter should sanitize path, create directories, and write frontmatter', async () => {
    const filePath = 'nested/test\x00.md';
    const metadata = { name: 'Test', description: undefined };
    const content = 'Hello world';

    await fileOps.writeFileWithFrontmatter(filePath, metadata, content, tempDir);

    const sanitizedPath = path.join(tempDir, 'nested', 'test.md');
    const written = await fs.readFile(sanitizedPath, 'utf-8');

    expect(written).toContain('name: Test');
    expect(written).toContain('Hello world');
    expect(written).not.toContain('description: undefined');
    expect(writeMock).toHaveBeenCalledWith(
      sanitizedPath,
      expect.any(String),
      { encoding: 'utf-8' }
    );
  });

  it('readFileWithFrontmatter should reject invalid paths', async () => {
    await expect(
      fileOps.readFileWithFrontmatter('../evil.md', tempDir)
    ).rejects.toThrow(/Invalid file path/);
  });

  it('validateAndResolvePath should reject traversal and log security event', () => {
    expect(() =>
      fileOps.validateAndResolvePath('../escape.md', tempDir)
    ).toThrow(/Path traversal/);

    expect(securityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PATH_TRAVERSAL_ATTEMPT'
      })
    );
  });

  it('generateFilename should slugify and append extension', () => {
    const filename = fileOps.generateFilename('My Fancy Name!');
    expect(filename).toBe('my-fancy-name.md');
  });

  it('fileExists should respect sanitized path and baseDir', async () => {
    const filePath = 'exists.md';
    await fs.writeFile(path.join(tempDir, filePath), 'content', 'utf-8');

    await expect(fileOps.fileExists(filePath, tempDir)).resolves.toBe(true);
    await expect(fileOps.fileExists('missing.md', tempDir)).resolves.toBe(false);
  });

  it('deleteFile should remove file and emit security event', async () => {
    const filePath = 'delete-me.md';
    const fullPath = path.join(tempDir, filePath);
    await fs.writeFile(fullPath, 'content', 'utf-8');

    await fileOps.deleteFile(filePath, tempDir);

    await expect(fs.access(fullPath)).rejects.toThrow();
    expect(securityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ELEMENT_DELETED',
        details: expect.stringContaining('delete-me.md')
      })
    );
  });

  it('listFiles should create directory and filter by extension when provided', async () => {
    await fs.mkdir(path.join(tempDir, 'files'));
    await fs.writeFile(path.join(tempDir, 'files', 'a.md'), 'a', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'files', 'b.txt'), 'b', 'utf-8');

    const all = await fileOps.listFiles(path.join(tempDir, 'files'));
    expect(all.sort()).toEqual(['a.md', 'b.txt']);

    const mdOnly = await fileOps.listFiles(path.join(tempDir, 'files'), '.md');
    expect(mdOnly).toEqual(['a.md']);
  });
});
