/**
 * InteractionRouter
 *
 * Express router mounted at /interaction/:uid by EmbeddedAuthorizationServer.
 * Bridges between the active IAuthMethod and oidc-provider's interaction
 * lifecycle.
 *
 * Flow:
 *   1. Browser hits POST /authorize → oidc-provider creates an Interaction
 *      record and redirects 303 to /interaction/:uid.
 *   2. GET /interaction/:uid: read Interaction details, call IAuthMethod
 *      .beginInteraction. If render-html, send the page (with a CSRF token
 *      stamped into the form). If redirect, send 303 to the target URL.
 *   3. POST /interaction/:uid: verify CSRF, call IAuthMethod
 *      .completeInteraction. On 'authenticated', upsert the account and
 *      tell oidc-provider via interactionFinished({ login, consent }).
 *      On 'next-step', send the next step's HTML/redirect. On 'denied',
 *      finish with an OAuth error.
 *
 * CSRF (must-fix #6): a random token is generated on render-html and stored
 * in IAuthStorageLayer.genericSet under model 'InteractionCsrf', keyed on
 * interactionId, with a TTL matching oidc-provider's interaction TTL.
 * Verified on POST and destroyed.
 *
 * @module auth/embedded-as/InteractionRouter
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger.js';
import type { IAuthMethod, InteractionContext } from './IAuthMethod.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

const CSRF_MODEL = 'InteractionCsrf';
const CSRF_TTL_SECONDS = 600; // 10 min, matches oidc-provider's default interaction TTL.

export interface OidcInteractionDetails {
  uid: string;
  params: Record<string, unknown>;
  prompt: { name: string; details: Record<string, unknown> };
  session?: { accountId?: string };
  grantId?: string;
}

interface OidcGrantInstance {
  accountId?: string;
  clientId?: string;
  addOIDCScope(scope: string): void;
  addResourceScope(resource: string, scope: string): void;
  save(): Promise<string>;
}

interface OidcGrantConstructor {
  new (init: { accountId: string; clientId: string }): OidcGrantInstance;
  find(id: string): Promise<OidcGrantInstance | undefined>;
}

export interface OidcProviderForInteractions {
  interactionDetails(req: Request, res: Response): Promise<OidcInteractionDetails>;
  interactionFinished(
    req: Request,
    res: Response,
    result: Record<string, unknown>,
    options?: { mergeWithLastSubmission?: boolean },
  ): Promise<void>;
  Grant: OidcGrantConstructor;
}

export interface InteractionRouterDeps {
  provider: OidcProviderForInteractions;
  /**
   * Configured auth methods for this AS. Single-method deployments pass
   * one element; multi-method deployments pass several. The router's
   * dispatch logic (see Phase 2.3 — LoginChooser) decides which method
   * handles an incoming interaction.
   */
  methods: readonly IAuthMethod[];
  storage: IAuthStorageLayer;
}

export function createInteractionRouter(deps: InteractionRouterDeps): Router {
  const { provider, methods, storage } = deps;
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  router.use(express.json({ limit: '32kb' }));

  // Until Phase 2.3 lands the chooser + per-method dispatch, the router
  // only handles single-method deployments. Multi-method input throws so
  // operators don't get a silent first-method-only behavior.
  const resolveMethod = (): IAuthMethod => {
    if (methods.length !== 1) {
      throw new Error(
        `InteractionRouter received ${methods.length} methods. ` +
        `Multi-method dispatch requires the LoginChooser (Phase 2.3); ` +
        `single-method deployments pass exactly one method.`,
      );
    }
    return methods[0]!;
  };

  router.get('/:uid', (req, res) => {
    void handleGet(req, res, provider, resolveMethod, storage);
  });

  router.post('/:uid', (req, res) => {
    void handlePost(req, res, provider, resolveMethod, storage);
  });

  return router;
}

async function handleGet(
  req: Request,
  res: Response,
  provider: OidcProviderForInteractions,
  resolveMethod: () => IAuthMethod,
  storage: IAuthStorageLayer,
): Promise<void> {
  let details;
  try {
    details = await provider.interactionDetails(req, res);
  } catch (err) {
    sendError(res, 400, 'invalid_interaction', describeError(err));
    return;
  }

  const method = resolveMethod();
  const ctx = makeContext(details, req);

  const step = await method.beginInteraction(ctx);

  if (step.kind === 'redirect') {
    res.redirect(303, step.url);
    return;
  }

  // render-html: stamp a CSRF token, persist it, splice into the rendered HTML.
  const csrfToken = randomBytes(32).toString('base64url');
  await storage.genericSet(CSRF_MODEL, details.uid, { token: csrfToken }, CSRF_TTL_SECONDS);

  const html = ensureCsrfInForm(step.html, csrfToken);
  res.type('html').send(html);
}

async function handlePost(
  req: Request,
  res: Response,
  provider: OidcProviderForInteractions,
  resolveMethod: () => IAuthMethod,
  storage: IAuthStorageLayer,
): Promise<void> {
  let details;
  try {
    details = await provider.interactionDetails(req, res);
  } catch (err) {
    sendError(res, 400, 'invalid_interaction', describeError(err));
    return;
  }

  // CSRF (must-fix #6): a render-html step from the GET handler stored a token
  // in IAuthStorageLayer. Methods that begin via a redirect (social login) don't
  // store a CSRF token here — their callback verification lives in their own
  // completeInteraction (e.g. OAuth `state` for GitHub).
  const persistedCsrf = await storage.genericGet(CSRF_MODEL, details.uid) as { token?: string } | null;
  if (persistedCsrf?.token) {
    const submitted = bodyValue(req, 'csrf_token');
    if (!submitted || !constantTimeStringEq(submitted, persistedCsrf.token)) {
      sendError(res, 403, 'invalid_csrf', 'CSRF token missing or invalid');
      return;
    }
    // Single-use: destroy regardless of method outcome.
    await storage.genericDestroy(CSRF_MODEL, details.uid);
  }

  const method = resolveMethod();
  const ctx = makeContext(details, req);

  const result = await method.completeInteraction(ctx, {
    formBody: req.body && typeof req.body === 'object' ? (req.body as Record<string, string>) : undefined,
    query: req.query as Record<string, string>,
    ip: req.ip ?? 'unknown',
  });

  if (result.kind === 'denied') {
    sendError(res, 400, 'access_denied', result.reason);
    return;
  }

  if (result.kind === 'next-step') {
    if (result.step.kind === 'redirect') {
      res.redirect(303, result.step.url);
      return;
    }
    // Re-stamp CSRF for the new render-html step.
    const csrfToken = randomBytes(32).toString('base64url');
    await storage.genericSet(CSRF_MODEL, details.uid, { token: csrfToken }, CSRF_TTL_SECONDS);
    res.type('html').send(ensureCsrfInForm(result.step.html, csrfToken));
    return;
  }

  await finishInteractionWithIdentity(req, res, provider, details, result.identity.sub, storage);
}

/**
 * Shared interaction-completion helper. Manages the oidc-provider Grant
 * explicitly (so oidc-provider doesn't synthesize a second consent
 * interaction), splits OIDC standard scopes from resource scopes, stamps
 * `account.lastAuthAt` so subsequent token issuance can populate the
 * `auth_time` claim, and calls provider.interactionFinished.
 *
 * Used by:
 *   - The InteractionRouter POST handler when an IAuthMethod returns
 *     `authenticated` from completeInteraction.
 *   - EmbeddedAuthorizationServer's /auth/social/github/callback route,
 *     after GithubSocialMethod.processCallback returns the identity.
 */
export async function finishInteractionWithIdentity(
  req: Request,
  res: Response,
  provider: OidcProviderForInteractions,
  details: OidcInteractionDetails,
  accountId: string,
  storage: IAuthStorageLayer,
): Promise<void> {
  try {
    const requestedScope = String(details.params.scope ?? '');
    const clientId = String(details.params.client_id ?? '');
    const requestedResource = details.params.resource;
    const { oidcScopes, resourceScopes } = splitScopes(requestedScope);

    let grantId = details.grantId;
    let grant: OidcGrantInstance | undefined;
    if (grantId) {
      grant = await provider.Grant.find(grantId);
    }
    if (!grant) {
      grant = new provider.Grant({ accountId, clientId });
    }
    if (oidcScopes.length > 0) {
      grant.addOIDCScope(oidcScopes.join(' '));
    }
    if (resourceScopes.length > 0) {
      const resources = Array.isArray(requestedResource) ? requestedResource : [requestedResource];
      for (const r of resources) {
        if (typeof r === 'string' && r.length > 0) {
          grant.addResourceScope(r, resourceScopes.join(' '));
        }
      }
    }
    grantId = await grant.save();

    // Stamp lastAuthAt before interactionFinished so the redirect-to-token
    // round-trip that follows can read a fresh value via extraTokenClaims.
    // Best-effort: a missing account row (race / new account) is logged but
    // not fatal — the auth_time claim will simply be omitted.
    const existing = await storage.getAccount(accountId);
    if (existing) {
      const now = Date.now();
      await storage.upsertAccount({ ...existing, lastAuthAt: now, updatedAt: now });
    } else {
      logger.warn('[InteractionRouter] no account row to stamp lastAuthAt', { accountId });
    }

    await provider.interactionFinished(req, res, {
      login: { accountId },
      consent: { grantId },
    });
  } catch (err) {
    logger.error('[InteractionRouter] interactionFinished failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      sendError(res, 500, 'server_error', 'Failed to finish interaction');
    }
  }
}

const OIDC_STANDARD_SCOPES = new Set([
  'openid',
  'profile',
  'email',
  'address',
  'phone',
  'offline_access',
]);

function splitScopes(combined: string): { oidcScopes: string[]; resourceScopes: string[] } {
  const oidcScopes: string[] = [];
  const resourceScopes: string[] = [];
  for (const s of combined.split(/\s+/).filter(Boolean)) {
    if (OIDC_STANDARD_SCOPES.has(s)) {
      oidcScopes.push(s);
    } else {
      resourceScopes.push(s);
    }
  }
  return { oidcScopes, resourceScopes };
}

function makeContext(
  details: { uid: string; params: Record<string, unknown> },
  req: Request,
): InteractionContext {
  return {
    interactionId: details.uid,
    clientId: String(details.params.client_id ?? ''),
    requestedScopes: typeof details.params.scope === 'string'
      ? details.params.scope.split(/\s+/).filter(Boolean)
      : [],
    requestUrl: req.originalUrl,
  };
}

function ensureCsrfInForm(html: string, csrfToken: string): string {
  // Insert a hidden CSRF input as the first <form> child. Methods can include
  // their own placeholder (the empty csrfInput in TrivialConsentMethod is a
  // no-op when no token was available), but the router is the source of truth.
  return html.replace(
    /<form\b([^>]*)>/i,
    (_match, attrs) =>
      `<form${attrs}>\n      <input type="hidden" name="csrf_token" value="${escapeHtmlAttr(csrfToken)}">`,
  );
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function bodyValue(req: Request, field: string): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[field];
  return typeof value === 'string' ? value : undefined;
}

function constantTimeStringEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sendError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
