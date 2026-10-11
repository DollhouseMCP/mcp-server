/** Bounded dormant candidate preservation. Inspection never restores dispatch authority. */
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import { withUserContext, withUserRead } from '../database/rls.js';
import type { MemoryUpdateCandidate } from './MemoryHeadUpdateAdapter.js';
import type { MemoryHeadToken } from './IMemoryHeadStore.js';
import { DatabaseMemoryAdmissionGate, requireDatabaseMemoryWriteAuthority,
  requireDatabaseMemoryCommittedWriteAuthority,
  type DatabaseMemoryAdmission, type DatabaseMemoryWriteAuthority,
  type DatabaseMemoryAdmittedWriteOutcome } from './DatabaseMemoryAdmissionGate.js';
import type { DatabaseMemoryStorageLayer } from './DatabaseMemoryStorageLayer.js';
import { DatabaseMemoryBootQualification } from './DatabaseMemoryBootQualification.js';
import { encodeMemoryCandidate, decodeMemoryCandidate } from './DatabaseMemoryCandidateEnvelope.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';

export interface MemoryHandoffAttribution {
  readonly contextRoot: string;
  readonly sessionId: string | null;
  readonly transport: string;
}
export interface MemoryCandidateHandoffReceipt { readonly protocolVersion: 1 }
interface RetainedReceipt {
  readonly id: string;
  readonly tenant: string;
  readonly candidateBytes: Buffer;
  readonly digest: string;
  readonly original: MemoryHeadToken;
  readonly boot: object;
  readonly attribution: string;
  readonly retireSecret: string;
  attempted: boolean;
  dispatchAuthority?: DatabaseMemoryWriteAuthority;
  prospective?: { readonly authority: DatabaseMemoryWriteAuthority; readonly token: MemoryHeadToken };
  committed?: MemoryHeadToken;
  publishing: boolean;
  published: boolean;
}
function refuse(): never {
  throw Object.assign(new Error('Original durable memory candidate handoff required'), { code: 'EMEMORYHANDOFF' });
}

export class DatabaseMemoryCandidateHandoff {
  private readonly receipts = new WeakMap<MemoryCandidateHandoffReceipt, RetainedReceipt>();
  private readonly bootInvocation = randomUUID();
  constructor(private readonly db: DatabaseInstance, private readonly store: DatabaseMemoryStorageLayer,
    private readonly gate: DatabaseMemoryAdmissionGate, private readonly boot: DatabaseMemoryBootQualification,
    private readonly getTenant: () => string, private readonly getAttribution: () => MemoryHandoffAttribution) {}

  private currentIdentity() { return { tenant: this.getTenant(), store: this.store, backend: 'database' as const }; }
  private attribution(): string {
    const value = this.getAttribution();
    if (!value || typeof value.contextRoot !== 'string' || !value.contextRoot ||
      (value.sessionId !== null && (typeof value.sessionId !== 'string' || !value.sessionId)) ||
      typeof value.transport !== 'string' || !value.transport) refuse();
    const serialized = JSON.stringify([value.contextRoot, value.sessionId, value.transport]);
    if (serialized.length > 8192) refuse();
    return serialized;
  }
  private required(receipt: MemoryCandidateHandoffReceipt): RetainedReceipt {
    const retained = this.receipts.get(receipt);
    if (!retained?.tenant || retained.tenant !== this.getTenant() || retained.attribution !== this.attribution()) refuse();
    this.boot.require(retained.boot, this.currentIdentity());
    return retained;
  }

  private async requireSchemaIsolation(tx: DrizzleTx): Promise<void> {
    const rows = await tx.execute(sql`SELECT relname,relowner=current_user::regrole AS owned,relforcerowsecurity
      FROM pg_catalog.pg_class WHERE oid IN
        ('public.memory_candidate_quotas'::regclass,'public.memory_candidate_handoffs'::regclass)`);
    if (rows.length !== 2 || rows.some(row => row.owned !== false || row.relforcerowsecurity !== true)) refuse();
  }

  async handoff(capture: DatabaseMemoryAdmission, candidate: MemoryUpdateCandidate,
    original: MemoryHeadToken): Promise<DatabaseMemoryAdmittedWriteOutcome<MemoryCandidateHandoffReceipt>> {
    const identity = this.currentIdentity(); const qualified = this.boot.capture(identity);
    const evidence = this.gate.describeCapture(capture);
    if (evidence.tenant !== identity.tenant || original.userId !== identity.tenant || original.backend !== 'database') refuse();
    const attribution = this.attribution(); const id = randomUUID();
    const retireSecret = randomBytes(32).toString('hex');
    const frozenOriginal = Object.freeze({ ...original });
    const encoded = encodeMemoryCandidate({ ...candidate, handoffEvidence: {
      original: frozenOriginal, admission: evidence, attribution, bootInvocation: this.bootInvocation,
    } } as MemoryUpdateCandidate);
    const outcome = await this.gate.withAdmittedWrite(capture, async authority => {
      this.boot.require(qualified, identity);
      if (this.getTenant() !== identity.tenant || attribution !== this.attribution()) refuse();
      const tx = requireDatabaseMemoryWriteAuthority(authority, this.store, identity.tenant);
      await this.requireSchemaIsolation(tx);
      await tx.execute(sql`INSERT INTO public.memory_candidate_handoffs
        (id,user_id,envelope,digest,retire_hash,envelope_bytes)
        VALUES (${id}::uuid,${identity.tenant}::uuid,${encoded.bytes},${encoded.digest},
          ${createHash('sha256').update(retireSecret).digest('hex')},0)`);
      this.boot.require(qualified, identity);
      if (this.getTenant() !== identity.tenant || attribution !== this.attribution()) refuse();
      return Object.freeze({ protocolVersion: 1 as const });
    });
    if (outcome.status !== 'committed') {
      if (outcome.status === 'unknown') this.boot.close();
      return outcome;
    }
    // No head dispatch follows a close during delivered handoff completion.
    this.boot.require(qualified, identity);
    if (this.getTenant() !== identity.tenant || attribution !== this.attribution()) refuse();
    this.receipts.set(outcome.value, { id, tenant: identity.tenant, candidateBytes: Buffer.from(encoded.bytes),
      digest: encoded.digest, original: frozenOriginal, boot: qualified, attribution, retireSecret,
      attempted: false, publishing: false, published: false });
    return outcome;
  }

  /** Consume before the first head attempt, even if that attempt later rolls back. */
  consume(receipt: MemoryCandidateHandoffReceipt): void {
    const retained = this.required(receipt);
    if (retained.attempted) refuse();
    retained.attempted = true;
  }

  async requireBeforeDispatch(authority: DatabaseMemoryWriteAuthority, receipt: MemoryCandidateHandoffReceipt,
    candidate: MemoryUpdateCandidate): Promise<void> {
    const retained = this.required(receipt);
    if (!retained.attempted || retained.dispatchAuthority) refuse();
    this.requireCandidate(retained, candidate);
    const tx = requireDatabaseMemoryWriteAuthority(authority, this.store, retained.tenant);
    // Rollback or SQL failure cannot authorize replay under a later transaction.
    retained.dispatchAuthority = authority;
    const rows = await tx.execute(sql`SELECT id FROM public.memory_candidate_handoffs
      WHERE id=${retained.id}::uuid AND user_id=${retained.tenant}::uuid AND status='prepared'
        AND digest=${retained.digest} AND envelope=${retained.candidateBytes} FOR UPDATE`);
    if (rows.length !== 1) refuse();
    this.required(receipt);
  }

  private requireCandidate(retained: RetainedReceipt, candidate: MemoryUpdateCandidate): void {
    const inspected = decodeMemoryCandidate({ bytes: retained.candidateBytes, digest: retained.digest });
    const { handoffEvidence: _evidence, ...originalCandidate } = inspected as MemoryUpdateCandidate & { handoffEvidence: unknown };
    if (!encodeMemoryCandidate(candidate).bytes.equals(encodeMemoryCandidate(originalCandidate).bytes)) refuse();
  }

  async recordCommitted(authority: DatabaseMemoryWriteAuthority, receipt: MemoryCandidateHandoffReceipt,
    candidate: MemoryUpdateCandidate, token: MemoryHeadToken): Promise<void> {
    const retained = this.required(receipt);
    if (!retained.attempted || retained.dispatchAuthority !== authority || retained.committed) refuse();
    // Candidate evidence contains original authority/context; compare the complete submitted data.
    this.requireCandidate(retained, candidate);
    if (token.backend !== 'database' || token.userId !== retained.tenant || token.ownerId !== retained.original.ownerId ||
      token.locator !== retained.original.locator || token.revision === retained.original.revision) refuse();
    const tx = requireDatabaseMemoryWriteAuthority(authority, this.store, retained.tenant);
    const rows = await tx.execute(sql`UPDATE public.memory_candidate_handoffs
      SET status='committed',committed_token=${JSON.stringify(token)}::jsonb
      WHERE id=${retained.id}::uuid AND user_id=${retained.tenant}::uuid
        AND status='prepared' AND digest=${retained.digest} RETURNING id`);
    if (rows.length !== 1) refuse();
    this.required(receipt);
    retained.prospective = { authority, token: Object.freeze({ ...token }) };
  }

  /** Called only after the enclosing gate returns known head COMMIT. */
  noteKnownCommit(receipt: MemoryCandidateHandoffReceipt): void {
    const retained = this.required(receipt); if (!retained.attempted) refuse();
    const prospective = retained.prospective;
    if (!prospective) refuse();
    requireDatabaseMemoryCommittedWriteAuthority(prospective.authority, this.store, retained.tenant);
    retained.committed = prospective.token;
  }

  close(): void { this.boot.close(); }

  /** Wrap the actual owning tail. A failed tail never mints publication completion. */
  async completePublication<T>(receipt: MemoryCandidateHandoffReceipt, publish: () => Promise<T>): Promise<T> {
    const retained = this.required(receipt);
    if (!retained.committed || retained.publishing || retained.published) refuse();
    retained.publishing = true;
    const result = await publish();
    const cleanup = await this.retireCompleted(receipt);
    if (cleanup === 'cleanup-unknown') {
      try {
        SecurityMonitor.logSecurityEvent({ type: 'OPERATION_FAILED', severity: 'MEDIUM',
          source: 'DatabaseMemoryCandidateHandoff',
          details: 'Candidate cleanup completion unknown; head-outcome=known-committed; application-publication=completed' });
      } catch {
        try { logger.warn('Completed memory candidate cleanup observation failed'); } catch { /* Preserve known success. */ }
      }
    }
    return result;
  }

  /** Private completion only; cleanup uncertainty does not change head success. */
  private async retireCompleted(receipt: MemoryCandidateHandoffReceipt): Promise<'retired' | 'cleanup-unknown'> {
    const retained = this.receipts.get(receipt);
    if (!retained?.committed || !retained.publishing || retained.published) refuse();
    retained.published = true;
    try {
      this.required(receipt);
      await withUserContext(this.db, retained.tenant, async tx => {
        await this.requireSchemaIsolation(tx);
        await tx.execute(sql`SELECT set_config('app.memory_handoff_retire',${retained.retireSecret},true)`);
        const rows = await tx.execute(sql`UPDATE public.memory_candidate_handoffs SET status='published'
          WHERE id=${retained.id}::uuid AND user_id=${retained.tenant}::uuid AND status='committed'
            AND committed_token=${JSON.stringify(retained.committed)}::jsonb RETURNING id`);
        if (rows.length !== 1) refuse();
        const deleted = await tx.execute(sql`DELETE FROM public.memory_candidate_handoffs
          WHERE id=${retained.id}::uuid AND user_id=${retained.tenant}::uuid AND status='published' RETURNING id`);
        if (deleted.length !== 1) refuse();
      });
      return 'retired';
    } catch { return 'cleanup-unknown'; }
  }

  /** Evidence only; no receipt, retire secret or write capability is restored. */
  async inspectRetained(): Promise<readonly { id: string; status: string; candidate: MemoryUpdateCandidate }[]> {
    const tenant = this.getTenant();
    const attribution = this.attribution();
    const rows = await withUserRead(this.db, tenant, async tx => {
      const rows = await tx.execute(sql`SELECT id,status,envelope,digest FROM public.memory_candidate_handoffs
        WHERE user_id=${tenant}::uuid ORDER BY created_at,id LIMIT 65`);
      if (rows.length > 64) refuse();
      return rows;
    });
    if (this.getTenant() !== tenant || this.attribution() !== attribution) refuse();
    return rows.map(row => ({ id: String(row.id), status: String(row.status), candidate:
      decodeMemoryCandidate({ bytes: row.envelope as Buffer, digest: String(row.digest) }) }));
  }
}
