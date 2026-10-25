/**
 * LegacyDetectingPathResolver — chooses flat vs per-user layout by
 * inspecting disk state at startup.
 *
 * Detection rules:
 *   - Portfolio-root sentinel present → per-user on that root, even if
 *     legacy content later appears. A recorded anchor takes precedence.
 *   - Legacy root missing → per-user on the new portfolio root
 *     (fresh install).
 *   - Without either marker, regular per-user content and no legacy
 *     element content → recover per-user on the portfolio root.
 *   - Otherwise, legacy root present, migration marker file absent → flat on
 *     legacy root (single-user install, never migrated).
 *   - Legacy root present, migration marker file present → per-user
 *     on legacy root (migrated install; base stays at `~/.dollhouse/`
 *     but layout is per-user).
 *
 * The migration marker is a namespaced sentinel file
 * (`.dollhouse-per-user-migrated`) written by the flat-to-per-user
 * migration module when it completes successfully. This is more
 * robust than probing for a bare `users/` subdirectory — an unrelated
 * tool or user could create `users/` by hand, and silently flipping
 * the layout based on that would be a surprising one-way change.
 *
 * The detection runs once via the `detect()` factory and the resulting
 * resolver is a stable delegate for the rest of the process lifetime.
 * The resolver carries its `anchorRoot` so consumers (notably
 * `PathsServiceRegistrar`) can decide whether to use legacy-root mode
 * for app-internal paths without having to probe the delegate.
 *
 * **Removability:** this file is the detection adapter. To pin a specific
 * layout (e.g. tests), skip `detect()` and register the concrete resolver
 * (`FlatPathResolver` or `PerUserPathResolver`) directly with the DI
 * container. No other path code changes.
 *
 * @since Step 4.5
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';

import { BundledElementProbe } from './BundledElementProbe.js';
import { ElementType } from '../portfolio/types.js';
import { logger } from '../utils/logger.js';
import { FlatPathResolver } from './FlatPathResolver.js';
import { IUserPathResolver } from './IUserPathResolver.js';
import { PerUserPathResolver } from './PerUserPathResolver.js';

export type Layout = 'flat' | 'per-user';

/**
 * Namespaced sentinel file the flat-to-per-user migration writes at
 * the end of a successful migration. Presence of this file (combined
 * with an existing legacy root) is the signal to use per-user layout
 * on the legacy root.
 */
export const MIGRATION_MARKER_FILENAME = '.dollhouse-per-user-migrated';

/** Fresh-install decision, anchored here rather than on the legacy migration root. */
export const PORTFOLIO_LAYOUT_MARKER_FILENAME = '.dollhouse-per-user-layout';

export interface DetectOptions {
  /** Path to the legacy `~/.dollhouse/` directory. */
  legacyRoot: string;

  /** Path to the new portfolio root (e.g. `~/DollhouseMCP/`). */
  portfolioRoot: string;

  /**
   * For tests: override the probe that checks what kind of filesystem
   * entry (if any) exists at a given path. Production implementation
   * uses `fs.lstat` (does NOT follow symlinks) so a symlinked migration
   * marker cannot flip the layout decision. Returns `'dir'`, `'file'`,
   * or `'missing'`. Non-ENOENT errors rethrow so startup fails loudly
   * on permission-denied or filesystem errors.
   */
  probe?: (p: string) => Promise<'dir' | 'file' | 'other' | 'missing'>;
}

type Probe = NonNullable<DetectOptions['probe']>;

export class LegacyDetectingPathResolver implements IUserPathResolver {
  private constructor(
    private readonly delegate: IUserPathResolver,
    private readonly _anchorRoot: string,
    private readonly _layout: Layout,
    private readonly recordDecision = false,
  ) {}

  /**
   * Inspect disk state and build the appropriate delegate resolver.
   * Called once at startup by `PathsServiceRegistrar`.
   *
   * Uses `lstat` rather than `access` so a pre-planted symlink at the
   * marker-file path cannot flip a fresh install into per-user-on-
   * legacy mode. A non-regular portfolio record refuses startup.
   */
  static async detect(opts: DetectOptions): Promise<LegacyDetectingPathResolver> {
    const probe = opts.probe ?? defaultProbe;
    const bundled = new BundledElementProbe();
    const legacyRoot = path.resolve(opts.legacyRoot);
    const portfolioRoot = path.resolve(opts.portfolioRoot);

    // Reconcile before every unrecorded return: deciding servers publish before
    // creating legacy directories (PathsServiceRegistrar awaits persistence).
    // Older binaries/scripts creating legacy roots and recovery beside a running
    // old flat server remain outside this startup protocol.
    const recorded = async () => {
      const marker = path.join(portfolioRoot, PORTFOLIO_LAYOUT_MARKER_FILENAME);
      const kind = await probe(marker);
      if (kind === 'missing') return undefined;
      if (kind !== 'file') throw new Error(`Portfolio layout record must be a regular file: ${marker}`);
      if (portfolioRoot !== legacyRoot) await warnAboutLegacyContent(legacyRoot, bundled, probe);
      return new LegacyDetectingPathResolver(new PerUserPathResolver(portfolioRoot), portfolioRoot, 'per-user');
    };
    const existing = await recorded();
    if (existing) return existing;

    const legacyKind = await probe(legacyRoot);

    if (legacyKind !== 'dir' && legacyKind !== 'missing') {
      assertIndependentRoot(legacyRoot, portfolioRoot);
      if (await hasPerUserContent(portfolioRoot, bundled, probe)) {
        logger.info(`Recovered the per-user layout at ${portfolioRoot}; legacy root ${legacyRoot} was not followed.`);
        return new LegacyDetectingPathResolver(new PerUserPathResolver(portfolioRoot), portfolioRoot, 'per-user', true);
      }
    }
    assertLegacyKind(legacyKind, legacyRoot);
    if (legacyKind === 'missing') {
      assertIndependentRoot(legacyRoot, portfolioRoot);
      return new LegacyDetectingPathResolver(
        new PerUserPathResolver(portfolioRoot),
        portfolioRoot,
        'per-user',
        true,
      );
    }

    const markerKind = await probe(path.join(legacyRoot, MIGRATION_MARKER_FILENAME));
    if (markerKind === 'file') {
      // Legacy root exists AND the migration completed — use per-user
      // semantics anchored on the legacy root. A symlinked or missing
      // marker intentionally does not trigger this branch.
      // This layout belongs to legacyRoot; a record under portfolioRoot would anchor it incorrectly.
      return await recorded() ?? new LegacyDetectingPathResolver(
        new PerUserPathResolver(legacyRoot),
        legacyRoot,
        'per-user',
      );
    }

    if (await recoverPortfolioRoot(legacyRoot, portfolioRoot, bundled, probe)) {
      assertIndependentRoot(legacyRoot, portfolioRoot);
      logger.info(`Recovered the per-user layout at ${portfolioRoot}; ${legacyRoot} has no legacy element content.`);
      return new LegacyDetectingPathResolver(new PerUserPathResolver(portfolioRoot), portfolioRoot, 'per-user', true);
    }

    // Legacy root with no recorded or recoverable portfolio decision — stay flat.
    return await recorded() ?? new LegacyDetectingPathResolver(
      new FlatPathResolver(legacyRoot),
      legacyRoot,
      'flat',
    );
  }

  /** Commit a fresh or recovered decision before startup creates incidental legacy directories. */
  async persistLayoutDecision(): Promise<void> {
    if (!this.recordDecision) return;
    await fs.mkdir(this._anchorRoot, { recursive: true });
    const marker = path.join(this._anchorRoot, PORTFOLIO_LAYOUT_MARKER_FILENAME);
    try {
      // The empty regular file IS the decision: exclusive creation publishes it
      // atomically, with no partially written payload or replacement of existing entries.
      const handle = await fs.open(marker, 'wx', 0o600);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && await defaultProbe(marker) === 'file') return;
      // Refuse an unpersisted startup (including a symlink collision) rather than
      // serving one layout now and silently switching on the next launch.
      throw error;
    }
  }

  /**
   * The base directory this resolver is anchored on. In legacy-install
   * deployments this is `~/.dollhouse/` (or whatever `legacyRoot` was
   * detected as); in fresh installs it is `~/DollhouseMCP/`. Consumers
   * use this to decide whether `resolveDataDirectory` should operate in
   * legacy-root mode (for byte-identical back-compat) or
   * platform-correct mode.
   */
  getAnchorRoot(): string {
    return this._anchorRoot;
  }

  /** The detected layout shape. */
  getLayout(): Layout {
    return this._layout;
  }

  getUserPortfolioDir(userId: string): string {
    return this.delegate.getUserPortfolioDir(userId);
  }

  getUserElementDir(userId: string, type: ElementType): string {
    return this.delegate.getUserElementDir(userId, type);
  }

  getUserStateDir(userId: string): string {
    return this.delegate.getUserStateDir(userId);
  }

  getUserAuthDir(userId: string): string {
    return this.delegate.getUserAuthDir(userId);
  }

  getUserBackupsDir(userId: string): string {
    return this.delegate.getUserBackupsDir(userId);
  }

  getUserSecurityDir(userId: string): string {
    return this.delegate.getUserSecurityDir(userId);
  }
}

/**
 * Default probe. Uses `lstat` (does NOT follow symlinks) so pre-planted
 * symlinks cannot influence layout detection. Distinguishes `dir`,
 * `file`, `other`, and `missing`; rethrows on permission-denied or other I/O
 * errors so startup fails loudly rather than silently mis-classifying.
 */
async function defaultProbe(p: string): Promise<'dir' | 'file' | 'other' | 'missing'> {
  try {
    const stats = await fs.lstat(p);
    if (stats.isDirectory()) return 'dir';
    if (stats.isFile()) return 'file';
    // Distinguish existing links/devices from absence without following them.
    return 'other';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return 'missing';
    }
    throw err;
  }
}

/** Only element directories count; logs, run files and activation state are incidental. */
async function hasPortfolioContent(portfolio: string, bundled: BundledElementProbe, probe: Probe): Promise<boolean> {
  if (await probe(portfolio) !== 'dir') return false;
  for (const type of Object.values(ElementType)) {
    if (await containsElementFiles(path.join(portfolio, type), type, bundled, probe)) return true;
  }
  return false;
}

async function warnAboutLegacyContent(legacyRoot: string, bundled: BundledElementProbe, probe: Probe): Promise<void> {
  const portfolio = path.join(legacyRoot, 'portfolio');
  try {
    if (await probe(legacyRoot) === 'dir' && await hasPortfolioContent(portfolio, bundled, probe)) {
      logger.warn(`Ignoring legacy portfolio at ${portfolio}; the recorded per-user portfolio root takes precedence. Legacy files were not moved or merged.`);
    }
  } catch {
    logger.warn(`Could not inspect legacy portfolio at ${portfolio}; continuing with the recorded per-user layout.`);
  }
}

async function hasPerUserContent(portfolioRoot: string, bundled: BundledElementProbe, probe: Probe): Promise<boolean> {
  const users = path.join(portfolioRoot, 'users');
  if (await probe(portfolioRoot) !== 'dir' || await probe(users) !== 'dir') return false;
  for (const entry of await fs.readdir(users, { withFileTypes: true })) {
    if (!entry.name.startsWith('.') && entry.isDirectory() && await hasPortfolioContent(path.join(users, entry.name, 'portfolio'), bundled, probe)) return true;
  }
  return false;
}

async function recoverPortfolioRoot(legacyRoot: string, portfolioRoot: string, bundled: BundledElementProbe, probe: Probe): Promise<boolean> {
  if (!await hasPerUserContent(portfolioRoot, bundled, probe)) return false;
  const legacyPortfolio = path.join(legacyRoot, 'portfolio');
  if (await hasPortfolioContent(legacyPortfolio, bundled, probe)) {
    logger.warn(`Element content exists at both ${legacyPortfolio} and ${portfolioRoot}; keeping the legacy flat layout. No files were moved or merged.`);
    return false;
  }
  return true;
}

async function containsElementFiles(directory: string, elementType: string, bundled: BundledElementProbe, probe: Probe, elementRoot = directory): Promise<boolean> {
  if (await probe(directory) !== 'dir') return false;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isFile() && /\.(?:md|ya?ml)$/i.test(entry.name) && !await bundled.isBundled(file, elementType, path.relative(elementRoot, file))) return true;
    // Dirent.isDirectory() excludes symlinks, so linked subdirectories are not traversed.
    if (entry.isDirectory() && await containsElementFiles(file, elementType, bundled, probe, elementRoot)) return true;
  }
  return false;
}

function assertLegacyKind(kind: Awaited<ReturnType<Probe>>, root: string): void {
  if (kind !== 'dir' && kind !== 'missing') throw new Error(`Legacy root must be a directory, not a link or file: ${root}`);
}

function assertIndependentRoot(legacyRoot: string, portfolioRoot: string): void {
  const relative = path.relative(legacyRoot, portfolioRoot);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error(`Cannot record a fresh or recovered layout inside the legacy root: ${portfolioRoot}`);
  }
}
