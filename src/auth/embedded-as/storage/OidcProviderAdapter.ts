/**
 * OidcProviderAdapter
 *
 * Implements oidc-provider's Adapter interface against our IAuthStorageLayer.
 * RefreshToken and AccessToken get a thin pass-through here at C4 — semantic
 * rotation happens at the EmbeddedAuthorizationServer level when refresh
 * issuance is wired (oidc-provider drives that via its Adapter calls).
 * Everything else (Session, Grant, Interaction, ReplayDetection, etc.) goes
 * through generic K/V.
 *
 * This file is the only place oidc-provider's Adapter type touches our code;
 * the rest of src/auth/embedded-as/ does not import from oidc-provider so
 * the library boundary stays clean.
 *
 * **Refresh-token rotation grace window (R3 / spec L926).**
 * oidc-provider's Adapter contract is find-then-consume, so a storage CAS alone
 * cannot stop two requests that both complete find() before either consume().
 * The adapter therefore creates one durable redemption claim per parent token.
 * The winner publishes a canonical successor; grace-period retries receive
 * aliases to that same successor. No retry can create an independent refresh
 * lineage. After the window, the consumed marker is visible and oidc-provider
 * invokes normal family replay detection. AuthorizationCode remains strictly
 * single-use. Default grace: 30 seconds, configurable.
 *
 * @module auth/embedded-as/storage/OidcProviderAdapter
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { logger } from '../../../utils/logger.js';
import type { IAuthStorageLayer } from './IAuthStorageLayer.js';

/**
 * Default rotation grace window. Industry consensus across implementations
 * (Auth0 grace tokens, better-auth proposal #8512, Apideck, Nango): 30s
 * is wide enough to absorb legitimate concurrent redeems from a single
 * client (multi-tab, retry, network jitter) while keeping the window
 * during which a stolen token can be replayed undetected as short as
 * practical. Operator-tunable via the constructor option.
 */
export const DEFAULT_REFRESH_ROTATION_GRACE_MS = 30_000;

/** Models that get the rotation grace treatment. RefreshToken only. */
const GRACE_ELIGIBLE_MODELS = new Set(['RefreshToken']);
const REFRESH_REDEMPTION_MODEL = 'DollhouseRefreshRedemption';
const REFRESH_ALIAS_FIELD = '__dollhouseCanonicalRefreshTokenId';
const REFRESH_REDEMPTION_INITIAL_POLL_MS = 10;
const REFRESH_REDEMPTION_MAX_POLL_MS = 250;
const REFRESH_REDEMPTION_MAX_POLLS = 128;

interface RefreshRedemptionRecord {
  readonly state: 'pending' | 'succeeded' | 'failed';
  readonly ownerId: string;
  readonly createdAt: number;
  readonly successorId?: string;
}

interface RefreshRedemptionRequestState {
  readonly parentId: string;
  readonly ownerId: string;
  readonly role: 'owner' | 'replay';
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly canonicalSuccessorId?: string;
  successorPublished: boolean;
}

/**
 * Per-request context for the optional IP/UA-bound rotation grace
 * (Round 5 / H1). Mounted by EmbeddedAuthorizationServer's request
 * wrapper around oidc-provider's catch-all so the adapter — which sees
 * find/upsert calls but not the request — can still consult the
 * originating ip + ua.
 *
 * Hashes are stored, not raw values: the payload lives in the same
 * generic K/V the audit log reads, so plaintext IP/UA would widen the
 * blast radius of an audit dump.
 *
 * Round 5 review fixup (MED-2): hashes are now HMAC-SHA256 keyed by a
 * per-deployment secret (the AS cookie signing key) when a salt is
 * provided. Plain SHA-256 of an IPv4 + a known user-agent is
 * rainbow-tableable from an audit dump — IPv4 alone is ~4B entries,
 * common UAs are a small set. HMAC with a per-deployment key forces
 * the attacker to also exfiltrate the salt before any pre-computation
 * helps. For tests that don't have a salt to hand, the plain-SHA256
 * path remains available (passing salt=undefined).
 */
export interface RotationRequestContext {
  ipHash?: string;
  uaHash?: string;
}

interface InternalRotationRequestContext extends RotationRequestContext {
  refreshRedemption?: RefreshRedemptionRequestState;
}

const requestContextStore = new AsyncLocalStorage<InternalRotationRequestContext>();

/**
 * Hash a value for use as `ipHash` or `uaHash` in the rotation
 * request context. When `salt` is provided (production path), uses
 * HMAC-SHA256 keyed by the salt; otherwise plain SHA-256 (test
 * convenience). The same `salt` MUST be used across upsert + find on
 * the same deployment — otherwise stamped hashes won't match
 * recomputed ones and the grace window will silently fail closed.
 *
 * Exported so the EmbeddedAuthorizationServer middleware that builds
 * the context can pre-compute hashes and tests can construct
 * deterministic comparisons.
 */
export function hashRotationAttribute(
  value: string | undefined | null,
  salt?: string,
): string {
  const input = value ?? '';
  if (salt && salt.length > 0) {
    return createHmac('sha256', salt).update(input).digest('hex');
  }
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Run `fn` inside an AsyncLocalStorage context carrying the request's
 * IP/UA hashes. Used by EmbeddedAuthorizationServer to wrap the
 * oidc-provider callback so refresh-token find/upsert calls during
 * that request can consult the context.
 */
export function withRotationRequestContext<T>(
  context: RotationRequestContext,
  fn: () => T,
): T {
  return requestContextStore.run({ ...context }, fn);
}

/** Read the current request context, if any. Returns undefined outside a wrapped call. */
export function currentRotationRequestContext(): RotationRequestContext | undefined {
  return requestContextStore.getStore();
}

/**
 * Release an unfinished refresh-token redemption claim at the end of a token
 * request. A provider failure must not strand a pending claim for the full
 * grace window and make an ordinary client retry look like a replay.
 */
export async function finalizeRotationRequestContext(storage: IAuthStorageLayer): Promise<void> {
  const redemption = requestContextStore.getStore()?.refreshRedemption;
  if (!redemption || redemption.role !== 'owner' || redemption.successorPublished) return;
  const pending = pendingRedemption(redemption.ownerId, redemption.createdAt);
  const failed: RefreshRedemptionRecord = {
    state: 'failed',
    ownerId: redemption.ownerId,
    createdAt: pending.createdAt,
  };
  await storage.genericCompareAndSet(
    REFRESH_REDEMPTION_MODEL,
    redemption.parentId,
    pending,
    failed,
    1,
  );
}

export interface OidcProviderAdapterOptions {
  /**
   * Window during which a consumed RefreshToken's `consumed` marker is
   * hidden from `find()` so legitimate concurrent rotations don't trip
   * reuse-detection. Set to 0 to disable (strict consume-then-detect
   * behavior — legitimate concurrent redeems will revoke the family).
   * Default: 30,000 ms.
   */
  refreshRotationGraceMs?: number;

  /**
   * Round 5 / H1: opt-in IP/UA gating during the rotation grace window.
   *
   * When `false` (default), the grace window applies on time alone —
   * matching Auth0, better-auth, and Apideck industry norm. NAT,
   * CGNAT, mobile carrier transitions, and corporate proxies make
   * per-IP gating unreliable for legitimate users; the structural
   * answer to sender-binding is DPoP (RFC 9449), planned for §8.2.
   *
   * When `true`, the grace window fires only if the new request's
   * IP+UA hashes match the hashes captured when the original refresh
   * token was issued. Mismatch = no grace = reuse-detection fires
   * (revokes the family). For deployments that want spec-strict
   * behavior at the cost of usability for users behind shifting
   * proxies/CGNAT.
   *
   * Requires `EmbeddedAuthorizationServer` to wrap oidc-provider
   * requests in `withRotationRequestContext` (it does this when this
   * option is true). Without the context, the option silently
   * degrades to the default time-only grace.
   */
  refreshRotationCheckIpUa?: boolean;
}

/**
 * The shape oidc-provider expects from an Adapter constructor — a class
 * `new (model: string) => Adapter` where Adapter has find/upsert/destroy
 * (plus optional secondary indexes). We implement a factory function that
 * returns an instance per-model.
 */
export class OidcProviderAdapter {
  private readonly graceMs: number;
  private readonly checkIpUa: boolean;

  constructor(
    private readonly model: string,
    private readonly storage: IAuthStorageLayer,
    options: OidcProviderAdapterOptions = {},
  ) {
    this.graceMs = options.refreshRotationGraceMs ?? DEFAULT_REFRESH_ROTATION_GRACE_MS;
    this.checkIpUa = options.refreshRotationCheckIpUa ?? false;
  }

  async upsert(id: string, payload: Record<string, unknown>, expiresIn?: number): Promise<void> {
    const redemption = requestContextStore.getStore()?.refreshRedemption;
    if (this.model === 'RefreshToken' && redemption) {
      const now = await this.authorityNow();
      if (redemption.role === 'replay') {
        if (now >= redemption.expiresAt) {
          throw new Error('refresh-token replay grace expired before alias publication');
        }
        if (!redemption.canonicalSuccessorId) {
          throw new Error('refresh-token replay is missing its canonical successor');
        }
        await this.storage.genericSet(this.model, id, {
          [REFRESH_ALIAS_FIELD]: redemption.canonicalSuccessorId,
        }, expiresIn);
        return;
      }
      if (now >= redemption.expiresAt) {
        throw new Error('refresh-token redemption claim expired before successor publication');
      }
    }

    // Round 5 / H1: when the operator opts into IP/UA-bound grace, stamp
    // the originating request's hashes onto the RefreshToken payload at
    // issue time. find() compares against the current request's hashes
    // to decide whether the grace window applies on consume-replay.
    //
    // Only stamp on initial issue (no `ipHash` already on the payload)
    // so a rotated successor records the rotating client's hashes
    // rather than the previous token's.
    //
    // Cycle 19 / B1: when checkIpUa is on and we hit the initial-issue
    // path WITHOUT a context, the IP/UA hashes never get stamped — and
    // every subsequent find() falls through to time-only grace because
    // the `recordIp/recordUa` legacy-data branch in ipUaGraceAllowed
    // returns true. That's the silent-degradation mode the reviewer
    // flagged. ALS DOES propagate from the EmbeddedAuthorizationServer
    // wrapper through oidc-provider's Koa middleware (verified by the
    // upstream test in OidcProviderAdapter.test.ts and the new
    // EmbeddedAuthorizationServer.rotationContext.test.ts), but if a
    // future oidc-provider release breaks the propagation OR if a new
    // call site forgets to wrap, this warning makes the degradation
    // visible instead of silent. Operators can grep for the message
    // and treat it as a config bug rather than a security incident.
    if (
      this.checkIpUa
      && GRACE_ELIGIBLE_MODELS.has(this.model)
      && payload.ipHash === undefined
      && payload.uaHash === undefined
    ) {
      const ctx = currentRotationRequestContext();
      if (ctx) {
        payload = { ...payload, ipHash: ctx.ipHash, uaHash: ctx.uaHash };
      } else {
        logger.warn(
          '[OidcProviderAdapter] refreshRotationCheckIpUa is enabled but the ' +
          'request context is missing during initial RefreshToken issue. The ' +
          'token will fall back to time-only grace. This usually means an ' +
          'auth-flow site is not wrapped in withRotationRequestContext, or an ' +
          'upstream oidc-provider release broke AsyncLocalStorage propagation. ' +
          'Investigate before relying on IP/UA-bound rotation security.',
          { model: this.model, id },
        );
      }
    }
    await this.storage.genericSet(this.model, id, payload, expiresIn);

    if (this.model === 'RefreshToken' && redemption?.role === 'owner') {
      const pending = pendingRedemption(
        redemption.ownerId,
        redemption.createdAt,
      );
      const succeeded: RefreshRedemptionRecord = {
        ...pending,
        state: 'succeeded',
        successorId: id,
      };
      const published = await this.storage.genericCompareAndSet(
        REFRESH_REDEMPTION_MODEL,
        redemption.parentId,
        pending,
        succeeded,
        this.redemptionTtlSeconds(),
      );
      if (!published) {
        await this.storage.genericDestroy(this.model, id);
        throw new Error('refresh-token redemption claim was lost before successor publication');
      }
      redemption.successorPublished = true;
    }
  }

  async find(id: string): Promise<Record<string, unknown> | undefined> {
    const canonicalId = this.model === 'RefreshToken'
      ? await this.resolveCanonicalRefreshTokenId(id)
      : id;
    const payload = await this.storage.genericGet(this.model, canonicalId);
    if (!payload) return undefined;
    const record = payload as Record<string, unknown>;

    // Rotation grace (R3): serialize refresh redemption and make later
    // grace-period requests reuse the winner's canonical successor. After the
    // window, return the consumed marker so oidc-provider revokes on replay.
    //
    // Round 5 / H1: when refreshRotationCheckIpUa is true AND the
    // payload carries ipHash/uaHash from issue time, the grace window
    // additionally requires the current request's hashes to match.
    // Mismatch = no grace = reuse-detection fires. When the option is
    // false (default), the time-only check matches Auth0 / better-auth
    // / industry norm and avoids false positives from NAT/CGNAT.
    if (this.graceMs > 0 && GRACE_ELIGIBLE_MODELS.has(this.model)) {
      return this.findRefreshTokenForRedemption(canonicalId, record);
    }

    return record;
  }

  /**
   * Decide whether the IP/UA portion of the grace check passes for
   * `record`. Returns true when:
   *   - the option is off (default), OR
   *   - the option is on but the record never recorded ipHash/uaHash
   *     (legacy data — fail open; the time-only window still applies), OR
   *   - the option is on AND ipHash AND uaHash match the current
   *     request context.
   * Returns false only when the option is on, the record carries
   * hashes, and they don't match.
   */
  private ipUaGraceAllowed(record: Record<string, unknown>): boolean {
    if (!this.checkIpUa) return true;
    const recordIp = typeof record.ipHash === 'string' ? record.ipHash : undefined;
    const recordUa = typeof record.uaHash === 'string' ? record.uaHash : undefined;
    if (!recordIp && !recordUa) return true; // legacy / no context at issue
    const ctx = currentRotationRequestContext();
    if (!ctx) return true; // no current context — degrade to time-only
    return recordIp === ctx.ipHash && recordUa === ctx.uaHash;
  }

  async consume(id: string): Promise<void> {
    // oidc-provider's Adapter contract: consume marks the record as used
    // BUT keeps it findable. The grant handlers detect replay by
    // checking `payload.consumed` on a subsequent find() — and on
    // detection trigger `revokeByGrantId` to invalidate the entire
    // refresh family. An earlier shape called genericDestroy here, which
    // made replays return `not found` and silently disabled OAuth 2.1
    // §6.1 reuse-detection. genericConsume on our storage layer marks
    // the payload while leaving the record findable.
    //
    // genericConsume's CAS-loss boolean is intentionally discarded because the
    // durable redemption claim already determines which request owns the one
    // canonical successor; retry aliases consume that same canonical record.
    const canonicalId = this.model === 'RefreshToken'
      ? await this.resolveCanonicalRefreshTokenId(id)
      : id;
    await this.storage.genericConsume(this.model, canonicalId);
  }

  private async findRefreshTokenForRedemption(
    canonicalId: string,
    record: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requestContext = requestContextStore.getStore();
    if (!requestContext) return record;

    const now = await this.authorityNow();
    const consumedAt = typeof record.consumed === 'number' ? record.consumed : null;
    if (consumedAt !== null && (
      now - consumedAt >= this.graceMs
      || !this.ipUaGraceAllowed(record)
    )) {
      return record;
    }

    const existingRequest = requestContext.refreshRedemption;
    if (existingRequest) {
      return existingRequest.parentId === canonicalId
        ? withoutConsumed(record)
        : record;
    }

    const createdAt = now;
    const expiresAt = (consumedAt ?? createdAt) + this.graceMs;
    const ownerId = randomUUID();
    let pending = pendingRedemption(ownerId, createdAt);
    let ownsClaim = await this.storage.genericInsertIfAbsent(
      REFRESH_REDEMPTION_MODEL,
      canonicalId,
      pending,
      this.redemptionTtlSeconds(),
    );
    let pollDelayMs = REFRESH_REDEMPTION_INITIAL_POLL_MS;
    let pollCount = 0;

    while (!ownsClaim && pollCount < REFRESH_REDEMPTION_MAX_POLLS) {
      if (await this.authorityNow() >= expiresAt) break;
      pollCount += 1;
      const current = parseRedemptionRecord(
        await this.storage.genericGet(REFRESH_REDEMPTION_MODEL, canonicalId),
      );
      if (!current) {
        pending = pendingRedemption(ownerId, createdAt);
        ownsClaim = await this.storage.genericInsertIfAbsent(
          REFRESH_REDEMPTION_MODEL,
          canonicalId,
          pending,
          this.redemptionTtlSeconds(),
        );
      } else if (!this.ipUaGraceAllowed(record)) {
        return { ...record, consumed: consumedAt ?? current.createdAt };
      } else if (current.state === 'failed') {
        ownsClaim = await this.storage.genericCompareAndSet(
          REFRESH_REDEMPTION_MODEL,
          canonicalId,
          current,
          pending,
          this.redemptionTtlSeconds(),
        );
      } else if (current.state === 'succeeded' && current.successorId) {
        requestContext.refreshRedemption = {
          parentId: canonicalId,
          ownerId: current.ownerId,
          role: 'replay',
          createdAt: current.createdAt,
          expiresAt,
          canonicalSuccessorId: current.successorId,
          successorPublished: true,
        };
        return withoutConsumed(record);
      }
      if (!ownsClaim) {
        await delay(pollDelayMs);
        pollDelayMs = Math.min(pollDelayMs * 2, REFRESH_REDEMPTION_MAX_POLL_MS);
      }
    }

    if (ownsClaim) {
      requestContext.refreshRedemption = {
        parentId: canonicalId,
        ownerId,
        role: 'owner',
        createdAt,
        expiresAt,
        successorPublished: false,
      };
      return withoutConsumed(record);
    }

    const latest = await this.storage.genericGet(this.model, canonicalId);
    const failedAt = await this.authorityNow();
    if (latest && typeof latest === 'object') {
      const latestRecord = latest as Record<string, unknown>;
      return typeof latestRecord.consumed === 'number'
        ? latestRecord
        : { ...latestRecord, consumed: failedAt };
    }
    return { ...record, consumed: failedAt };
  }

  private async resolveCanonicalRefreshTokenId(id: string): Promise<string> {
    const payload = await this.storage.genericGet('RefreshToken', id);
    if (!payload || typeof payload !== 'object') return id;
    const canonicalId = (payload as Record<string, unknown>)[REFRESH_ALIAS_FIELD];
    return typeof canonicalId === 'string' && canonicalId.length > 0 ? canonicalId : id;
  }

  private redemptionTtlSeconds(): number {
    return Math.max(1, Math.ceil((this.graceMs + 1_000) / 1_000));
  }

  private authorityNow(): Promise<number> {
    return this.storage.genericNow?.() ?? Promise.resolve(Date.now());
  }

  async findByUserCode(userCode: string): Promise<Record<string, unknown> | undefined> {
    if (!this.storage.genericFindByUserCode) return undefined;
    const payload = await this.storage.genericFindByUserCode(userCode);
    return (payload as Record<string, unknown> | null) ?? undefined;
  }

  async findByUid(uid: string): Promise<Record<string, unknown> | undefined> {
    if (!this.storage.genericFindByUid) return undefined;
    const payload = await this.storage.genericFindByUid(uid);
    return (payload as Record<string, unknown> | null) ?? undefined;
  }

  async destroy(id: string): Promise<void> {
    if (this.model !== 'RefreshToken') {
      await this.storage.genericDestroy(this.model, id);
      return;
    }
    const canonicalId = await this.resolveCanonicalRefreshTokenId(id);
    await this.storage.genericDestroy(this.model, canonicalId);
    if (canonicalId !== id) await this.storage.genericDestroy(this.model, id);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    if (!this.storage.genericRevokeByGrantId) return;
    await this.storage.genericRevokeByGrantId(grantId);
  }
}

function pendingRedemption(ownerId: string, createdAt: number): RefreshRedemptionRecord {
  return { state: 'pending', ownerId, createdAt };
}

function parseRedemptionRecord(value: unknown): RefreshRedemptionRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if ((record.state !== 'pending' && record.state !== 'succeeded' && record.state !== 'failed')
      || typeof record.ownerId !== 'string'
      || typeof record.createdAt !== 'number') return null;
  if (record.state === 'succeeded' && typeof record.successorId !== 'string') return null;
  return {
    state: record.state,
    ownerId: record.ownerId,
    createdAt: record.createdAt,
    ...(typeof record.successorId === 'string' ? { successorId: record.successorId } : {}),
  };
}

function withoutConsumed(record: Record<string, unknown>): Record<string, unknown> {
  const { consumed: _consumed, ...remaining } = record;
  return remaining;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Build the constructor oidc-provider's `adapter` config expects: a class
 * that takes a model string. The closure binds our IAuthStorageLayer +
 * adapter-level options (e.g. refresh-rotation grace window).
 */
export function createOidcAdapterFactory(
  storage: IAuthStorageLayer,
  options: OidcProviderAdapterOptions = {},
): new (model: string) => OidcProviderAdapter {
  return class extends OidcProviderAdapter {
    constructor(model: string) {
      super(model, storage, options);
    }
  };
}
