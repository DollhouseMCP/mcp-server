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
 *      .completeInteraction. On 'authenticated', render the hosted
 *      OAuth-client consent page before oidc-provider receives
 *      interactionFinished({ login, consent }). On 'next-step', send the
 *      next step's HTML/redirect. On 'denied', finish with an OAuth error.
 *
 * CSRF (must-fix #6): a random token is generated on render-html and stored
 * in IAuthStorageLayer.genericSet under model 'InteractionCsrf', keyed on
 * interactionId, with a TTL matching oidc-provider's interaction TTL.
 * Verified on POST and destroyed.
 *
 * @module auth/embedded-as/InteractionRouter
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger.js';
import type {
  AuthenticatedIdentity,
  IAuthMethod,
  InteractionContext,
  InteractionResult,
  InteractionStep,
} from './IAuthMethod.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';
import { allowCspFormActionOrigin } from './securityHeaders.js';

const CSRF_MODEL = 'InteractionCsrf';
const CSRF_TTL_SECONDS = 600; // 10 min, matches oidc-provider's default interaction TTL.
const METHOD_CHOICE_MODEL = 'InteractionMethodChoice';
const METHOD_CHOICE_TTL_SECONDS = 600; // matches CSRF + Interaction TTL
const PENDING_CLIENT_CONSENT_MODEL = 'PendingClientConsentIdentity';
const CLIENT_CONSENT_SEEN_MODEL = 'ClientConsentSeen';
const CLIENT_CONSENT_APPROVE_ACTION = 'authorize_oauth_client';
const CLIENT_CONSENT_DENY_ACTION = 'deny_oauth_client';
const INTERACTION_COOKIE_NAME = '_interaction';
const INTERACTION_SIG_COOKIE_NAME = '_interaction.sig';

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

interface OidcClientForConsent {
  clientId?: string;
  clientName?: string;
  redirectUris?: string[];
  applicationType?: string;
  scope?: string;
  metadata?(): Record<string, unknown>;
}

interface OidcClientConstructorForConsent {
  find(id: string): Promise<OidcClientForConsent | undefined>;
}

export interface ClientConsentIdentitySummary {
  sub: string;
  displayName?: string;
  email?: string;
  provider?: string;
  providerUsername?: string;
}

interface PendingClientConsentIdentity {
  accountId?: string;
  createdAt?: number;
  clientId?: string;
  firstSeen?: boolean;
  identity?: ClientConsentIdentitySummary;
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
  Client?: OidcClientConstructorForConsent;
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
}

export function createInteractionRouter(deps: InteractionRouterDeps): Router {
  const { provider, methods, storage, defaultResource } = deps;
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
    handlePost(req, res, provider, methods, storage, defaultResource).catch(next);
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
    logInteractionDetailsFailure(req, 'GET', err);
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
  defaultResource: string,
): Promise<void> {
  let details;
  try {
    details = await provider.interactionDetails(req, res);
  } catch (err) {
    logInteractionDetailsFailure(req, 'POST', err);
    sendError(res, 400, 'invalid_interaction', describeError(err));
    return;
  }

  const action = bodyValue(req, 'action');
  if (isClientConsentAction(action)) {
    await handleClientConsentPost(req, res, provider, storage, defaultResource, details, action);
    return;
  }

  await handleAuthMethodPost(req, res, provider, methods, storage, defaultResource, details);
}

function isClientConsentAction(action: string | undefined): action is
  | typeof CLIENT_CONSENT_APPROVE_ACTION
  | typeof CLIENT_CONSENT_DENY_ACTION {
  return action === CLIENT_CONSENT_APPROVE_ACTION || action === CLIENT_CONSENT_DENY_ACTION;
}

async function handleClientConsentPost(
  req: Request,
  res: Response,
  provider: OidcProviderForInteractions,
  storage: IAuthStorageLayer,
  defaultResource: string,
  details: OidcInteractionDetails,
  action: typeof CLIENT_CONSENT_APPROVE_ACTION | typeof CLIENT_CONSENT_DENY_ACTION,
): Promise<void> {
  const csrfOk = await verifyAndConsumeCsrf(req, res, storage, details.uid);
  if (!csrfOk) return;

  const pending = await storage.genericGet(PENDING_CLIENT_CONSENT_MODEL, details.uid) as
    | PendingClientConsentIdentity
    | null;
  await storage.genericDestroy(PENDING_CLIENT_CONSENT_MODEL, details.uid);

  if (action === CLIENT_CONSENT_DENY_ACTION) {
    await recordClientConsentAuditEvent(storage, 'auth.client_consent.denied', {
      details,
      pending,
      defaultResource,
    });
    await provider.interactionFinished(req, res, {
      error: 'access_denied',
      error_description: 'End-User denied client authorization',
    }, { mergeWithLastSubmission: false });
    return;
  }

  if (!pending?.accountId) {
    sendError(res, 400, 'invalid_interaction', 'no pending client consent found; restart sign-in');
    return;
  }

  await markClientConsentSeen(storage, pending.accountId, paramString(details.params.client_id));
  await recordClientConsentAuditEvent(storage, 'auth.client_consent.approved', {
    details,
    pending,
    defaultResource,
  });
  await finishInteractionWithIdentity(
    req,
    res,
    provider,
    details,
    pending.accountId,
    storage,
    defaultResource,
  );
}

async function handleAuthMethodPost(
  req: Request,
  res: Response,
  provider: OidcProviderForInteractions,
  methods: readonly IAuthMethod[],
  storage: IAuthStorageLayer,
  defaultResource: string,
  details: OidcInteractionDetails,
): Promise<void> {
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
  const csrfOk = await verifyAndConsumeCsrf(req, res, storage, details.uid);
  if (!csrfOk) return;

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

  await renderClientConsentForIdentity(
    res,
    provider,
    details,
    result.identity.sub,
    storage,
    defaultResource,
    buildClientConsentIdentitySummary(method, result.identity),
  );
}

function buildClientConsentIdentitySummary(
  method: IAuthMethod,
  identity: AuthenticatedIdentity,
): ClientConsentIdentitySummary {
  return {
    sub: identity.sub,
    displayName: identity.displayName,
    email: identity.email,
    provider: method.id,
    providerUsername: method.id === 'github' && typeof identity.raw?.githubUsername === 'string'
      ? identity.raw.githubUsername
      : undefined,
  };
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
  /**
   * Cycle 24 fix: fallback resource URL applied when the client requested
   * a resource scope (e.g. `mcp`) but didn't pass `resource=...` on the
   * authorize request. Without this, the grant's resource-scope binding
   * is empty, oidc-provider observes the grant doesn't satisfy the
   * requested scopes, and re-prompts via a new interaction — looping
   * forever. Mirrors the AS's `resourceIndicators.defaultResource`
   * callback. Passed by callers from the AS's resource URL (`this.resource`).
   */
  defaultResource: string,
): Promise<void> {
  try {
    await storage.genericDestroy(PENDING_CLIENT_CONSENT_MODEL, details.uid);
    const grantId = await resolveAndSaveGrant(provider, details, accountId, defaultResource);

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

/**
 * Render Dollhouse's client-consent page after an external auth method has
 * authenticated and allowlisted the user, but before oidc-provider issues an
 * authorization code. This is the hosted-DCR safety stop from #2220: unknown
 * MCP clients are allowed, while the user still sees the client name, callback
 * host, scopes, and resource before tokens are minted.
 */
export async function renderClientConsentForIdentity(
  res: Response,
  provider: OidcProviderForInteractions,
  details: OidcInteractionDetails,
  accountId: string,
  storage: IAuthStorageLayer,
  defaultResource: string,
  identity?: ClientConsentIdentitySummary,
): Promise<void> {
  const clientId = paramString(details.params.client_id) || 'unknown-client';
  const firstSeen = !(await hasSeenClientConsent(storage, accountId, clientId));
  await storage.genericSet(
    PENDING_CLIENT_CONSENT_MODEL,
    details.uid,
    {
      accountId,
      clientId,
      firstSeen,
      identity,
      createdAt: Date.now(),
    },
    CSRF_TTL_SECONDS,
  );
  const csrfToken = randomBytes(32).toString('base64url');
  await storage.genericSet(CSRF_MODEL, details.uid, { token: csrfToken }, CSRF_TTL_SECONDS);
  allowOAuthRedirectFormAction(res, details);
  const html = await renderOAuthClientConsentPage(provider, details, csrfToken, defaultResource, {
    identity,
    firstSeen,
  });
  res.type('html').send(html);
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

async function verifyAndConsumeCsrf(
  req: Request,
  res: Response,
  storage: IAuthStorageLayer,
  interactionId: string,
): Promise<boolean> {
  const persistedCsrf = await storage.genericGet(CSRF_MODEL, interactionId) as { token?: string } | null;
  if (!persistedCsrf?.token) {
    sendError(res, 403, 'invalid_csrf', 'CSRF token missing or invalid');
    return false;
  }
  const submitted = bodyValue(req, 'csrf_token');
  if (!submitted || !constantTimeStringEq(submitted, persistedCsrf.token)) {
    sendError(res, 403, 'invalid_csrf', 'CSRF token missing or invalid');
    return false;
  }
  // Single-use: destroy regardless of method outcome. A subsequent
  // next-step render-html or client-consent page stamps a fresh record.
  await storage.genericDestroy(CSRF_MODEL, interactionId);
  return true;
}

async function renderOAuthClientConsentPage(
  provider: OidcProviderForInteractions,
  details: OidcInteractionDetails,
  csrfToken: string,
  defaultResource: string,
  consent: {
    identity?: ClientConsentIdentitySummary;
    firstSeen: boolean;
  },
): Promise<string> {
  const view = await buildClientConsentView(provider, details, defaultResource);
  const scopes = renderScopeList(view.scopes);
  const redirectList = view.registeredRedirectUris.length > 0
    ? view.registeredRedirectUris.slice(0, 5).map((uri) => `<li><code>${escapeHtmlText(uri)}</code></li>`).join('\n')
    : '<li>Not available from client metadata</li>';
  const redirectOverflow = view.registeredRedirectUris.length > 5
    ? `<li>and ${view.registeredRedirectUris.length - 5} more</li>`
    : '';
  const clientUri = view.clientUri
    ? `<a href="${escapeHtmlAttr(view.clientUri)}" rel="noreferrer">${escapeHtmlText(view.clientUri)}</a>`
    : '<span class="muted">Not provided</span>';
  const identitySummary = consent.identity
    ? renderIdentityCard(consent.identity)
    : '<span class="muted">Authenticated DollhouseMCP account</span>';
  const historyLabel = consent.firstSeen
    ? 'New client for this account'
    : 'Previously authorized by this account';
  const historyClass = consent.firstSeen
    ? 'auth-badge auth-badge--accent'
    : 'auth-badge';
  const authorizationSummary = consent.firstSeen
    ? 'Review this client before granting access.'
    : 'This client has been authorized before for this account.';
  const clientWebsiteRow = view.clientUri
    ? `<div><dt>Client website</dt><dd>${clientUri}</dd></div>`
    : '';
  const signedInHeading = consent.identity?.provider
    ? `Signed in with ${providerDisplayName(consent.identity.provider)}`
    : 'Signed in';
  const authorizationHost = hostFromDisplayResource(view.resource);

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DollhouseMCP Authorization - Authorize ${escapeHtmlText(view.clientName)}</title>
  <link rel="icon" type="image/png" href="/dollhouse-logo.png">
  <link rel="apple-touch-icon" href="/dollhouse-logo.png">
  <link rel="stylesheet" href="/fonts.css">
  <style>
    :root {
      color-scheme: light;
      --ink-950: #0a1020;
      --ink-900: #18243a;
      --ink-700: #324563;
      --ink-500: #677893;
      --line: #c8d5e9;
      --paper: #f3f7ff;
      --paper-strong: #ffffff;
      --surface-1: #eaf1ff;
      --surface-2: #f8fbff;
      --signal: #1e40af;
      --signal-2: #3b82f6;
      --accent: #f97316;
      --accent-soft: #fff1e5;
      --shadow-soft: 0 0.95rem 1.8rem -1.15rem rgba(17, 40, 74, 0.28);
      --shadow-card: 0 1.5rem 2.9rem -1.35rem rgba(13, 35, 69, 0.34);
      --font-body: "Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-heading: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
      --step--1: clamp(0.78rem, 0.75rem + 0.15vw, 0.87rem);
      --step-0: clamp(0.93rem, 0.88rem + 0.25vw, 1.05rem);
      --step-1: clamp(1.1rem, 1rem + 0.5vw, 1.28rem);
      --step-2: clamp(1.3rem, 1.16rem + 0.7vw, 1.6rem);
      --gutter: clamp(1rem, 0.72rem + 1.15vw, 1.95rem);
    }
    * { box-sizing: border-box; }
    html { min-height: 100%; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink-900);
      background:
        radial-gradient(110% 55% at 0% 0%, color-mix(in srgb, var(--signal-2) 7%, transparent), transparent 55%),
        radial-gradient(85% 45% at 100% 0%, color-mix(in srgb, var(--accent) 4%, transparent), transparent 50%),
        var(--paper);
      font-family: var(--font-body);
      font-size: var(--step-0);
      line-height: 1.62;
    }
    .page-noise {
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(135deg, color-mix(in srgb, var(--signal) 4%, transparent) 0.75px, transparent 0.75px),
        linear-gradient(45deg, color-mix(in srgb, var(--accent) 3%, transparent) 0.75px, transparent 0.75px);
      background-size: 24px 24px, 34px 34px;
      z-index: -1;
    }
    .site-header {
      position: sticky;
      top: 0;
      z-index: 35;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-areas:
        "brand controls"
        "nav nav";
      align-items: center;
      column-gap: 1rem;
      row-gap: 0.12rem;
      padding: 0.44rem var(--gutter) 0.4rem;
      border-bottom: 1px solid var(--line);
      background: color-mix(in srgb, var(--paper-strong) 90%, transparent);
      backdrop-filter: blur(8px);
    }
    .site-header::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: -1px;
      height: 2px;
      background: linear-gradient(90deg,
        color-mix(in srgb, var(--signal) 10%, transparent),
        color-mix(in srgb, var(--accent) 12%, transparent),
        color-mix(in srgb, var(--signal) 10%, transparent));
      pointer-events: none;
    }
    .header-brand {
      grid-area: brand;
      display: flex;
      align-items: center;
      gap: 0.6rem;
      min-width: 0;
      min-height: 2.35rem;
    }
    .header-logo {
      width: 32px;
      height: 32px;
      flex-shrink: 0;
    }
    .header-brand-text {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 0.05rem;
      min-width: 0;
      min-height: 2.35rem;
    }
    .site-title {
      margin: 0;
      color: var(--ink-950);
      font-family: var(--font-heading);
      font-size: var(--step-1);
      font-weight: 800;
      line-height: 1.2;
    }
    .site-tagline {
      margin: 0;
      color: var(--ink-700);
      font-size: var(--step--1);
      line-height: 1.15;
    }
    .header-controls {
      grid-area: controls;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 0.65rem;
      min-width: 0;
    }
    .host-stat {
      display: inline-flex;
      align-items: baseline;
      gap: 0.24rem;
      max-width: min(44vw, 26rem);
      border: 1px solid color-mix(in srgb, var(--line) 88%, var(--paper-strong));
      border-radius: 0.32rem;
      background: color-mix(in srgb, var(--surface-2) 65%, var(--paper-strong));
      padding: 0.14rem 0.44rem;
      color: var(--ink-500);
      font-family: var(--font-mono);
      font-size: 0.72rem;
      overflow-wrap: anywhere;
    }
    .host-stat strong {
      color: var(--ink-950);
      font-family: var(--font-heading);
      font-size: var(--step-0);
      font-weight: 800;
    }
    .header-nav-row {
      grid-area: nav;
      display: flex;
      justify-content: flex-end;
      min-width: 0;
    }
    .console-tabs {
      display: flex;
      gap: 2px;
      width: fit-content;
      max-width: 100%;
      border-radius: 0.42rem;
      background: var(--surface-1);
      padding: 2px;
    }
    .console-tab {
      border: none;
      border-radius: 0.42rem;
      background: var(--paper-strong);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
      color: var(--signal);
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0.02em;
      padding: 4px 14px;
    }
    .auth-shell {
      width: min(76rem, calc(100vw - (2 * var(--gutter))));
      margin: 1.65rem auto 2.4rem;
    }
    main {
      display: grid;
      gap: 1rem;
    }
    .auth-hero {
      border: 1px solid var(--line);
      border-radius: 0.5rem;
      background:
        linear-gradient(135deg,
          color-mix(in srgb, var(--signal-2) 6%, var(--surface-2)),
          var(--surface-2) 60%);
      box-shadow: var(--shadow-soft);
      overflow: hidden;
    }
    .hero-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.75rem 1rem;
      background: var(--paper-strong);
      border-bottom: 1px solid var(--line);
    }
    .eyebrow {
      margin: 0;
      color: var(--ink-500);
      font-family: var(--font-mono);
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .client-chip {
      min-width: 0;
      max-width: 55%;
      border: 1px solid color-mix(in srgb, var(--signal) 24%, var(--line));
      border-radius: 999px;
      background: color-mix(in srgb, var(--surface-1) 70%, var(--paper-strong));
      color: var(--ink-700);
      font-family: var(--font-mono);
      font-size: 0.72rem;
      font-weight: 700;
      line-height: 1;
      overflow: hidden;
      padding: 0.48rem 0.78rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hero-body {
      padding: 1.45rem 1.6rem 1.5rem;
    }
    h1 {
      margin: 0 0 0.5rem;
      color: var(--ink-950);
      font-family: var(--font-heading);
      font-size: var(--step-2);
      font-weight: 800;
      line-height: 1.15;
    }
    h2 {
      margin: 0;
      color: var(--ink-950);
      font-family: var(--font-heading);
      font-size: var(--step-1);
      font-weight: 700;
      line-height: 1.24;
    }
    p {
      line-height: 1.5;
      margin: 0;
    }
    a {
      color: var(--signal);
      text-decoration-thickness: 0.08em;
      text-underline-offset: 0.16em;
    }
    a:hover { color: var(--accent); }
    code {
      border-radius: 0.1875rem;
      background: var(--surface-1);
      color: var(--ink-900);
      font-family: var(--font-mono);
      font-size: 0.78rem;
      padding: 0.05rem 0.22rem;
      overflow-wrap: anywhere;
    }
    .subtitle {
      max-width: 69ch;
      color: var(--ink-700);
      font-size: var(--step-0);
    }
    .auth-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 21rem;
      gap: 1rem;
      align-items: start;
    }
    .auth-card {
      border: 1px solid var(--line);
      border-radius: 0.5rem;
      background: var(--paper-strong);
      overflow: hidden;
    }
    .auth-card-header {
      padding: 0.75rem 1rem;
      background: var(--surface-2);
      border-bottom: 1px solid var(--line);
    }
    .auth-card-body {
      padding: 1rem;
    }
    .section + .section { margin-top: 1rem; }
    .scope-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.62rem;
    }
    .scope-list li {
      border: 1px solid var(--line);
      border-radius: 0.42rem;
      background: var(--surface-2);
      padding: 0.75rem 0.85rem;
    }
    .scope-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.75rem;
      color: var(--ink-900);
      font-family: var(--font-heading);
      font-size: 0.93rem;
      font-weight: 700;
    }
    .scope-title code {
      flex-shrink: 0;
      color: var(--ink-500);
      font-weight: 500;
    }
    .scope-desc {
      color: var(--ink-700);
      font-size: var(--step--1);
      margin-top: 0.2rem;
    }
    .side {
      display: grid;
      gap: 1rem;
      align-content: start;
    }
    .summary-card {
      border: 1px solid var(--line);
      border-radius: 0.5rem;
      background: var(--paper-strong);
      overflow: hidden;
    }
    .summary-card h2,
    .details-panel h2 {
      padding: 0.75rem 1rem;
      background: var(--surface-2);
      border-bottom: 1px solid var(--line);
      font-size: 0.875rem;
      font-weight: 600;
    }
    .summary-card-body,
    .details-body {
      padding: 1rem;
    }
    .summary-card--primary {
      background:
        linear-gradient(135deg,
          color-mix(in srgb, var(--accent) 7%, var(--paper-strong)),
          var(--paper-strong) 56%);
    }
    dl {
      display: grid;
      gap: 0.65rem;
      margin: 0;
    }
    dl > div {
      min-width: 0;
    }
    dt {
      color: var(--ink-500);
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      margin-bottom: 0.18rem;
      text-transform: uppercase;
    }
    dd {
      margin: 0;
      min-width: 0;
      color: var(--ink-900);
      font-size: 0.9rem;
      overflow-wrap: anywhere;
    }
    .identity {
      display: flex;
      flex-direction: column;
      gap: 0.18rem;
      min-width: 0;
    }
    .identity strong {
      color: var(--ink-950);
      font-family: var(--font-heading);
      font-size: var(--step-0);
      font-weight: 800;
    }
    .muted {
      color: var(--ink-700);
      font-size: var(--step--1);
    }
    .auth-badge {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, #22c55e 30%, var(--line));
      background: color-mix(in srgb, #22c55e 15%, var(--surface-1));
      color: #16a34a;
      font-family: var(--font-mono);
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      padding: 0.15rem 0.5rem;
      text-transform: uppercase;
    }
    .auth-badge--accent {
      border-color: color-mix(in srgb, var(--accent) 35%, var(--line));
      background: var(--accent-soft);
      color: #9a3412;
    }
    .details-panel {
      border: 1px solid var(--line);
      border-radius: 0.5rem;
      background: var(--paper-strong);
      overflow: hidden;
    }
    .callbacks-title {
      margin: 1rem -1rem 0;
    }
    summary {
      cursor: pointer;
      color: var(--signal);
      font-family: var(--font-heading);
      font-weight: 700;
      list-style-position: inside;
      padding: 0.75rem 1rem;
      background: var(--surface-2);
      border-bottom: 1px solid var(--line);
    }
    .redirect-list {
      margin: 0.7rem 0 0;
      padding-left: 1.15rem;
      color: var(--ink-700);
      font-size: var(--step--1);
    }
    form {
      display: flex;
      gap: 0.8rem;
      flex-wrap: wrap;
      margin-top: 1rem;
    }
    .side form {
      margin-top: 0;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.6rem;
      border-radius: 0.42rem;
      cursor: pointer;
      font-family: var(--font-mono);
      font-size: 0.88rem;
      font-weight: 700;
      padding: 0.55rem 1.4rem;
      transition: transform 0.12s, box-shadow 0.12s, background 0.12s;
    }
    button:hover,
    button:focus-visible {
      box-shadow: var(--shadow-soft);
      outline: 2px solid transparent;
      transform: translateY(-1px);
    }
    button.primary {
      border: none;
      background: var(--signal);
      color: #fff;
    }
    button.primary:hover { background: var(--signal-2); }
    button.secondary {
      border: 1px solid color-mix(in srgb, var(--signal) 30%, var(--line));
      background: var(--surface-1);
      color: var(--signal);
    }
    button.secondary:hover {
      background: color-mix(in srgb, var(--signal-2) 12%, var(--surface-1));
    }
    .callback-domain {
      font-family: var(--font-mono);
      font-size: 0.82rem;
      font-weight: 600;
    }
    .status-copy {
      margin-top: 0.65rem;
    }
    @media (max-width: 820px) {
      .site-header {
        grid-template-columns: 1fr;
        grid-template-areas:
          "brand"
          "controls"
          "nav";
      }
      .header-controls,
      .header-nav-row {
        justify-content: flex-start;
      }
      .host-stat {
        max-width: 100%;
      }
      .auth-shell {
        width: min(100vw - 1.25rem, 76rem);
        margin-top: 1rem;
      }
      .hero-header {
        align-items: flex-start;
        flex-direction: column;
      }
      .client-chip {
        max-width: 100%;
      }
      .hero-body {
        padding: 1.2rem;
      }
      .auth-layout { grid-template-columns: 1fr; }
      form { flex-direction: column; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="page-noise" aria-hidden="true"></div>
  <header class="site-header">
    <div class="header-brand">
      <img src="/dollhouse-logo.png" alt="DollhouseMCP" class="header-logo" width="32" height="32">
      <div class="header-brand-text">
        <p class="site-title">DollhouseMCP</p>
        <p class="site-tagline">Authorization</p>
      </div>
    </div>
    <div class="header-controls">
      <div class="host-stat"><span>Host</span><strong>${escapeHtmlText(authorizationHost)}</strong></div>
    </div>
    <div class="header-nav-row">
      <div class="console-tabs" aria-label="Authorization context">
        <span class="console-tab">OAuth</span>
      </div>
    </div>
  </header>
  <div class="auth-shell">
    <main>
      <section class="auth-hero">
        <div class="hero-header">
          <p class="eyebrow">OAuth client authorization</p>
          <span class="client-chip">${escapeHtmlText(view.clientName)}</span>
        </div>
        <div class="hero-body">
          <h1>Authorize ${escapeHtmlText(view.clientName)}?</h1>
          <p class="subtitle">${escapeHtmlText(view.clientName)} is requesting access to DollhouseMCP. DollhouseMCP will issue OAuth tokens to this client after approval.</p>
        </div>
      </section>
      <section class="auth-layout">
        <div>
          <section class="auth-card section">
            <div class="auth-card-header">
              <h2>Requested access</h2>
            </div>
            <div class="auth-card-body">
              <ul class="scope-list">
${scopes}
              </ul>
            </div>
          </section>
          <details class="details-panel section">
            <summary>Technical details</summary>
            <div class="details-body">
              <dl>
                <div>
                  <dt>Client ID</dt>
                  <dd><code>${escapeHtmlText(view.clientId)}</code></dd>
                </div>
                ${clientWebsiteRow}
                <div>
                  <dt>Callback domain</dt>
                  <dd><code>${escapeHtmlText(view.callbackHost)}</code></dd>
                </div>
                <div>
                  <dt>Callback URL</dt>
                  <dd><code>${escapeHtmlText(view.redirectUri)}</code></dd>
                </div>
                <div>
                  <dt>Resource</dt>
                  <dd><code>${escapeHtmlText(view.resource)}</code></dd>
                </div>
                <div>
                  <dt>Application type</dt>
                  <dd>${escapeHtmlText(view.applicationType)}</dd>
                </div>
              </dl>
              <h2 class="callbacks-title">Registered callbacks</h2>
              <ul class="redirect-list">
${redirectList}
${redirectOverflow}
              </ul>
            </div>
          </details>
        </div>
        <aside class="side">
          <section class="summary-card summary-card--primary">
            <h2>${escapeHtmlText(signedInHeading)}</h2>
            <div class="summary-card-body">
              ${identitySummary}
            </div>
          </section>
          <section class="summary-card">
            <h2>Client status</h2>
            <div class="summary-card-body">
              <span class="${historyClass}">${escapeHtmlText(historyLabel)}</span>
              <p class="muted status-copy">${escapeHtmlText(authorizationSummary)}</p>
            </div>
          </section>
          <section class="summary-card">
            <h2>Callback</h2>
            <div class="summary-card-body">
              <dl>
                <div>
                  <dt>Domain</dt>
                  <dd class="callback-domain">${escapeHtmlText(view.callbackHost)}</dd>
                </div>
              </dl>
            </div>
          </section>
          <form method="post" action="/interaction/${escapeHtmlAttr(details.uid)}">
            <input type="hidden" name="csrf_token" value="${escapeHtmlAttr(csrfToken)}">
            <button class="primary" type="submit" name="action" value="${CLIENT_CONSENT_APPROVE_ACTION}">Authorize Client</button>
            <button class="secondary" type="submit" name="action" value="${CLIENT_CONSENT_DENY_ACTION}">Cancel</button>
          </form>
        </aside>
      </section>
    </main>
  </div>
</body>
</html>`;
}

interface ClientConsentView {
  clientId: string;
  clientName: string;
  clientUri?: string;
  callbackHost: string;
  redirectUri: string;
  registeredRedirectUris: string[];
  scopes: string[];
  resource: string;
  applicationType: string;
}

async function buildClientConsentView(
  provider: OidcProviderForInteractions,
  details: OidcInteractionDetails,
  defaultResource: string,
): Promise<ClientConsentView> {
  const clientId = paramString(details.params.client_id) || 'unknown-client';
  const redirectUri = paramString(details.params.redirect_uri) || firstString(details.params.redirect_uris) || 'not provided';
  const client = await findClientForConsent(provider, clientId);
  const metadata = client?.metadata?.() ?? {};
  const registeredRedirectUris = stringArrayFrom(metadata.redirect_uris) ?? client?.redirectUris ?? [];
  const clientName = stringFrom(metadata.client_name)
    ?? client?.clientName
    ?? clientId;
  const clientUri = stringFrom(metadata.client_uri);
  const scopes = (paramString(details.params.scope) ?? client?.scope ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const resource = renderResource(details.params.resource, defaultResource);
  const applicationType = stringFrom(metadata.application_type)
    ?? client?.applicationType
    ?? 'unspecified';

  return {
    clientId,
    clientName,
    clientUri,
    callbackHost: callbackHostFor(redirectUri),
    redirectUri,
    registeredRedirectUris,
    scopes,
    resource,
    applicationType,
  };
}

async function findClientForConsent(
  provider: OidcProviderForInteractions,
  clientId: string,
): Promise<OidcClientForConsent | undefined> {
  if (!provider.Client) return undefined;
  try {
    return await provider.Client.find(clientId);
  } catch (err) {
    logger.warn('[InteractionRouter] failed to load client metadata for consent page', {
      clientId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function paramString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function allowOAuthRedirectFormAction(res: Response, details: OidcInteractionDetails): void {
  const redirectUri = paramString(details.params.redirect_uri);
  if (!redirectUri) return;

  try {
    // Safe only for the hosted client-consent page: oidc-provider has already
    // matched this redirect_uri to the registered OAuth client, and this CSP
    // source allows only the browser's final form-submit redirect back to that
    // client origin. All other embedded auth pages keep form-action at 'self'.
    allowCspFormActionOrigin(res, new URL(redirectUri).origin);
  } catch (err) {
    // oidc-provider validates redirect_uri before creating the interaction.
    // Keep the CSP opt-in fail-closed if provider details are unexpected.
    logger.debug('[InteractionRouter] skipped OAuth redirect CSP form-action origin', {
      interactionIdHash: fingerprintTransientId(details.uid),
      redirectUriHash: fingerprintTransientId(redirectUri),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayFrom(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function callbackHostFor(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return 'not provided';
  }
}

function renderResource(resource: unknown, defaultResource: string): string {
  if (typeof resource === 'string' && resource.length > 0) return resource;
  if (Array.isArray(resource)) {
    const strings = resource.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (strings.length > 0) return strings.join(', ');
  }
  return defaultResource;
}

function hostFromDisplayResource(resource: string): string {
  const firstResource = resource.split(',')[0]?.trim();
  if (!firstResource) return 'mcp.dollhousemcp.com';
  try {
    return new URL(firstResource).host;
  } catch {
    return firstResource;
  }
}

async function hasSeenClientConsent(
  storage: IAuthStorageLayer,
  accountId: string,
  clientId: string,
): Promise<boolean> {
  const existing = await storage.genericGet(CLIENT_CONSENT_SEEN_MODEL, clientConsentSeenKey(accountId, clientId));
  return Boolean(existing);
}

async function markClientConsentSeen(
  storage: IAuthStorageLayer,
  accountId: string,
  clientId: string | undefined,
): Promise<void> {
  if (!clientId) return;
  const key = clientConsentSeenKey(accountId, clientId);
  const now = Date.now();
  const existing = await storage.genericGet(CLIENT_CONSENT_SEEN_MODEL, key) as
    | { firstApprovedAt?: number }
    | null;
  await storage.genericSet(CLIENT_CONSENT_SEEN_MODEL, key, {
    accountId,
    clientId,
    firstApprovedAt: existing?.firstApprovedAt ?? now,
    lastApprovedAt: now,
  });
}

function clientConsentSeenKey(accountId: string, clientId: string): string {
  return `cc_${Buffer.from(JSON.stringify([accountId, clientId]), 'utf8').toString('base64url')}`;
}

async function recordClientConsentAuditEvent(
  storage: IAuthStorageLayer,
  type: 'auth.client_consent.approved' | 'auth.client_consent.denied',
  context: {
    details: OidcInteractionDetails;
    pending: PendingClientConsentIdentity | null;
    defaultResource: string;
  },
): Promise<void> {
  try {
    const redirectUri = paramString(context.details.params.redirect_uri)
      || firstString(context.details.params.redirect_uris)
      || 'not provided';
    await storage.recordIdentityEvent({
      type,
      sub: context.pending?.accountId,
      details: {
        clientId: context.pending?.clientId ?? paramString(context.details.params.client_id) ?? 'unknown-client',
        clientFirstSeenForIdentity: context.pending?.firstSeen,
        callbackHost: callbackHostFor(redirectUri),
        redirectUri,
        resource: renderResource(context.details.params.resource, context.defaultResource),
        scopes: (paramString(context.details.params.scope) ?? '').split(/\s+/).filter(Boolean),
        identity: context.pending?.identity,
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.warn('[InteractionRouter] failed to record client-consent audit event', {
      type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function renderScopeList(scopes: string[]): string {
  if (scopes.length === 0) {
    return `<li>
      <div class="scope-title"><span>Default OAuth access</span><code>default</code></div>
      <p class="scope-desc">Complete this authorization request.</p>
    </li>`;
  }
  return scopes.map((scope) => {
    const display = scopeDisplay(scope);
    return `<li>
      <div class="scope-title"><span>${escapeHtmlText(display.title)}</span><code>${escapeHtmlText(scope)}</code></div>
      <p class="scope-desc">${escapeHtmlText(display.description)}</p>
    </li>`;
  }).join('\n');
}

function scopeDisplay(scope: string): { title: string; description: string } {
  switch (scope) {
    case 'mcp':
      return {
        title: 'Use DollhouseMCP tools',
        description: 'Call the MCP server on your behalf.',
      };
    case 'offline_access':
      return {
        title: 'Keep access between sessions',
        description: 'Receive a refresh token so you do not need to sign in every time.',
      };
    case 'openid':
      return {
        title: 'Confirm your identity',
        description: 'Use your DollhouseMCP account identity for this OAuth connection.',
      };
    case 'profile':
      return {
        title: 'Read basic profile information',
        description: 'Share your display name with this OAuth connection.',
      };
    case 'email':
      return {
        title: 'Read verified email information',
        description: 'Share the verified email associated with this account when available.',
      };
    default:
      return {
        title: scope,
        description: 'Requested by the client.',
      };
  }
}

function renderIdentityCard(identity: ClientConsentIdentitySummary): string {
  const primary = identity.providerUsername
    ? `@${identity.providerUsername}`
    : identity.displayName;
  const provider = identity.provider ? providerDisplayName(identity.provider) : 'Account';
  const displayName = identity.displayName && identity.displayName !== primary
    ? `<span class="muted">${escapeHtmlText(identity.displayName)}</span>`
    : '';
  const email = identity.email
    ? `<span class="muted">${escapeHtmlText(identity.email)}</span>`
    : '';
  return `<div class="identity">
    <strong>${escapeHtmlText(primary ?? identity.sub)}</strong>
    <span class="muted">${escapeHtmlText(provider)} account</span>
    ${displayName}
    ${email}
    <code>${escapeHtmlText(identity.sub)}</code>
  </div>`;
}

function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'github':
      return 'GitHub';
    case 'magic-link':
      return 'Email magic link';
    case 'local-password':
      return 'Local password';
    case 'trivial-consent':
      return 'Trivial consent';
    default:
      return provider;
  }
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

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
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

function sendError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logInteractionDetailsFailure(req: Request, phase: 'GET' | 'POST', err: unknown): void {
  const diagnostics = interactionRequestDiagnostics(req);
  const statusCode = errorObjectNumber(err, 'statusCode') ?? errorObjectNumber(err, 'status');
  const errorDescription = errorObjectString(err, 'error_description');
  logger.warn(
    `[InteractionRouter] interactionDetails failed ` +
      `phase=${phase} ` +
      `pathUidHash=${diagnosticValue(diagnostics.pathUidHash)} ` +
      `hasCookieHeader=${diagnosticValue(diagnostics.hasCookieHeader)} ` +
      `hasInteractionCookie=${diagnosticValue(diagnostics.hasInteractionCookie)} ` +
      `hasInteractionSigCookie=${diagnosticValue(diagnostics.hasInteractionSigCookie)} ` +
      `interactionCookieHash=${diagnosticValue(diagnostics.interactionCookieHash)} ` +
      `interactionCookieMatchesPathUid=${diagnosticValue(diagnostics.interactionCookieMatchesPathUid)} ` +
      `error=${describeError(err)} ` +
      `errorDescription=${diagnosticValue(errorDescription)} ` +
      `statusCode=${diagnosticValue(statusCode)}`,
    {
      phase,
      ...diagnostics,
      errorName: err instanceof Error ? err.name : typeof err,
      error: describeError(err),
      errorDescription,
      statusCode,
    },
  );
}

function interactionRequestDiagnostics(req: Request): Record<string, unknown> {
  const pathUid = typeof req.params?.uid === 'string' ? req.params.uid : undefined;
  const rawCookieHeader = Array.isArray(req.headers.cookie)
    ? req.headers.cookie.join('; ')
    : req.headers.cookie;
  const interactionCookie = parseCookieValue(rawCookieHeader, INTERACTION_COOKIE_NAME);
  const interactionSigCookie = parseCookieValue(rawCookieHeader, INTERACTION_SIG_COOKIE_NAME);
  return {
    hasPathUid: Boolean(pathUid),
    pathUidHash: fingerprintTransientId(pathUid),
    hasCookieHeader: Boolean(rawCookieHeader),
    hasInteractionCookie: Boolean(interactionCookie),
    hasInteractionSigCookie: Boolean(interactionSigCookie),
    interactionCookieHash: fingerprintTransientId(interactionCookie),
    interactionCookieMatchesPathUid: Boolean(pathUid && interactionCookie && pathUid === interactionCookie),
    contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined,
  };
}

function fingerprintTransientId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function errorObjectString(err: unknown, key: string): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function errorObjectNumber(err: unknown, key: string): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

function parseCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function diagnosticValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'none';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).replace(/\s+/g, '_');
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
