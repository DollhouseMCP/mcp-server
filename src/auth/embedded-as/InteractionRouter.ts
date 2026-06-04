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
import { sendAuthError } from './browserErrorPage.js';
import type {
  IAuthMethod,
  AuthenticatedIdentity,
  InteractionContext,
  InteractionResult,
  InteractionStep,
} from './IAuthMethod.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';
import type { AdminTotpService } from './totp/AdminTotpService.js';
import type { IConsoleIdentityResolver } from '../../web-console/identity/IConsoleIdentityResolver.js';
import type { IRateLimitStore } from './storage/IRateLimitStore.js';
import {
  adminTotpRateLimitSubject,
  checkAdminTotpRateLimit,
  noteAdminTotpFailure,
  resetAdminTotpRateLimit,
} from './totp/AdminTotpRateLimit.js';

const CSRF_MODEL = 'InteractionCsrf';
const CSRF_TTL_SECONDS = 600; // 10 min, matches oidc-provider's default interaction TTL.
const METHOD_CHOICE_MODEL = 'InteractionMethodChoice';
const METHOD_CHOICE_TTL_SECONDS = 600; // matches CSRF + Interaction TTL
const ADMIN_ACR = 'urn:dollhouse:acr:admin-stepup';
const ADMIN_STEP_UP_PENDING_MODEL = 'AdminStepUpPending';
export const ADMIN_STEP_UP_CLAIMS_MODEL = 'AdminStepUpClaims';
const ADMIN_STEP_UP_TTL_SECONDS = 600;
const ADMIN_TOTP_PROOF_SCOPE = 'admin_totp_stepup';

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
  /**
   * Cycle 24 fix: the AS's resource URL, used as the fallback when an
   * authorize request didn't include `resource=...` but did request a
   * resource scope (e.g. `mcp`). Without this fallback, the grant gets
   * an OIDC-scope binding but no resource-scope binding, oidc-provider
   * re-prompts on every /auth resume, and the consent flow loops forever.
   * Mirrors the same value oidc-provider's `resourceIndicators.defaultResource`
   * callback returns.
   */
  defaultResource: string;
  adminStepUp?: AdminStepUpInteractionDeps;
}

export interface AdminStepUpInteractionDeps {
  totpService: Pick<AdminTotpService, 'hasActiveFactor' | 'prove'>;
  identityResolver: IConsoleIdentityResolver;
  rateLimitStore?: IRateLimitStore;
  now?: () => Date;
}

export interface AdminStepUpClaims {
  accountId: string;
  acr: typeof ADMIN_ACR;
  amr: readonly string[];
  authTime: number;
}

export interface FinishInteractionOptions {
  storage: IAuthStorageLayer;
  defaultResource: string;
  adminClaims?: AdminStepUpClaims;
}

export function createInteractionRouter(deps: InteractionRouterDeps): Router {
  const { provider, methods, storage, defaultResource, adminStepUp } = deps;
  const router = express.Router();
  // Cycle-13 fix (HIGH): cap urlencoded body at 4kb to match the
  // per-method routers (LocalAccountMethod, MagicLinkMethod). The
  // earlier shape used Express's 100kb default, which left the
  // unauthenticated interaction POST as a sibling-fix-miss of the
  // body-cap-by-route pattern those methods already enforce. CSRF
  // token + form fields fit comfortably under 4kb. JSON parser also
  // tightened from 32kb to 4kb (no JSON consumer needs more here).
  router.use(express.urlencoded({ extended: false, limit: '4kb' }));
  router.use(express.json({ limit: '4kb' }));

  // H8: route handlers forward errors to Express's `next` so unhandled
  // rejections in handleGet/handlePost surface as a real 500 instead of
  // a hung request (the prior `void` discard swallowed the rejection).
  router.get('/:uid', (req, res, next) => {
    handleGet(req, res, provider, methods, storage).catch(next);
  });

  router.post('/:uid', (req, res, next) => {
    handlePost(req, res, provider, methods, storage, defaultResource, adminStepUp).catch(next);
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
  if (methods.length === 1) return { kind: 'method', method: methods[0] };

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
    sendError(res, req, 400, 'invalid_interaction', describeError(err));
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
    sendError(res, req, 500, 'server_error', 'method beginInteraction failed');
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
  defaultResource: string,
  adminStepUp: AdminStepUpInteractionDeps | undefined,
): Promise<void> {
  let details;
  try {
    details = await provider.interactionDetails(req, res);
  } catch (err) {
    sendError(res, req, 400, 'invalid_interaction', describeError(err));
    return;
  }

  const resolution = await resolveMethodForRequest(req, details, methods, storage);
  if (resolution.kind === 'chooser') {
    // POST without a stored method choice — the user submitted the
    // interaction form before picking a method. Tell them to restart
    // rather than silently picking one.
    sendError(res, req, 400, 'invalid_interaction', 'no auth method selected; restart sign-in');
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
    sendError(res, req, 403, 'invalid_csrf', 'CSRF token missing or invalid');
    return;
  }
  const submitted = bodyValue(req, 'csrf_token');
  if (!submitted || !constantTimeStringEq(submitted, persistedCsrf.token)) {
    sendError(res, req, 403, 'invalid_csrf', 'CSRF token missing or invalid');
    return;
  }
  // Single-use: destroy regardless of method outcome. A subsequent
  // next-step render-html stamps a fresh record before the user sees
  // the next form.
  await storage.genericDestroy(CSRF_MODEL, details.uid);

  const pendingAdminStepUp = await readPendingAdminStepUp(storage, details.uid);
  if (pendingAdminStepUp) {
    await completeAdminStepUpProof(req, res, storage, {
      provider,
      details,
      defaultResource,
      pending: pendingAdminStepUp,
      adminStepUp,
    });
    return;
  }

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
    sendError(res, req, 500, 'server_error', 'method completeInteraction failed');
    return;
  }

  if (result.kind === 'denied') {
    sendError(res, req, 400, 'access_denied', result.reason);
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

  if (isAdminStepUpRequest(details)) {
    await beginAdminStepUpProof(req, res, storage, details, result.identity, adminStepUp);
    return;
  }

  await finishInteractionWithIdentity(req, res, provider, details, result.identity.sub, {
    storage,
    defaultResource,
  });
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
  options: FinishInteractionOptions,
): Promise<void> {
  try {
    const { storage, defaultResource, adminClaims } = options;
    const grantId = await resolveAndSaveGrant(provider, details, accountId, defaultResource);
    if (adminClaims) {
      await storage.genericSet(ADMIN_STEP_UP_CLAIMS_MODEL, grantId, adminClaims, ADMIN_STEP_UP_TTL_SECONDS);
    }

    // Stamp lastAuthAt before interactionFinished so the redirect-to-token
    // round-trip that follows can read a fresh value via extraTokenClaims.
    // Use the targeted updateAccountLastAuth so we don't race a concurrent
    // upsert (e.g. a fresh GitHub login on another tab) and clobber its
    // freshly-fetched displayName/rawProfile via the read-modify-write
    // path. Best-effort: a missing account row (new account / race) just
    // logs — the auth_time claim is omitted.
    const stamped = await storage.updateAccountLastAuth(
      accountId,
      adminClaims ? adminClaims.authTime * 1000 : Date.now(),
    );
    if (!stamped) {
      logger.warn('[InteractionRouter] no account row to stamp lastAuthAt', { accountId });
    }

    // Admin step-up acr/amr/auth_time must go on the LOGIN RESULT so
    // oidc-provider stamps them natively into the id_token (which the BFF
    // reads). extraTokenClaims only populates access tokens, not id_tokens, so
    // relying on it alone left the id_token without amr=otp and the BFF
    // rejected the elevation. `ts` is the OIDC auth_time (seconds).
    await provider.interactionFinished(req, res, {
      login: adminClaims
        ? { accountId, acr: adminClaims.acr, amr: [...adminClaims.amr], ts: adminClaims.authTime }
        : { accountId },
      consent: { grantId },
    });
  } catch (err) {
    logger.error('[InteractionRouter] interactionFinished failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      sendError(res, req, 500, 'server_error', 'Failed to finish interaction');
    }
  }
}

interface PendingAdminStepUp {
  accountId: string;
  userId: string;
}

interface AdminStepUpProofContext {
  provider: OidcProviderForInteractions;
  details: OidcInteractionDetails;
  defaultResource: string;
  pending: PendingAdminStepUp;
  adminStepUp?: AdminStepUpInteractionDeps;
}

export function isAdminStepUpRequest(details: OidcInteractionDetails): boolean {
  return typeof details.params.acr_values === 'string'
    && details.params.acr_values.split(/\s+/).includes(ADMIN_ACR);
}

async function readPendingAdminStepUp(
  storage: IAuthStorageLayer,
  interactionId: string,
): Promise<PendingAdminStepUp | null> {
  const raw = await storage.genericGet(ADMIN_STEP_UP_PENDING_MODEL, interactionId);
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  return typeof value.accountId === 'string' && typeof value.userId === 'string'
    ? { accountId: value.accountId, userId: value.userId }
    : null;
}

export async function beginAdminStepUpProof(
  req: Request,
  res: Response,
  storage: IAuthStorageLayer,
  details: OidcInteractionDetails,
  identity: AuthenticatedIdentity,
  adminStepUp: AdminStepUpInteractionDeps | undefined,
): Promise<void> {
  if (!adminStepUp) {
    sendError(res, req, 400, 'access_denied', 'administrative step-up is not configured');
    return;
  }
  const principal = await adminStepUp.identityResolver.resolveEnabledPrincipal(identity.sub);
  if (!principal || !(await adminStepUp.totpService.hasActiveFactor(principal.userId))) {
    await recordAdminProofFailure(storage, identity.sub, 'factor_not_enrolled');
    sendError(res, req, 400, 'access_denied', 'administrative TOTP factor is required');
    return;
  }
  await storage.genericSet(
    ADMIN_STEP_UP_PENDING_MODEL,
    details.uid,
    { accountId: identity.sub, userId: principal.userId },
    ADMIN_STEP_UP_TTL_SECONDS,
  );
  await renderAdminProofStep(req, res, storage, details.uid, null);
}

async function completeAdminStepUpProof(
  req: Request,
  res: Response,
  storage: IAuthStorageLayer,
  context: AdminStepUpProofContext,
): Promise<void> {
  const { provider, details, defaultResource, pending, adminStepUp } = context;
  if (!adminStepUp) {
    sendError(res, req, 400, 'access_denied', 'administrative step-up is not configured');
    return;
  }
  const code = bodyValue(req, 'code') ?? '';
  const rateSubject = adminTotpRateLimitSubject(pending.userId, req.ip);
  const check = await checkAdminTotpRateLimit(adminStepUp.rateLimitStore, ADMIN_TOTP_PROOF_SCOPE, rateSubject);
  if (!check.allowed) {
    sendError(res, req, 429, 'rate_limited', 'too many administrative proof attempts');
    return;
  }

  const proof = await adminStepUp.totpService.prove(pending.userId, code);
  if (!proof.ok) {
    await noteAdminTotpFailure(adminStepUp.rateLimitStore, ADMIN_TOTP_PROOF_SCOPE, rateSubject);
    await recordAdminProofFailure(storage, pending.accountId, 'invalid_totp_code');
    await renderAdminProofStep(req, res, storage, details.uid, 'Invalid authentication code.');
    return;
  }
  await resetAdminTotpRateLimit(adminStepUp.rateLimitStore, ADMIN_TOTP_PROOF_SCOPE, rateSubject);
  await storage.genericDestroy(ADMIN_STEP_UP_PENDING_MODEL, details.uid);
  await storage.recordIdentityEvent({
    type: proof.method === 'backup'
      ? 'auth.admin_step_up.backup_code_consumed'
      : 'auth.admin_step_up.succeeded',
    sub: pending.accountId,
    details: { method: proof.method },
    timestamp: proof.authTime.getTime(),
  });
  await finishInteractionWithIdentity(req, res, provider, details, pending.accountId, {
    storage,
    defaultResource,
    adminClaims: {
      accountId: pending.accountId,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: Math.floor(proof.authTime.getTime() / 1000),
    },
  });
}

async function renderAdminProofStep(
  _req: Request,
  res: Response,
  storage: IAuthStorageLayer,
  interactionId: string,
  error: string | null,
): Promise<void> {
  const csrfToken = randomBytes(32).toString('base64url');
  await storage.genericSet(CSRF_MODEL, interactionId, { token: csrfToken }, CSRF_TTL_SECONDS);
  const errorHtml = error ? `<p role="alert">${escapeHtml(error)}</p>` : '';
  res.type('html').send(ensureCsrfInForm(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Administrative verification</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f4;color:#181816}main{max-width:420px;margin:12vh auto;padding:32px;background:white;border:1px solid #d8d6cc;border-radius:8px}label,input,button{display:block;width:100%;box-sizing:border-box}input{margin:8px 0 16px;padding:10px}button{padding:12px 16px;background:#185c37;color:white;border:0;border-radius:6px;font-weight:700}</style>
</head><body><main>
<h1>Administrative verification</h1>
${errorHtml}
<form method="post" action="/interaction/${encodeURIComponent(interactionId)}">
<label for="code">Authentication code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
<button type="submit">Continue</button>
</form>
</main></body></html>`, csrfToken));
}

async function recordAdminProofFailure(
  storage: IAuthStorageLayer,
  sub: string,
  reason: string,
): Promise<void> {
  await storage.recordIdentityEvent({
    type: 'auth.admin_step_up.failed',
    sub,
    details: { reason },
    timestamp: Date.now(),
  });
}

/**
 * Resolve (or create) the OIDC Grant for this interaction, bind all
 * requested scopes to both OIDC + resource dimensions (cycle 24 fix —
 * scopes that appear in both dimensions need to be in both grant lists
 * or the consent prompt re-fires), and save. Returns the saved grant id.
 */
async function resolveAndSaveGrant(
  provider: OidcProviderForInteractions,
  details: OidcInteractionDetails,
  accountId: string,
  defaultResource: string,
): Promise<string> {
  // Explicit string-narrowing: details.params values are typed as unknown
  // in oidc-provider. String(obj) would yield "[object Object]" if a
  // caller put non-string content there.
  const requestedScope = typeof details.params.scope === 'string' ? details.params.scope : '';
  const clientId = typeof details.params.client_id === 'string' ? details.params.client_id : '';
  // Use the explicitly-passed resource(s) when present; otherwise fall
  // back to the AS's default resource. Cycle 24 fix.
  const requestedResource = details.params.resource ?? defaultResource;
  const { oidcScopes, resourceScopes } = splitScopes(requestedScope);

  const grant = await findOrCreateGrant(provider, details.grantId, accountId, clientId);
  bindAllScopesToGrant(grant, [...oidcScopes, ...resourceScopes], requestedResource);
  return grant.save();
}

async function findOrCreateGrant(
  provider: OidcProviderForInteractions,
  existingGrantId: string | undefined,
  accountId: string,
  clientId: string,
): Promise<OidcGrantInstance> {
  if (existingGrantId) {
    const found = await provider.Grant.find(existingGrantId);
    if (found) return found;
  }
  return new provider.Grant({ accountId, clientId });
}

function bindAllScopesToGrant(
  grant: OidcGrantInstance,
  allScopes: string[],
  requestedResource: unknown,
): void {
  if (allScopes.length === 0) return;
  // Cycle 24 fix: oidc-provider's prompt-resolution checks `missingOIDCScope`
  // and `missingResourceScopes` independently. A scope that appears in BOTH
  // `scopes` (the OIDC-level config) AND `getResourceServerInfo.scope` (the
  // resource-server scope set) needs to be in BOTH grant dimensions or the
  // prompt re-fires. Our `mcp` scope is in both. Adding ALL requested scopes
  // to BOTH dimensions is safe: oidc-provider ignores scopes that aren't
  // valid for a given dimension.
  const joined = allScopes.join(' ');
  grant.addOIDCScope(joined);
  const resources = Array.isArray(requestedResource) ? requestedResource : [requestedResource];
  for (const r of resources) {
    if (typeof r === 'string' && r.length > 0) {
      grant.addResourceScope(r, joined);
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
    clientId: typeof details.params.client_id === 'string' ? details.params.client_id : '',
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
  return html.replaceAll(
    /<form\b([^>]*)>/gi,
    (_match, attrs) =>
      `<form${attrs}>\n      <input type="hidden" name="csrf_token" value="${escapeHtmlAttr(csrfToken)}">`,
  );
}

function escapeHtmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function bodyValue(req: Request, field: string): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[field];
  return typeof value === 'string' ? value : undefined;
}

function constantTimeStringEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Cycle-17 sibling-fix: pad-and-compare so length mismatch doesn't
  // take a different code path from content mismatch. Matches the
  // pattern in inviteTokens.ts and interactionCookieBinding.ts.
  // CSRF tokens are fixed-length (43 base64url chars) so a length
  // mismatch always means forgery.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function sendError(res: Response, req: Request, status: number, error: string, description: string): void {
  sendAuthError(res, req, status, error, description);
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
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
