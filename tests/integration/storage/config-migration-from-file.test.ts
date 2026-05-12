/**
 * Phase 4.5 / Phase J: legacy config.yml + JWKS keyfile + cookie-secret
 * keyfile → DB-backed-stores migration.
 *
 * Runs against the InMemory storage backends (filesystem-realistic enough
 * for verifying the splitter + idempotence + key-preservation invariants
 * without requiring Postgres). The Postgres-specific persistence behavior
 * is already covered by the four storage parity suites.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';

import { runConfigToDatabaseMigration, readMarker } from '../../../src/storage/migration/configToDatabase.js';
import { InMemoryOperatorConfigStore } from '../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js';
import { InMemoryUserConfigStore } from '../../../src/storage/userConfig/InMemoryUserConfigStore.js';
import { InMemorySigningKeyStore } from '../../../src/storage/signingKeys/InMemorySigningKeyStore.js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000123';

const SAMPLE_CONFIG_YAML = `
version: 1
user:
  username: todd
  email: tdibble@gmail.com
github:
  auth:
    use_oauth: true
    client_id: Ov23liuTIXZr6wpIXxlL
  portfolio:
    repository_url: https://github.com/dibble/dollhouse-portfolio
sync:
  enabled: true
  individual:
    require_confirmation: false
  privacy:
    auto_consent: false
autoLoad:
  memories:
    - 'session-2026-04-29'
  token_budget: 4096
retentionPolicy:
  default_ttl_days: 90
wizard:
  completed: true
  last_step: 'finished'
display:
  show_persona_indicator: true
collection:
  auto_submit: false
  require_review: true
  add_attribution: true
source_priority:
  preferred_source: 'local'
elements:
  default_element_dir: '/home/todd/.dollhouse/portfolio'
  enhanced_index:
    limits:
      max_entries: 1000
    telemetry:
      enabled: true
    resources: true
  auto_activate:
    personas:
      - 'helpful-assistant'
console:
  port: 3700
license:
  tier: 'pro'
  attestation: 'sig-abc123'
`;

const SAMPLE_JWKS_KEYFILE = JSON.stringify({
  kid: 'jwks-test-1',
  generatedAt: new Date().toISOString(),
  privateKey: { kty: 'EC', crv: 'P-256', d: 'private-d', x: 'x', y: 'y' },
  publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
});

const SAMPLE_COOKIE_SECRET = Buffer.alloc(32, 0xab);

describe('configToDatabase migration', () => {
  let tmpRoot: string;
  let configRoot: string;
  let runRoot: string;
  let operatorStore: InMemoryOperatorConfigStore;
  let userStore: InMemoryUserConfigStore;
  let signingKeyStore: InMemorySigningKeyStore;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'config-migration-'));
    configRoot = path.join(tmpRoot, '.dollhouse');
    runRoot = path.join(configRoot, 'run');
    await fs.mkdir(runRoot, { recursive: true });
    operatorStore = new InMemoryOperatorConfigStore();
    userStore = new InMemoryUserConfigStore();
    signingKeyStore = new InMemorySigningKeyStore();
  });

  describe('skipped when no legacy state exists', () => {
    it('returns skipped-no-legacy-state and writes no marker', async () => {
      const result = await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
      });
      expect(result.status).toBe('skipped-no-legacy-state');
      expect(result.configMigrated).toBe(false);
      expect(result.jwksMigrated).toBe(false);
      expect(result.cookieSecretMigrated).toBe(false);
      // marker is NOT written when nothing was migrated
      expect(await readMarker(configRoot)).toBeNull();
    });
  });

  describe('full migration: config.yml + JWKS + cookie secret', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(configRoot, 'config.yml'), SAMPLE_CONFIG_YAML);
      await fs.writeFile(path.join(runRoot, 'oauth-signing-key.json'), SAMPLE_JWKS_KEYFILE);
      await fs.writeFile(path.join(runRoot, 'cookie-signing-secret.bin'), SAMPLE_COOKIE_SECRET);
    });

    it('migrates all three artifacts and writes the marker', async () => {
      const result = await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
      });
      expect(result.status).toBe('migrated');
      expect(result.configMigrated).toBe(true);
      expect(result.jwksMigrated).toBe(true);
      expect(result.cookieSecretMigrated).toBe(true);
      const marker = await readMarker(configRoot);
      expect(marker).not.toBeNull();
      expect(marker!.version).toBe(1);
    });

    it('routes per-host sections to operator store', async () => {
      await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
      });
      const op = await operatorStore.load();
      expect(op.consoleConfig).toEqual({ port: '3700' });
      expect(op.licenseConfig).toEqual({ tier: 'pro', attestation: 'sig-abc123' });
      expect(op.enhancedIndexConfig.resources).toBe('true');
      expect(op.defaultsConfig.version).toBe('1');
      expect(op.defaultsConfig.default_element_dir).toBe('/home/todd/.dollhouse/portfolio');
    });

    it('routes per-user sections to user store under the supplied userId', async () => {
      await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
      });
      const u = await userStore.load(TEST_USER_ID);
      expect(u.userIdentityConfig).toEqual({ username: 'todd', email: 'tdibble@gmail.com' });
      expect((u.githubConfig.auth as Record<string, unknown>).client_id).toBe('Ov23liuTIXZr6wpIXxlL');
      expect(u.syncConfig.enabled).toBe('true');
      expect(u.wizardConfig.completed).toBe('true');
      expect(u.autoActivateConfig.personas).toEqual(['helpful-assistant']);
    });

    it('preserves the original JWKS kid (currently-issued tokens stay valid)', async () => {
      await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
      });
      const active = await signingKeyStore.getActive('jwks');
      expect(active?.kid).toBe('jwks-test-1');
      expect(active?.payload).toMatchObject({
        privateKey: expect.objectContaining({ kty: 'EC' }),
        publicKey: expect.objectContaining({ kty: 'EC' }),
      });
    });

    it('preserves the original cookie secret bytes (existing cookies stay valid)', async () => {
      await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
      });
      const active = await signingKeyStore.getActive('cookie');
      expect(active?.kid).toMatch(/^cookie-migrated-/);
      const payload = active!.payload as { secret: string; length: number };
      expect(payload.length).toBe(32);
      expect(Buffer.from(payload.secret, 'base64').equals(SAMPLE_COOKIE_SECRET)).toBe(true);
    });
  });

  describe('idempotence', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(configRoot, 'config.yml'), SAMPLE_CONFIG_YAML);
      await fs.writeFile(path.join(runRoot, 'oauth-signing-key.json'), SAMPLE_JWKS_KEYFILE);
      await fs.writeFile(path.join(runRoot, 'cookie-signing-secret.bin'), SAMPLE_COOKIE_SECRET);
    });

    it('second invocation short-circuits via the marker', async () => {
      const first = await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
      });
      expect(first.status).toBe('migrated');
      const second = await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
      });
      expect(second.status).toBe('skipped-already-migrated');
      expect(second.configMigrated).toBe(false);
    });
  });

  describe('preview / dry-run mode', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(configRoot, 'config.yml'), SAMPLE_CONFIG_YAML);
    });

    it('returns preview status without writing to stores or marker', async () => {
      const result = await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
        dryRun: true,
      });
      expect(result.status).toBe('preview');
      expect(result.plan.operatorSectionsToWrite.length).toBeGreaterThan(0);
      expect(result.plan.userSectionsToWrite.length).toBeGreaterThan(0);
      // No writes occurred
      expect(await readMarker(configRoot)).toBeNull();
      const op = await operatorStore.load();
      expect(Object.keys(op.consoleConfig).length).toBe(0);
    });
  });

  describe('failure modes', () => {
    it('throws on malformed YAML rather than silently dropping config', async () => {
      await fs.writeFile(path.join(configRoot, 'config.yml'), 'not-an-object: [\n  unbalanced');
      await expect(
        runConfigToDatabaseMigration({
          operatorStore, userStore, signingKeyStore,
          userId: TEST_USER_ID,
          legacyConfigRoot: configRoot,
          legacyRunRoot: runRoot,
        }),
      ).rejects.toThrow();
    });

    it('throws on malformed JWKS keyfile rather than silently skipping', async () => {
      await fs.writeFile(path.join(runRoot, 'oauth-signing-key.json'), '{"not": "a-keypair"}');
      await expect(
        runConfigToDatabaseMigration({
          operatorStore, userStore, signingKeyStore,
          userId: TEST_USER_ID,
          legacyConfigRoot: configRoot,
          legacyRunRoot: runRoot,
        }),
      ).rejects.toThrow(/malformed/);
    });

    it('throws on too-short cookie secret rather than accepting weak material', async () => {
      await fs.writeFile(path.join(runRoot, 'cookie-signing-secret.bin'), Buffer.alloc(16));
      await expect(
        runConfigToDatabaseMigration({
          operatorStore, userStore, signingKeyStore,
          userId: TEST_USER_ID,
          legacyConfigRoot: configRoot,
          legacyRunRoot: runRoot,
        }),
      ).rejects.toThrow(/shorter than 32 bytes/);
    });
  });

  describe('keys-only migration (no config.yml)', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(runRoot, 'oauth-signing-key.json'), SAMPLE_JWKS_KEYFILE);
    });

    it('migrates JWKS even when config.yml is absent', async () => {
      const result = await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
      });
      expect(result.status).toBe('migrated');
      expect(result.configMigrated).toBe(false);
      expect(result.jwksMigrated).toBe(true);
      const active = await signingKeyStore.getActive('jwks');
      expect(active?.kid).toBe('jwks-test-1');
    });
  });

  describe('skip when DB already has active keys', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(runRoot, 'oauth-signing-key.json'), SAMPLE_JWKS_KEYFILE);
    });

    it('does not overwrite an existing active JWKS', async () => {
      // Pre-populate the store with a different active key
      await signingKeyStore.rotate({
        kid: 'preexisting-kid',
        kind: 'jwks',
        payload: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
      });
      await runConfigToDatabaseMigration({
        operatorStore, userStore, signingKeyStore,
        userId: TEST_USER_ID,
        legacyConfigRoot: configRoot,
        legacyRunRoot: runRoot,
      });
      const active = await signingKeyStore.getActive('jwks');
      expect(active?.kid).toBe('preexisting-kid');
    });
  });
});
