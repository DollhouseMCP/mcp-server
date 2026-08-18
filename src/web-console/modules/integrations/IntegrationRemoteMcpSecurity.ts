import type { PinnedFetch } from './PinnedOutboundFactory.js';

const REDACTED = '[redacted]';
const MAX_PAYLOAD_DEPTH = 128;
const MAX_PAYLOAD_NODES = 100_000;

export const DEFAULT_REMOTE_MCP_RESPONSE_BYTES = 1024 * 1024;

interface CredentialPatterns {
  readonly exact: readonly string[];
  readonly encoded: RegExp | null;
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
 * Limit each MCP POST response while preserving JSON and SSE streaming semantics.
 * Long-lived GET notification streams are intentionally not capped cumulatively.
 */
export function createBoundedRemoteMcpFetch(
  pinnedFetch: PinnedFetch,
  maxBytes: number,
): PinnedFetch {
  return async (input, init) => {
    const response = await pinnedFetch(input, init);
    if ((init?.method ?? 'GET').toUpperCase() !== 'POST') return response;

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number.parseInt(contentLength, 10) > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new RemoteMcpPayloadSafetyError('Remote MCP response exceeds the configured byte limit.');
    }
    if (!response.body) return response;

    let totalBytes = 0;
    const boundedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          throw new RemoteMcpPayloadSafetyError('Remote MCP response exceeds the configured byte limit.');
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(boundedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
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
    exact: [credential],
    encoded: encodedCredentialPattern(credential),
  };
}

function redactCredentialString(value: string, patterns: CredentialPatterns): string {
  let redacted = value;
  for (const pattern of patterns.exact) redacted = redacted.replaceAll(pattern, REDACTED);
  if (patterns.encoded) redacted = redacted.replace(patterns.encoded, REDACTED);
  return redacted;
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
  const first = caseInsensitiveHexDigit(hexadecimal[0] ?? '');
  const second = caseInsensitiveHexDigit(hexadecimal[1] ?? '');
  return `%${first}${second}`;
}

function caseInsensitiveHexDigit(value: string): string {
  const lower = value.toLowerCase();
  return lower >= 'a' && lower <= 'f' ? `[${lower}${lower.toUpperCase()}]` : value;
}

function escapeRegexCharacter(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\\$&`);
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
