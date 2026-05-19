import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InviteTokenStore,
  loadOrGenerateInviteSecret,
  loadOrGenerateInviteSecretViaStore,
} from '../../../../src/auth/embedded-as/inviteTokens.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InMemorySigningKeyStore } from '../../../../src/storage/signingKeys/InMemorySigningKeyStore.js';

describe('InviteTokenStore', () => {
  let store: InviteTokenStore;
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
    store = new InviteTokenStore(randomBytes(32), storage);
  });

  it('rejects construction with a too-short secret', () => {
    expect(() => new InviteTokenStore(Buffer.from('short'))).toThrow(/at least 16 bytes/);
  });

  it('issues, verifies, and consumes a fresh token (must-fix #17 / #1)', async () => {
    const token = store.issue({ sub: 'local_alice', email: 'alice@example.com', purpose: 'invite' });
    const verified = store.verify(token);
    expect(verified.ok).toBe(true);

    const consumed = await store.consume(token);
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(consumed.payload.sub).toBe('local_alice');
      expect(consumed.payload.email).toBe('alice@example.com');
      expect(consumed.payload.purpose).toBe('invite');
    }
  });

  it('rejects a second consume on the same token (single-use)', async () => {
    const token = store.issue({ sub: 'a', email: 'a@x', purpose: 'invite' });
    expect((await store.consume(token)).ok).toBe(true);
    const second = await store.consume(token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already-consumed');
  });

  it('verify does NOT consume — anti-pre-fetch (must-fix #1)', async () => {
    const token = store.issue({ sub: 'a', email: 'a@x', purpose: 'magic-link' });
    expect(store.verify(token).ok).toBe(true);
    expect(store.verify(token).ok).toBe(true);
    expect(store.verify(token).ok).toBe(true);
    // Still consumable — verify never consumed.
    expect((await store.consume(token)).ok).toBe(true);
  });

  it('rejects tokens signed by a different secret', () => {
    const other = new InviteTokenStore(randomBytes(32), new InMemoryAuthStorageLayer());
    const token = other.issue({ sub: 'a', email: 'a@x', purpose: 'invite' });
    const verified = store.verify(token);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('invalid');
  });

  it('rejects expired tokens', () => {
    const token = store.issue({ sub: 'a', email: 'a@x', purpose: 'invite', ttlMs: 1 });
    const start = Date.now();
    while (Date.now() === start) { /* spin */ }
    const verified = store.verify(token);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('expired');
  });

  it('rejects malformed tokens', () => {
    expect(store.verify('not-a-token').ok).toBe(false);
    expect(store.verify('only-one-part').ok).toBe(false);
    expect(store.verify('aaa.bbb.ccc').ok).toBe(false);
  });

  it('consume() requires storage; throws clearly when constructed without it', async () => {
    const issuerOnly = new InviteTokenStore(randomBytes(32));
    const token = issuerOnly.issue({ sub: 'a', email: 'a@x', purpose: 'invite' });
    await expect(issuerOnly.consume(token)).rejects.toThrow(/requires a storage layer/);
  });

  it('consumed-jti durability: a second InviteTokenStore against the same storage rejects replay (H5)', async () => {
    // Pin H5: the in-memory consumed-set used to evaporate on restart,
    // letting captured invite URLs replay within their TTL — for local
    // accounts that meant a re-upsert of a fresh password hash.
    // Persisting the consumed marker through IAuthStorageLayer means a
    // fresh InviteTokenStore against the same storage still rejects the
    // replay.
    const secret = randomBytes(32);
    const storeA = new InviteTokenStore(secret, storage);
    const storeB = new InviteTokenStore(secret, storage);
    const token = storeA.issue({ sub: 'persist', email: 'p@x', purpose: 'invite' });
    expect((await storeA.consume(token)).ok).toBe(true);
    const replay = await storeB.consume(token);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('already-consumed');
  });

  describe('loadOrGenerateInviteSecret (cycle-16 coverage gap)', () => {
    let tmpDir: string;
    const ENV_KEY = 'DOLLHOUSE_INVITE_TOKEN_SECRET';
    let originalEnv: string | undefined;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-secret-'));
      originalEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(() => {
      if (originalEnv !== undefined) process.env[ENV_KEY] = originalEnv;
      else delete process.env[ENV_KEY];
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // Cycle 22: env var resolution now happens at module load through
    // Zod (env.DOLLHOUSE_INVITE_TOKEN_SECRET). Runtime process.env
    // mutation no longer reaches the call. Tests use the explicit
    // `options.envSecret` override (the test injection point).

    it('reads a valid hex env var and returns the decoded buffer', () => {
      const hexSecret = randomBytes(32).toString('hex');
      const buf = loadOrGenerateInviteSecret(path.join(tmpDir, 'unused.bin'), { envSecret: hexSecret });
      expect(buf.toString('hex')).toBe(hexSecret);
    });

    it('rejects env-var values shorter than 16 bytes', () => {
      expect(() => loadOrGenerateInviteSecret(path.join(tmpDir, 'unused.bin'), { envSecret: 'aa'.repeat(8) }))
        .toThrow(/at least 16 bytes/);
    });

    it('env var takes precedence over the file', () => {
      const filePath = path.join(tmpDir, 'invite-secret.bin');
      const fileSecret = randomBytes(32);
      fs.writeFileSync(filePath, fileSecret);
      const envHex = randomBytes(32).toString('hex');
      const buf = loadOrGenerateInviteSecret(filePath, { envSecret: envHex });
      expect(buf.toString('hex')).toBe(envHex);
    });

    it('generates a new secret on first run when no file or env is set', () => {
      const filePath = path.join(tmpDir, 'invite-secret.bin');
      expect(fs.existsSync(filePath)).toBe(false);
      const buf = loadOrGenerateInviteSecret(filePath);
      expect(buf.length).toBeGreaterThanOrEqual(16);
      expect(fs.existsSync(filePath)).toBe(true);
      // Mode 0600 only meaningful on POSIX; skip the stat assertion on
      // Windows where mode bits don't map cleanly.
      if (process.platform !== 'win32') {
        const mode = fs.statSync(filePath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it('reuses an existing valid file on subsequent calls', () => {
      const filePath = path.join(tmpDir, 'invite-secret.bin');
      const first = loadOrGenerateInviteSecret(filePath);
      const second = loadOrGenerateInviteSecret(filePath);
      expect(first.equals(second)).toBe(true);
    });
  });

  describe('loadOrGenerateInviteSecretViaStore', () => {
    it('generates and reuses an invite secret from the signing-key store', async () => {
      const keyStore = new InMemorySigningKeyStore();

      const first = await loadOrGenerateInviteSecretViaStore(keyStore);
      const second = await loadOrGenerateInviteSecretViaStore(keyStore);

      expect(first.length).toBe(32);
      expect(first.equals(second)).toBe(true);
      const active = await keyStore.getActive('invite');
      expect(active?.kind).toBe('invite');
      expect(active?.payload.secret).toBe(first.toString('base64'));
    });

    it('allows independent runtimes sharing the store to verify each other\'s tokens', async () => {
      const keyStore = new InMemorySigningKeyStore();
      const runtimeASecret = await loadOrGenerateInviteSecretViaStore(keyStore);
      const runtimeBSecret = await loadOrGenerateInviteSecretViaStore(keyStore);
      const runtimeA = new InviteTokenStore(runtimeASecret, storage);
      const runtimeB = new InviteTokenStore(runtimeBSecret, storage);

      const token = runtimeA.issue({ sub: 'replica-user', email: 'replica@example.com', purpose: 'invite' });

      const verifiedByB = runtimeB.verify(token);
      expect(verifiedByB.ok).toBe(true);
      if (verifiedByB.ok) {
        expect(verifiedByB.payload.sub).toBe('replica-user');
      }
    });

    it('env var takes precedence over the signing-key store', async () => {
      const keyStore = new InMemorySigningKeyStore();
      const storeSecret = await loadOrGenerateInviteSecretViaStore(keyStore);
      const envSecret = randomBytes(32);

      const resolved = await loadOrGenerateInviteSecretViaStore(keyStore, {
        envSecret: envSecret.toString('hex'),
      });

      expect(resolved.equals(envSecret)).toBe(true);
      expect(resolved.equals(storeSecret)).toBe(false);
    });

    it('regenerates when the active stored invite secret is too short', async () => {
      const keyStore = new InMemorySigningKeyStore();
      await keyStore.rotate({
        kid: 'invite-short',
        kind: 'invite',
        payload: { secret: randomBytes(8).toString('base64'), length: 8 },
      });

      const resolved = await loadOrGenerateInviteSecretViaStore(keyStore);

      expect(resolved.length).toBe(32);
      const active = await keyStore.getActive('invite');
      expect(active?.kid).not.toBe('invite-short');
      expect(active?.payload.secret).toBe(resolved.toString('base64'));
    });
  });

  describe('H11: oversize-token DoS guard', () => {
    it('rejects tokens longer than 4096 chars without computing the HMAC', () => {
      const oversized = 'a'.repeat(4097);
      const verified = store.verify(oversized);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.reason).toBe('invalid');
    });

    it('accepts tokens at the upper bound when the signature is valid', () => {
      // Genuine token issued by the store will be ~250 chars — well under
      // the 4096 cap. This asserts the cap doesn't reject legitimate
      // tokens in the typical size range.
      const token = store.issue({ sub: 'a', email: 'a@x', purpose: 'invite' });
      expect(token.length).toBeLessThan(4096);
      expect(store.verify(token).ok).toBe(true);
    });

    it('a 100KB attacker payload is rejected fast (no HMAC over 100KB)', () => {
      const huge = 'X'.repeat(100 * 1024);
      const t0 = process.hrtime.bigint();
      const verified = store.verify(huge);
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
      expect(verified.ok).toBe(false);
      // Way under any HMAC-of-100KB cost; the assertion is loose to
      // tolerate noisy CI runners.
      expect(elapsedMs).toBeLessThan(20);
    });
  });
});
