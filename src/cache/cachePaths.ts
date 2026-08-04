import * as os from 'node:os';
import * as path from 'node:path';

export function resolveCollectionCacheDir(baseDir?: string): string {
  const configuredCacheDir = process.env.DOLLHOUSE_CACHE_DIR;
  if (configuredCacheDir) return configuredCacheDir;

  const dollhouseHome = baseDir ?? process.env.DOLLHOUSE_HOME_DIR ?? os.homedir();
  return path.join(dollhouseHome, '.dollhouse', 'cache');
}
