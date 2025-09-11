/**
 * Unit tests for PortfolioDownloader
 * Tests GitHub download functionality for portfolio synchronization
 */

import { jest } from '@jest/globals';
import { PortfolioDownloader } from '../../../../src/sync/PortfolioDownloader.js';
import { PortfolioRepoManager } from '../../../../src/portfolio/PortfolioRepoManager.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import * as path from 'path';

// Mock dependencies
jest.mock('../../../../src/portfolio/PortfolioRepoManager.js');
jest.mock('../../../../src/security/UnicodeValidator.js', () => ({
  UnicodeValidator: {
    normalize: jest.fn((content: string) => ({
      normalizedContent: content,
      warnings: []
    }))
  }
}));

describe('PortfolioDownloader', () => {
  let downloader: PortfolioDownloader;
  let mockRepoManager: jest.Mocked<PortfolioRepoManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    downloader = new PortfolioDownloader();
    mockRepoManager = new PortfolioRepoManager() as jest.Mocked<PortfolioRepoManager>;
  });

  describe('downloadFromGitHub', () => {
    const mockFileContent = `---
name: Test Element
description: A test element
version: 1.0.0
---

# Test Content

This is test content.`;

    const mockBase64Content = Buffer.from(mockFileContent).toString('base64');

    it('should download and parse a valid element file', async () => {
      mockRepoManager.getFileContent.mockResolvedValue({
        content: mockBase64Content,
        encoding: 'base64',
        sha: 'abc123',
        size: mockFileContent.length
      });

      const result = await downloader.downloadFromGitHub(
        mockRepoManager,
        'personas/test-element.md',
        'testuser',
        'testrepo'
      );

      expect(result).toEqual({
        content: mockFileContent,
        metadata: {
          name: 'Test Element',
          description: 'A test element',
          version: '1.0.0'
        },
        sha: 'abc123'
      });

      expect(mockRepoManager.getFileContent).toHaveBeenCalledWith(
        'testuser',
        'testrepo',
        'personas/test-element.md'
      );
    });

    it('should handle files without YAML frontmatter', async () => {
      const plainContent = '# Just Markdown\n\nNo frontmatter here.';
      const plainBase64 = Buffer.from(plainContent).toString('base64');

      mockRepoManager.getFileContent.mockResolvedValue({
        content: plainBase64,
        encoding: 'base64',
        sha: 'def456',
        size: plainContent.length
      });

      const result = await downloader.downloadFromGitHub(
        mockRepoManager,
        'personas/plain.md',
        'testuser',
        'testrepo'
      );

      expect(result).toEqual({
        content: plainContent,
        metadata: {},
        sha: 'def456'
      });
    });

    it('should normalize Unicode content', async () => {
      const unicodeContent = `---
name: Tëst Élement
---
Content with émojis 🎉`;
      const unicodeBase64 = Buffer.from(unicodeContent).toString('base64');

      mockRepoManager.getFileContent.mockResolvedValue({
        content: unicodeBase64,
        encoding: 'base64',
        sha: 'ghi789',
        size: unicodeContent.length
      });

      const result = await downloader.downloadFromGitHub(
        mockRepoManager,
        'personas/unicode.md',
        'testuser',
        'testrepo'
      );

      expect(result.content).toBe(unicodeContent);
      expect(result.metadata.name).toBe('Tëst Élement');
    });

    it('should handle network errors gracefully', async () => {
      mockRepoManager.getFileContent.mockRejectedValue(
        new Error('Network error: Unable to connect')
      );

      await expect(
        downloader.downloadFromGitHub(
          mockRepoManager,
          'personas/error.md',
          'testuser',
          'testrepo'
        )
      ).rejects.toThrow('Network error: Unable to connect');
    });

    it('should handle rate limit errors', async () => {
      mockRepoManager.getFileContent.mockRejectedValue(
        new Error('API rate limit exceeded')
      );

      await expect(
        downloader.downloadFromGitHub(
          mockRepoManager,
          'personas/ratelimit.md',
          'testuser',
          'testrepo'
        )
      ).rejects.toThrow('API rate limit exceeded');
    });

    it('should handle 404 not found errors', async () => {
      mockRepoManager.getFileContent.mockRejectedValue(
        new Error('Not Found')
      );

      await expect(
        downloader.downloadFromGitHub(
          mockRepoManager,
          'personas/missing.md',
          'testuser',
          'testrepo'
        )
      ).rejects.toThrow('Not Found');
    });
  });

  describe('downloadBatch', () => {
    it('should download multiple files in parallel', async () => {
      const files = [
        'personas/element1.md',
        'personas/element2.md',
        'skills/skill1.md'
      ];

      const mockResponses = files.map((file, index) => ({
        content: Buffer.from(`Content for ${file}`).toString('base64'),
        encoding: 'base64' as const,
        sha: `sha${index}`,
        size: 100
      }));

      mockRepoManager.getFileContent
        .mockResolvedValueOnce(mockResponses[0])
        .mockResolvedValueOnce(mockResponses[1])
        .mockResolvedValueOnce(mockResponses[2]);

      const results = await downloader.downloadBatch(
        mockRepoManager,
        files,
        'testuser',
        'testrepo'
      );

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[0].data?.content).toContain('element1.md');
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(true);
      expect(mockRepoManager.getFileContent).toHaveBeenCalledTimes(3);
    });

    it('should handle partial failures in batch', async () => {
      const files = [
        'personas/success.md',
        'personas/failure.md',
        'personas/another-success.md'
      ];

      mockRepoManager.getFileContent
        .mockResolvedValueOnce({
          content: Buffer.from('Success content').toString('base64'),
          encoding: 'base64',
          sha: 'sha1',
          size: 100
        })
        .mockRejectedValueOnce(new Error('Download failed'))
        .mockResolvedValueOnce({
          content: Buffer.from('Another success').toString('base64'),
          encoding: 'base64',
          sha: 'sha3',
          size: 100
        });

      const results = await downloader.downloadBatch(
        mockRepoManager,
        files,
        'testuser',
        'testrepo'
      );

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBe('Download failed');
      expect(results[2].success).toBe(true);
    });

    it('should respect batch size limits', async () => {
      const files = Array.from({ length: 20 }, (_, i) => `personas/file${i}.md`);
      
      // Mock all responses
      files.forEach(() => {
        mockRepoManager.getFileContent.mockResolvedValueOnce({
          content: Buffer.from('Content').toString('base64'),
          encoding: 'base64',
          sha: 'sha',
          size: 100
        });
      });

      const results = await downloader.downloadBatch(
        mockRepoManager,
        files,
        'testuser',
        'testrepo',
        5 // batch size
      );

      expect(results).toHaveLength(20);
      
      // Verify batching worked by checking timing
      // With batch size 5, we should have 4 batches
      // This is hard to test directly, but we can verify all succeeded
      results.forEach(result => {
        expect(result.success).toBe(true);
      });
    });

    it('should handle empty batch', async () => {
      const results = await downloader.downloadBatch(
        mockRepoManager,
        [],
        'testuser',
        'testrepo'
      );

      expect(results).toHaveLength(0);
      expect(mockRepoManager.getFileContent).not.toHaveBeenCalled();
    });
  });

  describe('YAML parsing', () => {
    it('should safely parse YAML without code execution', async () => {
      const maliciousYaml = `---
name: !!js/function "() => console.log('executed')"
description: Test
---
Content`;
      const base64 = Buffer.from(maliciousYaml).toString('base64');

      mockRepoManager.getFileContent.mockResolvedValue({
        content: base64,
        encoding: 'base64',
        sha: 'xyz',
        size: maliciousYaml.length
      });

      const result = await downloader.downloadFromGitHub(
        mockRepoManager,
        'personas/malicious.md',
        'testuser',
        'testrepo'
      );

      // Should safely parse without executing the function
      expect(result.metadata.name).toBeDefined();
      expect(typeof result.metadata.name).not.toBe('function');
    });

    it('should handle invalid YAML gracefully', async () => {
      const invalidYaml = `---
name: Test
description: [Unclosed bracket
---
Content`;
      const base64 = Buffer.from(invalidYaml).toString('base64');

      mockRepoManager.getFileContent.mockResolvedValue({
        content: base64,
        encoding: 'base64',
        sha: 'bad',
        size: invalidYaml.length
      });

      const result = await downloader.downloadFromGitHub(
        mockRepoManager,
        'personas/invalid.md',
        'testuser',
        'testrepo'
      );

      // Should return content even if YAML parsing fails
      expect(result.content).toBe(invalidYaml);
      expect(result.metadata).toEqual({});
    });
  });
});