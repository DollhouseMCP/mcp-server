/**
 * persistKeys — keyfile lifecycle (must-fix #14 / Q2 / H2).
 *
 * Pins the JWKS-rotation half of the mode-switch invalidation contract.
 * Without rotateSigningKey, K/V state and cookie secrets rotated on
 * mode change but stateless JWT access tokens kept verifying until
 * natural exp because the signing keypair persisted across the rotation.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadOrGenerateSigningJwks,
  loadOrGenerateSigningJwksViaStore,
  rotateAndRetireSigningKeysViaStore,
  rotateSigningKey,
  rotateSigningKeyViaStore,
} from '../../../../src/auth/embedded-as/persistKeys.js';
import { InMemorySigningKeyStore } from '../../../../src/storage/signingKeys/InMemorySigningKeyStore.js';

describe('persistKeys', () => {
  let tmpDir: string;
  let keyFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'persist-keys-'));
    keyFile = path.join(tmpDir, 'oauth-key.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('first call generates and persists a fresh keyset', async () => {
    const k1 = await loadOrGenerateSigningJwks(keyFile);
    expect(k1.kid).toMatch(/^dh-/);
    expect(k1.jwks.keys).toHaveLength(1);
    // File on disk now exists with mode 0600.
    const stat = await fs.stat(keyFile);
    expect(stat.isFile()).toBe(true);
  });

  it('second call returns the same kid (key file persisted)', async () => {
    const k1 = await loadOrGenerateSigningJwks(keyFile);
    const k2 = await loadOrGenerateSigningJwks(keyFile);
    expect(k2.kid).toBe(k1.kid);
  });

  it('rotateSigningKey unlinks the file; next load mints a new kid', async () => {
    const k1 = await loadOrGenerateSigningJwks(keyFile);
    await rotateSigningKey(keyFile);
    // File gone.
    await expect(fs.stat(keyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const k2 = await loadOrGenerateSigningJwks(keyFile);
    expect(k2.kid).not.toBe(k1.kid);
  });

  it('rotateSigningKey is idempotent when the file is already absent', async () => {
    // Never generated — ENOENT path. Must not throw.
    await expect(rotateSigningKey(keyFile)).resolves.toBeUndefined();
  });

  it('preserves verification grace during ordinary store-backed rotation', async () => {
    const store = new InMemorySigningKeyStore();
    const first = await loadOrGenerateSigningJwksViaStore(store);

    await rotateSigningKeyViaStore(store);

    expect(await store.getByKid(first.kid)).toMatchObject({
      active: false,
      retiredAt: undefined,
    });
  });

  it('retires every pre-transition key during store-backed invalidation', async () => {
    const store = new InMemorySigningKeyStore();
    const first = await loadOrGenerateSigningJwksViaStore(store);
    await rotateSigningKeyViaStore(store);
    const second = await store.getActive('jwks');

    await rotateAndRetireSigningKeysViaStore(store);

    const active = await store.getActive('jwks');
    expect(active?.kid).not.toBe(first.kid);
    expect(active?.kid).not.toBe(second?.kid);
    expect(active?.retiredAt).toBeUndefined();
    expect(await store.getByKid(first.kid)).toMatchObject({ retiredAt: expect.any(Number) });
    expect(await store.getByKid(second?.kid ?? '')).toMatchObject({
      retiredAt: expect.any(Number),
    });
  });
});
