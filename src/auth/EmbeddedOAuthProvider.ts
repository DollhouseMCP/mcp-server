import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import express, { type Router, type Request, type Response } from 'express';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
} from 'jose';
import { env } from '../config/env.js';
import { PACKAGE_VERSION } from '../generated/version.js';
import { logger } from '../utils/logger.js';
import type { AuthClaims, AuthResult, IAuthProvider, IssueOptions } from './IAuthProvider.js';
import { assertSafePublicBaseUrl, joinUrl, resolvePublicBaseUrl } from './oauth/url.js';

const ALGORITHM = 'ES256';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
const DEFAULT_CLIENT_ID = 'dollhouse-claude-connector';

interface StoredKeyPair {
  kid: string;
  privateKey: JWK;
  publicKey: JWK;
  generatedAt: string;
}

interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
}

interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope: string;
  subject: string;
  expiresAt: number;
  used: boolean;
}

interface RefreshTokenRecord {
  token: string;
  clientId: string;
  subject: string;
  resource?: string;
  scope: string;
  expiresAt: number;
}

export interface EmbeddedOAuthProviderOptions {
  publicBaseUrl?: string;
  mcpPath?: string;
  keyFilePath?: string;
  stateFilePath?: string;
  defaultSubject?: string;
}

interface StoredOAuthState {
  clients: RegisteredClient[];
  refreshTokens: RefreshTokenRecord[];
  updatedAt: string;
}

export class EmbeddedOAuthProvider implements IAuthProvider {
  readonly name = 'embedded-oauth';

  private readonly keyFilePath: string;
  private readonly stateFilePath: string;
  private readonly defaultSubject: string;
  private readonly mcpPath: string;
  private publicBaseUrl: string;
  private issuer: string;
  private resource: string;
  private privateKey: CryptoKey | Uint8Array | null = null;
  private publicKey: CryptoKey | Uint8Array | null = null;
  private publicJwk: JWK | null = null;
  private kid = '';
  private initialized = false;
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  constructor(options: EmbeddedOAuthProviderOptions = {}) {
    this.publicBaseUrl = resolvePublicBaseUrl({ publicBaseUrl: options.publicBaseUrl });
    this.issuer = this.publicBaseUrl;
    this.mcpPath = normalizePath(options.mcpPath ?? env.DOLLHOUSE_HTTP_MCP_PATH);
    this.resource = joinUrl(this.publicBaseUrl, this.mcpPath);
    this.keyFilePath = options.keyFilePath ?? defaultKeyFilePath();
    this.stateFilePath = options.stateFilePath ?? defaultStateFilePath();
    this.defaultSubject = options.defaultSubject ?? process.env.DOLLHOUSE_USER?.trim() ?? getDefaultSubject();
    this.ensureDefaultClient();
  }

  setPublicBaseUrl(publicBaseUrl: string): void {
    this.publicBaseUrl = assertSafePublicBaseUrl(publicBaseUrl);
    this.issuer = this.publicBaseUrl;
    this.resource = joinUrl(this.publicBaseUrl, this.mcpPath);
  }

  getProtectedResourceMetadataUrl(): string {
    return joinUrl(this.publicBaseUrl, '/.well-known/oauth-protected-resource');
  }

  getAuthorizationServerMetadataUrl(): string {
    return joinUrl(this.publicBaseUrl, '/.well-known/oauth-authorization-server');
  }

  async validate(token: string): Promise<AuthResult> {
    await this.ensureInitialized();

    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.publicKey!, {
        issuer: this.issuer,
        audience: this.resource,
        algorithms: [ALGORITHM],
      });

      if (protectedHeader.kid !== this.kid) {
        return { ok: false, reason: 'unknown key id' };
      }

      if (!payload.sub) {
        return { ok: false, reason: 'token missing sub claim' };
      }

      return {
        ok: true,
        claims: {
          sub: payload.sub,
          displayName: typeof payload.name === 'string' ? payload.name : undefined,
          tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : null,
          scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : undefined,
          exp: payload.exp,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('exp')) return { ok: false, reason: 'token expired' };
      if (message.includes('aud')) return { ok: false, reason: 'invalid audience' };
      if (message.includes('iss')) return { ok: false, reason: 'invalid issuer' };
      return { ok: false, reason: 'token validation failed' };
    }
  }

  async issue(sub: string, options?: IssueOptions): Promise<string> {
    return this.issueAccessToken({
      subject: sub,
      clientId: DEFAULT_CLIENT_ID,
      resource: this.resource,
      scope: options?.scopes?.join(' ') || 'mcp',
      ttlSeconds: options?.ttlSeconds,
      displayName: options?.displayName,
    });
  }

  createRouter(): Router {
    const router = express.Router();
    router.use(express.urlencoded({ extended: false }));
    router.use(express.json({ limit: '64kb' }));

    router.get('/.well-known/oauth-protected-resource', (_req, res) => {
      res.json({
        resource: this.resource,
        authorization_servers: [this.issuer],
        bearer_methods_supported: ['header'],
        resource_documentation: joinUrl(this.publicBaseUrl, '/'),
      });
    });

    const metadataHandler = (_req: Request, res: Response) => {
      res.json(this.authorizationServerMetadata());
    };
    router.get('/.well-known/oauth-authorization-server', metadataHandler);
    router.get('/.well-known/openid-configuration', metadataHandler);

    router.get('/oauth/jwks', async (_req, res, next) => {
      try {
        await this.ensureInitialized();
        res.json({ keys: [this.publicJwk] });
      } catch (error) {
        next(error);
      }
    });

    router.post('/oauth/register', (req, res) => void this.handleClientRegistration(req, res));
    router.get('/oauth/authorize', (req, res) => void this.renderConsent(req, res));
    router.post('/oauth/authorize', (req, res) => void this.handleAuthorize(req, res));
    router.post('/oauth/token', (req, res) => void this.handleToken(req, res));

    return router;
  }

  private authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: joinUrl(this.publicBaseUrl, '/oauth/authorize'),
      token_endpoint: joinUrl(this.publicBaseUrl, '/oauth/token'),
      jwks_uri: joinUrl(this.publicBaseUrl, '/oauth/jwks'),
      registration_endpoint: joinUrl(this.publicBaseUrl, '/oauth/register'),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['mcp', 'openid', 'offline_access'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [ALGORITHM],
    };
  }

  private async handleClientRegistration(req: Request, res: Response): Promise<void> {
    await this.ensureInitialized();

    const redirectUris = Array.isArray(req.body?.redirect_uris)
      ? req.body.redirect_uris.filter((value: unknown): value is string => typeof value === 'string')
      : [];

    if (redirectUris.length === 0) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
      return;
    }

    const clientId = `dh_${randomUUID()}`;
    const client: RegisteredClient = {
      clientId,
      redirectUris,
      clientName: typeof req.body?.client_name === 'string' ? req.body.client_name : undefined,
      createdAt: Date.now(),
    };
    this.clients.set(clientId, client);
    await this.persistState();

    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }

  private async renderConsent(req: Request, res: Response): Promise<void> {
    await this.ensureInitialized();

    const validation = this.validateAuthorizeRequest(req.query);
    if ('error' in validation) {
      res.status(400).send(escapeHtml(validation.error_description));
      return;
    }

    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DollhouseMCP Connector</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f7f7f4; color: #181816; }
    main { max-width: 520px; margin: 12vh auto; padding: 32px; background: white; border: 1px solid #d8d6cc; border-radius: 8px; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    p { line-height: 1.5; }
    button { background: #185c37; color: white; border: 0; border-radius: 6px; padding: 12px 16px; font-weight: 700; cursor: pointer; }
    .muted { color: #68675f; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>Connect to DollhouseMCP</h1>
    <p>Approve this connector to use DollhouseMCP tools over MCP Streamable HTTP.</p>
    <p class="muted">Client: ${escapeHtml(validation.client.clientName ?? validation.client.clientId)}</p>
    <form method="post" action="/oauth/authorize">
      ${hidden('client_id', validation.client.clientId)}
      ${hidden('redirect_uri', validation.redirectUri)}
      ${hidden('response_type', 'code')}
      ${hidden('code_challenge', validation.codeChallenge)}
      ${hidden('code_challenge_method', 'S256')}
      ${hidden('scope', validation.scope)}
      ${hidden('state', validation.state ?? '')}
      ${hidden('resource', validation.resource ?? '')}
      <button type="submit">Approve Connector</button>
    </form>
  </main>
</body>
</html>`);
  }

  private async handleAuthorize(req: Request, res: Response): Promise<void> {
    await this.ensureInitialized();

    const validation = this.validateAuthorizeRequest(req.body);
    if ('error' in validation) {
      res.status(400).json(validation);
      return;
    }

    const code = base64Url(randomBytes(32));
    this.codes.set(code, {
      code,
      clientId: validation.client.clientId,
      redirectUri: validation.redirectUri,
      codeChallenge: validation.codeChallenge,
      resource: validation.resource,
      scope: validation.scope,
      subject: this.defaultSubject,
      expiresAt: Date.now() + 5 * 60 * 1000,
      used: false,
    });

    const redirect = new URL(validation.redirectUri);
    redirect.searchParams.set('code', code);
    if (validation.state) redirect.searchParams.set('state', validation.state);
    res.redirect(302, redirect.toString());
  }

  private async handleToken(req: Request, res: Response): Promise<void> {
    const grantType = req.body?.grant_type;
    if (grantType === 'authorization_code') {
      await this.handleAuthorizationCodeToken(req, res);
      return;
    }

    if (grantType === 'refresh_token') {
      await this.handleRefreshToken(req, res);
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  }

  private async handleAuthorizationCodeToken(req: Request, res: Response): Promise<void> {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const record = this.codes.get(code);
    if (!record || record.used || record.expiresAt <= Date.now()) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }

    const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : record.clientId;
    const redirectUri = typeof req.body?.redirect_uri === 'string' ? req.body.redirect_uri : '';
    const codeVerifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : '';

    if (clientId !== record.clientId || redirectUri !== record.redirectUri) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }

    if (!codeVerifier || pkceS256(codeVerifier) !== record.codeChallenge) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    record.used = true;
    const accessToken = await this.issueAccessToken({
      subject: record.subject,
      clientId: record.clientId,
      resource: record.resource ?? this.resource,
      scope: record.scope,
    });
    const refreshToken = base64Url(randomBytes(32));
    this.refreshTokens.set(refreshToken, {
      token: refreshToken,
      clientId: record.clientId,
      subject: record.subject,
      resource: record.resource,
      scope: record.scope,
      expiresAt: Date.now() + DEFAULT_REFRESH_TOKEN_TTL_SECONDS * 1000,
    });
    await this.persistState();

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: record.scope,
    });
  }

  private async handleRefreshToken(req: Request, res: Response): Promise<void> {
    await this.ensureInitialized();

    const token = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
    const record = this.refreshTokens.get(token);
    if (!record || record.expiresAt <= Date.now()) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }

    const accessToken = await this.issueAccessToken({
      subject: record.subject,
      clientId: record.clientId,
      resource: record.resource ?? this.resource,
      scope: record.scope,
    });

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: token,
      scope: record.scope,
    });
  }

  private validateAuthorizeRequest(input: Request['query'] | Request['body']):
    | {
        client: RegisteredClient;
        redirectUri: string;
        codeChallenge: string;
        scope: string;
        state?: string;
        resource?: string;
      }
    | { error: string; error_description: string } {
    const clientId = singleString(input.client_id);
    const responseType = singleString(input.response_type);
    const redirectUri = singleString(input.redirect_uri);
    const codeChallenge = singleString(input.code_challenge);
    const codeChallengeMethod = singleString(input.code_challenge_method);
    const scope = singleString(input.scope) || 'mcp';
    const state = singleString(input.state);
    const resource = singleString(input.resource) || this.resource;

    if (responseType !== 'code') {
      return { error: 'unsupported_response_type', error_description: 'response_type must be code' };
    }

    if (!clientId || !redirectUri) {
      return { error: 'invalid_request', error_description: 'client_id and redirect_uri are required' };
    }

    const client = this.clients.get(clientId);
    if (!client) {
      return { error: 'unauthorized_client', error_description: 'Unknown client_id' };
    }

    if (!client.redirectUris.includes(redirectUri)) {
      return { error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' };
    }

    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return { error: 'invalid_request', error_description: 'PKCE S256 is required' };
    }

    if (resource !== this.resource) {
      return { error: 'invalid_target', error_description: 'resource must match this MCP server' };
    }

    return { client, redirectUri, codeChallenge, scope, state, resource };
  }

  private async issueAccessToken(options: {
    subject: string;
    clientId: string;
    resource: string;
    scope: string;
    ttlSeconds?: number;
    displayName?: string;
  }): Promise<string> {
    await this.ensureInitialized();

    return new SignJWT({
      azp: options.clientId,
      scope: options.scope,
      name: options.displayName ?? options.subject,
    })
      .setProtectedHeader({ alg: ALGORITHM, kid: this.kid })
      .setIssuer(this.issuer)
      .setAudience(options.resource)
      .setSubject(options.subject)
      .setIssuedAt()
      .setExpirationTime(`${options.ttlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.privateKey!);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const raw = await fs.readFile(this.keyFilePath, 'utf-8');
      const stored = JSON.parse(raw) as StoredKeyPair;
      this.kid = stored.kid;
      this.privateKey = await importJWK(stored.privateKey, ALGORITHM) as CryptoKey;
      this.publicKey = await importJWK(stored.publicKey, ALGORITHM) as CryptoKey;
      this.publicJwk = { ...stored.publicKey, kid: stored.kid, alg: ALGORITHM, use: 'sig' };
      logger.info(`[EmbeddedOAuthProvider] Loaded signing key from ${this.keyFilePath}`);
    } catch {
      await this.generateAndStoreKeyPair();
    }

    await this.loadState();
    this.initialized = true;
  }

  private async generateAndStoreKeyPair(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { extractable: true });
    const kid = `dh-${randomUUID()}`;
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.kid = kid;

    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);
    this.publicJwk = { ...publicJwk, kid, alg: ALGORITHM, use: 'sig' };

    const stored: StoredKeyPair = {
      kid,
      privateKey: { ...privateJwk, kid, alg: ALGORITHM },
      publicKey: this.publicJwk,
      generatedAt: new Date().toISOString(),
    };

    await fs.mkdir(path.dirname(this.keyFilePath), { recursive: true });
    await fs.writeFile(this.keyFilePath, JSON.stringify(stored, null, 2), { mode: 0o600 });
    logger.info(`[EmbeddedOAuthProvider] Generated signing key at ${this.keyFilePath}`);
  }

  private ensureDefaultClient(): void {
    if (this.clients.has(DEFAULT_CLIENT_ID)) {
      return;
    }

    this.clients.set(DEFAULT_CLIENT_ID, {
      clientId: DEFAULT_CLIENT_ID,
      redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      clientName: 'Dollhouse Claude Connector',
      createdAt: Date.now(),
    });
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf-8');
      const stored = JSON.parse(raw) as Partial<StoredOAuthState>;
      const clients = Array.isArray(stored.clients) ? stored.clients : [];
      const refreshTokens = Array.isArray(stored.refreshTokens) ? stored.refreshTokens : [];
      const now = Date.now();

      this.clients.clear();
      for (const client of clients) {
        if (isRegisteredClient(client)) {
          this.clients.set(client.clientId, client);
        }
      }

      this.refreshTokens.clear();
      for (const refreshToken of refreshTokens) {
        if (isRefreshTokenRecord(refreshToken) && refreshToken.expiresAt > now) {
          this.refreshTokens.set(refreshToken.token, refreshToken);
        }
      }
    } catch {
      this.clients.clear();
      this.refreshTokens.clear();
    }

    this.ensureDefaultClient();
  }

  private async persistState(): Promise<void> {
    const state: StoredOAuthState = {
      clients: Array.from(this.clients.values()),
      refreshTokens: Array.from(this.refreshTokens.values())
        .filter(refreshToken => refreshToken.expiresAt > Date.now()),
      updatedAt: new Date().toISOString(),
    };
    const tmpPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, this.stateFilePath);
  }
}

function defaultKeyFilePath(): string {
  const homeDir = process.env.DOLLHOUSE_HOME_DIR || os.homedir();
  return path.join(homeDir, '.dollhouse', 'run', 'oauth-signing-key.json');
}

function defaultStateFilePath(): string {
  const homeDir = process.env.DOLLHOUSE_HOME_DIR || os.homedir();
  return path.join(homeDir, '.dollhouse', 'run', 'oauth-state.json');
}

function getDefaultSubject(): string {
  try {
    return os.userInfo().username || 'local-operator';
  } catch {
    return 'local-operator';
  }
}

function normalizePath(rawPath: string): string {
  if (!rawPath || rawPath === '/') return '/mcp';
  return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
}

function singleString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function isRegisteredClient(value: unknown): value is RegisteredClient {
  const candidate = value as RegisteredClient;
  return typeof candidate?.clientId === 'string'
    && Array.isArray(candidate.redirectUris)
    && candidate.redirectUris.every(uri => typeof uri === 'string')
    && typeof candidate.createdAt === 'number'
    && (candidate.clientName === undefined || typeof candidate.clientName === 'string');
}

function isRefreshTokenRecord(value: unknown): value is RefreshTokenRecord {
  const candidate = value as RefreshTokenRecord;
  return typeof candidate?.token === 'string'
    && typeof candidate.clientId === 'string'
    && typeof candidate.subject === 'string'
    && typeof candidate.scope === 'string'
    && typeof candidate.expiresAt === 'number'
    && (candidate.resource === undefined || typeof candidate.resource === 'string');
}
