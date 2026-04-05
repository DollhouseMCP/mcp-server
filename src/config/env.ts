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
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

// Load .env files with priority: .env.local (personal) > .env (shared defaults)
// Both files are optional - no error if either doesn't exist
//
// MCP Protocol Compliance: Suppress dotenv's stdout output
// The MCP protocol requires that ONLY JSON-RPC messages go to stdout.
// dotenv may output version info to stdout, which breaks Claude Desktop connection.
// Solution: Temporarily redirect stdout to stderr during dotenv initialization.
// In --web mode, suppress both stdout AND stderr — the user only needs the
// console URL banner, not dotenv's injection summary. Logs go to the web viewer.
const isWebSilent = process.argv.includes('--web')
  && !process.env.DOLLHOUSE_DEBUG && !process.env.ENABLE_DEBUG;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (isWebSilent ? (() => true) : process.stderr.write.bind(process.stderr)) as any;
if (isWebSilent) process.stderr.write = (() => true) as any;
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
  // Test Configuration
  // ============================================================================
  TEST_BASE_DIR: z.string().optional(),
  TEST_PERSONAS_DIR: z.string().optional(),
  TEST_CACHE_DIR: z.string().optional(),
  TEST_CONFIG_DIR: z.string().optional(),

  // ============================================================================
  // Feature Flags
  // ============================================================================
  DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION: z.coerce.boolean().default(false),
  ENABLE_DEBUG: z.coerce.boolean().default(false),
  TEST_VERBOSE_LOGGING: z.coerce.boolean().default(false),

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
  // Web Console Configuration
  // ============================================================================
  /** Enable the unified web console (logs + metrics tabs) */
  DOLLHOUSE_WEB_CONSOLE: z.coerce.boolean().default(true),

  /**
   * Port the web console leader binds to (#1794).
   *
   * ⚠️ PROVISIONAL DEFAULT — will be revisited before the first public
   * release of the authenticated console. 5907 is confirmed to conflict
   * with the Stellar Cyber security monitoring platform, which uses it
   * as the listen port for its HTTP Google Kubernetes Engine log parser
   * (JSON, `http_google_kubernetes_engine`, `cloudsec` category). See:
   * https://docs.stellarcyber.ai/6.3.xs/Configure/Ports/Firewall-Ports-for-Parsers.htm
   *
   * Stellar Cyber is a plausible co-tenant on DollhouseMCP-adjacent
   * security workstations, so this collision matters. A tracking issue
   * filed alongside #1796 will pick the permanent default.
   *
   * The whole point of this architecture is that changing the port is a
   * single-line edit here, not a hunt across the codebase. Every runtime
   * reference (UnifiedConsole leader election, `startWebServer` default,
   * port discovery) reads from this value, and the env var override
   * lets deployments hit a collision resolve it without any code change.
   *
   * Why 5907 is still a useful interim default despite the conflict:
   *   - Digits 5-9-0-7 spell "LOGS" upside down on a calculator — a nod
   *     to the management console's logs tab. Thematic, memorable.
   *   - Below the macOS ephemeral range (49152-65535), so `bind()`
   *     does not race with kernel-allocated source ports
   *   - In the IANA registered range (1024-49151)
   *   - Not adjacent to the pre-authentication default (3939), so an
   *     off-by-one typo can't silently hit the wrong console
   *   - The conflict is with a specific security vendor's product, not
   *     a ubiquitous dev tool, so the collision radius for interim
   *     testing is bounded
   */
  DOLLHOUSE_WEB_CONSOLE_PORT: z.coerce.number().int().min(1024).max(65535).default(5907),

  /**
   * Issue #1780: Enforce Bearer token authentication on the web console API.
   * When true, all protected endpoints require a valid token from the
   * console token file. When false (the pre-Phase-2 default), the token
   * file is still generated but the middleware does not enforce — this
   * lets the infrastructure land without breaking existing consumers.
   * Will flip to default `true` in a follow-up PR once all consumers
   * (browser, followers, bridge) have been updated to attach tokens.
   */
  DOLLHOUSE_WEB_AUTH_ENABLED: z.coerce.boolean().default(false),

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

  /**
   * Issue #1780: Phase 2 — require a confirmation code (OS dialog or TOTP)
   * for privileged actions like token rotation. Default is true for safety;
   * set to false for headless CI and scripted deployments that need to rotate
   * without human interaction.
   */
  DOLLHOUSE_CONSOLE_ROTATION_REQUIRE_CONFIRMATION: z.coerce.boolean().default(true),

  // ============================================================================
  // Security Configuration
  // ============================================================================
  /**
   * Issue #452: Gatekeeper policy enforcement.
   * When true (default), all MCP-AQL operations go through the 4-layer Gatekeeper
   * enforce() pipeline. When false, falls back to route validation only.
   * This is a user/operator setting — the LLM cannot bypass it.
   */
  DOLLHOUSE_GATEKEEPER_ENABLED: z.coerce.boolean().default(true),
  /**
   * Issue #679: Element policy layer kill switch.
   * When true (default), active element gatekeeper policies (allow/confirm/deny/scopeRestrictions)
   * can override default operation permission levels. When false, Layer 2 of Gatekeeper.enforce()
   * is bypassed entirely — only route validation and default permission levels apply.
   * Use for emergency lockdown, hardened deployments, or policy debugging.
   * This is an operator/infrastructure setting — the LLM cannot bypass it.
   */
  DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES: z.coerce.boolean().default(true),
  /**
   * Issue #799: Policy export opt-in flag.
   * When true (default), PolicyExportService writes the security policy blueprint to
   * ~/.dollhouse/bridge/imports/policies/ on activation changes. The DollhouseBridge
   * permission-prompt server watches this file to evaluate permissions locally.
   * Set to false to disable policy file export entirely.
   */
  DOLLHOUSE_POLICY_EXPORT_ENABLED: z.coerce.boolean().default(true),

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

  // ============================================================================
  // Metrics Collection Configuration
  // ============================================================================
  DOLLHOUSE_METRICS_ENABLED: z.coerce.boolean().default(true),
  DOLLHOUSE_METRICS_COLLECTION_INTERVAL_MS: z.coerce.number().min(1000).max(300000).default(15000),
  DOLLHOUSE_METRICS_MAX_SNAPSHOT_SIZE: z.coerce.number().default(102400),
  DOLLHOUSE_METRICS_COLLECTOR_FAILURE_THRESHOLD: z.coerce.number().min(1).max(100).default(10),
  DOLLHOUSE_METRICS_COLLECTION_DURATION_WARN_MS: z.coerce.number().min(100).max(60000).default(5000),
  DOLLHOUSE_METRICS_MEMORY_SNAPSHOT_CAPACITY: z.coerce.number().min(10).max(10000).default(240),

  // Pattern encryption settings for Memory Security (Issue #1321)
  DOLLHOUSE_DISABLE_ENCRYPTION: z.coerce.boolean().default(false),
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
    HAS_GITHUB_TOKEN: !!env.GITHUB_TOKEN,
    HAS_GITHUB_TEST_TOKEN: !!env.GITHUB_TEST_TOKEN,
  });
}
