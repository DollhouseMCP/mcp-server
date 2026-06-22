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
import { validateDcrClientMetadata, type DcrPolicyAuditFinding } from './dcrPolicy.js';
import { normalizeIp } from './rateLimit.js';
import type { IAuthStorageLayer, IdentityAuditEvent } from './storage/IAuthStorageLayer.js';
import type { IRateLimitStore } from './storage/IRateLimitStore.js';

const DCR_BODY_LIMIT = '16kb';
const MAX_CLIENT_ID_ATTEMPTS = 5;
const DCR_RATE_LIMIT_WINDOW_MS = 60_000;
const DCR_RATE_LIMIT_MAX_REQUESTS = 60;
const DCR_RATE_LIMIT_SCOPE = 'open_dcr_registration';

export interface DcrClientInstance {
  clientId: string;
  metadata(): Record<string, unknown>;
}

export interface DcrClientConstructor {
  new (metadata: Record<string, unknown>): DcrClientInstance;
  find(id: string): Promise<DcrClientInstance | undefined>;
  adapter?: {
    upsert(id: string, payload: Record<string, unknown>): Promise<void>;
  };
}

export interface DcrProvider {
  Client: DcrClientConstructor;
}

interface DcrRateLimitState {
  count: number;
  windowStartedAt: number;
  limitFired?: boolean;
}

type DcrRateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; event?: 'limit_crossed' };

export function createOpenDcrRegistrationHandlers(options: {
  ensureProvider: () => Promise<DcrProvider>;
  rateLimitStore: IRateLimitStore;
  storage: IAuthStorageLayer;
}): RequestHandler[] {
  return [
    (req, res, next) => {
      void (async () => {
        const ip = normalizeIp(req.ip ?? req.socket.remoteAddress ?? 'unknown');
        const rateLimit = await consumeRateLimit(options.rateLimitStore, ip);
        if (!rateLimit.allowed) {
          res.set('Retry-After', String(Math.ceil(rateLimit.retryAfterMs / 1000)));
          if (rateLimit.event === 'limit_crossed') {
            await recordDcrAuditEvent(options.storage, {
              type: 'auth.dcr.registration_rejected',
              details: {
                reason: 'rate limit exceeded',
                ip,
              },
              timestamp: Date.now(),
            });
          }
          res.status(429).json({
            error: 'too_many_requests',
            error_description: 'dynamic client registration rate limit exceeded',
          });
          return;
        }

        next();
      })().catch((err) => {
        logger.warn('[EmbeddedAuthorizationServer] open DCR rate-limit store failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.set('Retry-After', '30');
        res.status(503).json({
          error: 'temporarily_unavailable',
          error_description: 'dynamic client registration is temporarily unavailable',
        });
      });
    },
    express.json({ type: 'application/json', limit: DCR_BODY_LIMIT }),
    (req, res, next) => {
      void (async () => {
        const ip = normalizeIp(req.ip ?? req.socket.remoteAddress ?? 'unknown');
        const decision = validateDcrClientMetadata(req.body);
        if (!decision.allowed) {
          logger.warn('[EmbeddedAuthorizationServer] open DCR registration rejected by policy', {
            errors: decision.errors,
            ip,
          });
          await recordDcrAuditEvent(options.storage, {
            type: 'auth.dcr.registration_rejected',
            details: buildDcrAuditDetails(req.body, ip, {
              errors: decision.errors,
              redirectHosts: decision.redirectHosts,
              auditFindings: decision.auditFindings,
            }),
            timestamp: Date.now(),
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
        await upsertClientMetadata(provider.Client, client.clientId, client.metadata());
        await recordDcrAuditEvent(options.storage, {
          type: 'auth.dcr.registration_accepted',
          details: buildDcrAuditDetails(metadata, ip, {
            clientId: client.clientId,
            redirectHosts: decision.redirectHosts,
            auditFindings: decision.auditFindings,
          }),
          timestamp: Date.now(),
        });

        res.set({
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        });
        res.status(201).json(client.metadata());
      })().catch(next);
    },
  ];
}

async function consumeRateLimit(
  store: IRateLimitStore,
  key: string,
): Promise<DcrRateLimitDecision> {
  const now = Date.now();
  const update = await store.update<DcrRateLimitState, DcrRateLimitDecision>(
    DCR_RATE_LIMIT_SCOPE,
    key,
    (prev) => {
      if (!prev || now - prev.windowStartedAt >= DCR_RATE_LIMIT_WINDOW_MS) {
        return {
          state: { count: 1, windowStartedAt: now },
          result: { allowed: true },
        };
      }

      const retryAfterMs = Math.max(1, DCR_RATE_LIMIT_WINDOW_MS - (now - prev.windowStartedAt));
      if (prev.count >= DCR_RATE_LIMIT_MAX_REQUESTS) {
        const state = prev.limitFired ? prev : { ...prev, limitFired: true };
        return {
          state,
          result: {
            allowed: false,
            retryAfterMs,
            ...(prev.limitFired ? {} : { event: 'limit_crossed' as const }),
          },
        };
      }

      const next = { ...prev, count: prev.count + 1 };
      return {
        state: next,
        result: { allowed: true },
      };
    },
    {
      expiresAt: now + DCR_RATE_LIMIT_WINDOW_MS * 2,
      maxRetries: 5,
    },
  );
  return update.result ?? { allowed: true };
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
  delete metadata.client_secret;
  delete metadata.client_secret_expires_at;

  return metadata;
}

async function upsertClientMetadata(
  Client: DcrClientConstructor,
  clientId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!Client.adapter) {
    throw new Error('dynamic client adapter is unavailable');
  }
  await Client.adapter.upsert(clientId, metadata);
}

async function generateUniqueClientId(Client: DcrClientConstructor): Promise<string> {
  for (let attempt = 0; attempt < MAX_CLIENT_ID_ATTEMPTS; attempt += 1) {
    const candidate = `dcr_${randomBytes(18).toString('base64url')}`;
    const existing = await Client.find(candidate);
    if (!existing) return candidate;
  }
  throw new Error('failed to allocate a unique dynamic client id');
}

async function recordDcrAuditEvent(storage: IAuthStorageLayer, event: IdentityAuditEvent): Promise<void> {
  try {
    await storage.recordIdentityEvent(event);
  } catch (err) {
    logger.warn('[EmbeddedAuthorizationServer] failed to record open DCR audit event', {
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildDcrAuditDetails(
  metadata: unknown,
  ip: string,
  context: {
    clientId?: string;
    errors?: string[];
    redirectHosts: string[];
    auditFindings: DcrPolicyAuditFinding[];
  },
): Record<string, unknown> {
  const body = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return {
    ip,
    clientId: context.clientId,
    clientName: stringValue(body.client_name),
    redirectHosts: context.redirectHosts,
    redirectUriCount: Array.isArray(body.redirect_uris) ? body.redirect_uris.length : undefined,
    applicationType: stringValue(body.application_type),
    tokenEndpointAuthMethod: stringValue(body.token_endpoint_auth_method),
    errors: context.errors,
    metadataAuditFindings: context.auditFindings,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
