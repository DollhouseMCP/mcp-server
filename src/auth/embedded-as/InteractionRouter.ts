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
import type {
  IAuthMethod,
  InteractionContext,
  InteractionResult,
  InteractionStep,
} from './IAuthMethod.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

const CSRF_MODEL = 'InteractionCsrf';
const CSRF_TTL_SECONDS = 600; // 10 min, matches oidc-provider's default interaction TTL.
const METHOD_CHOICE_MODEL = 'InteractionMethodChoice';
const METHOD_CHOICE_TTL_SECONDS = 600; // matches CSRF + Interaction TTL

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

  // H8: route handlers forward errors to Express's `next` so unhandled
  // rejections in handleGet/handlePost surface as a real 500 instead of
  // a hung request (the prior `void` discard swallowed the rejection).
  router.get('/:uid', (req, res, next) => {
    handleGet(req, res, provider, methods, storage).catch(next);
  });

  router.post('/:uid', (req, res, next) => {
    handlePost(req, res, provider, methods, storage).catch(next);
  });

  return router;
}

type MethodResolution =
  | { kind: 'method'; method: IAuthMethod }
  | { kind: 'chooser' };

/**
 * Decide which method handles this interaction.
 *
 * Single-method deployments always return that method.
 *
 * Multi-method deployments:
 *   1. If the request carries `?method=<id>` (chooser link clicked),
 *      validate against the configured set, persist the choice for the
 *      subsequent POST, and return that method.
 *   2. Else if a prior choice was persisted (e.g. POST after GET render),
 *      look it up.
 *   3. Else return `{ kind: 'chooser' }` — caller renders the chooser.
 */
async function resolveMethodForRequest(
  req: Request,
  details: OidcInteractionDetails,
  methods: readonly IAuthMethod[],
  storage: IAuthStorageLayer,
): Promise<MethodResolution> {
  if (methods.length === 1) return { kind: 'method', method: methods[0]! };

  const queryMethod = typeof req.query.method === 'string' ? req.query.method : null;
  if (queryMethod) {
    const found = methods.find((m) => m.id === queryMethod);
    if (found) {
      await storage.genericSet(
        METHOD_CHOICE_MODEL,
        details.uid,
        { methodId: found.id },
        METHOD_CHOICE_TTL_SECONDS,
      );
      return { kind: 'method', method: found };
    }
    // Invalid id falls through to either a stored choice or the chooser.
  }

  const stored = (await storage.genericGet(METHOD_CHOICE_MODEL, details.uid)) as
    | { methodId?: string }
    | null;
  if (stored?.methodId) {
    const found = methods.find((m) => m.id === stored.methodId);
    if (found) return { kind: 'method', method: found };
  }

  return { kind: 'chooser' };
}

async function handleGet(
  req: Request,
  res: Response,
  provider: OidcProviderForInteractions,
  methods: readonly IAuthMethod[],
  storage: IAuthStorageLayer,
): Promise<void> {
  let details;
  try {
    details = await provider.interactionDetails(req, res);
  } catch (err) {
    sendError(res, 400, 'invalid_interaction', describeError(err));
    return;
  }

  const resolution = await resolveMethodForRequest(req, details, methods, storage);
  if (resolution.kind === 'chooser') {
    res.type('html').send(renderLoginChooser(methods, details.uid));
    return;
  }

  const method = resolution.method;
  const ctx = makeContext(details, req);

  // H8: catch beginInteraction throws so a method bug surfaces as a
  // structured 500 instead of a silent hang.
  let step: InteractionStep;
  try {
    step = await method.beginInteraction(ctx);
  } catch (err) {
    logger.error('[InteractionRouter] beginInteraction threw', {
      methodId: method.id,
      interactionId: details.uid,
      error: err instanceof Error ? err.message : String(err),
    });
    sendError(res, 500, 'server_error', 'method beginInteraction failed');
    return;
  }

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
  methods: readonly IAuthMethod[],
  storage: IAuthStorageLayer,
): Promise<void> {
  let details;
  try {
    details = await provider.interactionDetails(req, res);
  } catch (err) {
    sendError(res, 400, 'invalid_interaction', describeError(err));
    return;
  }

  const resolution = await resolveMethodForRequest(req, details, methods, storage);
  if (resolution.kind === 'chooser') {
    // POST without a stored method choice — the user submitted the
    // interaction form before picking a method. Tell them to restart
    // rather than silently picking one.
    sendError(res, 400, 'invalid_interaction', 'no auth method selected; restart sign-in');
    return;
  }

  // CSRF (must-fix #6 + H13): require a CSRF record for every POST to
  // /interaction/:uid. A POST without a record is either:
  //   (a) Submission before any GET render-html step — illegitimate.
  //   (b) Replay after a previous successful POST consumed the token —
  //       attacker re-submitting a back-button form.
  // The earlier shape (`if (persistedCsrf?.token) verify; else fall
  // through`) silently bypassed CSRF in case (b). Methods that begin
  // via a redirect (social login) handle their callback on their own
  // contributeRoutes path, NOT on /interaction/:uid POST — so any
  // redirect-flow request reaching this handler without a CSRF record
  // is also illegitimate.
  const persistedCsrf = await storage.genericGet(CSRF_MODEL, details.uid) as { token?: string } | null;
  if (!persistedCsrf?.token) {
    sendError(res, 403, 'invalid_csrf', 'CSRF token missing or invalid');
    return;
  }
  const submitted = bodyValue(req, 'csrf_token');
  if (!submitted || !constantTimeStringEq(submitted, persistedCsrf.token)) {
    sendError(res, 403, 'invalid_csrf', 'CSRF token missing or invalid');
    return;
  }
  // Single-use: destroy regardless of method outcome. A subsequent
  // next-step render-html stamps a fresh record before the user sees
  // the next form.
  await storage.genericDestroy(CSRF_MODEL, details.uid);

  const method = resolution.method;
  const ctx = makeContext(details, req);

  // H8: catch completeInteraction throws.
  let result: InteractionResult;
  try {
    result = await method.completeInteraction(ctx, {
      formBody: req.body && typeof req.body === 'object' ? (req.body as Record<string, string>) : undefined,
      query: req.query as Record<string, string>,
      ip: req.ip ?? 'unknown',
    });
  } catch (err) {
    logger.error('[InteractionRouter] completeInteraction threw', {
      methodId: method.id,
      interactionId: details.uid,
      error: err instanceof Error ? err.message : String(err),
    });
    sendError(res, 500, 'server_error', 'method completeInteraction failed');
    return;
  }

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
    // Use the targeted updateAccountLastAuth so we don't race a concurrent
    // upsert (e.g. a fresh GitHub login on another tab) and clobber its
    // freshly-fetched displayName/rawProfile via the read-modify-write
    // path. Best-effort: a missing account row (new account / race) just
    // logs — the auth_time claim is omitted.
    const stamped = await storage.updateAccountLastAuth(accountId, Date.now());
    if (!stamped) {
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
  // Insert a hidden CSRF input as the first child of EVERY <form>.
  // Methods can include their own placeholder (the empty csrfInput
  // in TrivialConsentMethod is a no-op when no token was available),
  // but the router is the source of truth.
  //
  // Cycle-10 HIGH fix: previously this used a single regex replace
  // (no /g flag), so only the FIRST <form> on the page got the CSRF
  // token. `LocalAccountMethod`'s render renders TWO <form>s on the
  // login-or-invite page (one for sign-in, one for invite redemption);
  // the second form's POST was rejected with 403 because no
  // csrf_token field. The fix: replaceAll-equivalent regex with /g
  // flag so every form gets a token. They share the same per-render
  // CSRF token, which is correct — the token is bound to the
  // interaction, not to a specific form.
  return html.replace(
    /<form\b([^>]*)>/gi,
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

/**
 * Method chooser shown when more than one auth method is configured and
 * the user hasn't yet picked one. Each option is a GET link to the same
 * interaction URL with `?method=<id>` appended; clicking persists the
 * choice and dispatches to that method's beginInteraction.
 *
 * Kept inline (rather than in each method) because the chooser is a
 * cross-method concern — it knows about the menu, not any particular
 * method's render behavior.
 */
function renderLoginChooser(methods: readonly IAuthMethod[], interactionId: string): string {
  const safeUid = escapeHtmlAttr(interactionId);
  const items = methods.map((m) => {
    const safeId = escapeHtmlAttr(m.id);
    const safeLabel = m.displayName
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `      <li><a href="/interaction/${safeUid}?method=${safeId}">${safeLabel}</a></li>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in to DollhouseMCP</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:420px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}ul{list-style:none;padding:0;margin:24px 0}li{margin:8px 0}a{display:block;padding:12px 16px;background:#185c37;color:white;text-decoration:none;border-radius:6px;font-weight:700}a:hover{background:#143f25}</style>
</head><body><main>
<h1>Sign in to DollhouseMCP</h1>
<p>Choose how to sign in:</p>
<ul>
${items}
    </ul>
</main></body></html>`;
}
