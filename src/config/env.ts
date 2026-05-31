/**
 * Centralized Environment Configuration
 *
 * This module provides type-safe access to environment variables with validation.
 * All environment variables should be accessed through this module rather than
 * directly via process.env to ensure type safety and validation.
 *
 * Usage:
 * ```typescript
 * import { env } from './config/env';
 * const token = env.GITHUB_TOKEN;  // Type: string
 * ```
 */

import { z } from 'zod';

/**
 * Parse a boolean env var correctly. z.coerce.boolean() uses JavaScript's
 * Boolean() which treats any non-empty string as true — so 'false' becomes
 * true. This helper treats only 'true' and '1' as true.
 */
const envBool = (defaultValue: boolean) =>
  z.string().default(String(defaultValue)).transform(v => v === 'true' || v === '1');
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

const HTTP_ALLOWED_HOST_PATTERN = /^[A-Za-z0-9.\-:[\]]+$/;

function parseAllowedHosts(rawValue: string | undefined): string[] | undefined {
  if (!rawValue) {
    return undefined;
  }

  const hosts = rawValue
    .split(',')
    .map(host => host.trim())
    .filter(Boolean);

  for (const host of hosts) {
    if (!HTTP_ALLOWED_HOST_PATTERN.test(host)) {
      throw new Error(`Invalid host allow-list entry: ${host}`);
    }
  }

  return hosts.length > 0 ? hosts : undefined;
}

// Load .env files with priority: .env.local (personal) > .env (shared defaults)
// Both files are optional - no error if either doesn't exist
//
// MCP Protocol Compliance: Suppress dotenv's stdout output
// The MCP protocol requires that ONLY JSON-RPC messages go to stdout.
// dotenv may output version info to stdout, which breaks Claude Desktop connection.
// Solution: Temporarily redirect stdout to stderr during dotenv initialization.
// In --web mode, suppress both stdout AND stderr — the user only needs the
// console URL banner, not dotenv's injection summary. Logs go to the web viewer.
//
// Cycle 19 / H3 note: this is the one site that legitimately reads
// DOLLHOUSE_DEBUG / ENABLE_DEBUG raw from process.env — the schema isn't
// parsed until line 572, and we need this decision before dotenv runs.
// All other consumers should use env.DOLLHOUSE_DEBUG / env.ENABLE_DEBUG.
const isWebSilent = process.argv.includes('--web')
  && !process.env.DOLLHOUSE_DEBUG && !process.env.ENABLE_DEBUG;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const suppressStreamWrite = () => true;
process.stdout.write = isWebSilent ? suppressStreamWrite : process.stderr.write.bind(process.stderr);
if (isWebSilent) process.stderr.write = suppressStreamWrite;
dotenv.config({ path: ['.env.local', '.env'] });
process.stdout.write = originalStdoutWrite;
if (isWebSilent) process.stderr.write = originalStderrWrite;

/**
 * Environment variable schema with validation
 */
const envSchema = z.object({
  // ============================================================================
  // Environment
  // ============================================================================
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ============================================================================
  // Production GitHub Credentials
  // ============================================================================
  // Used by production code (src/) for real GitHub operations
  // Optional: Features requiring GitHub will fail gracefully if not set
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_USERNAME: z.string().optional(),
  GITHUB_REPOSITORY: z.string().optional(),

  // ============================================================================
  // Test GitHub Credentials (SEPARATE account!)
  // ============================================================================
  // Used by test code (tests/) - tests will skip if not provided
  // IMPORTANT: Use a different GitHub account for testing!
  GITHUB_TEST_TOKEN: z.string().optional(),
  GITHUB_TEST_USERNAME: z.string().optional(),
  GITHUB_TEST_REPOSITORY: z.string().optional(),

  // ============================================================================
  // Server Configuration
  // ============================================================================
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // ============================================================================
  // Transport Configuration (Phase 2: Streamable HTTP)
  // ============================================================================
  /** MCP transport mode: 'stdio' (default) or 'streamable-http' for hosted HTTP mode. */
  DOLLHOUSE_TRANSPORT: z.enum(['stdio', 'streamable-http']).default('stdio'),
  /** HTTP server bind address. Default localhost-only for security. */
  DOLLHOUSE_HTTP_HOST: z.string().default('127.0.0.1'),
  /** HTTP server port for MCP transport. */
  DOLLHOUSE_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** URL path for the MCP endpoint. */
  DOLLHOUSE_HTTP_MCP_PATH: z.string().default('/mcp'),
  /** Comma-separated allowlist of Host header values (DNS rebinding protection).
   *  When unset, the SDK's createMcpExpressApp() enforces localhost-only Host headers.
   *  Set explicitly when binding to 0.0.0.0 in containers or behind reverse proxies. */
  DOLLHOUSE_HTTP_ALLOWED_HOSTS: z.string()
    .optional()
    .transform(parseAllowedHosts),
  /** Rate limit window in milliseconds. */
  DOLLHOUSE_HTTP_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(0).default(60000),
  /** Maximum requests per client per rate limit window. */
  DOLLHOUSE_HTTP_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(0).default(300),
  /** Session idle timeout in milliseconds (0 = no timeout). */
  DOLLHOUSE_HTTP_SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(900000),
  /** Pre-warmed session pool size (0 = disabled). */
  DOLLHOUSE_HTTP_SESSION_POOL_SIZE: z.coerce.number().int().min(0).max(32).default(0),
  /** Start the web console alongside HTTP transport for session monitoring. */
  DOLLHOUSE_HTTP_WEB_CONSOLE: envBool(true),
  /** Public HTTPS base URL used in OAuth discovery metadata for remote connectors. */
  DOLLHOUSE_PUBLIC_BASE_URL: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),
  /** Stable per-process replica identifier for hosted web-console/runtime control. */
  DOLLHOUSE_REPLICA_ID: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),
  /** Path to TLS certificate (PEM). When set with DOLLHOUSE_TLS_KEY_PATH, the HTTP transport binds HTTPS. */
  DOLLHOUSE_TLS_CERT_PATH: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),
  /** Path to TLS private key (PEM). Required alongside DOLLHOUSE_TLS_CERT_PATH for HTTPS. */
  DOLLHOUSE_TLS_KEY_PATH: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),
  /** CI-only escape hatch: allow non-loopback bind without TLS. Never set in production. */
  DOLLHOUSE_UNSAFE_NO_TLS: envBool(false),
  /**
   * Cycle-17: separate GitHub OAuth credentials for the §8.1 user-auth
   * flow. The legacy `DOLLHOUSE_GITHUB_CLIENT_ID` is for the
   * portfolio-sync feature (server → GitHub, device flow, no secret).
   * The §8.1 GitHub method needs its own web-flow OAuth app with a
   * registered callback URL — running both features against a single
   * OAuth app is possible (enable both flows, register the §8.1
   * callback) but operationally fragile. Splitting the env vars lets
   * operators register distinct apps for the two purposes.
   *
   * Backward compat: when `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` is unset,
   * AuthProviderFactory falls back to `DOLLHOUSE_GITHUB_CLIENT_ID` and
   * logs a deprecation warning. Same fallback for the secret.
   */
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),
  DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),
  /**
   * Legacy GitHub OAuth client secret. Predates the env-var split
   * above. Kept as a fallback so existing operators don't break;
   * prefer `DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET` for new deployments.
   */
  DOLLHOUSE_GITHUB_CLIENT_SECRET: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),
  /**
   * HMAC secret for invite-token / magic-link signing. ≥32 hex chars.
   * Auto-generated and persisted with the AS signing key on first run if
   * not provided. Set explicitly for multi-instance deployments so all
   * instances share the secret.
   */
  DOLLHOUSE_INVITE_TOKEN_SECRET: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),
  // SMTP for the magic-link auth method (must-fix #10 STARTTLS-mandatory).
  DOLLHOUSE_SMTP_HOST: z.string().trim().optional().transform(v => v || undefined),
  DOLLHOUSE_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  DOLLHOUSE_SMTP_USER: z.string().trim().optional().transform(v => v || undefined),
  DOLLHOUSE_SMTP_PASSWORD: z.string().optional().transform(v => v || undefined),
  DOLLHOUSE_SMTP_FROM: z.string().trim().optional().transform(v => v || undefined),

  // ============================================================================
  // Database Configuration (Phase 4)
  // ============================================================================
  /** Storage backend: 'file' (default) or 'database' (PostgreSQL). */
  DOLLHOUSE_STORAGE_BACKEND: z.enum(['file', 'database']).default('file'),
  /** Application database URL (non-superuser role, RLS enforced). Required when DOLLHOUSE_STORAGE_BACKEND=database. */
  DOLLHOUSE_DATABASE_URL: z.string().optional(),
  /** Admin database URL (superuser role, for migrations only). Falls back to DOLLHOUSE_DATABASE_URL if not set. */
  DOLLHOUSE_DATABASE_ADMIN_URL: z.string().optional(),
  /** Maximum connection pool size. */
  DOLLHOUSE_DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  /** SSL mode for database connection. */
  DOLLHOUSE_DATABASE_SSL: z.enum(['disable', 'prefer', 'require']).default('prefer'),
  /** Base64-encoded 32-byte key used to wrap DB-stored OAuth token DEKs. Required in database mode. */
  DOLLHOUSE_MASTER_ENCRYPTION_KEY: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),

  // ============================================================================
  // Auth Storage Configuration (§8.1)
  // ============================================================================
  /**
   * Cycle 19 / B2: backend selector for the embedded AS storage layer.
   * Previously read raw via process.env in createAuthStorage.pickBackend
   * and cliAuthStorage.detectBackend, which silently allowed typos to
   * fall through to the filesystem default. Schema enforcement makes
   * misspelled values fail loudly at config parse with a clear error.
   *
   * `memory` is permitted for tests only — runtime use with durable
   * methods (local-password, magic-link) requires
   * DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE=true (see below).
   */
  DOLLHOUSE_AUTH_STORAGE_BACKEND: z.enum(['memory', 'filesystem', 'postgres']).optional(),
  /**
   * Cycle 19 / B2: explicit override that lets the in-memory AS storage
   * backend serve durable auth methods (local-password, magic-link).
   * Without this, createAuthStorage refuses the combination because
   * accounts and refresh tokens are lost on restart. Routed through
   * the schema so a typo (e.g. DOLLHOUS_ALLOW_MEMORY_AUTH_STORAGE)
   * fails loudly instead of silently leaving the safety guard active.
   */
  DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE: envBool(false),
  /** Auth rate-limit backend. Use postgres for multi-replica hosted deployments. */
  DOLLHOUSE_RATE_LIMIT_BACKEND: z.enum(['memory', 'postgres']).default('memory'),

  /**
   * Strict-mode toggle for `dollhouse_config set <path> <value>`. When
   * true (default), unknown paths and type mismatches are rejected with
   * a clear error. When false, unknown paths produce a warning but are
   * accepted — preserves back-compat for operator workflows that may
   * have stored config paths the schema registry hasn't catalogued yet.
   * See src/config/configSchema.ts for the path registry.
   */
  DOLLHOUSE_CONFIG_STRICT_PATHS: envBool(true),

  // ============================================================================
  // Shared Pool Configuration (Step 4.6)
  // ============================================================================
  /** Override the upstream collection base URL. When set, install_collection_content
   *  fetches from this URL instead of the default DollhouseMCP GitHub collection. */
  DOLLHOUSE_COLLECTION_URL: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),
  /** Comma-separated additional hostnames to add to GitHubClient's SSRF allowlist.
   *  Each entry must be a valid hostname (no scheme, no path, no wildcards). */
  DOLLHOUSE_COLLECTION_ALLOWLIST: z.string().optional()
    .transform(parseAllowedHosts),
  /** Override the shared-pool seed directory for deployment-supplied elements. */
  DOLLHOUSE_SHARED_POOL_DIR: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),

  // ============================================================================
  // Test Configuration
  // ============================================================================
  TEST_BASE_DIR: z.string().optional(),
  TEST_PERSONAS_DIR: z.string().optional(),
  TEST_CACHE_DIR: z.string().optional(),
  TEST_CONFIG_DIR: z.string().optional(),

  // ============================================================================
  // Feature Flags
  // ============================================================================
  DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION: envBool(false),
  /** Enable the shared public element pool (Step 4.6). Default: false (opt-in). */
  DOLLHOUSE_SHARED_POOL_ENABLED: envBool(false),
  ENABLE_DEBUG: envBool(false),
  /**
   * Cycle 19 / H3: debug-mode flag for verbose logging and dev-friendly
   * behaviors (console error verbosity, static-asset cache disable).
   * Previously read raw via process.env across 5 src files; routing
   * through the schema makes typos visible at config parse.
   *
   * NOTE: env.ts:58 (dotenv silencing) and utils/logger.ts:22 (logger
   * minLevel default) intentionally still read process.env directly
   * because both run before envSchema.parse() completes. See comments
   * at those sites.
   */
  DOLLHOUSE_DEBUG: envBool(false),
  TEST_VERBOSE_LOGGING: envBool(false),

  // ============================================================================
  // MCP Interface Configuration (Issue #237)
  // ============================================================================
  /**
   * MCP interface mode - controls which tool interface is exposed to LLMs:
   * - 'discrete': ~40 individual tools (list_elements, create_element, etc.) - ~3,000 tokens
   * - 'mcpaql': Consolidated MCP-AQL interface - uses MCP_AQL_ENDPOINT_MODE for style
   *
   * Default: 'mcpaql' - recommended for token efficiency and cleaner tool discovery
   */
  MCP_INTERFACE_MODE: z.enum(['discrete', 'mcpaql']).default('mcpaql'),

  /**
   * MCP-AQL endpoint mode (only applies when MCP_INTERFACE_MODE='mcpaql'):
   * - 'crude': 5 CRUDE tools (Create, Read, Update, Delete, Execute) - ~4,300 tokens
   * - 'single': 1 tool (mcp_aql) - ~350 tokens, ideal for multi-server deployments
   */
  MCP_AQL_ENDPOINT_MODE: z.enum(['crude', 'single']).default('crude'),

  // Backward compatibility alias for MCP_AQL_MODE (deprecated, use MCP_AQL_ENDPOINT_MODE)
  MCP_AQL_MODE: z.enum(['crude', 'single']).optional(),

  // ============================================================================
  // Unified Logging Configuration (docs/LOGGING-DESIGN.md)
  // ============================================================================
  DOLLHOUSE_LOG_DIR: z.string().default('~/.dollhouse/logs/'),
  DOLLHOUSE_LOG_FORMAT: z.enum(['text', 'jsonl']).default('text'),
  DOLLHOUSE_LOG_RETENTION_DAYS: z.coerce.number().default(30),
  DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS: z.coerce.number().default(7),
  DOLLHOUSE_LOG_FLUSH_INTERVAL_MS: z.coerce.number().default(5000),
  // Buffer raised to 2000 to support the web console log viewer — the higher capacity
  // reduces flush frequency and keeps more entries available for SSE backfill on connect.
  DOLLHOUSE_LOG_BUFFER_SIZE: z.coerce.number().default(2000),
  DOLLHOUSE_LOG_MEMORY_CAPACITY: z.coerce.number().default(5000),
  DOLLHOUSE_LOG_MEMORY_APP_CAPACITY: z.coerce.number().default(10000),
  DOLLHOUSE_LOG_MEMORY_SECURITY_CAPACITY: z.coerce.number().default(5000),
  DOLLHOUSE_LOG_MEMORY_PERF_CAPACITY: z.coerce.number().default(2000),
  DOLLHOUSE_LOG_MEMORY_TELEMETRY_CAPACITY: z.coerce.number().default(1000),
  DOLLHOUSE_LOG_MAX_ENTRY_SIZE: z.coerce.number().default(16384),
  DOLLHOUSE_LOG_IMMEDIATE_FLUSH_RATE: z.coerce.number().default(50),
  DOLLHOUSE_LOG_FILE_MAX_SIZE: z.coerce.number().default(104857600),
  DOLLHOUSE_LOG_MAX_DIR_SIZE_BYTES: z.coerce.number().default(0),
  DOLLHOUSE_LOG_MAX_FILES_PER_CATEGORY: z.coerce.number().default(100),

  // ============================================================================
  // Permission Server Configuration
  // ============================================================================
  /**
   * Enable the HTTP permission evaluation server for PreToolUse hooks.
   * When true, starts an HTTP endpoint on a dynamic port after deferred
   * setup completes. Writes port to ~/.dollhouse/run/permission-server.port
   * for hook script discovery. Required for autonomous agent permission
   * management via Claude Code hooks.
   */
  DOLLHOUSE_PERMISSION_SERVER: envBool(true),

  // Web Console Configuration
  // ============================================================================
  /** Enable the unified web console (logs + metrics tabs) */
  DOLLHOUSE_WEB_CONSOLE: envBool(true),

  /**
   * Port the web console leader binds to (#1794, #1798).
   *
   * Default: 41715 — "AILIS" on a phone keypad, after the AI Layer
   * Interface Specification that DollhouseMCP implements. Also "Alice"
   * in Gaelic.
   *
   * Port selection criteria (verified 2026-04-06):
   *   - Not registered with IANA (no entry in the service name registry)
   *   - Not in nmap services database (never observed in the wild)
   *   - No known application, security tool, or malware associations
   *   - Below the macOS ephemeral range (49152-65535), so `bind()`
   *     does not race with kernel-allocated source ports
   *   - In the IANA user port range (1024-49151)
   *   - Not adjacent to the pre-authentication default (3939)
   *
   * Previous default was 5907 ("LOGS" upside down on a calculator),
   * which conflicted with Stellar Cyber's HTTP GKE log parser.
   *
   * Override via env var if 41715 collides with something in your
   * environment — every runtime reference reads from this single value.
   */
  DOLLHOUSE_WEB_CONSOLE_PORT: z.coerce.number().int().min(1024).max(65535).default(41715),

  /**
   * Issue #1780: Enforce Bearer token authentication on the web console API.
   * When true, all protected endpoints require a valid token from the
   * console token file. When false (the pre-Phase-2 default), the token
   * file is still generated but the middleware does not enforce — this
   * lets the infrastructure land without breaking existing consumers.
   * Will flip to default `true` in a follow-up PR once all consumers
   * (browser, followers, bridge) have been updated to attach tokens.
   */
  DOLLHOUSE_WEB_AUTH_ENABLED: envBool(false),

  /**
   * Unified authentication (JWT-based) for HTTP transport and web console.
   * When enabled, all HTTP requests must carry a valid Bearer token.
   * When disabled (default), auth behavior depends on the surface:
   * - MCP transport: no auth (loopback binding is the security boundary)
   * - Web console: uses legacy console token auth if DOLLHOUSE_WEB_AUTH_ENABLED is set
   */
  DOLLHOUSE_AUTH_ENABLED: envBool(false),

  /** Auth provider: 'local' (self-signed JWTs), 'embedded' (Dollhouse OAuth AS), or 'oidc' (external IdP). */
  DOLLHOUSE_AUTH_PROVIDER: z.enum(['local', 'embedded', 'oidc']).default('local'),
  /**
   * Comma-separated list of auth methods exposed by the embedded AS.
   * Recognized values (per docs/PRODUCTION-AUTH-ARCHITECTURE.md §8.1):
   * 'trivial-consent', 'github', 'local-password', 'magic-link'.
   *
   * Multi-method is supported (Phase 2 shipped) — list any combination
   * and the AS exposes them all simultaneously via the LoginChooser
   * at /interaction time.
   *
   * Defaults to 'trivial-consent' (solo localhost) when unset.
   * 'oidc-bridge' is NOT a method id — it's the outer provider mode
   * selected via DOLLHOUSE_AUTH_PROVIDER=oidc.
   */
  DOLLHOUSE_AUTH_METHODS: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined),

  /** OIDC issuer URL (required when provider=oidc). */
  DOLLHOUSE_AUTH_ISSUER: z.string().optional(),

  /** OIDC expected audience claim (required when provider=oidc). */
  DOLLHOUSE_AUTH_AUDIENCE: z.string().optional(),

  /** OIDC JWKS endpoint (auto-derived from issuer if omitted). */
  DOLLHOUSE_AUTH_JWKS_URI: z.string().optional(),

  /**
   * Cycle 19 / security-#6: enforce RFC 9068 `typ: at+jwt` on OIDC-bridge
   * tokens. Default false because many managed IdPs (Auth0, Okta, Keycloak,
   * AWS Cognito) don't stamp typ on access tokens by default; hard-requiring
   * it would break those deployments. Operators whose IdP DOES stamp typ
   * should enable this to close the id-token-as-access-token gap (where an
   * id_token issued for the same audience with `mcp` scope would otherwise
   * pass the resource-server check).
   */
  DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP: envBool(false),

  /**
   * Cycle 24 / smoke-test escape hatch: allow open Dynamic Client Registration
   * at /reg without requiring an Initial Access Token. Default false (production
   * shape): only callers holding an IAT can register clients, preventing random
   * clients on the network from registering arbitrary redirect URIs and defeating
   * the redirect-URI exact-match guarantee. Set true for localhost dev to let
   * MCP clients (Gemini CLI, claude.ai web, etc.) self-register without an
   * out-of-band IAT-issuance step.
   *
   * Threat model: open DCR is acceptable when the AS is bound to loopback and
   * cannot be reached from outside the host. On a non-loopback bind, leaving
   * this on widens the attack surface to anyone who can reach the AS.
   *
   * Follow-up: the dashboard tracks IAT issuance as a deferred admin-channel
   * feature. Once that lands, operators won't need this escape hatch for
   * remote deployments; loopback dev can keep it for convenience.
   */
  DOLLHOUSE_AUTH_OPEN_DCR: envBool(false),

  /**
   * Sign-in allowlist enforcement mode.
   *
   * When `false` (initial default for back-compat): an empty allowlist
   * means "no gate" — anyone who clears the auth method's identity check
   * (GitHub OAuth, magic-link, local-password invite) can sign in. The
   * gate only activates once the operator adds a first entry.
   *
   * When `true` (secure-by-default mode): an empty allowlist means
   * "bootstrap admin only" — the pre-claimed admin can always sign in,
   * but everyone else is denied until the operator adds them. Production
   * hosted deploys should set this to `true` so a deploy-and-forget
   * doesn't sit open to anyone with a GitHub account.
   *
   * The bootstrap admin always passes regardless of this setting or the
   * allowlist contents — operators cannot lock themselves out.
   *
   * A startup warning fires when this is `false` AND the AS binds to a
   * non-loopback host AND a social method (github / magic-link) is
   * configured — naming the open-sign-in risk.
   */
  DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: envBool(false),

  /**
   * Optional path to a JSON seed file for the sign-in allowlist. When
   * set, the AS reads the file on startup and idempotently upserts each
   * entry into the active storage backend (Postgres or filesystem).
   * Lets operators who manage configuration in source control keep the
   * allowlist alongside the rest of their infrastructure.
   *
   * File format:
   * ```json
   * {
   *   "entries": [
   *     { "kind": "email", "value": "todd@example.com", "note": "founder" },
   *     { "kind": "github_username", "value": "insomnolence" }
   *   ]
   * }
   * ```
   *
   * Re-runs are no-ops for entries that already exist. Existing entries
   * not in the seed file are NOT removed — the seed file is additive, not
   * authoritative. To remove an entry, use the admin CRUD ops.
   */
  DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE: z.string().optional(),

  /** Key pair file path for local dev provider. */
  DOLLHOUSE_AUTH_LOCAL_KEY_FILE: z.string().optional(),

  /** Default subject for auto-generated startup token (local dev). */
  DOLLHOUSE_AUTH_LOCAL_DEFAULT_SUB: z.string().optional(),

  /**
   * GitHub OAuth client ID. Originally introduced for the legacy
   * portfolio-sync feature (server → GitHub, device flow). Cycle-17
   * split out a dedicated `DOLLHOUSE_AUTH_GITHUB_CLIENT_ID` for the
   * §8.1 user-auth flow; this var remains the canonical name for
   * portfolio sync AND serves as the fallback for §8.1 when the new
   * var is unset (with a deprecation warning).
   */
  DOLLHOUSE_GITHUB_CLIENT_ID: z.string().optional(),

  /**
   * Cycle-8 fix (H8): cookie signing secret. When set, must be hex-
   * encoded and decode to at least 32 bytes. Used as the keygrip key
   * for oidc-provider's signed-cookie path AND (when
   * `refreshRotationCheckIpUa=true`) as the HMAC salt for IP/UA
   * hashes on refresh tokens. In multi-replica HA, every replica
   * MUST read the same value here — file-loaded keys diverge per
   * replica and break legitimate refresh rotations.
   *
   * The shape validation here catches "set but decodes to <32 bytes"
   * at config load instead of at AS init (where the throw is buried
   * inside `loadOrGenerateCookieSigningKeys`).
   */
  DOLLHOUSE_COOKIE_SIGNING_SECRET: z.string().trim().optional()
    .refine(
      (v) => {
        if (v === undefined || v === '') return true;
        // Must be hex-encoded ≥32 bytes (64 hex chars).
        if (!/^[0-9a-fA-F]+$/.test(v)) return false;
        if (v.length < 64) return false;
        return true;
      },
      {
        message:
          'DOLLHOUSE_COOKIE_SIGNING_SECRET must be hex-encoded and decode to at least ' +
          '32 bytes (64 hex characters). Generate one with: ' +
          'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      },
    )
    .transform((v) => (v === '' ? undefined : v)),

  /**
   * Round 5 / H4: trusted-proxy CIDR list for `app.set('trust proxy')`.
   * Multiple comma-separated values; each is a CIDR or one of the
   * recognized keywords (`loopback`, `linklocal`, `uniquelocal`).
   * When unset, the default is `loopback`. Hosted multi-tenant
   * deployments MUST set this explicitly — the
   * AuthProviderFactory startup-fail guard refuses to run multi-user
   * methods behind a non-loopback bind without it (per-IP rate-limit
   * collapse hazard).
   *
   * Round 5 review fixup (MED-5): each entry is shape-validated. A
   * misspelled value (e.g. `DOLLHOUSE_TRUSTED_PROXIES=foo`) used to
   * pass the H4 startup-fail guard yet silently produce
   * `app.set('trust proxy', ['foo'])` which Express's proxy-addr
   * rejects at request time — leaving operators in the proxy-IP-
   * collapse failure mode the guard was meant to prevent. Now the
   * env load fails loudly with a clear shape error.
   */
  DOLLHOUSE_TRUSTED_PROXIES: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined)
    .refine(
      (entries) => {
        if (entries === undefined) return true;
        const keyword = /^(loopback|linklocal|uniquelocal)$/;
        // Match an IPv4 CIDR (e.g. 10.0.0.0/8) or an IPv6 CIDR
        // (e.g. fd00::/8) or a bare IPv4/IPv6 address. Not a full
        // RFC-strict parser — proxy-addr does the strict check at
        // mount time. This guard catches the common typo class
        // (alphabetic non-keyword strings like 'foo') without
        // re-implementing IP parsing.
        const cidrLike = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;
        return entries.every((entry) => keyword.test(entry) || cidrLike.test(entry));
      },
      {
        message:
          "DOLLHOUSE_TRUSTED_PROXIES entries must be CIDR ranges " +
          "(e.g. '10.0.0.0/8') or one of the keywords " +
          "'loopback' / 'linklocal' / 'uniquelocal'",
      },
    ),

  /**
   * Issue #1780: Optional override for the console token file location.
   * When unset, `ConsoleTokenStore` falls back to its built-in default
   * under `~/.dollhouse/run/`. Mainly useful for tests and for enterprise
   * deployments that mount a shared token file from a secrets volume.
   */
  DOLLHOUSE_CONSOLE_TOKEN_FILE: z.string().optional(),

  /**
   * Optional override for the console leader lock file location (#1794).
   * When unset, `LeaderElection` falls back to its built-in default under
   * `~/.dollhouse/run/`. Primarily useful for tests that need isolation
   * between runs and for deployments that split runtime state across
   * multiple installations on the same machine.
   */
  DOLLHOUSE_CONSOLE_LEADER_LOCK_FILE: z.string().optional(),

  // Leader/Follower Recovery (#1850)
  // ============================================================================

  /**
   * Issue #1850: Retry delays (in ms) when the leader fails to bind the console
   * port due to EADDRINUSE. Each value is a successive backoff delay.
   * Default: 1s, 2s, 4s (7s total). Increase for slow or remote environments.
   */
  DOLLHOUSE_CONSOLE_BIND_RETRY_DELAYS: z.string()
    .optional()
    .transform(v => v ? v.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 0) : undefined),

  /**
   * Issue #1850: Number of consecutive forwarding failures before a follower
   * declares the leader dead and attempts self-promotion. Higher values reduce
   * false positives in high-latency environments but delay recovery.
   * Default: 10.
   */
  DOLLHOUSE_CONSOLE_MAX_FORWARD_FAILURES: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * Issue #1780: Phase 2 — require a confirmation code (OS dialog or TOTP)
   * for privileged actions like token rotation. Default is true for safety;
   * set to false for headless CI and scripted deployments that need to rotate
   * without human interaction.
   */
  DOLLHOUSE_CONSOLE_ROTATION_REQUIRE_CONFIRMATION: envBool(true),

  // ============================================================================
  // Security Configuration
  // ============================================================================
  /**
   * Issue #452: Gatekeeper policy enforcement.
   * When true (default), all MCP-AQL operations go through the 4-layer Gatekeeper
   * enforce() pipeline. When false, falls back to route validation only.
   * This is a user/operator setting — the LLM cannot bypass it.
   */
  DOLLHOUSE_GATEKEEPER_ENABLED: envBool(true),
  /**
   * Issue #679: Element policy layer kill switch.
   * When true (default), active element gatekeeper policies (allow/confirm/deny/scopeRestrictions)
   * can override default operation permission levels. When false, Layer 2 of Gatekeeper.enforce()
   * is bypassed entirely — only route validation and default permission levels apply.
   * Use for emergency lockdown, hardened deployments, or policy debugging.
   * This is an operator/infrastructure setting — the LLM cannot bypass it.
   */
  DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES: envBool(true),
  /**
   * Issue #799: Policy export opt-in flag.
   * When true (default), PolicyExportService writes the security policy blueprint to
   * ~/.dollhouse/bridge/imports/policies/ on activation changes. The DollhouseBridge
   * permission-prompt server watches this file to evaluate permissions locally.
   * Set to false to disable policy file export entirely.
   */
  DOLLHOUSE_POLICY_EXPORT_ENABLED: envBool(true),

  // ============================================================================
  // Storage Layer Configuration
  // ============================================================================
  DOLLHOUSE_SCAN_COOLDOWN_MS: z.coerce.number().default(1000),
  DOLLHOUSE_INDEX_DEBOUNCE_MS: z.coerce.number().default(2000),
  DOLLHOUSE_ELEMENT_CACHE_TTL_MS: z.coerce.number().default(3600000),
  DOLLHOUSE_PATH_CACHE_TTL_MS: z.coerce.number().default(3600000),
  DOLLHOUSE_TOOL_CACHE_TTL_MS: z.coerce.number().default(60000),
  DOLLHOUSE_GLOBAL_CACHE_MEMORY_MB: z.coerce.number().default(150),

  // ============================================================================
  // Permission Prompt Configuration (Issue #625)
  // ============================================================================

  /** Maximum CLI approval records before LRU eviction (default: 50) */
  DOLLHOUSE_CLI_APPROVAL_MAX: z.coerce.number().default(50),

  /** Default TTL for CLI approval records in ms (default: 300000 = 5 min) */
  DOLLHOUSE_CLI_APPROVAL_TTL_MS: z.coerce.number().default(300_000),

  /** Permission prompt rate limit: max requests per window (default: 100) */
  DOLLHOUSE_PERMISSION_PROMPT_RATE_LIMIT: z.coerce.number().default(100),

  /** CLI approval creation rate limit: max requests per window (default: 20) */
  DOLLHOUSE_CLI_APPROVAL_RATE_LIMIT: z.coerce.number().default(20),

  /** Rate limit window in ms for permission prompt and CLI approvals (default: 60000 = 60s) */
  DOLLHOUSE_PERMISSION_RATE_WINDOW_MS: z.coerce.number().default(60_000),

  /** Store raw tool input detail in CLI approval audit records. Secure default is digest-only. */
  DOLLHOUSE_AUDIT_RETAIN_RAW_INPUT: envBool(false),
  /** Hex-encoded HMAC key for audit input hashes. When unset, a persisted key is generated. */
  DOLLHOUSE_AUDIT_HMAC_SECRET: z.string().trim().optional()
    .transform(v => (v && v.length > 0) ? v : undefined),

  // ============================================================================
  // Metrics Collection Configuration
  // ============================================================================
  DOLLHOUSE_METRICS_ENABLED: envBool(true),
  DOLLHOUSE_METRICS_COLLECTION_INTERVAL_MS: z.coerce.number().min(1000).max(300000).default(15000),
  DOLLHOUSE_METRICS_MAX_SNAPSHOT_SIZE: z.coerce.number().default(102400),
  DOLLHOUSE_METRICS_COLLECTOR_FAILURE_THRESHOLD: z.coerce.number().min(1).max(100).default(10),
  DOLLHOUSE_METRICS_COLLECTION_DURATION_WARN_MS: z.coerce.number().min(100).max(60000).default(5000),
  DOLLHOUSE_METRICS_MEMORY_SNAPSHOT_CAPACITY: z.coerce.number().min(10).max(10000).default(240),

  // Pattern encryption settings for Memory Security (Issue #1321)
  DOLLHOUSE_DISABLE_ENCRYPTION: envBool(false),
  DOLLHOUSE_ENCRYPTION_SECRET: z.string().optional(),
  DOLLHOUSE_ENCRYPTION_SALT: z.string().optional(),

  // Token encryption secret (SEC-01, #1735)
  // When set, replaces the predictable machine-derived passphrase for token encryption.
  // Strongly recommended for any shared or multi-user environment.
  // Minimum 32 characters enforced to prevent weak passphrases.
  DOLLHOUSE_TOKEN_SECRET: z.string().min(32).optional(),
});

/**
 * Validated environment variables
 * Type is automatically inferred from the schema
 */
export const env = envSchema.parse(process.env);

/**
 * Environment type (inferred from schema)
 */
export type Env = z.infer<typeof envSchema>;

/**
 * Convenience helpers for environment detection
 */
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';
export const isProduction = env.NODE_ENV === 'production';

/**
 * Log environment configuration (without secrets)
 */
if (isDevelopment || isTest) {
  logger.debug('Environment configuration loaded:', {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    LOG_LEVEL: env.LOG_LEVEL,
    DOLLHOUSE_TRANSPORT: env.DOLLHOUSE_TRANSPORT,
    HAS_GITHUB_TOKEN: !!env.GITHUB_TOKEN,
    HAS_GITHUB_TEST_TOKEN: !!env.GITHUB_TEST_TOKEN,
  });
}
