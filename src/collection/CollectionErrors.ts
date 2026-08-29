/**
 * Typed errors for the collection fetch/validate pipeline.
 *
 * Consumers (the web-console install/browse surfaces, MCP collection handlers)
 * classify failures into user-facing statuses. Matching on `instanceof` keeps
 * that classification stable when a message is reworded; the messages
 * themselves are preserved verbatim from the previous plain-Error throws so
 * existing message-based handling keeps working during the transition.
 */

/** The requested collection element does not exist (or is not a file). */
export class CollectionElementNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectionElementNotFoundError';
  }
}

/** The collection path is structurally invalid (shape, type segment, extension). */
export class CollectionPathInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectionPathInvalidError';
  }
}

/**
 * The element's content failed install-grade validation (size, security scan,
 * required fields) — permanent for this element, not a transient outage.
 */
export class CollectionContentInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectionContentInvalidError';
  }
}

/**
 * instanceof check that also walks the `cause` chain. The GitHub client wraps
 * everything it catches in an McpError (token redaction + MCP error contract)
 * but attaches the original error as `cause` — so a typed collection error
 * survives the wrap and classification stays typed end-to-end. Depth-bounded
 * against pathological cause cycles.
 */
export function isCollectionError<T extends Error>(
  error: unknown,
  errorClass: new (message: string) => T,
): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof errorClass) return true;
    current = current.cause;
  }
  return false;
}
