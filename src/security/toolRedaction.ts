import { createHmac } from 'node:crypto';

import type { AuditHmacKeyMaterial } from './auditHmacKey.js';

/**
 * Resolver contract. Implementations live in `src/security/auditHmacKey.ts`
 * (`AuditHmacKeyResolver` for production, `StaticAuditHmacKeyResolver` for tests).
 * Threaded explicitly through callers — no module-level singleton.
 */
export interface AuditHmacResolver {
  resolve(): Promise<AuditHmacKeyMaterial>;
}

export interface ToolRedactionSpec {
  keepFields?: string[];
  digestFields?: string[];
}

export const TOOL_REDACTION: Record<string, ToolRedactionSpec> = {
  Bash: { keepFields: ['description'], digestFields: ['command'] },
  Write: { keepFields: ['file_path'], digestFields: ['content'] },
  Edit: { keepFields: ['file_path', 'replace_all'], digestFields: ['old_string', 'new_string'] },
  Read: { keepFields: ['file_path', 'limit', 'offset'] },
  WebFetch: { keepFields: ['prompt'], digestFields: ['url'] },
  mcp_aql_create: { keepFields: ['operation', 'element_type'], digestFields: ['value', 'content', 'params'] },
  mcp_aql_update: { keepFields: ['operation', 'element_type'], digestFields: ['value', 'content', 'params'] },
  mcp_aql_execute: { keepFields: ['operation'], digestFields: ['params'] },
  mcp_aql_read: { keepFields: ['operation', 'element_type', 'element_name'], digestFields: ['params'] },
  mcp_aql_delete: { keepFields: ['operation', 'element_type', 'element_name'] },
  install_collection_content: { keepFields: ['element_type'], digestFields: ['url', 'params'] },
};

const MAX_FIELD_CHARS = 256;
const MAX_DIGEST_BYTES = 4096;
const TRUNC_SUFFIX = (original: number) => `...[truncated, ${original} chars original]`;
/**
 * Deny-list keywords for field NAMES. Substring match against a
 * normalized form (lower-case, separator-stripped) so `accessToken`,
 * `client-id`, `Private_Key`, and `clientsecret` all match without
 * needing a complex alternation regex.
 */
const SECRET_KEY_KEYWORDS = [
  'password', 'token', 'secret', 'apikey', 'auth', 'credential',
  'cookie', 'bearer', 'signature', 'sig', 'nonce', 'privatekey',
  'clientid', 'clientsecret',
];

function isSecretKeyName(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll(/[_-]/g, '');
  return SECRET_KEY_KEYWORDS.some((kw) => normalized.includes(kw));
}
/**
 * Specific-format secret detectors. Ordered most-specific to least.
 * Add new detectors here as concrete prefix-anchored formats, never as
 * length-only heuristics — those produce too many false positives on
 * identifiers, hashes, and content-addressed names.
 */
const SECRET_VALUE_PATTERNS = [
  // Cloud providers
  /AKIA[0-9A-Z]{16}/,                              // AWS access key id
  /AIza[\w-]{35}/,                                 // Google API key
  // Version-control hosts
  /ghp_[A-Za-z0-9]{36}/,                           // GitHub classic PAT
  /github_pat_\w{82}/,                             // GitHub fine-grained PAT
  /glpat-[\w-]{20}/,                               // GitLab PAT
  // AI providers
  /sk-ant-[\w-]{20,}/,                             // Anthropic API key (must precede generic sk-)
  /sk-[A-Za-z0-9]{32,}/,                           // OpenAI API key
  // Payments / chat / package managers
  /sk_(live|test)_[A-Za-z0-9]{24,}/,               // Stripe secret key
  /xox[abprs]-[\w-]{10,}/,                         // Slack tokens (bot / user / app / refresh / etc.)
  /npm_[A-Za-z0-9]{36,}/,                          // npm automation token
  /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/i, // Discord webhook URL
  // Standard formats
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/,                     // JWT (base64url header.payload.signature)
  /Bearer\s+[\w.+/=-]{20,}/i,                      // Bearer-prefixed token
  /-----BEGIN [A-Z ]+-----/,                       // PEM block header (private keys, certs)
  /\b[a-f0-9]{32,}\b/i,                            // Long hex (last-resort)
];
const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'password',
  'token',
  'secret',
  'client_secret',
  'refresh_token',
]);

export async function redactToolInput(
  toolName: string,
  raw: Record<string, unknown>,
  resolver: AuditHmacResolver,
): Promise<{ digest: Record<string, unknown>; hash: string; detail: Record<string, unknown> }> {
  const spec = TOOL_REDACTION[toolName];
  const digest = spec ? redactWithSpec(raw, spec) : genericRedact(raw);
  const key = await resolver.resolve();
  const hash = `${key.keyId}:${createHmac('sha256', key.key).update(canonicalJSON(raw)).digest('hex')}`;
  return { digest: capDigest(digest), hash, detail: raw };
}

/**
 * Normalize a possibly-old-shape CliApprovalRecord into the new digest+hash
 * shape. New-shape records are passed through with the `toolInput` field
 * stripped. Old-shape records (with `toolInput` present) are rehashed using
 * `resolver` — callers reading old data must therefore provide one.
 */
export async function normalizeCliApprovalRecord<T extends {
  toolName: string;
  toolInputDigest?: Record<string, unknown>;
  toolInputHash?: string;
  toolInputDetail?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
}>(
  record: T,
  retainRaw: boolean,
  resolver: AuditHmacResolver | undefined,
): Promise<Omit<T, 'toolInput'> & {
  toolInputDigest: Record<string, unknown>;
  toolInputHash: string;
  toolInputDetail?: Record<string, unknown>;
}> {
  if (record.toolInputDigest && record.toolInputHash) {
    const { toolInput: _ignored, ...rest } = record;
    return rest as Omit<T, 'toolInput'> & {
      toolInputDigest: Record<string, unknown>;
      toolInputHash: string;
      toolInputDetail?: Record<string, unknown>;
    };
  }
  if (!resolver) {
    throw new Error(
      `Cannot normalize old-shape CliApprovalRecord without an AuditHmacResolver. ` +
      `Caller must inject the resolver to rehash legacy records (toolName=${record.toolName}).`,
    );
  }
  const raw = record.toolInput ?? {};
  const redacted = await redactToolInput(record.toolName, raw, resolver);
  const { toolInput: _ignored, ...rest } = record;
  return {
    ...rest,
    toolInputDigest: redacted.digest,
    toolInputHash: redacted.hash,
    toolInputDetail: retainRaw ? redacted.detail : undefined,
  };
}

/**
 * Stable canonical JSON for HMAC input.
 *
 * Sorts object keys recursively and SKIPS `undefined` values (mirroring
 * `JSON.stringify` semantics) so two logically-equal inputs that differ
 * only in explicit-vs-implicit absence hash identically.
 *
 * Restricted to JSON-shaped values (the MCP tool-input domain). `Symbol`
 * and `Function` values are coerced to `null` (parity with JSON.stringify
 * dropping them silently); `BigInt` throws — same as JSON.stringify.
 *
 * Native object types that are not plain JSON containers — `Date`, `Map`,
 * `Set`, `RegExp`, class instances — fall into the object branch and hash
 * as `{}` because none of them expose enumerable own keys. This is correct
 * for MCP tool inputs (which arrive as JSON-decoded payloads and never
 * carry these types), but will silently produce the SAME hash for any two
 * such instances. If a future caller needs to hash native types, prefer a
 * dedicated serializer over expanding this one.
 *
 * Recursion is bounded by `CANONICAL_JSON_MAX_DEPTH` so a deeply-nested
 * adversarial input cannot stack-overflow the HMAC path before the
 * digest's depth cap fires.
 */
export function canonicalJSON(value: unknown): string {
  return canonicalJSONInner(value, 0);
}

const CANONICAL_JSON_MAX_DEPTH = 64;

function canonicalJSONInner(value: unknown, depth: number): string {
  if (depth > CANONICAL_JSON_MAX_DEPTH) {
    throw new RangeError(
      `canonicalJSON: input nested deeper than ${CANONICAL_JSON_MAX_DEPTH} levels; ` +
      `tool inputs above this depth are rejected to prevent stack-overflow during HMAC computation`,
    );
  }
  if (value === undefined) return 'null';
  if (typeof value === 'bigint') {
    // JSON.stringify throws on BigInt; mirror that explicit failure rather
    // than silently emitting a malformed JSON fragment via the template
    // literal below.
    throw new TypeError('canonicalJSON: BigInt values are not supported');
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    // JSON.stringify drops these silently (returns undefined for the
    // whole call, or skips the key inside an object). Coerce to null so
    // canonical output stays a well-formed JSON fragment.
    return 'null';
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJSONInner(v, depth + 1))).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  // Explicit codepoint comparator (deterministic across locales, identical
  // to default sort behaviour on strings — verified by the round-trip hash
  // pin test). Don't use localeCompare here: it's locale-dependent and
  // would break HMAC stability across deployments.
  const entries = Object.keys(obj)
    .sort(compareCodepoint)
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJSONInner(obj[k], depth + 1)}`);
  return `{${entries.join(',')}}`;
}

function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function redactWithSpec(raw: Record<string, unknown>, spec: ToolRedactionSpec): Record<string, unknown> {
  const keep = new Set(spec.keepFields ?? []);
  const digest = new Set(spec.digestFields ?? []);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    // keepFields run through redactString (URL userinfo scrub, URL query-param
    // scrub, specific-format secret patterns) before length-capping. Free-text
    // fields like Bash.description or WebFetch.prompt are user-controlled and
    // cannot be trusted to be free of secrets; accepting a false-positive
    // redaction is preferable to leaking an embedded credential.
    if (keep.has(key)) result[key] = sanitizeKeepValue(value);
    else if (digest.has(key)) result[key] = digestMarker(value);
    else result[key] = genericRedactValue(key, value);
  }
  return result;
}

// Recursion depth cap on generic redaction. Tool inputs deeper than this
// almost certainly aren't legitimate parameter trees; capping protects
// against a malicious or buggy caller submitting a deeply-nested object
// to burn CPU during redaction. 10 levels comfortably accommodates real
// MCP tool calls (typically 2-4 deep).
const MAX_REDACTION_DEPTH = 10;
// Frozen so a future caller can't mutate the marker and have the change
// propagate to every depth-capped subtree in every digest in the process.
const DEPTH_TRUNCATED: Record<string, unknown> = Object.freeze({
  redacted: true,
  type: 'object',
  reason: 'depth_cap',
}) as Record<string, unknown>;

function genericRedact(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth >= MAX_REDACTION_DEPTH) return DEPTH_TRUNCATED;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    result[key] = genericRedactValue(key, value, depth);
  }
  return result;
}

function genericRedactValue(key: string, value: unknown, depth = 0): unknown {
  if (isSecretKeyName(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_REDACTION_DEPTH) return DEPTH_TRUNCATED;
    return value.map((v) => genericRedactValue(key, v, depth + 1));
  }
  if (value && typeof value === 'object') {
    return genericRedact(value as Record<string, unknown>, depth + 1);
  }
  return value;
}

function redactString(value: string): string {
  // First sweep: scrub URL-like substrings embedded inside larger strings
  // (e.g. natural-language descriptions like "visit https://u:p@host/").
  // Without this pre-pass, a userinfo-bearing URL in prose would survive
  // because scrubUrlLike(entire-string) fails to parse and the fallback
  // path can't find an embedded URL.
  let scrubbed = scrubEmbeddedUrls(value);
  // Second sweep: scrubUrlLike(scrubbed) — handles the case where the
  // value IS a single URL (no surrounding text). Idempotent with the
  // embedded sweep above.
  scrubbed = scrubUrlLike(scrubbed);
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(scrubbed))) {
    scrubbed = '[REDACTED]';
  }
  return capString(scrubbed);
}

// URL-scheme prefixes that commonly carry userinfo or auth-bearing query
// strings. `data:` is intentionally excluded — it carries no auth and the
// payload is bulk content that would dominate the digest size cap. Extend
// here only with schemes that materially expand the attack surface.
const EMBEDDED_URL_RE = /(?:https?|wss?|ftp):\/\/[^\s'"<>]+/gi;

/**
 * Sweep `value` for URL-shaped substrings and pass each through
 * `scrubUrlLike`. Used as a pre-pass inside `redactString` to catch
 * userinfo and sensitive query params in URLs that appear inside larger
 * free-text fields (e.g. `Bash.description: "visit https://u:p@host/"`).
 *
 * Pairs with `scrubUrlLike`: when `value` IS a single URL with no
 * surrounding text, the regex-replace is a no-op and `scrubUrlLike` does
 * the work. When `value` is prose containing a URL, this function
 * extracts the URL substring so `scrubUrlLike` can parse it.
 */
function scrubEmbeddedUrls(value: string): string {
  return value.replaceAll(EMBEDDED_URL_RE, (match) => scrubUrlLike(match));
}

function scrubUrlLike(value: string): string {
  try {
    const url = new URL(value);
    // Clear HTTP-Basic userinfo before re-emitting.
    if (url.username !== '' || url.password !== '') {
      url.username = '';
      url.password = '';
    }
    scrubSearchParams(url.searchParams);
    return url.toString();
  } catch {
    return scrubNonAbsoluteUrl(value);
  }
}

function scrubNonAbsoluteUrl(value: string): string {
  if (value.startsWith('?')) {
    const params = new URLSearchParams(value.slice(1));
    scrubSearchParams(params);
    return `?${params.toString()}`;
  }

  // Look for URL-like substrings of the form `[host-or-path]?key=value...`.
  // Anchoring to a host/path-shaped prefix prevents the previous
  // first-question-mark heuristic from misfiring on free text like
  // "is the API key abc? maybe" (which is not a URL, but contained `?`).
  // We accept word/dot/slash characters before the `?` and require at
  // least one `=` in the query portion to confirm it's a query string.
  return value
    .replaceAll(NON_ABSOLUTE_URL_DOTTED_RE, scrubQueryReplacement)
    .replaceAll(NON_ABSOLUTE_URL_SLASHED_RE, scrubQueryReplacement);
}

// Two narrowly-scoped regexes for URL-shaped fragments preceding `?...`.
// Kept as separate alternatives (instead of one big alternation regex) so
// each one's complexity stays well under static-analysis thresholds and
// so a future change to either form is isolated. The prefix MUST contain
// a `.` or `/` to qualify — that's what distinguishes a URL-shaped
// fragment from prose containing a question mark.
//   `[\w-]+(?:\.[\w-]+)+` — dotted name (with optional `/path` tail)
const NON_ABSOLUTE_URL_DOTTED_RE = /([\w-]+(?:\.[\w-]+)+(?:\/[\w./-]*)?)\?([^\s?]+)/g;
//   `[\w.-]*\/[\w./-]+` — slashed path (must contain at least one `/`)
const NON_ABSOLUTE_URL_SLASHED_RE = /([\w.-]*\/[\w./-]+)\?([^\s?]+)/g;

function scrubQueryReplacement(_match: string, prefix: string, query: string): string {
  if (!query.includes('=')) return `${prefix}?${query}`;
  const params = new URLSearchParams(query);
  scrubSearchParams(params);
  return `${prefix}?${params.toString()}`;
}

function scrubSearchParams(params: URLSearchParams): void {
  for (const key of Array.from(params.keys())) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, '[REDACTED]');
    }
  }
}

/**
 * Sanitize a `keepFields` value: run secret detection + URL scrubbing,
 * then length-cap. `redactString` already applies the cap as its final
 * step, so calling capString again here would double-truncate and emit
 * a wrong "N chars original" count. Non-string values pass through
 * unchanged.
 */
function sanitizeKeepValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return redactString(value);
}

function capString(value: string): string {
  return value.length > MAX_FIELD_CHARS
    ? `${value.slice(0, MAX_FIELD_CHARS)}${TRUNC_SUFFIX(value.length)}`
    : value;
}

function digestMarker(value: unknown): Record<string, unknown> {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    redacted: true,
    type: Array.isArray(value) ? 'array' : typeof value,
    length: serialized?.length ?? 0,
  };
}

function capDigest(digest: Record<string, unknown>): Record<string, unknown> {
  let json = JSON.stringify(digest);
  if (Buffer.byteLength(json, 'utf8') <= MAX_DIGEST_BYTES) return digest;
  const capped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(digest)) {
    capped[key] = value;
    json = JSON.stringify(capped);
    if (Buffer.byteLength(json, 'utf8') > MAX_DIGEST_BYTES) {
      capped[key] = '[TRUNCATED_DIGEST]';
      break;
    }
  }
  return capped;
}
