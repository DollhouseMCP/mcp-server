/**
 * Local Development Authentication Provider
 *
 * Issues and validates self-signed ES256 JWTs using an auto-generated
 * ECDSA key pair stored locally. Designed for development and testing —
 * no external dependencies, no network calls.
 *
 * Key pair lifecycle:
 * - Generated on first use and written to disk (mode 0600)
 * - Reused across server restarts from the same key file
 * - Key file location: DOLLHOUSE_AUTH_LOCAL_KEY_FILE or ~/.dollhouse/run/auth-keypair.json
 *
 * Tokens use standard JWT claims (iss, sub, aud, exp, iat) and are
 * validated with the same key pair that signed them. Swapping to a
 * production OIDC provider replaces this class via DI — no consumer
 * code changes.
 *
 * @module auth/LocalDevAuthProvider
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SignJWT, jwtVerify, importJWK, exportJWK, generateKeyPair } from 'jose';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { IAuthProvider, AuthResult, AuthClaims, IssueOptions } from './IAuthProvider.js';

const ISSUER = 'dollhousemcp-local';
const AUDIENCE = 'dollhousemcp';
const DEFAULT_TTL_SECONDS = 86400; // 24 hours
const ALGORITHM = 'ES256';

export interface LocalDevAuthProviderOptions {
  /** Path to the key pair file. Auto-generated if missing. */
  keyFilePath: string;
}

export class LocalDevAuthProvider implements IAuthProvider {
  readonly name = 'local-dev';

  private readonly keyFilePath: string;
  private privateKey: CryptoKey | Uint8Array | null = null;
  private publicKey: CryptoKey | Uint8Array | null = null;
  private initialized = false;

  constructor(options: LocalDevAuthProviderOptions) {
    this.keyFilePath = options.keyFilePath;
  }

  async validate(token: string): Promise<AuthResult> {
    await this.ensureInitialized();

    try {
      const { payload } = await jwtVerify(token, this.publicKey!, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALGORITHM],
      });

      if (!payload.sub) {
        return { ok: false, reason: 'token missing sub claim' };
      }

      const claims: AuthClaims = {
        sub: payload.sub,
        displayName: typeof payload.display_name === 'string' ? payload.display_name : undefined,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : null,
        scopes: Array.isArray(payload.scopes) ? payload.scopes as string[] : undefined,
        exp: payload.exp,
      };

      return { ok: true, claims };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('exp')) {
        return { ok: false, reason: 'token expired' };
      }
      if (message.includes('signature')) {
        return { ok: false, reason: 'invalid signature' };
      }
      return { ok: false, reason: 'token validation failed' };
    }
  }

  async issue(sub: string, options?: IssueOptions): Promise<string> {
    await this.ensureInitialized();

    const ttl = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const builder = new SignJWT({
      ...(options?.displayName ? { display_name: options.displayName } : {}),
      ...(options?.email ? { email: options.email } : {}),
      ...(options?.scopes?.length ? { scopes: options.scopes } : {}),
    })
      .setProtectedHeader({ alg: ALGORITHM })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`);

    return builder.sign(this.privateKey!);
  }

  /** Ensure key pair is loaded or generated. */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const raw = await fs.readFile(this.keyFilePath, 'utf-8');
      const stored = JSON.parse(raw) as { privateKey: Record<string, unknown>; publicKey: Record<string, unknown> };
      this.privateKey = await importJWK(stored.privateKey, ALGORITHM) as CryptoKey;
      this.publicKey = await importJWK(stored.publicKey, ALGORITHM) as CryptoKey;
      logger.info(`[LocalDevAuthProvider] Loaded key pair from ${this.keyFilePath}`);
    } catch {
      await this.generateAndStoreKeyPair();
    }

    this.initialized = true;
  }

  private async generateAndStoreKeyPair(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { extractable: true });
    this.privateKey = privateKey;
    this.publicKey = publicKey;

    const exported = {
      privateKey: await exportJWK(privateKey),
      publicKey: await exportJWK(publicKey),
      generatedAt: new Date().toISOString(),
    };

    await fs.mkdir(path.dirname(this.keyFilePath), { recursive: true });
    await fs.writeFile(this.keyFilePath, JSON.stringify(exported, null, 2), { mode: 0o600 });

    logger.info(`[LocalDevAuthProvider] Generated new ES256 key pair at ${this.keyFilePath}`);
    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_INITIALIZATION',
      severity: 'LOW',
      source: 'LocalDevAuthProvider',
      details: `Generated new authentication key pair at ${this.keyFilePath}`,
    });
  }
}
