import { BlockStateValidationError } from '../security/BlockStateValidationError.js';
import { validateAgentName } from '../security/validateAgentName.js';
import { isStateObject, readPersistedState } from './persistence-utils.js';

export const MAX_BLOCK_SNAPSHOT_BYTES = 10 * 1024 * 1024;
class BlockSnapshotSizeError extends BlockStateValidationError {}

/** Shared bounded decoding for file storage and startup import. */
export async function readDangerZoneBlockSnapshot(
  read: () => Promise<string>,
  stat?: () => Promise<{ size: number }>,
) {
  const result = await readPersistedState(async () => {
    if (stat && (await stat()).size > MAX_BLOCK_SNAPSHOT_BYTES) {
      throw new BlockSnapshotSizeError('Block snapshot exceeds size limit');
    }
    const content = await read();
    if (Buffer.byteLength(content, 'utf8') > MAX_BLOCK_SNAPSHOT_BYTES) {
      throw new BlockSnapshotSizeError('Block snapshot exceeds size limit');
    }
    return content;
  }, value => {
    if (!isStateObject(value) || !isStateObject(value.blocks)) throw new BlockStateValidationError('Invalid block snapshot');
    const blocks: Record<string, unknown> = Object.create(null);
    for (const name of Object.keys(value.blocks)) {
      validateAgentName(name, 'restore');
      const normalized = name.trim();
      if (Object.hasOwn(blocks, normalized)) throw new BlockStateValidationError('Duplicate persisted agent name');
      blocks[normalized] = value.blocks[name];
    }
    return blocks;
  }, 1);
  return result.status === 'unreadable' && result.cause instanceof BlockSnapshotSizeError
    ? { status: 'invalid' as const, cause: result.cause } : result;
}
