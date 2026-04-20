/**
 * FlatPathResolver — legacy single-user filesystem layout.
 *
 * Used for existing `~/.dollhouse/` installs where content lives flat
 * (no `users/<uuid>/` subtree). All `userId` arguments are ignored;
 * there is effectively one user.
 *
 * Paths under this resolver match the pre-Step-4.5 layout byte-identical
 * so existing installs see no change.
 *
 * @since Step 4.5
 */

import path from 'node:path';

import { ElementType } from '../portfolio/types.js';
import { IUserPathResolver } from './IUserPathResolver.js';

export class FlatPathResolver implements IUserPathResolver {
  /**
   * @param legacyRoot the base directory (typically `~/.dollhouse`); must be absolute
   */
  constructor(private readonly legacyRoot: string) {
    if (!path.isAbsolute(legacyRoot)) {
      throw new Error(`FlatPathResolver: legacyRoot must be absolute, got ${legacyRoot}`);
    }
  }

  getUserPortfolioDir(_userId: string): string {
    return path.join(this.legacyRoot, 'portfolio');
  }

  getUserElementDir(_userId: string, type: ElementType): string {
    return path.join(this.legacyRoot, 'portfolio', type);
  }

  getUserStateDir(_userId: string): string {
    return path.join(this.legacyRoot, 'state');
  }

  getUserAuthDir(_userId: string): string {
    return path.join(this.legacyRoot, '.auth');
  }

  getUserBackupsDir(_userId: string): string {
    return path.join(this.legacyRoot, 'portfolio', '.backups');
  }

  getUserSecurityDir(_userId: string): string {
    return path.join(this.legacyRoot, 'security');
  }
}
