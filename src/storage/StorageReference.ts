import * as path from 'node:path';

/** Convert an internally constructed native path to a portable storage reference.
 * This is not caller-input validation: callers must still reject unsafe reference text.
 */
export function storageReferenceFromPath(nativePath: string): string {
  return nativePath.split(path.sep).join('/');
}
