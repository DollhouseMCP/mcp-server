/**
 * PathService — the single DI-injectable entry point for all path
 * resolution in the server.
 *
 * Composes three distinct resolution backends behind a small facade:
 *   - `resolveDataDir`        → `resolveDataDirectory` (app-internal paths)
 *   - `getUserXxxDir`         → `IUserPathResolver` (per-user paths)
 *   - `resolvePackageResource` → `PackageResourceLocator` (package-internal)
 *
 * Callers pick the method matching their need; types enforce correctness.
 * Per-user methods accept an optional explicit `userId` — when omitted,
 * the service resolves the current user from the injected callback
 * (typically `ContextTracker.getSessionContext().userId`). Passing an
 * empty string is rejected as a call-site bug — the fallback applies
 * only when the argument is `undefined`.
 *
 * **Removability:** every consumer injects `PathService` via DI. To
 * replace the path infrastructure entirely, re-implement the facade
 * against a new backend triplet (resolver / per-user / locator) and
 * swap the registrar binding. No consumer changes needed.
 *
 * @since Step 4.5
 */

import { ElementType } from '../portfolio/types.js';
import type { PackageResourceLocator } from './PackageResourceLocator.js';
import type { IUserPathResolver } from './IUserPathResolver.js';
import {
  resolveDataDirectory,
  type DataDirKey,
  type ResolveOptions,
} from './resolveDataDirectory.js';
import { validateUserId } from './validateUserId.js';

/**
 * Returns the active user's ID. Implementations typically read from
 * `ContextTracker` or `UserContext`. Throws if called outside a session
 * scope — callers that need user paths outside a session must pass
 * `userId` explicitly to the path methods.
 */
export type UserIdResolver = () => string;

export interface PathServiceOptions {
  /** Layout backend for per-user paths. */
  userResolver: IUserPathResolver;

  /** Package resource locator for seed files and bundled assets. */
  packageLocator: PackageResourceLocator;

  /** Resolves the current session's userId (typically from ContextTracker). */
  userIdResolver: UserIdResolver;

  /**
   * Options applied to every `resolveDataDirectory` call (legacyRoot,
   * homeDir override, etc.). Set once at startup by
   * `PathsServiceRegistrar`.
   */
  dataDirectoryOptions?: Partial<ResolveOptions>;
}

export class PathService {
  constructor(private readonly opts: PathServiceOptions) {}

  // ── App-internal / system paths ─────────────────────────────────

  /**
   * Resolve a canonical app-internal directory (cache, logs, state,
   * config, run, portfolio-root, shared-pool, shared-provenance).
   * Not user-scoped.
   */
  resolveDataDir(key: DataDirKey, callOptions?: Partial<ResolveOptions>): string {
    return resolveDataDirectory(key, {
      ...this.opts.dataDirectoryOptions,
      ...callOptions,
    });
  }

  // ── Per-user paths ──────────────────────────────────────────────

  /** User's portfolio base directory. */
  getUserPortfolioDir(userId?: string): string {
    return this.opts.userResolver.getUserPortfolioDir(this.user(userId));
  }

  /** Specific element-type directory under the user's portfolio. */
  getUserElementDir(type: ElementType, userId?: string): string {
    return this.opts.userResolver.getUserElementDir(this.user(userId), type);
  }

  /** Per-user state directory (session-state files + agent state). */
  getUserStateDir(userId?: string): string {
    return this.opts.userResolver.getUserStateDir(this.user(userId));
  }

  /** Per-user auth directory (GitHub tokens, OAuth state). */
  getUserAuthDir(userId?: string): string {
    return this.opts.userResolver.getUserAuthDir(this.user(userId));
  }

  /** Per-user backup directory. */
  getUserBackupsDir(userId?: string): string {
    return this.opts.userResolver.getUserBackupsDir(this.user(userId));
  }

  /** Per-user security directory (DangerZone block list). */
  getUserSecurityDir(userId?: string): string {
    return this.opts.userResolver.getUserSecurityDir(this.user(userId));
  }

  // ── Package-internal resources ──────────────────────────────────

  /**
   * Resolve a package-internal resource (sync — no disk check).
   * Returns a best-guess path relative to the tree root the locator
   * was loaded from.
   */
  resolvePackageResource(relativePath: string): string {
    return this.opts.packageLocator.resolve(relativePath);
  }

  /**
   * Locate a package-internal resource (async — verifies existence
   * and falls back to the alternate tree if needed). Returns `null`
   * if the resource is missing everywhere.
   *
   * Existence-check only; does not distinguish files from directories.
   * Callers relying on a specific file type must stat themselves.
   * TOCTOU: the returned path may become invalid between this call
   * and a subsequent open — do not rely on `locate()` as a security
   * decision.
   */
  async locatePackageResource(relativePath: string): Promise<string | null> {
    return this.opts.packageLocator.locate(relativePath);
  }

  /**
   * The installed package root (parent of `src/` or `dist/`). Used
   * by callers that need to locate `package.json` or other resources
   * outside the tree root.
   */
  getPackageRoot(): string {
    return this.opts.packageLocator.getPackageRoot();
  }

  // ── Internal helpers ────────────────────────────────────────────

  /**
   * Resolve a userId: caller-supplied wins, otherwise ask the resolver.
   * The returned value is always run through `validateUserId` so
   * downstream per-user-path methods receive a guaranteed-safe input.
   * This protects flat-mode callers that bypass `PerUserPathResolver`'s
   * internal validation.
   *
   * Empty string is explicitly rejected with a descriptive error — the
   * fallback applies only when the argument is `undefined`.
   */
  private user(explicit?: string): string {
    if (explicit !== undefined) {
      if (explicit.length === 0) {
        throw new Error(
          'PathService: userId was the empty string — pass `undefined` to fall ' +
          'back to the active session, or a valid userId. Empty is never valid.'
        );
      }
      return validateUserId(explicit);
    }
    return validateUserId(this.opts.userIdResolver());
  }
}
