import type { PinnedFetch } from './PinnedOutboundFactory.js';

const REDACTED = '[redacted]';
const MAX_PAYLOAD_DEPTH = 128;
const MAX_PAYLOAD_NODES = 100_000;
const MAX_CREDENTIAL_DECODE_DEPTH = 4;
const JSON_ESCAPE_PATTERN = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/g;
const PERCENT_ESCAPE_RUN_PATTERN = /(?:%[0-9A-Fa-f]{2})+/g;
const UTF8_DECODER = new TextDecoder();

export const DEFAULT_REMOTE_MCP_RESPONSE_BYTES = 1024 * 1024;

interface CredentialPatterns {
  readonly credential: string;
  readonly exact: readonly string[];
  readonly encoded: RegExp | null;
}

interface ResponseByteLimitState {
  totalBytes: number;
  previousByte: number;
  byteBeforePrevious: number;
}

interface DecodedFrontierResult {
  readonly containsCredential: boolean;
  readonly next: string[];
}

interface PayloadTraversalFrame {
  readonly source: object;
  readonly target: unknown[] | Record<string, unknown>;
  readonly depth: number;
}

interface PayloadTraversalState {
  readonly patterns: CredentialPatterns;
  readonly seen: WeakSet<object>;
  readonly pending: PayloadTraversalFrame[];
  visitedNodes: number;
}

export class RemoteMcpPayloadSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteMcpPayloadSafetyError';
  }
}

/**
 * Limit each MCP POST response and each event on long-lived GET SSE streams.
 */
export function createBoundedRemoteMcpFetch(
  pinnedFetch: PinnedFetch,
  maxBytes: number,
): PinnedFetch {
  return async (input, init) => {
    const response = await pinnedFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') return boundRemoteMcpResponse(response, maxBytes, false);
    if (method === 'GET') return boundRemoteMcpResponse(response, maxBytes, true);
    return response;
  };
}

function boundRemoteMcpResponse(response: Response, maxBytes: number, perSseEvent: boolean): Response {
  if (!perSseEvent) {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number.parseInt(contentLength, 10) > maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new RemoteMcpPayloadSafetyError('Remote MCP response exceeds the configured byte limit.');
    }
  }
  if (!response.body) return response;

  const state: ResponseByteLimitState = {
    totalBytes: 0,
    previousByte: -1,
    byteBeforePrevious: -1,
  };
  const boundedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      enforceResponseByteLimit(chunk, maxBytes, perSseEvent, state);
      controller.enqueue(chunk);
    },
  }));
  return new Response(boundedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function enforceResponseByteLimit(
  chunk: Uint8Array,
  maxBytes: number,
  perSseEvent: boolean,
  state: ResponseByteLimitState,
): void {
  if (!perSseEvent) {
    state.totalBytes += chunk.byteLength;
    assertWithinResponseByteLimit(state.totalBytes, maxBytes);
    return;
  }
  for (const byte of chunk) {
    if (isSseEventBoundary(byte, state.previousByte, state.byteBeforePrevious)) {
      state.totalBytes = 0;
    } else {
      state.totalBytes += 1;
      assertWithinResponseByteLimit(state.totalBytes, maxBytes);
    }
    state.byteBeforePrevious = state.previousByte;
    state.previousByte = byte;
  }
}

function assertWithinResponseByteLimit(totalBytes: number, maxBytes: number): void {
  if (totalBytes > maxBytes) {
    throw new RemoteMcpPayloadSafetyError('Remote MCP response exceeds the configured byte limit.');
  }
}

function isSseEventBoundary(byte: number, previousByte: number, byteBeforePrevious: number): boolean {
  const LF = 0x0a;
  const CR = 0x0d;
  if (byte === CR) return previousByte === CR || previousByte === LF;
  if (byte !== LF) return false;
  if (previousByte === LF) return true;
  return previousByte === CR && (byteBeforePrevious === CR || byteBeforePrevious === LF);
}

/**
 * Clone JSON-like MCP output while removing the exact bearer credential from
 * every exposed string and property name. Traversal limits make malformed
 * custom-client output fail closed instead of overflowing the process stack.
 */
export function redactRemoteMcpCredentialEchoes(value: unknown, credential: string): unknown {
  if (credential === '' || REDACTED.includes(credential)) {
    throw new RemoteMcpPayloadSafetyError('Remote MCP credential cannot be safely redacted.');
  }
  const patterns = credentialPatterns(credential);
  if (!isContainer(value)) return redactPrimitive(value, patterns);

  const root = createContainer(value);
  const state: PayloadTraversalState = {
    patterns,
    seen: new WeakSet<object>([value]),
    pending: [{ source: value, target: root, depth: 0 }],
    visitedNodes: 0,
  };
  while (state.pending.length > 0) {
    const current = state.pending.pop();
    if (current) copyContainerFields(current, state);
  }
  return root;
}

function copyContainerFields(current: PayloadTraversalFrame, state: PayloadTraversalState): void {
  if (current.depth >= MAX_PAYLOAD_DEPTH) {
    throw new RemoteMcpPayloadSafetyError('Remote MCP response exceeds the supported nesting depth.');
  }
  for (const [key, field] of Object.entries(current.source)) {
    copyContainerField(current, key, field, state);
  }
}

function copyContainerField(
  current: PayloadTraversalFrame,
  key: string,
  field: unknown,
  state: PayloadTraversalState,
): void {
  recordVisitedNode(state);
  const safeKey = redactCredentialString(key, state.patterns);
  if (!isContainer(field)) {
    defineSafeProperty(current.target, safeKey, redactPrimitive(field, state.patterns));
    return;
  }
  if (state.seen.has(field)) {
    throw new RemoteMcpPayloadSafetyError('Remote MCP response contains a circular reference.');
  }
  state.seen.add(field);
  const child = createContainer(field);
  defineSafeProperty(current.target, safeKey, child);
  state.pending.push({ source: field, target: child, depth: current.depth + 1 });
}

function recordVisitedNode(state: PayloadTraversalState): void {
  state.visitedNodes += 1;
  if (state.visitedNodes > MAX_PAYLOAD_NODES) {
    throw new RemoteMcpPayloadSafetyError('Remote MCP response exceeds the supported node count.');
  }
}

function isContainer(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function createContainer(value: object): unknown[] | Record<string, unknown> {
  // Preserve sparse-array length while safe property definitions copy present indexes.
  return Array.isArray(value) ? new Array<unknown>(value.length) : {};
}

function redactPrimitive(value: unknown, patterns: CredentialPatterns): unknown {
  if (typeof value === 'string') return redactCredentialString(value, patterns);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    const serialized = String(value);
    const redacted = redactCredentialString(serialized, patterns);
    return redacted === serialized ? value : redacted;
  }
  return value;
}

function credentialPatterns(credential: string): CredentialPatterns {
  try {
    // Reject lone surrogates before constructing UTF-8 alternatives.
    encodeURIComponent(credential);
  } catch {
    throw new RemoteMcpPayloadSafetyError('Remote MCP credential cannot be safely redacted.');
  }
  return {
    credential,
    exact: [credential],
    encoded: encodedCredentialPattern(credential),
  };
}

function redactCredentialString(value: string, patterns: CredentialPatterns): string {
  if (decodedVariantContainsCredential(value, patterns.credential)) return REDACTED;
  let redacted = value;
  for (const pattern of patterns.exact) redacted = redacted.replaceAll(pattern, REDACTED);
  if (patterns.encoded) redacted = redacted.replace(patterns.encoded, REDACTED);
  if (redacted.includes(patterns.credential)) return REDACTED;
  return decodedVariantContainsCredential(redacted, patterns.credential, true) ? REDACTED : redacted;
}

function decodedVariantContainsCredential(
  value: string,
  credential: string,
  inspectFirstLayer = false,
): boolean {
  const seen = new Set<string>([value]);
  let frontier = [value];
  for (let depth = 0; depth < MAX_CREDENTIAL_DECODE_DEPTH; depth += 1) {
    const expanded = expandDecodedFrontier(frontier, credential, inspectFirstLayer || depth > 0, seen);
    if (expanded.containsCredential) return true;
    frontier = expanded.next;
    if (frontier.length === 0) return false;
  }
  return false;
}

function expandDecodedFrontier(
  frontier: readonly string[],
  credential: string,
  inspectForCredential: boolean,
  seen: Set<string>,
): DecodedFrontierResult {
  const next: string[] = [];
  for (const variant of frontier) {
    for (const decoded of decodedVariants(variant)) {
      if (inspectForCredential && decoded.includes(credential)) {
        return { containsCredential: true, next };
      }
      appendUnseenDecodedVariant(decoded, variant, seen, next);
    }
  }
  return { containsCredential: false, next };
}

function appendUnseenDecodedVariant(
  decoded: string,
  source: string,
  seen: Set<string>,
  next: string[],
): void {
  if (decoded === source || seen.has(decoded)) return;
  seen.add(decoded);
  next.push(decoded);
}

function decodedVariants(value: string): readonly string[] {
  return [decodeJsonEscapes(value), decodeValidPercentEscapeRuns(value)];
}

function decodeValidPercentEscapeRuns(value: string): string {
  return value.replaceAll(PERCENT_ESCAPE_RUN_PATTERN, decodePercentEscapeRun);
}

function decodePercentEscapeRun(run: string): string {
  const bytes = new Uint8Array(run.length / 3);
  for (let offset = 0; offset < run.length; offset += 3) {
    bytes[offset / 3] = Number.parseInt(run.slice(offset + 1, offset + 3), 16);
  }
  // Decoding is inspection-only. Replacement characters isolate invalid UTF-8
  // bytes while allowing adjacent valid spans to continue through the bounded scan.
  return UTF8_DECODER.decode(bytes);
}

function decodeJsonEscapes(value: string): string {
  return value.replaceAll(JSON_ESCAPE_PATTERN, (escape) => {
    if (escape.startsWith(String.raw`\u`)) {
      return String.fromCodePoint(Number.parseInt(escape.slice(2), 16));
    }
    switch (escape[1]) {
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return escape;
    }
  });
}

function encodedCredentialPattern(credential: string): RegExp {
  let pattern = '';
  for (const character of credential) {
    const encodedBytes = Array.from(new TextEncoder().encode(character), percentEncodedBytePattern).join('');
    const alternatives = [
      escapeRegexCharacter(character),
      encodedBytes,
      unicodeEscapedCharacterPattern(character),
    ];
    const shortEscape = jsonShortEscape(character);
    if (shortEscape) alternatives.push(escapeRegexCharacter(shortEscape));
    pattern += `(?:${alternatives.join('|')})`;
  }
  return new RegExp(pattern, 'g');
}

function unicodeEscapedCharacterPattern(character: string): string {
  let pattern = '';
  for (const codeUnit of character.split('')) {
    const value = codeUnit.codePointAt(0);
    if (value === undefined) continue;
    const hexadecimal = value.toString(16).padStart(4, '0');
    pattern += String.raw`\\u${Array.from(hexadecimal, caseInsensitiveHexDigit).join('')}`;
  }
  return pattern;
}

function jsonShortEscape(character: string): string | null {
  switch (character) {
    case '"': return String.raw`\"`;
    case '\\': return String.raw`\\`;
    case '/': return String.raw`\/`;
    case '\b': return String.raw`\b`;
    case '\f': return String.raw`\f`;
    case '\n': return String.raw`\n`;
    case '\r': return String.raw`\r`;
    case '\t': return String.raw`\t`;
    default: return null;
  }
}

function percentEncodedBytePattern(byte: number): string {
  const hexadecimal = byte.toString(16).padStart(2, '0');
  const first = caseInsensitiveHexDigit(hexadecimal[0]);
  const second = caseInsensitiveHexDigit(hexadecimal[1]);
  return `%${first}${second}`;
}

function caseInsensitiveHexDigit(value: string): string {
  const lower = value.toLowerCase();
  return lower >= 'a' && lower <= 'f' ? `[${lower}${lower.toUpperCase()}]` : value;
}

function escapeRegexCharacter(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\\$&`);
}

function defineSafeProperty(
  target: unknown[] | Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
