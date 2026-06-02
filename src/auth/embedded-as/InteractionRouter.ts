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
const PENDING_CLIENT_CONSENT_MODEL = 'PendingClientConsentIdentity';
const CLIENT_CONSENT_SEEN_MODEL = 'ClientConsentSeen';
const CLIENT_CONSENT_APPROVE_ACTION = 'authorize_oauth_client';
const CLIENT_CONSENT_DENY_ACTION = 'deny_oauth_client';

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
    sendError(res, 400, 'invalid_interaction', describeError(err));
    return;
  }

  const action = bodyValue(req, 'action');
  if (action === CLIENT_CONSENT_APPROVE_ACTION || action === CLIENT_CONSENT_DENY_ACTION) {
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

  await finishInteractionWithIdentity(req, res, provider, details, result.identity.sub, storage, defaultResource);
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
    ? 'badge accent'
    : 'badge';
  const authorizationSummary = consent.firstSeen
    ? 'Review this client before granting access.'
    : 'This client has been authorized before for this account.';
  const clientWebsiteRow = view.clientUri
    ? `<div><dt>Client website</dt><dd>${clientUri}</dd></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DollhouseMCP - Authorize ${escapeHtmlText(view.clientName)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171717;
      --muted: #64645f;
      --line: #d9d7ce;
      --panel: #ffffff;
      --page: #f5f4ef;
      --brand: #174c39;
      --brand-strong: #0f3529;
      --accent: #b65b00;
      --soft: #f0eee5;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--page);
      color: var(--ink);
    }
    .shell {
      width: min(880px, calc(100vw - 32px));
      margin: 32px auto;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 800;
      letter-spacing: 0;
    }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 7px;
      background: var(--brand);
      color: white;
      font-size: 14px;
    }
    .host {
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
      text-align: right;
    }
    main {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 18px 48px rgba(23, 23, 23, 0.08);
      overflow: hidden;
    }
    .hero {
      padding: 30px 32px 24px;
      border-bottom: 1px solid var(--line);
      background: #fbfaf6;
    }
    .eyebrow {
      color: var(--brand);
      font-size: 13px;
      font-weight: 800;
      margin: 0 0 8px;
      text-transform: uppercase;
    }
    h1 {
      font-size: 28px;
      line-height: 1.15;
      margin: 0 0 10px;
      letter-spacing: 0;
    }
    h2 {
      font-size: 16px;
      margin: 0 0 12px;
    }
    p {
      line-height: 1.5;
      margin: 0;
    }
    a { color: var(--brand); }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .subtitle {
      color: var(--muted);
      font-size: 16px;
      max-width: 660px;
    }
    .content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 280px;
      gap: 24px;
      padding: 28px 32px 32px;
    }
    .section + .section { margin-top: 24px; }
    .scope-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .scope-list li {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 14px;
      background: #fff;
    }
    .scope-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      font-weight: 750;
    }
    .scope-title code {
      color: var(--muted);
      font-weight: 500;
    }
    .scope-desc {
      color: var(--muted);
      font-size: 14px;
      margin-top: 4px;
    }
    .side {
      display: grid;
      gap: 14px;
      align-content: start;
    }
    .summary-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--soft);
      padding: 14px;
    }
    .summary-card h2 {
      margin-bottom: 10px;
    }
    dl {
      display: grid;
      gap: 10px;
      margin: 0;
    }
    dl > div {
      min-width: 0;
    }
    dt {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      margin-bottom: 3px;
      text-transform: uppercase;
    }
    dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .identity {
      display: grid;
      gap: 3px;
    }
    .identity strong {
      font-size: 15px;
    }
    .muted {
      color: var(--muted);
      font-size: 14px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 9px;
      background: white;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    .badge.accent {
      border-color: #e0b27a;
      background: #fff6e8;
      color: #6b3400;
    }
    details {
      border-top: 1px solid var(--line);
      padding-top: 18px;
      margin-top: 24px;
    }
    summary {
      cursor: pointer;
      color: var(--brand);
      font-weight: 800;
    }
    .redirect-list {
      margin: 12px 0 0;
      padding-left: 18px;
      color: var(--muted);
    }
    form {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 28px;
    }
    button {
      border: 0;
      border-radius: 7px;
      padding: 12px 18px;
      font-weight: 800;
      cursor: pointer;
      font-size: 15px;
    }
    button.primary {
      background: var(--brand);
      color: white;
    }
    button.primary:hover { background: var(--brand-strong); }
    button.secondary {
      background: #ece8dd;
      color: var(--ink);
    }
    @media (max-width: 760px) {
      .shell { width: min(100vw - 20px, 880px); margin: 16px auto; }
      header { align-items: flex-start; flex-direction: column; }
      .host { text-align: left; }
      .hero, .content { padding: 22px; }
      .content { grid-template-columns: 1fr; }
      h1 { font-size: 24px; }
      form { flex-direction: column; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand"><span class="brand-mark">DM</span><span>DollhouseMCP Authorization</span></div>
      <div class="host">mcp.dollhousemcp.com</div>
    </header>
    <main>
      <section class="hero">
        <p class="eyebrow">OAuth client authorization</p>
        <h1>Authorize ${escapeHtmlText(view.clientName)}?</h1>
        <p class="subtitle">${escapeHtmlText(view.clientName)} is requesting access to DollhouseMCP. DollhouseMCP will issue OAuth tokens to this client after approval.</p>
      </section>
      <section class="content">
        <div>
          <section class="section">
            <h2>Requested access</h2>
            <ul class="scope-list">
${scopes}
            </ul>
          </section>
          <details>
            <summary>Technical details</summary>
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
            <h2 style="margin-top: 20px;">Registered callbacks</h2>
            <ul class="redirect-list">
${redirectList}
${redirectOverflow}
            </ul>
          </details>
          <form method="post" action="/interaction/${escapeHtmlAttr(details.uid)}">
            <input type="hidden" name="csrf_token" value="${escapeHtmlAttr(csrfToken)}">
            <button class="primary" type="submit" name="action" value="${CLIENT_CONSENT_APPROVE_ACTION}">Authorize</button>
            <button class="secondary" type="submit" name="action" value="${CLIENT_CONSENT_DENY_ACTION}">Cancel</button>
          </form>
        </div>
        <aside class="side">
          <section class="summary-card">
            <h2>Signed in with GitHub</h2>
            ${identitySummary}
          </section>
          <section class="summary-card">
            <h2>Client status</h2>
            <span class="${historyClass}">${escapeHtmlText(historyLabel)}</span>
            <p class="muted" style="margin-top: 10px;">${escapeHtmlText(authorizationSummary)}</p>
          </section>
          <section class="summary-card">
            <h2>Callback</h2>
            <dl>
              <div>
                <dt>Domain</dt>
                <dd><code>${escapeHtmlText(view.callbackHost)}</code></dd>
              </div>
            </dl>
          </section>
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
  return `${encodeURIComponent(accountId)}:${encodeURIComponent(clientId)}`;
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
  return provider === 'github' ? 'GitHub' : provider;
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
