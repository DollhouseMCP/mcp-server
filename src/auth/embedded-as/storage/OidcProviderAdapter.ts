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
 * @module auth/embedded-as/storage/OidcProviderAdapter
 */

import type { IAuthStorageLayer } from './IAuthStorageLayer.js';

/**
 * The shape oidc-provider expects from an Adapter constructor — a class
 * `new (model: string) => Adapter` where Adapter has find/upsert/destroy
 * (plus optional secondary indexes). We implement a factory function that
 * returns an instance per-model.
 */
export class OidcProviderAdapter {
  constructor(
    private readonly model: string,
    private readonly storage: IAuthStorageLayer,
  ) {}

  async upsert(id: string, payload: Record<string, unknown>, expiresIn?: number): Promise<void> {
    await this.storage.genericSet(this.model, id, payload, expiresIn);
  }

  async find(id: string): Promise<Record<string, unknown> | undefined> {
    const payload = await this.storage.genericGet(this.model, id);
    return (payload as Record<string, unknown> | null) ?? undefined;
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
 * that takes a model string. The closure binds our IAuthStorageLayer.
 */
export function createOidcAdapterFactory(storage: IAuthStorageLayer): new (model: string) => OidcProviderAdapter {
  return class extends OidcProviderAdapter {
    constructor(model: string) {
      super(model, storage);
    }
  };
}
