import { mkdtemp, mkdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import { DollhouseContainer } from '../../src/di/Container.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';

export interface IntegrationContainerOptions {
  /**
   * Base directory to use for the portfolio. When omitted, a unique temporary
   * directory under the system temp folder is created automatically.
   */
  portfolioDir?: string;
  /**
   * Optional override for HOME environment variable. When omitted, a derived
   * home directory based on the portfolio path (or temp directory) is used.
   */
  homeDir?: string;
  /**
   * Controls whether the PortfolioManager should be initialised automatically.
   * Defaults to true.
   */
  initializePortfolio?: boolean;
}

export interface IntegrationContainer {
  container: DollhouseContainer;
  portfolioManager: PortfolioManager;
  portfolioDir: string;
  /**
   * Dispose of the container and clean up any temporary directories that were created.
   */
  dispose: () => Promise<void>;
}

/**
 * Creates an integration-focused DI container with an isolated portfolio directory.
 * Ensures that the PortfolioManager and related services operate against a dedicated
 * temporary directory, preventing cross-test bleed.
 */
/**
 * Lightweight container factory for unit tests that mock portfolio behavior.
 *
 * Points the DI container at an empty temp directory so that service
 * resolution (PortfolioManager, MigrationManager, etc.) doesn't scan
 * the user's real portfolio. Does NOT initialize the portfolio —
 * tests are expected to mock preparePortfolio() internals.
 *
 * Returns a container and a cleanup function that restores env vars
 * and removes the temp directory.
 *
 * Can optionally seed element-type directories with fixture data via
 * the `seedElements` option, useful for prototyping new element types.
 *
 * @example
 * ```typescript
 * let env: IsolatedContainer;
 * beforeEach(async () => { env = await createIsolatedContainer(); });
 * afterEach(async () => { await env.dispose(); });
 * ```
 */
export interface IsolatedContainerOptions {
  /** Seed element-type subdirectories under the portfolio root. */
  seedElements?: Record<string, string[]>;
}

export interface IsolatedContainer {
  container: DollhouseContainer;
  portfolioDir: string;
  dispose: () => Promise<void>;
}

export async function createIsolatedContainer(
  options: IsolatedContainerOptions = {}
): Promise<IsolatedContainer> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dollhouse-unit-'));
  const portfolioDir = path.join(tempRoot, '.dollhouse', 'portfolio');
  await mkdir(portfolioDir, { recursive: true });

  // Seed element-type directories if requested
  if (options.seedElements) {
    for (const [elementType, files] of Object.entries(options.seedElements)) {
      const typeDir = path.join(portfolioDir, elementType);
      await mkdir(typeDir, { recursive: true });
      for (const file of files) {
        // Create empty placeholder files — tests can write real content
        const { writeFile } = await import('fs/promises');
        await writeFile(path.join(typeDir, file), '');
      }
    }
  }

  const previousPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  const previousHome = process.env.HOME;
  const previousHomeDirEnv = process.env.DOLLHOUSE_HOME_DIR;

  process.env.DOLLHOUSE_PORTFOLIO_DIR = portfolioDir;
  process.env.HOME = tempRoot;
  process.env.DOLLHOUSE_HOME_DIR = tempRoot;

  const container = new DollhouseContainer();

  return {
    container,
    portfolioDir,
    dispose: async () => {
      await container.dispose();

      if (previousPortfolioDir === undefined) {
        delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
      } else {
        process.env.DOLLHOUSE_PORTFOLIO_DIR = previousPortfolioDir;
      }

      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      if (previousHomeDirEnv === undefined) {
        delete process.env.DOLLHOUSE_HOME_DIR;
      } else {
        process.env.DOLLHOUSE_HOME_DIR = previousHomeDirEnv;
      }

      await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}

export async function createIntegrationContainer(
  options: IntegrationContainerOptions = {}
): Promise<IntegrationContainer> {
  const shouldInit = options.initializePortfolio !== false;
  let tempRoot: string | null = null;

  const portfolioDir =
    options.portfolioDir ??
    (tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dollhouse-integration-')),
    path.join(tempRoot, '.dollhouse', 'portfolio'));

  await mkdir(portfolioDir, { recursive: true });

  const previousPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  process.env.DOLLHOUSE_PORTFOLIO_DIR = portfolioDir;

  const previousHome = process.env.HOME;
  const previousDollhouseHomeDir = process.env.DOLLHOUSE_HOME_DIR;
  const derivedHome = options.homeDir
    ?? (tempRoot ? tempRoot : path.resolve(portfolioDir, '..', '..'));
  if (derivedHome) {
    process.env.HOME = derivedHome;
    process.env.DOLLHOUSE_HOME_DIR = derivedHome;
  }

  const container = new DollhouseContainer();
  const portfolioManager = container.resolve<PortfolioManager>('PortfolioManager');

  if (shouldInit) {
    await portfolioManager.initialize();
  }

  return {
    container,
    portfolioManager,
    portfolioDir,
    dispose: async () => {
      await container.dispose();
      if (previousPortfolioDir === undefined) {
        delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
      } else {
        process.env.DOLLHOUSE_PORTFOLIO_DIR = previousPortfolioDir;
      }

      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      if (previousDollhouseHomeDir === undefined) {
        delete process.env.DOLLHOUSE_HOME_DIR;
      } else {
        process.env.DOLLHOUSE_HOME_DIR = previousDollhouseHomeDir;
      }

      if (tempRoot) {
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  };
}
