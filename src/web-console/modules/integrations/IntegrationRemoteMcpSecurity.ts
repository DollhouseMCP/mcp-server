import type { PinnedFetch } from './PinnedOutboundFactory.js';

const REDACTED = '[redacted]';
const MAX_PAYLOAD_DEPTH = 128;
const MAX_PAYLOAD_NODES = 100_000;

export const DEFAULT_REMOTE_MCP_RESPONSE_BYTES = 1024 * 1024;

export class RemoteMcpPayloadSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteMcpPayloadSafetyError';
  }
}

/** Limit each MCP POST response while preserving JSON and SSE streaming semantics. */
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
  if (credential === '') {
    throw new RemoteMcpPayloadSafetyError('Remote MCP credential is empty.');
  }
  const patterns = credentialPatterns(credential);
  if (!isContainer(value)) return redactPrimitive(value, patterns);

  const root = createContainer(value);
  const seen = new WeakSet<object>([value]);
  const pending: Array<{ source: object; target: unknown[] | Record<string, unknown>; depth: number }> = [
    { source: value, target: root, depth: 0 },
  ];
  let visitedNodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.depth >= MAX_PAYLOAD_DEPTH) {
      throw new RemoteMcpPayloadSafetyError('Remote MCP response exceeds the supported nesting depth.');
    }
    for (const [key, field] of Object.entries(current.source)) {
      visitedNodes += 1;
      if (visitedNodes > MAX_PAYLOAD_NODES) {
        throw new RemoteMcpPayloadSafetyError('Remote MCP response exceeds the supported node count.');
      }
      const safeKey = redactCredentialString(key, patterns);
      if (!isContainer(field)) {
        defineSafeProperty(current.target, safeKey, redactPrimitive(field, patterns));
        continue;
      }
      if (seen.has(field)) {
        throw new RemoteMcpPayloadSafetyError('Remote MCP response contains a circular reference.');
      }
      seen.add(field);
      const child = createContainer(field);
      defineSafeProperty(current.target, safeKey, child);
      pending.push({ source: field, target: child, depth: current.depth + 1 });
    }
  }
  return root;
}

function isContainer(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function createContainer(value: object): unknown[] | Record<string, unknown> {
  return Array.isArray(value) ? new Array<unknown>(value.length) : {};
}

function redactPrimitive(value: unknown, patterns: readonly string[]): unknown {
  if (typeof value === 'string') return redactCredentialString(value, patterns);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return patterns.includes(String(value)) ? REDACTED : value;
  }
  return value;
}

function credentialPatterns(credential: string): readonly string[] {
  const patterns = [credential];
  let encoded: string;
  try {
    encoded = encodeURIComponent(credential);
  } catch {
    return patterns;
  }
  if (encoded !== credential) patterns.push(encoded);
  return patterns;
}

function redactCredentialString(value: string, patterns: readonly string[]): string {
  let redacted = value;
  for (const pattern of patterns) redacted = redacted.replaceAll(pattern, REDACTED);
  return redacted;
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
