import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ElementInstaller } from '../../../src/collection/ElementInstaller.js';
import type { GitHubClient } from '../../../src/collection/GitHubClient.js';
import type { UnifiedIndexManager } from '../../../src/portfolio/UnifiedIndexManager.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';

const TEST_PORTFOLIO_DIR = path.join(os.tmpdir(), 'fetch-and-validate-portfolio');

const MARKDOWN_SKILL = `---
name: Code Review
description: Reviews pull requests
version: 1.2.0
author: dollhousemcp
tags:
  - review
  - code
---

# Code Review
Body instructions here.
`;

const MEMORY_YAML = `metadata:
  name: Welcome Guide
  description: Onboarding notes
  version: 1.0.0
entries:
  - id: e1
    content: hello world
    timestamp: 2026-01-01T00:00:00Z
`;

const ENSEMBLE_MARKDOWN = `---
name: Review Team
description: A code review ensemble
version: 1.0.0
---

# Review Team
Members and activation notes.
`;

// Stub a GitHub file response on a mocked client (shared across both suites).
function stubGithubFile(mockGitHubClient: jest.Mocked<GitHubClient>, text: string): void {
  mockGitHubClient.fetchFromGitHub.mockResolvedValue({
    type: 'file',
    size: Buffer.byteLength(text),
    content: Buffer.from(text, 'utf-8').toString('base64'),
  });
}

/**
 * Tests for the no-write ElementInstaller.fetchAndValidate seam used by the web
 * console to fetch + validate a collection element before routing the write
 * through its own backend-honest portfolio path.
 */
describe('ElementInstaller.fetchAndValidate', () => {
  let installer: ElementInstaller;
  let mockGitHubClient: jest.Mocked<GitHubClient>;

  beforeEach(() => {
    mockGitHubClient = { fetchFromGitHub: jest.fn() } as any;
    const mockPortfolioManager = { getElementDir: jest.fn(() => TEST_PORTFOLIO_DIR) } as any;
    installer = new ElementInstaller(mockGitHubClient, {
      portfolioManager: mockPortfolioManager,
      unifiedIndexManager: { search: jest.fn() } as unknown as UnifiedIndexManager,
      fileOperations: createTestFileOperationsService(),
    });
  });

  function githubFileResponse(text: string): void {
    stubGithubFile(mockGitHubClient, text);
  }

  it.each([
    ['library/personas/test-persona.md', ElementType.PERSONA, MARKDOWN_SKILL],
    ['library/skills/test-skill.md', ElementType.SKILL, MARKDOWN_SKILL],
    ['library/templates/test-template.md', ElementType.TEMPLATE, MARKDOWN_SKILL],
    ['library/agents/test-agent.md', ElementType.AGENT, MARKDOWN_SKILL],
    ['library/memories/test-memory.yaml', ElementType.MEMORY, MEMORY_YAML],
    ['library/ensembles/test-ensemble.md', ElementType.ENSEMBLE, ENSEMBLE_MARKDOWN],
  ] as const)('dispatches %s to the expected element type', async (collectionPath, expectedType, content) => {
    githubFileResponse(content);

    const result = await installer.fetchAndValidate(collectionPath);

    expect(result.elementType).toBe(expectedType);
  });

  it('fetches and validates a markdown skill, returning the frontmatter-stripped body', async () => {
    githubFileResponse(MARKDOWN_SKILL);
    const result = await installer.fetchAndValidate('library/skills/code-review.md');

    expect(result.elementType).toBe(ElementType.SKILL);
    expect(result.name).toBe('Code Review');
    expect(result.metadata.description).toBe('Reviews pull requests');
    expect(result.content).toContain('# Code Review');
    expect(result.content).not.toContain('name: Code Review'); // frontmatter stripped
  });

  it('fetches and validates a pure-YAML memory, returning the whole document', async () => {
    githubFileResponse(MEMORY_YAML);
    const result = await installer.fetchAndValidate('library/memories/welcome-guide.yaml');

    expect(result.elementType).toBe(ElementType.MEMORY);
    expect(result.name).toBe('Welcome Guide');
    expect(result.metadata.description).toBe('Onboarding notes');
    // Memories are written as a whole YAML document (the store parses entries).
    expect(result.content).toContain('entries:');
    expect(result.content).toContain('hello world');
  });

  it('accepts memory .yml extension', async () => {
    githubFileResponse(MEMORY_YAML);
    await expect(installer.fetchAndValidate('library/memories/welcome-guide.yml')).resolves.toMatchObject({
      elementType: ElementType.MEMORY,
    });
  });

  it('rejects a markdown extension for a memory type', async () => {
    githubFileResponse(MEMORY_YAML);
    await expect(installer.fetchAndValidate('library/memories/welcome-guide.md'))
      .rejects.toThrow(/Expected \.yaml/);
  });

  it('rejects a yaml extension for a markdown type', async () => {
    githubFileResponse(MARKDOWN_SKILL);
    await expect(installer.fetchAndValidate('library/skills/code-review.yaml'))
      .rejects.toThrow(/Expected \.md/);
  });

  it('rejects an unknown element type segment', async () => {
    await expect(installer.fetchAndValidate('library/gadgets/thing.md'))
      .rejects.toThrow(/Unknown element type/);
    expect(mockGitHubClient.fetchFromGitHub).not.toHaveBeenCalled();
  });

  it('rejects a non-library path', async () => {
    await expect(installer.fetchAndValidate('showcase/skills/thing.md'))
      .rejects.toThrow(/Invalid collection path format/);
    expect(mockGitHubClient.fetchFromGitHub).not.toHaveBeenCalled();
  });

  it('rejects a path-traversal path before any fetch', async () => {
    await expect(installer.fetchAndValidate('library/skills/../../../etc/passwd'))
      .rejects.toThrow();
    expect(mockGitHubClient.fetchFromGitHub).not.toHaveBeenCalled();
  });

  it('rejects content missing required name/description', async () => {
    githubFileResponse(`---\nversion: 1.0.0\n---\n\nbody\n`);
    await expect(installer.fetchAndValidate('library/skills/broken.md'))
      .rejects.toThrow(/missing required name or description/);
  });

  it('rejects a memory document missing required fields', async () => {
    githubFileResponse(`metadata:\n  version: 1.0.0\nentries: []\n`);
    await expect(installer.fetchAndValidate('library/memories/broken.yaml'))
      .rejects.toThrow(/missing required name or description/);
  });

  it('rejects a memory document whose name is not a string', async () => {
    // parseRawYaml yields `name: 2024` as a number; letting it escape typed as
    // string would TypeError deep in the portfolio store instead of 422ing.
    githubFileResponse(`metadata:\n  name: 2024\n  description: Year notes\nentries: []\n`);
    await expect(installer.fetchAndValidate('library/memories/year.yaml'))
      .rejects.toThrow(/missing required name or description/);
  });

  it('rejects a memory document whose description is not a string', async () => {
    githubFileResponse(`metadata:\n  name: Guide\n  description: true\nentries: []\n`);
    await expect(installer.fetchAndValidate('library/memories/guide.yaml'))
      .rejects.toThrow(/missing required name or description/);
  });

  it('propagates a not-found error from the GitHub client', async () => {
    mockGitHubClient.fetchFromGitHub.mockRejectedValue(new Error('File not found in collection. Try search.'));
    await expect(installer.fetchAndValidate('library/skills/missing.md'))
      .rejects.toThrow(/File not found in collection/);
  });

  it('rejects a response that is not a file', async () => {
    mockGitHubClient.fetchFromGitHub.mockResolvedValue({ type: 'dir' });
    await expect(installer.fetchAndValidate('library/skills/adir.md'))
      .rejects.toThrow(/does not point to a file/);
  });
});

/**
 * The MCP-tool install path (installContent -> installFromCollection) must
 * support the SAME six element types as the web-console seam — a catalog
 * element installable from the console but not from the MCP tools would make
 * the "all six types" claim false on one of its two surfaces.
 */
describe('ElementInstaller.installContent (all six element types)', () => {
  let installer: ElementInstaller;
  let mockGitHubClient: jest.Mocked<GitHubClient>;
  let portfolioDir: string;

  beforeEach(async () => {
    portfolioDir = await fs.mkdtemp(path.join(os.tmpdir(), 'install-content-'));
    mockGitHubClient = { fetchFromGitHub: jest.fn() } as any;
    const mockPortfolioManager = { getElementDir: jest.fn(() => portfolioDir) } as any;
    installer = new ElementInstaller(mockGitHubClient, {
      portfolioManager: mockPortfolioManager,
      unifiedIndexManager: { search: jest.fn() } as unknown as UnifiedIndexManager,
      fileOperations: createTestFileOperationsService(),
    });
  });

  afterEach(async () => {
    await fs.rm(portfolioDir, { recursive: true, force: true });
  });

  it('installs a pure-YAML memory with its .yaml filename', async () => {
    stubGithubFile(mockGitHubClient, MEMORY_YAML);
    const result = await installer.installContent('library/memories/welcome-guide.yaml');

    expect(result.success).toBe(true);
    expect(result.elementType).toBe(ElementType.MEMORY);
    expect(result.filename).toBe('welcome-guide.yaml');
    const written = await fs.readFile(path.join(portfolioDir, 'welcome-guide.yaml'), 'utf-8');
    expect(written).toContain('entries:');
    expect(written).toContain('hello world');
  });

  it('canonicalizes an accepted .yml memory install to discoverable .yaml storage', async () => {
    stubGithubFile(mockGitHubClient, MEMORY_YAML);
    const result = await installer.installContent('library/memories/welcome-guide.yml');

    expect(result.success).toBe(true);
    expect(result.filename).toBe('welcome-guide.yaml');
    await expect(fs.readFile(path.join(portfolioDir, 'welcome-guide.yaml'), 'utf-8'))
      .resolves.toContain('entries:');
    await expect(fs.access(path.join(portfolioDir, 'welcome-guide.yml')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('installs an ensemble through the markdown pipeline', async () => {
    stubGithubFile(mockGitHubClient, ENSEMBLE_MARKDOWN);
    const result = await installer.installContent('library/ensembles/review-team.md');

    expect(result.success).toBe(true);
    expect(result.elementType).toBe(ElementType.ENSEMBLE);
    expect(result.filename).toBe('review-team.md');
  });

  it('installs a markdown skill (regression: existing types still work)', async () => {
    stubGithubFile(mockGitHubClient, MARKDOWN_SKILL);
    const result = await installer.installContent('library/skills/code-review.md');

    expect(result.success).toBe(true);
    expect(result.elementType).toBe(ElementType.SKILL);
  });

  it('rejects a markdown extension for a memory type', async () => {
    stubGithubFile(mockGitHubClient, MEMORY_YAML);
    await expect(installer.installContent('library/memories/welcome-guide.md'))
      .rejects.toThrow(/Expected \.yaml/);
  });

  it('rejects a yaml extension for a markdown type', async () => {
    stubGithubFile(mockGitHubClient, MARKDOWN_SKILL);
    await expect(installer.installContent('library/ensembles/review-team.yaml'))
      .rejects.toThrow(/Expected \.md/);
  });

  it('still rejects an unknown element type segment', async () => {
    await expect(installer.installContent('library/gadgets/thing.md'))
      .rejects.toThrow(/Unknown element type/);
    expect(mockGitHubClient.fetchFromGitHub).not.toHaveBeenCalled();
  });
});
