import * as fs from 'node:fs/promises';
import path from 'node:path';
import { SEED_MEMORY_FILENAME } from '../elements/memories/constants.js';
import { PackageResourceLocator } from './PackageResourceLocator.js';

/** Per-detection cache of shipped default bytes; never parse candidate element contents. */
export class BundledElementProbe {
  private readonly defaults = new Map<string, Promise<Buffer | undefined>>();

  async isBundled(file: string, elementType: string, relativePath: string): Promise<boolean> {
    if (elementType === 'memories' && path.dirname(relativePath) === 'system' && this.isSeed(path.basename(file))) return true;
    // DefaultElementProvider copies top-level markdown files byte for byte.
    if (path.extname(file) !== '.md' || path.dirname(relativePath) !== '.') return false;
    const source = path.join(new PackageResourceLocator().getPackageRoot(), 'data', elementType, path.basename(file));
    if (!this.defaults.has(source)) this.defaults.set(source, this.readDefault(source));
    const expected = await this.defaults.get(source);
    // Defaults changed since an older release conservatively count as user content.
    return expected !== undefined && expected.equals(await fs.readFile(file));
  }

  private isSeed(filename: string): boolean {
    if (filename === SEED_MEMORY_FILENAME) return true;
    const prefix = `${path.basename(SEED_MEMORY_FILENAME, '.yaml')}.backup-`;
    return filename.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}(?:-v\d+)?\.yaml$/.test(filename.slice(prefix.length));
  }

  private async readDefault(source: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
