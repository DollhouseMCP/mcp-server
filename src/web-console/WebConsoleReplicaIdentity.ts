import { createHash } from 'node:crypto';
import * as os from 'node:os';

import { env } from '../config/env.js';

const MAX_REPLICA_ID_LENGTH = 128;
const HASH_SUFFIX_LENGTH = 16;
const HASH_SEPARATOR = '-';
const MAX_PREFIX_LENGTH = MAX_REPLICA_ID_LENGTH - HASH_SEPARATOR.length - HASH_SUFFIX_LENGTH;

export interface WebConsoleReplicaIdResolutionOptions {
  readonly explicitReplicaId?: string | null;
  readonly envReplicaId?: string | null;
  readonly hostname?: string | null;
  readonly pid?: number;
  readonly reportTruncation?: (detail: {
    readonly originalLength: number;
    readonly replicaId: string;
  }) => void;
}

export function resolveWebConsoleReplicaId(
  options: WebConsoleReplicaIdResolutionOptions = {},
): string {
  const rawReplicaId = firstNonEmpty([
    options.explicitReplicaId,
    options.envReplicaId ?? env.DOLLHOUSE_REPLICA_ID,
    options.hostname ?? os.hostname(),
    `pid-${options.pid ?? process.pid}`,
  ]);
  if (!rawReplicaId) {
    throw new Error('Web console replica id source resolved to an empty value');
  }
  return boundWebConsoleReplicaId(rawReplicaId, options.reportTruncation);
}

export function resolveStableWebConsoleReplicaId(
  options: Omit<WebConsoleReplicaIdResolutionOptions, 'pid'> = {},
): string {
  const rawReplicaId = firstNonEmpty([
    options.explicitReplicaId,
    options.envReplicaId ?? env.DOLLHOUSE_REPLICA_ID,
    options.hostname ?? os.hostname(),
  ]);
  if (!rawReplicaId) {
    throw new Error(
      'Hosted/shared web console requires a stable replica id from DOLLHOUSE_REPLICA_ID or host identity',
    );
  }
  return boundWebConsoleReplicaId(rawReplicaId, options.reportTruncation);
}

export function boundWebConsoleReplicaId(
  rawReplicaId: string,
  reportTruncation?: WebConsoleReplicaIdResolutionOptions['reportTruncation'],
): string {
  if (rawReplicaId.trim() === '') {
    throw new Error('Web console replica id must be non-empty');
  }
  if (rawReplicaId.length <= MAX_REPLICA_ID_LENGTH) return rawReplicaId;
  const hash = createHash('sha256').update(rawReplicaId).digest('hex').slice(0, HASH_SUFFIX_LENGTH);
  const replicaId = `${rawReplicaId.slice(0, MAX_PREFIX_LENGTH)}${HASH_SEPARATOR}${hash}`;
  reportTruncation?.({
    originalLength: rawReplicaId.length,
    replicaId,
  });
  return replicaId;
}

function firstNonEmpty(values: readonly (string | null | undefined)[]): string | null {
  return values.find(value => value !== undefined && value !== null && value.trim() !== '') ?? null;
}
