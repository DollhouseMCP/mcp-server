/**
 * IUserPathResolver — the per-user path contract.
 *
 * Abstracts over flat (legacy single-user) and per-user (multi-user HTTP)
 * filesystem layouts. Callers pass a `userId` uniformly; the flat
 * implementation ignores it, the per-user implementation uses it to
 * scope paths under `users/<userId>/`.
 *
 * The interface is deliberately narrow: only the kinds of user-owned
 * paths the server needs. App-internal paths (cache, logs, config,
 * run, state) are resolved via `resolveDataDirectory` at a different
 * layer.
 *
 * **Composition contract.** Each method returns a *base directory*.
 * Callers that need finer-grained structure compose subpaths on top:
 *
 * | Return                   | Structure inside          | Used by                             |
 * |--------------------------|---------------------------|-------------------------------------|
 * | `getUserPortfolioDir`    | `<type>/...`              | PortfolioManager; base for elements |
 * | `getUserElementDir`      | element files (leaf dir)  | Element managers                    |
 * | `getUserStateDir`        | session-keyed filenames   | Activation/confirmation/challenge   |
 * |                          | (e.g. `activations-<sid>.json`) | stores                         |
 * | `getUserAuthDir`         | `github_token.enc`,       | TokenManager, GitHubAuthHandler     |
 * |                          | `oauth-helper-*`          |                                     |
 * | `getUserBackupsDir`      | `<elementType>/<date>/`   | BackupService composes date path    |
 * | `getUserSecurityDir`     | `blocked-agents.json`     | DangerZoneEnforcer                  |
 *
 * Callers compose subpaths with `path.join(resolver.getUserXxxDir(uid), ...)`
 * rather than asking the resolver to know every caller's internal
 * structure. This keeps the interface small (6 methods) while still
 * covering all follow-on consumers.
 *
 * @since Step 4.5
 */

import { ElementType } from '../portfolio/types.js';

export interface IUserPathResolver {
  /** The user's portfolio base directory. */
  getUserPortfolioDir(userId: string): string;

  /** A specific element-type directory under the user's portfolio. */
  getUserElementDir(userId: string, type: ElementType): string;

  /** Per-user state directory (session-state files + agent state). */
  getUserStateDir(userId: string): string;

  /** Per-user auth directory (GitHub tokens, OAuth helper state). */
  getUserAuthDir(userId: string): string;

  /** Per-user backup directory. */
  getUserBackupsDir(userId: string): string;

  /** Per-user security directory (DangerZone block lists). */
  getUserSecurityDir(userId: string): string;
}
