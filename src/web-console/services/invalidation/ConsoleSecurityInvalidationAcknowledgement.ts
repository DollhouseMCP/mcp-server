import type { IConsoleSecurityInvalidationStore } from './IConsoleSecurityInvalidationStore.js';

export type ConsoleSecurityInvalidationAcknowledgementStore = Pick<
  IConsoleSecurityInvalidationStore,
  'listLiveReplicaIds' | 'listAcknowledgedReplicaIds'
>;

export interface WaitForSecurityInvalidationAcknowledgementsOptions {
  readonly store?: ConsoleSecurityInvalidationAcknowledgementStore | null;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly timeoutMs?: number;
}

export async function waitForSecurityInvalidationAcknowledgements(
  options: WaitForSecurityInvalidationAcknowledgementsOptions,
): Promise<boolean> {
  if (!options.store) return true;
  // Database-backed stores use their authority clock when the cutoff is
  // omitted, avoiding a fast mutation replica excluding healthy peers.
  const expected = new Set(await options.store.listLiveReplicaIds());
  if (expected.size === 0) return true;

  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (attempt === 0 || Date.now() < deadline) {
    attempt += 1;
    const acknowledged = new Set(await options.store.listAcknowledgedReplicaIds(options.eventId));
    if ([...expected].every(replicaId => acknowledged.has(replicaId))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(25, timeoutMs)));
  }
  return false;
}
