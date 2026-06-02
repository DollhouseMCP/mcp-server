/**
 * Open Dynamic Client Registration handler for issue #2220.
 *
 * oidc-provider's built-in registration policies require Initial Access
 * Tokens. Hosted MCP clients such as Claude/Gemini auto-register without
 * IATs, so open-DCR uses this first-party handler: validate callback shape,
 * construct an oidc-provider Client, store it through the provider adapter,
 * and return RFC 7591-style client metadata.
 */

import { randomBytes } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import { logger } from '../../utils/logger.js';
import { validateDcrClientMetadata } from './dcrPolicy.js';

const DCR_BODY_LIMIT = '16kb';
const MAX_CLIENT_ID_ATTEMPTS = 5;
const DCR_RATE_LIMIT_WINDOW_MS = 60_000;
const DCR_RATE_LIMIT_MAX_REQUESTS = 60;

export interface DcrClientInstance {
  clientId: string;
  metadata(): Record<string, unknown>;
}

export interface DcrClientConstructor {
  new (metadata: Record<string, unknown>): DcrClientInstance;
  find(id: string): Promise<DcrClientInstance | undefined>;
  adapter: {
    upsert(id: string, payload: Record<string, unknown>): Promise<void>;
  };
}

export interface DcrProvider {
  Client: DcrClientConstructor;
}

interface DcrRateLimitBucket {
  count: number;
  resetAt: number;
}

export function createOpenDcrRegistrationHandlers(options: {
  ensureProvider: () => Promise<DcrProvider>;
}): RequestHandler[] {
  const rateLimitBuckets = new Map<string, DcrRateLimitBucket>();

  return [
    express.json({ type: 'application/json', limit: DCR_BODY_LIMIT }),
    (req, res, next) => {
      void (async () => {
        const rateLimit = consumeRateLimit(rateLimitBuckets, req.ip ?? req.socket.remoteAddress ?? 'unknown');
        if (!rateLimit.allowed) {
          res.set('Retry-After', String(Math.ceil(rateLimit.retryAfterMs / 1000)));
          res.status(429).json({
            error: 'too_many_requests',
            error_description: 'dynamic client registration rate limit exceeded',
          });
          return;
        }

        const decision = validateDcrClientMetadata(req.body);
        if (!decision.allowed) {
          logger.warn('[EmbeddedAuthorizationServer] open DCR registration rejected by policy', {
            errors: decision.errors,
            ip: req.ip,
          });
          res.status(400).json({
            error: 'invalid_client_metadata',
            error_description: decision.errors.join('; '),
          });
          return;
        }

        const provider = await options.ensureProvider();
        const metadata = await buildClientMetadata(req.body, provider.Client);
        const client = new provider.Client(metadata);
        await provider.Client.adapter.upsert(client.clientId, client.metadata());

        res.set({
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        });
        res.status(201).json(client.metadata());
      })().catch(next);
    },
  ];
}

function consumeRateLimit(
  buckets: Map<string, DcrRateLimitBucket>,
  key: string,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const now = Date.now();
  if (buckets.size > 1000) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }

  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + DCR_RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }
  if (current.count >= DCR_RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, retryAfterMs: current.resetAt - now };
  }
  current.count += 1;
  return { allowed: true };
}

async function buildClientMetadata(input: unknown, Client: DcrClientConstructor): Promise<Record<string, unknown>> {
  const body = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const metadata: Record<string, unknown> = { ...body };

  metadata.client_id = await generateUniqueClientId(Client);
  metadata.client_id_issued_at = Math.floor(Date.now() / 1000);
  metadata.id_token_signed_response_alg ??= 'ES256';
  metadata.token_endpoint_auth_method ??= 'none';
  metadata.grant_types ??= ['authorization_code', 'refresh_token'];
  metadata.response_types ??= ['code'];

  if (
    metadata.token_endpoint_auth_method === 'client_secret_basic'
    || metadata.token_endpoint_auth_method === 'client_secret_post'
  ) {
    metadata.client_secret = randomBytes(32).toString('base64url');
    metadata.client_secret_expires_at = 0;
  } else {
    delete metadata.client_secret;
    delete metadata.client_secret_expires_at;
  }

  return metadata;
}

async function generateUniqueClientId(Client: DcrClientConstructor): Promise<string> {
  for (let attempt = 0; attempt < MAX_CLIENT_ID_ATTEMPTS; attempt += 1) {
    const candidate = `dcr_${randomBytes(18).toString('base64url')}`;
    const existing = await Client.find(candidate);
    if (!existing) return candidate;
  }
  throw new Error('failed to allocate a unique dynamic client id');
}
