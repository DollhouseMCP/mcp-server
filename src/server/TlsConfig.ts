/**
 * TlsConfig
 *
 * Loads and validates TLS certificate + key from disk for the HTTP transport
 * (and any other surface that needs HTTPS — web console, admin endpoints).
 * The presence of both paths activates HTTPS in createHttpOrHttpsServer().
 *
 * Reads DOLLHOUSE_TLS_CERT_PATH and DOLLHOUSE_TLS_KEY_PATH from env by default;
 * accepts overrides via constructor for tests.
 *
 * @module server/TlsConfig
 */

import * as fs from 'node:fs';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface TlsConfigOptions {
  certPath?: string;
  keyPath?: string;
}

export class TlsConfig {
  private readonly certPath: string | undefined;
  private readonly keyPath: string | undefined;
  private cachedOptions: HttpsServerOptions | null | undefined;

  constructor(options: TlsConfigOptions = {}) {
    this.certPath = options.certPath ?? env.DOLLHOUSE_TLS_CERT_PATH;
    this.keyPath = options.keyPath ?? env.DOLLHOUSE_TLS_KEY_PATH;
  }

  isEnabled(): boolean {
    return Boolean(this.certPath && this.keyPath);
  }

  /**
   * Returns https.ServerOptions with the loaded cert+key, or null when TLS is
   * not configured. Throws if only one of cert/key is set, or if either file
   * is missing/unreadable/empty. Result is cached after first successful load.
   */
  toServerOptions(): HttpsServerOptions | null {
    if (this.cachedOptions !== undefined) {
      return this.cachedOptions;
    }

    if (!this.certPath && !this.keyPath) {
      this.cachedOptions = null;
      return null;
    }

    if (!this.certPath || !this.keyPath) {
      throw new Error(
        'TLS misconfigured: both DOLLHOUSE_TLS_CERT_PATH and DOLLHOUSE_TLS_KEY_PATH must be set together.',
      );
    }

    const cert = readPemOrThrow(this.certPath, 'DOLLHOUSE_TLS_CERT_PATH');
    const key = readPemOrThrow(this.keyPath, 'DOLLHOUSE_TLS_KEY_PATH');

    this.cachedOptions = { cert, key };
    logger.info('[TlsConfig] TLS enabled', { certPath: this.certPath, keyPath: this.keyPath });
    return this.cachedOptions;
  }
}

function readPemOrThrow(path: string, envName: string): Buffer {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`TLS misconfigured: ${envName}=${path} is not readable (${reason}).`);
  }

  if (!stat.isFile()) {
    throw new Error(`TLS misconfigured: ${envName}=${path} is not a regular file.`);
  }

  if (stat.size === 0) {
    throw new Error(`TLS misconfigured: ${envName}=${path} is empty.`);
  }

  return fs.readFileSync(path);
}
