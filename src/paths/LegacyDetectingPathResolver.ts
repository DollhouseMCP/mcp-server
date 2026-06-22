/**
 * LegacyDetectingPathResolver — chooses flat vs per-user layout by
 * inspecting disk state at startup.
 *
 * Detection rules:
 *   - Legacy root missing → per-user on the new portfolio root
 *     (fresh install).
 *   - Legacy root present, migration marker file absent → flat on
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

import { ElementType } from '../portfolio/types.js';
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
  probe?: (p: string) => Promise<'dir' | 'file' | 'missing'>;
}

export class LegacyDetectingPathResolver implements IUserPathResolver {
  private constructor(
    private readonly delegate: IUserPathResolver,
    private readonly _anchorRoot: string,
    private readonly _layout: Layout,
  ) {}

  /**
   * Inspect disk state and build the appropriate delegate resolver.
   * Called once at startup by `PathsServiceRegistrar`.
   *
   * Uses `lstat` rather than `access` so a pre-planted symlink at the
   * marker-file path cannot flip a fresh install into per-user-on-
   * legacy mode. The marker must be a regular file; symlinks and other
   * entry types are ignored (treated as "not present").
   */
  static async detect(opts: DetectOptions): Promise<LegacyDetectingPathResolver> {
    const probe = opts.probe ?? defaultProbe;
    const legacyRoot = path.resolve(opts.legacyRoot);
    const portfolioRoot = path.resolve(opts.portfolioRoot);

    const legacyKind = await probe(legacyRoot);

    if (legacyKind !== 'dir') {
      // Fresh install (or legacy root is a symlink/file, which we do
      // not follow). Use new portfolio root with per-user layout.
      return new LegacyDetectingPathResolver(
        new PerUserPathResolver(portfolioRoot),
        portfolioRoot,
        'per-user',
      );
    }

    const markerKind = await probe(path.join(legacyRoot, MIGRATION_MARKER_FILENAME));
    if (markerKind === 'file') {
      // Legacy root exists AND the migration completed — use per-user
      // semantics anchored on the legacy root. A symlinked or missing
      // marker intentionally does not trigger this branch.
      return new LegacyDetectingPathResolver(
        new PerUserPathResolver(legacyRoot),
        legacyRoot,
        'per-user',
      );
    }

    // Legacy root, no migration marker — flat single-user layout.
    return new LegacyDetectingPathResolver(
      new FlatPathResolver(legacyRoot),
      legacyRoot,
      'flat',
    );
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
 * `file`, and `missing`; rethrows on permission-denied or other I/O
 * errors so startup fails loudly rather than silently mis-classifying.
 */
async function defaultProbe(p: string): Promise<'dir' | 'file' | 'missing'> {
  try {
    const stats = await fs.lstat(p);
    if (stats.isDirectory()) return 'dir';
    if (stats.isFile()) return 'file';
    // Symlinks, sockets, devices, etc. — treat as missing; we do not
    // follow them.
    return 'missing';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return 'missing';
    }
    throw err;
  }
}
