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
 * DB mode doesn't use this — the database storage layer's collection read
 * handles include_public natively through RLS-aware queries.
 *
 * @module collection/shared-pool/PublicElementDiscovery
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../../utils/logger.js';
import { elementReadFailure } from '../../elements/base/ElementReadError.js';
import type { IFileOperationsService } from '../../services/FileOperationsService.js';
import type { ElementType } from '../../portfolio/types.js';

const SUPPORTED_EXTENSIONS = new Set(['.md', '.yaml', '.yml']);

export class PublicElementDiscovery {
  /**
   * @param sharedPoolDir - Absolute path to the shared pool root
   *   (e.g. `~/DollhouseMCP/shared/`).
   * @param files - The audited file service every shared definition is read through.
   */
  constructor(private readonly sharedPoolDir: string, private readonly files: IFileOperationsService) {}

  /** The bytes of one discovered shared-pool file, through the audited read. */
  readPublicElement(elementType: string, sharedFile: string): Promise<string> {
    return this.files.readElementFile(sharedFile, elementType as ElementType, { source: 'PublicElementDiscovery.readPublicElement' });
  }

  /** The reference every consumer reports for a shared-pool file: `shared/<type>/<file>`. */
  publicReference(elementType: string, sharedFile: string): string {
    return path.posix.join('shared', elementType, path.basename(sharedFile));
  }

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
      throw elementReadFailure(err, elementType);
    }
  }
}
