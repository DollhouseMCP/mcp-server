import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request, type Response, type Router } from 'express';
import type { IRateLimitStore } from '../../auth/embedded-as/storage/IRateLimitStore.js';
import { normalizeIp } from '../../auth/embedded-as/rateLimit.js';
import { securityHeaders } from '../../auth/embedded-as/securityHeaders.js';
import type { InvitationManagementAudit } from '../IInvitationManagementStore.js';
import { InvitationError } from '../InvitationTypes.js';
import { InvitationTokenError, MAX_INVITATION_TOKEN_LENGTH, parseInvitationToken } from '../InvitationToken.js';
import type { PostgresOnboardingMetadataStore, OnboardingInvitationMetadata } from './PostgresOnboardingMetadataStore.js';
import { OnboardingCredentials } from './OnboardingCredentials.js';
import {
  GitHubEnrollmentFlowError,
  type GitHubEnrollmentOrchestrationService,
} from './GitHubEnrollmentOrchestrationService.js';
import { onboardingOwnerCookieMaxAgeSeconds } from './OnboardingOwnerCookie.js';
import { ONBOARDING_SESSION_TTL_SECONDS } from './OnboardingRecords.js';
import { OnboardingStoreError, type PostgresOnboardingStore } from './PostgresOnboardingStore.js';
import { ONBOARDING_OWNER_COOKIE, ONBOARDING_SESSION_COOKIE, clearOnboardingCookie,
  onboardingMutationAllowed, readOnboardingCookie, serializeOnboardingCookie } from './OnboardingBrowserPolicy.js';

export interface OnboardingRouterOptions {
  readonly store: Pick<PostgresOnboardingStore, 'createOwner' | 'findOwner' | 'findSession' | 'exchangeClaim' |
    'rotateOwnerCsrf' | 'rotateSessionCsrf' | 'endSession'>;
  readonly metadataReader: Pick<PostgresOnboardingMetadataStore, 'read'>;
  readonly githubEnrollment: Pick<GitHubEnrollmentOrchestrationService, 'start' | 'complete'>;
  readonly credentials: OnboardingCredentials;
  readonly rateLimits: IRateLimitStore;
  readonly trustedOrigin: string;
  readonly audit: Extract<InvitationManagementAudit, { kind: 'system' }>;
  readonly now?: () => Date;
}
class BoundaryError extends Error {
  constructor(readonly status: number) { super('Onboarding request unavailable'); }
}

/** Unregistered API only. Future mounting owns TLS, trusted proxy and logging policy. */
export function createOnboardingRouter(options: OnboardingRouterOptions): Router {
  const { store, metadataReader, githubEnrollment, credentials, rateLimits, trustedOrigin, audit } = options;
  const origin = new URL(trustedOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== trustedOrigin || !rateLimits ||
      typeof metadataReader?.read !== 'function' || typeof githubEnrollment?.start !== 'function' ||
      typeof githubEnrollment?.complete !== 'function' || audit.kind !== 'system') {
    throw new Error('Invalid onboarding router configuration');
  }
  const now = options.now ?? (() => new Date());
  const router = express.Router();
  router.use(securityHeaders());
  router.use((req, _res, next) => {
    try {
      // No credentials in URLs, ambiguous cookie bindings, or merged headers.
      const githubCallback = req.method === 'GET' && req.path === '/github/callback';
      if ((!githubCallback && req.url.includes('?')) || duplicateHeaders(req)) throw new BoundaryError(400);
      for (const name of [ONBOARDING_OWNER_COOKIE, ONBOARDING_SESSION_COOKIE] as const) {
        const count = (req.headers.cookie?.split(';') ?? []).filter(part => part.trim().split('=')[0] === name).length;
        if (count > 1 || (count === 1 && !readOnboardingCookie(req.headers.cookie, name))) throw new BoundaryError(400);
      }
      if (req.method === 'POST' && req.headers.origin !== trustedOrigin) throw new BoundaryError(403);
      next();
    } catch (error) { next(error); }
  });
  const json = express.json({ limit: '1kb', strict: true, inflate: false, type: 'application/json' });
  const post = (path: string, action: (req: Request, res: Response) => Promise<void>) => {
    router.post(path, async (req, _res, next) => {
      try {
        if (!req.is('application/json')) throw new BoundaryError(415);
        if (path !== '/logout') {
          // req.ip is derived only through Express's operator-controlled proxy
          // policy. Never read forwarding headers or use credential material.
          const at = now().getTime();
          const result = await rateLimits.update<{ start: number; count: number }, boolean>(
            'onboarding:admission:v1', normalizeIp(req.ip ?? 'unknown'), previous => {
              const state = previous && previous.start <= at && at - previous.start < 60_000
                ? { ...previous } : { start: at, count: 0 };
              const allowed = state.count < 30;
              if (allowed) state.count++;
              return { state, result: allowed };
            }, { expiresAt: at + 60_000 });
          if (result.result !== true) throw new BoundaryError(429);
        }
        next();
      } catch (error) { next(error); }
    }, json, (req, res, next) => { void action(req, res).catch(next); });
  };
  async function context(req: Request) {
    const rawOwner = readOnboardingCookie(req.headers.cookie, ONBOARDING_OWNER_COOKIE);
    const rawSession = readOnboardingCookie(req.headers.cookie, ONBOARDING_SESSION_COOKIE);
    const ownerHash = rawOwner ? credentials.hash('owner', rawOwner) : undefined;
    const owner = ownerHash ? await store.findOwner(ownerHash) : null;
    const sessionHash = rawSession ? credentials.hash('session', rawSession) : undefined;
    const session = owner && ownerHash && sessionHash ? await store.findSession(ownerHash, sessionHash) : null;
    if (rawSession !== undefined && !session) throw new BoundaryError(409);
    return { owner, ownerHash, session, sessionHash };
  }
  type Context = Awaited<ReturnType<typeof context>>;
  function authorize(req: Request, ctx: Context) {
    const record = ctx.session ?? ctx.owner;
    if (!record || !onboardingMutationAllowed({ method: req.method, origin: req.headers.origin,
      csrfToken: req.headers['x-onboarding-csrf'] }, trustedOrigin, record.csrfTokenHash, credentials)) throw new BoundaryError(403);
  }
  function metadata(ctx: Pick<Context, 'owner' | 'session'>) {
    return ctx.session ? { state: 'claimed', expiresAt: ctx.session.expiresAt.toISOString() }
      : ctx.owner ? { state: 'ready', expiresAt: ctx.owner.expiresAt.toISOString() } : { state: 'unavailable' };
  }
  post('/bootstrap', async (req, res) => {
    exactBody(req.body, []);
    const ctx = await context(req);
    const csrf = credentials.issue('csrf');
    if (ctx.session && ctx.ownerHash && ctx.sessionHash) {
      ctx.session = await store.rotateSessionCsrf(ctx.ownerHash, ctx.sessionHash, csrf.hash);
    } else if (ctx.owner && ctx.ownerHash) {
      ctx.owner = await store.rotateOwnerCsrf(ctx.ownerHash, csrf.hash);
    } else {
      const owner = credentials.issue('owner');
      ctx.owner = await store.createOwner(owner.hash, csrf.hash);
      res.append('Set-Cookie', serializeOnboardingCookie(ONBOARDING_OWNER_COOKIE, owner.value,
        onboardingOwnerCookieMaxAgeSeconds(ctx.owner, now())));
    }
    if (!ctx.session) res.append('Set-Cookie', clearOnboardingCookie(ONBOARDING_SESSION_COOKIE));
    res.json({ ...metadata(ctx), csrfToken: csrf.value });
  });
  post('/exchange', async (req, res) => {
    exactBody(req.body, ['credential']);
    const value = (req.body as { credential: unknown }).credential;
    if (typeof value !== 'string' || value.length > MAX_INVITATION_TOKEN_LENGTH) throw new BoundaryError(400);
    const ctx = await context(req);
    authorize(req, ctx);
    const parsed = parseInvitationToken(value);
    try {
      const session = credentials.issue('session');
      const csrf = credentials.issue('csrf');
      const record = await store.exchangeClaim({ invitationId: parsed.invitationId, generation: parsed.generation,
        credentialSecret: parsed.secret, ownerHash: ctx.ownerHash!, sessionHash: session.hash,
        csrfTokenHash: csrf.hash, correlationId: randomUUID(), expectedSessionHash: ctx.sessionHash }, audit);
      const remaining = Math.min(ONBOARDING_SESSION_TTL_SECONDS, Math.floor((record.expiresAt.getTime() - now().getTime()) / 1000));
      if (remaining <= 0) throw new BoundaryError(409);
      res.append('Set-Cookie', serializeOnboardingCookie(ONBOARDING_SESSION_COOKIE, session.value, remaining));
      res.json({ ...metadata({ owner: ctx.owner, session: record }), csrfToken: csrf.value });
    } finally { parsed.secret.fill(0); }
  });
  post('/github/start', async (req, res) => {
    exactBody(req.body, []);
    const ctx = await context(req);
    authorize(req, ctx);
    if (!ctx.session || !ctx.ownerHash || !ctx.sessionHash) throw new BoundaryError(409);
    const started = await githubEnrollment.start({ ownerHash: ctx.ownerHash, sessionHash: ctx.sessionHash });
    res.json({ authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt.toISOString() });
  });
  router.get('/github/callback', (req, res) => {
    void (async () => {
      let ownerHash: Buffer | undefined;
      let sessionHash: Buffer | undefined;
      try {
        rejectGetBody(req);
        const callback = parseGitHubCallback(req.originalUrl, trustedOrigin);
        const rawOwner = readOnboardingCookie(req.headers.cookie, ONBOARDING_OWNER_COOKIE);
        const rawSession = readOnboardingCookie(req.headers.cookie, ONBOARDING_SESSION_COOKIE);
        if (!rawOwner || !rawSession) throw new BoundaryError(400);
        ownerHash = credentials.hash('owner', rawOwner);
        sessionHash = credentials.hash('session', rawSession);
        const result = await githubEnrollment.complete({ ownerHash, sessionHash, callback });
        if (result.status === 'cancelled') return sendGitHubHelp(res, 400);
        res.append('Set-Cookie', clearOnboardingCookie(ONBOARDING_OWNER_COOKIE));
        res.append('Set-Cookie', clearOnboardingCookie(ONBOARDING_SESSION_COOKIE));
        res.status(303).location('/api/v1/auth/login').end();
      } catch (error) {
        sendGitHubHelp(res, githubCallbackStatus(error));
      } finally {
        ownerHash?.fill(0);
        sessionHash?.fill(0);
      }
    })();
  });
  router.get('/context', (req, res, next) => { void (async () => {
    rejectGetBody(req);
    const rawOwner = readOnboardingCookie(req.headers.cookie, ONBOARDING_OWNER_COOKIE);
    const rawSession = readOnboardingCookie(req.headers.cookie, ONBOARDING_SESSION_COOKIE);
    if (!rawOwner || !rawSession) throw new BoundaryError(409);
    const ownerHash = credentials.hash('owner', rawOwner);
    const sessionHash = credentials.hash('session', rawSession);
    try {
      // One transactional authority read; no preceding owner/session lookup or public ID input.
      const value = await metadataReader.read(ownerHash, sessionHash);
      if (!value || value.state !== 'claimed') throw new BoundaryError(409);
      const result: OnboardingInvitationMetadata = {
        state: 'claimed', account: { username: value.account.username, displayName: value.account.displayName,
          verifiedEmail: value.account.verifiedEmail }, intendedRoles: [...value.intendedRoles],
        emailVerifiedAt: value.emailVerifiedAt, invitationExpiresAt: value.invitationExpiresAt,
        sessionExpiresAt: value.sessionExpiresAt, serverTime: value.serverTime,
      };
      res.json(result);
    } finally { ownerHash.fill(0); sessionHash.fill(0); }
  })().catch(next); });
  router.get('/status', (req, res, next) => { void context(req).then(ctx => { res.json(metadata(ctx)); }).catch(next); });
  post('/logout', async (req, res) => {
    exactBody(req.body, []);
    const ctx = await context(req);
    authorize(req, ctx);
    if (ctx.ownerHash && ctx.sessionHash) await store.endSession(ctx.ownerHash, ctx.sessionHash);
    res.append('Set-Cookie', clearOnboardingCookie(ONBOARDING_SESSION_COOKIE));
    res.status(204).end();
  });
  router.use((_req, res) => { res.status(404).json({ error: 'onboarding_not_found' }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    let status = 503;
    if (error instanceof BoundaryError) status = error.status;
    else if (error instanceof InvitationTokenError) status = 400;
    else if (error instanceof InvitationError) status = ['configuration_invalid', 'concurrent_update'].includes(error.code) ? 503 : 409;
    else if (error instanceof OnboardingStoreError) status = 409;
    else if (error && typeof error === 'object' && 'type' in error) {
      if (error.type === 'entity.too.large') status = 413;
      else if (error.type === 'entity.parse.failed') status = 400;
      else if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') status = 415;
    }
    res.status(status).json({ error: status === 503 ? 'onboarding_unavailable' : 'onboarding_request_rejected' });
  };
  router.use(errors);
  return router;
}
function exactBody(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new BoundaryError(400);
}
function duplicateHeaders(req: Request): boolean {
  const seen = new Set<string>();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase();
    if (!['origin', 'cookie', 'x-onboarding-csrf', 'content-type'].includes(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

function rejectGetBody(req: Request): void {
  if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0 || req.body !== undefined) {
    throw new BoundaryError(400);
  }
}

function parseGitHubCallback(originalUrl: string, trustedOrigin: string) {
  const url = new URL(originalUrl, trustedOrigin);
  const entries = [...url.searchParams.entries()];
  if (url.origin !== trustedOrigin || url.pathname !== '/auth/onboarding/github/callback' || entries.length !== 2) {
    throw new BoundaryError(400);
  }
  const stateValues = url.searchParams.getAll('state');
  const codeValues = url.searchParams.getAll('code');
  const errorValues = url.searchParams.getAll('error');
  if (stateValues.length !== 1 || stateValues[0].length === 0 ||
      (codeValues.length === 1) === (errorValues.length === 1) ||
      codeValues.length > 1 || errorValues.length > 1) throw new BoundaryError(400);
  if (codeValues.length === 1 && (codeValues[0].length === 0 || codeValues[0].length > 2_048 ||
      /[\s\p{Cc}\p{Cf}]/u.test(codeValues[0]))) throw new BoundaryError(400);
  if (errorValues.length === 1 && (errorValues[0].length === 0 || errorValues[0].length > 256 ||
      /[\s\p{Cc}\p{Cf}]/u.test(errorValues[0]))) {
    throw new BoundaryError(400);
  }
  return codeValues.length === 1
    ? { kind: 'code' as const, state: stateValues[0], code: codeValues[0] }
    : { kind: 'provider_error' as const, state: stateValues[0],
      error: errorValues[0] === 'access_denied' ? 'access_denied' as const : 'other' as const };
}

function githubCallbackStatus(error: unknown): number {
  if (!(error instanceof GitHubEnrollmentFlowError)) return error instanceof BoundaryError ? error.status : 503;
  return ['provider_unavailable', 'activation_unavailable', 'audit_unavailable'].includes(error.code) ? 503 : 400;
}

function sendGitHubHelp(res: Response, status: number): void {
  res.status(status).type('html').send(
    '<!doctype html><html><head><meta charset="utf-8"><title>GitHub enrollment</title></head>' +
    '<body><main><h1>GitHub enrollment was not completed</h1>' +
    '<p>Return to the enrollment page and start GitHub enrollment again.</p></main></body></html>',
  );
}
