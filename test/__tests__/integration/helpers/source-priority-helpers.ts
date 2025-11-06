/**
 * Test helpers for element source priority integration tests
 *
 * Provides utilities for:
 * - Creating test elements in different sources (local, GitHub, collection)
 * - Mocking GitHub and collection APIs
 * - Configuring source priority settings
 * - Simulating source failures
 * - Test environment setup and cleanup
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementSource, SourcePriorityConfig, DEFAULT_SOURCE_PRIORITY } from '../../../../src/config/sourcePriority.js';
import { createTempDir } from './file-utils.js';

/**
 * Test element data structure
 */
export interface TestElement {
  name: string;
  description: string;
  version: string;
  elementType: ElementType;
  content?: string;
  author?: string;
  category?: string;
  tags?: string[];
}

/**
 * Create element content in markdown format with frontmatter
 */
export function createElementContent(element: TestElement): string {
  const { name, description, version, content = 'Test content', author = 'Test Author', category, tags } = element;

  const frontmatter: any = {
    name,
    description,
    version,
    author,
  };

  if (category) {
    frontmatter.category = category;
  }

  if (tags && tags.length > 0) {
    frontmatter.tags = tags;
  }

  const frontmatterYaml = Object.entries(frontmatter)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}:\n${value.map(v => `  - ${v}`).join('\n')}`;
      }
      return `${key}: ${value}`;
    })
    .join('\n');

  return `---
${frontmatterYaml}
---

${content}`;
}

/**
 * Generate filename from element name
 */
export function elementNameToFilename(name: string, elementType: ElementType): string {
  const baseName = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const extension = '.md';
  return `${baseName}${extension}`;
}

/**
 * Get element type directory name
 */
export function getElementTypeDir(elementType: ElementType): string {
  return elementType;
}

/**
 * Create a test element in local portfolio
 */
export async function createLocalElement(
  portfolioDir: string,
  element: TestElement
): Promise<string> {
  const typeDir = path.join(portfolioDir, getElementTypeDir(element.elementType));
  await fs.mkdir(typeDir, { recursive: true });

  const filename = elementNameToFilename(element.name, element.elementType);
  const filePath = path.join(typeDir, filename);
  const content = createElementContent(element);

  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Create multiple local elements
 */
export async function createLocalElements(
  portfolioDir: string,
  elements: TestElement[]
): Promise<string[]> {
  return Promise.all(elements.map(el => createLocalElement(portfolioDir, el)));
}

/**
 * Check if element exists in local portfolio
 */
export async function localElementExists(
  portfolioDir: string,
  name: string,
  elementType: ElementType
): Promise<boolean> {
  const filename = elementNameToFilename(name, elementType);
  const filePath = path.join(portfolioDir, getElementTypeDir(elementType), filename);

  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get element content from local portfolio
 */
export async function getLocalElementContent(
  portfolioDir: string,
  name: string,
  elementType: ElementType
): Promise<string | null> {
  const filename = elementNameToFilename(name, elementType);
  const filePath = path.join(portfolioDir, getElementTypeDir(elementType), filename);

  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Delete element from local portfolio
 */
export async function deleteLocalElement(
  portfolioDir: string,
  name: string,
  elementType: ElementType
): Promise<void> {
  const filename = elementNameToFilename(name, elementType);
  const filePath = path.join(portfolioDir, getElementTypeDir(elementType), filename);

  try {
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist, that's fine
  }
}

/**
 * Mock SHA counter for deterministic test data
 * FIX: Replaced Math.random() with counter to prevent weak cryptography warning (SonarCloud S2245)
 * Safe for test mocks - not used for security purposes
 */
let mockShaCounter = 0;

/**
 * Generate deterministic mock SHA for testing
 * @returns Mock SHA string with incrementing counter
 */
function generateMockSha(prefix: string = 'mock-sha'): string {
  return `${prefix}-${++mockShaCounter}`;
}

/**
 * Mock GitHub API response for element content
 */
export interface MockGitHubElement {
  name: string;
  path: string;
  content: string;
  sha: string;
  size: number;
  type: 'file';
  download_url: string;
  html_url: string;
}

/**
 * Create mock GitHub element response
 */
export function createMockGitHubElement(element: TestElement): MockGitHubElement {
  const content = createElementContent(element);
  const encodedContent = Buffer.from(content).toString('base64');
  const filename = elementNameToFilename(element.name, element.elementType);
  const elementPath = `${getElementTypeDir(element.elementType)}/${filename}`;

  return {
    name: filename,
    path: elementPath,
    content: encodedContent,
    sha: generateMockSha('mock-sha'),
    size: content.length,
    type: 'file',
    download_url: `https://raw.githubusercontent.com/test/portfolio/main/${elementPath}`,
    html_url: `https://github.com/test/portfolio/blob/main/${elementPath}`
  };
}

/**
 * Mock collection API response for element
 */
export interface MockCollectionElement {
  path: string;
  name: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string;
  type: 'file';
  content?: string;
  encoding?: 'base64';
}

/**
 * Create mock collection element response
 */
export function createMockCollectionElement(element: TestElement, collectionPath: string): MockCollectionElement {
  const content = createElementContent(element);
  const encodedContent = Buffer.from(content).toString('base64');

  return {
    path: collectionPath,
    name: elementNameToFilename(element.name, element.elementType),
    sha: generateMockSha('mock-collection-sha'),
    size: content.length,
    url: `https://api.github.com/repos/DollhouseMCP/collection/contents/${collectionPath}`,
    html_url: `https://github.com/DollhouseMCP/collection/blob/main/${collectionPath}`,
    git_url: `https://api.github.com/repos/DollhouseMCP/collection/git/blobs/mock-sha`,
    download_url: `https://raw.githubusercontent.com/DollhouseMCP/collection/main/${collectionPath}`,
    type: 'file',
    content: encodedContent,
    encoding: 'base64'
  };
}

/**
 * Setup test environment with temporary directories
 */
export async function setupSourcePriorityTestEnv(): Promise<{
  portfolioDir: string;
  tempDir: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await createTempDir('source-priority-test');
  const portfolioDir = path.join(tempDir, 'portfolio');
  await fs.mkdir(portfolioDir, { recursive: true });

  // Create element type directories
  for (const type of ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles']) {
    await fs.mkdir(path.join(portfolioDir, type), { recursive: true });
  }

  const cleanup = async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Cleanup failed, but don't fail the test
      console.warn('Failed to cleanup test directory:', error);
    }
  };

  return { portfolioDir, tempDir, cleanup };
}

/**
 * Configure source priority for testing
 */
export function setTestSourcePriority(config: Partial<SourcePriorityConfig>): void {
  const fullConfig: SourcePriorityConfig = {
    ...DEFAULT_SOURCE_PRIORITY,
    ...config
  };

  // Set environment variable for testing
  process.env.SOURCE_PRIORITY = JSON.stringify(fullConfig);
}

/**
 * Reset source priority to defaults
 */
export function resetSourcePriority(): void {
  delete process.env.SOURCE_PRIORITY;
}

/**
 * Create test source priority config
 */
export function createTestSourcePriorityConfig(
  priority: ElementSource[],
  options: {
    stopOnFirst?: boolean;
    checkAllForUpdates?: boolean;
    fallbackOnError?: boolean;
  } = {}
): SourcePriorityConfig {
  return {
    priority,
    stopOnFirst: options.stopOnFirst ?? true,
    checkAllForUpdates: options.checkAllForUpdates ?? false,
    fallbackOnError: options.fallbackOnError ?? true
  };
}

/**
 * Simulate network failure for testing fallback behavior
 */
export class NetworkFailureSimulator {
  private failedSources: Set<ElementSource> = new Set();

  /**
   * Mark a source as failing
   */
  failSource(source: ElementSource): void {
    this.failedSources.add(source);
  }

  /**
   * Mark a source as working
   */
  unfailSource(source: ElementSource): void {
    this.failedSources.delete(source);
  }

  /**
   * Check if a source should fail
   */
  shouldFail(source: ElementSource): boolean {
    return this.failedSources.has(source);
  }

  /**
   * Reset all failures
   */
  reset(): void {
    this.failedSources.clear();
  }
}

/**
 * Wait for async operation with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await condition();
    if (result) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Sample test elements for common test scenarios
 */
export const TEST_ELEMENTS = {
  persona1: {
    name: 'Test Creative Writer',
    description: 'A creative writing assistant for testing',
    version: '1.0.0',
    elementType: 'personas' as ElementType,
    content: 'You are a creative writing assistant. Help users with writing tasks.',
    category: 'creative',
    tags: ['writing', 'creative', 'test']
  },
  persona2: {
    name: 'Test Technical Expert',
    description: 'A technical expert for testing',
    version: '1.0.0',
    elementType: 'personas' as ElementType,
    content: 'You are a technical expert. Help users with technical problems.',
    category: 'professional',
    tags: ['technical', 'expert', 'test']
  },
  skill1: {
    name: 'Test Code Review',
    description: 'A code review skill for testing',
    version: '1.0.0',
    elementType: 'skills' as ElementType,
    content: 'Perform comprehensive code reviews following best practices.',
    tags: ['code-review', 'testing', 'quality']
  },
  skill2: {
    name: 'Test Documentation',
    description: 'A documentation skill for testing',
    version: '1.0.0',
    elementType: 'skills' as ElementType,
    content: 'Create comprehensive documentation for code projects.',
    tags: ['documentation', 'testing', 'writing']
  }
};
