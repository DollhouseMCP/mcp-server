/**
 * Pure single-block recovery proposal. This grants no authority to clear a block.
 * An executor must separately establish authenticated human approval and exclusive
 * namespace authority; restored state or absent process-local ownership is not proof.
 */
import { createHash } from 'node:crypto';

export interface DangerZoneBlockClearProposal {
  readonly agentName: string;
  readonly originalSha256: string;
  readonly blockSha256: string;
  readonly replacement: string;
}

const MAX_RECOVERY_BYTES = 10 * 1024 * 1024;

function fingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Inspect a bounded existing snapshot and propose removal of exactly one own key. */
export function prepareDangerZoneBlockClear(original: string, agentName: string): DangerZoneBlockClearProposal {
  if (Buffer.byteLength(original, 'utf8') > MAX_RECOVERY_BYTES) {
    throw new Error('DangerZone recovery snapshot exceeds the 10 MiB byte limit');
  }
  if (!agentName || agentName.trim() !== agentName || agentName.length > 256) {
    throw new Error('An exact existing agent name is required');
  }
  const parsed: unknown = JSON.parse(original);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid DangerZone recovery snapshot');
  }
  const data = parsed as Record<string, unknown>;
  // Current enforcers write JSON.stringify output. Refuse snapshots whose parse /
  // stringify round-trip changes a token (e.g. duplicate keys or unsafe numbers)
  // rather than silently altering an unrelated block during recovery.
  const compact = original.replace(/"(?:\\.|[^"\\])*"|\s+/g, token => token.startsWith('"') ? token : '');
  if (compact !== JSON.stringify(data)) {
    throw new Error('DangerZone recovery snapshot has ambiguous or noncanonical JSON tokens');
  }
  const blocks = data.blocks;
  if (data.version !== 1 || !blocks || typeof blocks !== 'object' || Array.isArray(blocks)) {
    throw new Error('Unsupported DangerZone recovery snapshot');
  }
  if (!Object.hasOwn(blocks, agentName)) throw new Error('Selected DangerZone block is absent');
  const block = (blocks as Record<string, unknown>)[agentName];
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error('Selected DangerZone block is malformed');
  }
  const blockSha256 = fingerprint(JSON.stringify(block));
  delete (blocks as Record<string, unknown>)[agentName];
  return Object.freeze({
    agentName,
    originalSha256: fingerprint(original),
    blockSha256,
    replacement: JSON.stringify(data, null, 2),
  });
}

/** Refuse a stale whole-file or target-block observation before any executor write. */
export function revalidateDangerZoneBlockClear(original: string, proposal: DangerZoneBlockClearProposal): void {
  if (fingerprint(original) !== proposal.originalSha256) {
    throw new Error('DangerZone recovery snapshot changed; renewed human approval is required');
  }
  const current = prepareDangerZoneBlockClear(original, proposal.agentName);
  if (current.blockSha256 !== proposal.blockSha256 || current.replacement !== proposal.replacement) {
    throw new Error('DangerZone recovery proposal does not match the selected block');
  }
}
