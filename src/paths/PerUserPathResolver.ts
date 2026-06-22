/**
 * PerUserPathResolver — per-user filesystem layout for multi-user HTTP
 * deployments.
 *
 * Every user gets a subtree under `<portfolioRoot>/users/<userId>/`
 * containing their portfolio, state, auth, backups, and security data.
 * Cross-user access is prevented at the filesystem level (PathValidator
 * enforces the per-user sandbox).
 *
 * The `portfolioRoot` is the base directory that contains the `users/`
 * subtree. In migrated legacy installs it is `~/.dollhouse/`; in new
 * installs it is `~/DollhouseMCP/`.
 *
 * **Validation ownership:** `PathService.user()` is the chokepoint that
 * runs `validateUserId` on every userId before it reaches this class.
 * Direct instantiators of `PerUserPathResolver` (tests, migrations,
 * future non-PathService callers) MUST validate themselves — this
 * class trusts its input and composes paths directly. A single
 * validation point keeps the hot path (6 methods × N callers) cheap
 * and makes ownership unambiguous.
 *
 * @since Step 4.5
 */

import path from 'node:path';

import { ElementType } from '../portfolio/types.js';
import { IUserPathResolver } from './IUserPathResolver.js';

export class PerUserPathResolver implements IUserPathResolver {
  /**
   * @param portfolioRoot base dir containing the `users/` subtree; must be absolute
   */
  constructor(private readonly portfolioRoot: string) {
    if (!path.isAbsolute(portfolioRoot)) {
      throw new Error(`PerUserPathResolver: portfolioRoot must be absolute, got ${portfolioRoot}`);
    }
  }

  getUserPortfolioDir(userId: string): string {
    return path.join(this.portfolioRoot, 'users', userId, 'portfolio');
  }

  getUserElementDir(userId: string, type: ElementType): string {
    return path.join(this.portfolioRoot, 'users', userId, 'portfolio', type);
  }

  getUserStateDir(userId: string): string {
    return path.join(this.portfolioRoot, 'users', userId, 'state');
  }

  getUserAuthDir(userId: string): string {
    return path.join(this.portfolioRoot, 'users', userId, 'auth');
  }

  getUserBackupsDir(userId: string): string {
    return path.join(this.portfolioRoot, 'users', userId, 'backups');
  }

  getUserSecurityDir(userId: string): string {
    return path.join(this.portfolioRoot, 'users', userId, 'security');
  }
}
