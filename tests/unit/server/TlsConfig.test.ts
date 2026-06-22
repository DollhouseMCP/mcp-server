import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TlsConfig } from '../../../src/server/TlsConfig.js';

describe('TlsConfig', () => {
  let testDir: string;
  let certPath: string;
  let keyPath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-tls-'));
    certPath = path.join(testDir, 'cert.pem');
    keyPath = path.join(testDir, 'key.pem');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('reports disabled when no paths are configured', () => {
    const config = new TlsConfig({ certPath: undefined, keyPath: undefined });
    expect(config.isEnabled()).toBe(false);
    expect(config.toServerOptions()).toBeNull();
  });

  it('returns server options when both paths point to readable PEM files', async () => {
    await fs.writeFile(certPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    await fs.writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n');

    const config = new TlsConfig({ certPath, keyPath });
    expect(config.isEnabled()).toBe(true);

    const options = config.toServerOptions();
    expect(options).not.toBeNull();
    expect(options!.cert).toBeInstanceOf(Buffer);
    expect(options!.key).toBeInstanceOf(Buffer);
    // Cycle-13 fix: pin TLSv1.2 minimum. A regression that drops this
    // would let Node's default acceptance of TLS 1.0/1.1 (on older
    // base images) ship silently.
    expect(options!.minVersion).toBe('TLSv1.2');
  });

  it('throws when only one of cert/key is set', () => {
    const config = new TlsConfig({ certPath, keyPath: undefined });
    expect(() => config.toServerOptions()).toThrow(/both DOLLHOUSE_TLS_CERT_PATH and DOLLHOUSE_TLS_KEY_PATH must be set/);
  });

  it('throws when the cert file does not exist', () => {
    const config = new TlsConfig({ certPath: path.join(testDir, 'missing.pem'), keyPath });
    expect(() => config.toServerOptions()).toThrow(/DOLLHOUSE_TLS_CERT_PATH=.*is not readable/);
  });

  it('throws when the key file is empty', async () => {
    await fs.writeFile(certPath, 'cert');
    await fs.writeFile(keyPath, '');

    const config = new TlsConfig({ certPath, keyPath });
    expect(() => config.toServerOptions()).toThrow(/DOLLHOUSE_TLS_KEY_PATH=.*is empty/);
  });

  it('caches the loaded options across calls', async () => {
    await fs.writeFile(certPath, 'cert-content');
    await fs.writeFile(keyPath, 'key-content');

    const config = new TlsConfig({ certPath, keyPath });
    const first = config.toServerOptions();
    const second = config.toServerOptions();
    expect(second).toBe(first);
  });
});
