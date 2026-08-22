import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import type { JWK } from 'jose';
import { OidcLifecycleSigningKey } from '../../../../src/auth/embedded-as/OidcLifecycleSigningKey.js';
import {
  createFreshSigningKeyWrite,
  type StoredKeyPair,
} from '../../../../src/auth/embedded-as/persistKeys.js';
import { InMemorySigningKeyStore } from '../../../../src/storage/signingKeys/InMemorySigningKeyStore.js';

const GENERATION = 'A'.repeat(43);

describe('OidcLifecycleSigningKey', () => {
  it('holds the signing-key lifecycle read lease through the signature operation', async () => {
    const store = new InMemorySigningKeyStore();
    const first = await createFreshSigningKeyWrite();
    await store.rotate(first);
    const signingKey = createExternalKey(store, first);
    const originalWithActiveKey = store.withActiveKey.bind(store);
    const entered = deferred<void>();
    const release = deferred<void>();
    jest.spyOn(store, 'withActiveKey').mockImplementation((kind, operation) =>
      originalWithActiveKey(kind, async active => {
        entered.resolve();
        await release.promise;
        return operation(active);
      }));

    const payload = Buffer.from('oidc-provider-signing-boundary');
    const signaturePromise = signingKey.sign(payload);
    await entered.promise;

    const second = await createFreshSigningKeyWrite();
    let rotationFinished = false;
    const rotationPromise = store.rotate(second).then(() => {
      rotationFinished = true;
    });
    await Promise.resolve();
    expect(rotationFinished).toBe(false);

    release.resolve();
    const signature = await signaturePromise;
    await rotationPromise;
    expect(signature).toHaveLength(64);
    expect(verify('sha256', payload, {
      key: createPublicKey({
        key: (first.payload as unknown as StoredKeyPair).publicKey as import('node:crypto').JsonWebKey,
        format: 'jwk',
      }),
      dsaEncoding: 'ieee-p1363',
    }, signature)).toBe(true);
  });

  it('refuses to sign with a provider key that has already been rotated out', async () => {
    const store = new InMemorySigningKeyStore();
    const first = await createFreshSigningKeyWrite();
    await store.rotate(first);
    const signingKey = createExternalKey(store, first);
    await store.rotate(await createFreshSigningKeyWrite());

    await expect(signingKey.sign(Buffer.from('stale-provider'))).rejects.toThrow(
      /retired before oidc-provider completed signing/,
    );
  });
});

function createExternalKey(
  store: InMemorySigningKeyStore,
  write: Awaited<ReturnType<typeof createFreshSigningKeyWrite>>,
): OidcLifecycleSigningKey {
  const stored = write.payload as unknown as StoredKeyPair;
  return new OidcLifecycleSigningKey({
    store,
    keysetJwk: stored.privateKey as JWK,
    expectedKid: write.kid,
    expectedGenerationFingerprint: GENERATION,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
