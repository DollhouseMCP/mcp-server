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
    // oidc-provider calls consume() when a token has been used and should
    // become unusable on subsequent finds. The earlier soft-marker
    // implementation wrote `consumed: <ts>` into the payload but find()
    // never honored it — so a previously-consumed token would still
    // resolve. We destroy outright; oidc-provider's contract is that find
    // returning undefined is the "consumed" signal it acts on.
    await this.storage.genericDestroy(this.model, id);
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
