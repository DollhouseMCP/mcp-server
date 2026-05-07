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
 * oidc-provider's Adapter contract is find-then-consume returning
 * Promise<void>; even though our storage layer's genericConsume CAS
 * tells us when a concurrent consume lost, that signal can't be
 * communicated upstream. Two truly-concurrent token redeems can both
 * pass `find()` before either consume completes. To prevent legitimate
 * concurrent rotations from tripping reuse-detection (which would log
 * the user out), the adapter implements the industry-standard grace
 * window: after a consume(), the consumed marker is HIDDEN from
 * subsequent find() calls for `graceWindowMs`. After the window
 * elapses, the marker becomes visible and oidc-provider triggers
 * `revokeByGrantId` on replay — preserving §6.1 reuse-detection for
 * actual token theft. Window applies ONLY to RefreshToken;
 * AuthorizationCode is single-use by spec and grace would weaken its
 * security guarantee. Default 30s, configurable.
 *
 * @module auth/embedded-as/storage/OidcProviderAdapter
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
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

/**
 * Per-request context for the optional IP/UA-bound rotation grace
 * (Round 5 / H1). Mounted by EmbeddedAuthorizationServer's request
 * wrapper around oidc-provider's catch-all so the adapter — which sees
 * find/upsert calls but not the request — can still consult the
 * originating ip + ua.
 *
 * Hashes are stored, not raw values: the payload lives in the same
 * generic K/V the audit log reads, so plaintext IP/UA would widen the
 * blast radius of an audit dump. SHA-256 is plenty here — the goal is
 * "same client?" comparison, not authentication.
 */
export interface RotationRequestContext {
  ipHash: string;
  uaHash: string;
}

const requestContextStore = new AsyncLocalStorage<RotationRequestContext>();

/**
 * Hash a string with SHA-256 hex. Exported for tests + the
 * EmbeddedAuthorizationServer middleware that builds the context.
 */
export function hashRotationAttribute(value: string | undefined | null): string {
  return createHash('sha256').update(value ?? '').digest('hex');
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
  return requestContextStore.run(context, fn);
}

/** Read the current request context, if any. Returns undefined outside a wrapped call. */
export function currentRotationRequestContext(): RotationRequestContext | undefined {
  return requestContextStore.getStore();
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
    // Round 5 / H1: when the operator opts into IP/UA-bound grace, stamp
    // the originating request's hashes onto the RefreshToken payload at
    // issue time. find() compares against the current request's hashes
    // to decide whether the grace window applies on consume-replay.
    //
    // Only stamp on initial issue (no `ipHash` already on the payload)
    // so a rotated successor records the rotating client's hashes
    // rather than the previous token's.
    if (
      this.checkIpUa
      && GRACE_ELIGIBLE_MODELS.has(this.model)
      && payload.ipHash === undefined
      && payload.uaHash === undefined
    ) {
      const ctx = currentRotationRequestContext();
      if (ctx) {
        payload = { ...payload, ipHash: ctx.ipHash, uaHash: ctx.uaHash };
      }
    }
    await this.storage.genericSet(this.model, id, payload, expiresIn);
  }

  async find(id: string): Promise<Record<string, unknown> | undefined> {
    const payload = await this.storage.genericGet(this.model, id);
    if (!payload) return undefined;
    const record = payload as Record<string, unknown>;

    // Rotation grace (R3): for refresh tokens within the grace window
    // after first consume, hide the `consumed` marker so oidc-provider
    // issues new rotated tokens instead of revoking the family. After
    // the window expires, the marker becomes visible and reuse-detection
    // fires normally on the next find().
    //
    // Round 5 / H1: when refreshRotationCheckIpUa is true AND the
    // payload carries ipHash/uaHash from issue time, the grace window
    // additionally requires the current request's hashes to match.
    // Mismatch = no grace = reuse-detection fires. When the option is
    // false (default), the time-only check matches Auth0 / better-auth
    // / industry norm and avoids false positives from NAT/CGNAT.
    if (
      this.graceMs > 0
      && GRACE_ELIGIBLE_MODELS.has(this.model)
      && typeof record.consumed === 'number'
      && Date.now() - record.consumed < this.graceMs
      && this.ipUaGraceAllowed(record)
    ) {
      const { consumed: _consumed, ...withoutConsumed } = record;
      return withoutConsumed;
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
    // Note: genericConsume's CAS-loss boolean is intentionally
    // discarded — oidc-provider's Adapter API is Promise<void>, so we
    // can't propagate "you lost the race" upstream. The grace window
    // in find() above absorbs the concurrent-redeem case so the lost
    // CAS doesn't matter for legitimate users.
    await this.storage.genericConsume(this.model, id);
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
    await this.storage.genericDestroy(this.model, id);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    if (!this.storage.genericRevokeByGrantId) return;
    await this.storage.genericRevokeByGrantId(grantId);
  }
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
