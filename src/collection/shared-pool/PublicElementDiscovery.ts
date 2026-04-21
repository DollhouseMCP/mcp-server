/**
 * PublicElementDiscovery
 *
 * Augments file-mode element listing with shared-pool elements.
 * When `include_public` is true, scans the `shared/<type>/` directory
 * and returns element file paths that can be loaded by the manager.
 *
 * De-duplication: elements in the user's own portfolio take precedence
 * over shared-pool elements with the same name.
 *
 * DB mode doesn't use this — it handles include_public natively via
 * RLS-aware queries in listFromDatabase().
 *
 * @module collection/shared-pool/PublicElementDiscovery
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../../utils/logger.js';

const SUPPORTED_EXTENSIONS = new Set(['.md', '.yaml', '.yml']);

export class PublicElementDiscovery {
  /**
   * @param sharedPoolDir - Absolute path to the shared pool root
   *   (e.g. `~/DollhouseMCP/shared/`).
   */
  constructor(private readonly sharedPoolDir: string) {}

  /**
   * List shared-pool element files for a given type, excluding any
   * that the user already has in their own portfolio.
   *
   * @param elementType - The element type directory (e.g. 'personas').
   * @param userFileNames - Set of filenames already in the user's
   *   portfolio (used for de-duplication — user copy wins).
   * @returns Absolute paths to shared element files to load.
   */
  async discoverPublicElements(
    elementType: string,
    userFileNames: Set<string>,
  ): Promise<string[]> {
    const sharedTypeDir = path.join(this.sharedPoolDir, elementType);

    try {
      const entries = await fs.readdir(sharedTypeDir);
      const sharedFiles: string[] = [];

      for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

        // De-duplicate: user's copy wins
        if (userFileNames.has(entry)) {
          logger.debug(`[PublicElementDiscovery] Skipping shared '${entry}' — user has own copy`);
          continue;
        }

        sharedFiles.push(path.join(sharedTypeDir, entry));
      }

      return sharedFiles;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.warn(`[PublicElementDiscovery] Failed to scan shared ${elementType}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
