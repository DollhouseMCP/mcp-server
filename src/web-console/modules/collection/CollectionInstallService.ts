import type {
  ConsoleHandlerResult,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import {
  isConsolePortfolioElementType,
  PortfolioElementAlreadyExistsError,
  type ConsolePortfolioElementType,
  type IPortfolioElementStore,
} from '../../stores/IPortfolioElementStore.js';
import { serializePortfolioElementDetail, portfolioElementEtag } from '../portfolio/PortfolioDtos.js';
import { validateElementPayload } from '../portfolio/PortfolioService.js';
import {
  CollectionContentInvalidError,
  CollectionElementNotFoundError,
  CollectionPathInvalidError,
  isCollectionError,
} from '../../../collection/CollectionErrors.js';
import { ApplicationError, ErrorCategory } from '../../../utils/ErrorHandler.js';
import { ValidationErrorCodes } from '../../../utils/errorCodes.js';

/**
 * A collection element fetched and fully validated but not written. Structural
 * mirror of ElementInstaller.CollectionFetchAndValidateResult so the module
 * depends on behavior, not the concrete installer class.
 */
export interface CollectionValidatedElement {
  readonly elementType: string;
  readonly name: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
}

/** No-write fetch+validate seam over the collection installer. */
export interface CollectionInstallPort {
  fetchAndValidate(collectionPath: string): Promise<CollectionValidatedElement>;
}

export interface CollectionInstallServiceOptions {
  readonly installer: CollectionInstallPort;
  readonly portfolioStore: IPortfolioElementStore;
  readonly now?: () => Date;
}

const CATALOG_PATH_MAX_LENGTH = 512;

/**
 * Installs a collection element into the authenticated user's portfolio. Fetch
 * + validate happens through the shared installer's no-write seam; the write
 * goes through the SAME manager-backed store portfolio CRUD uses, so a DB-mode
 * deployment persists to Postgres with no filesystem fallback and full per-user
 * scoping. CSRF and idempotency are enforced by the secured router BEFORE this
 * handler runs, so a forged or replayed request never triggers the outbound
 * fetch.
 */
export class CollectionInstallService {
  private readonly now: () => Date;

  constructor(private readonly options: CollectionInstallServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async install(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const path = collectionPathFromBody(req.body);
    if (path.kind === 'invalid') return invalidRequest(path.detail);

    let validated: CollectionValidatedElement;
    try {
      validated = await this.options.installer.fetchAndValidate(path.value);
    } catch (error) {
      return classifyFetchError(error);
    }

    if (!isConsolePortfolioElementType(validated.elementType)) {
      return problem(422, 'collection_element_unsupported', 'Unsupported element',
        'The collection element is not a supported portfolio element type.');
    }
    const type: ConsolePortfolioElementType = validated.elementType;
    const displayName = displayNameFrom(validated.metadata) ?? validated.name;
    const tags = tagsFrom(validated.metadata);

    // The installer's own caps are looser than the console's portfolio record
    // contract (name/displayName <= 200, tags <= 50 x 80 chars, content <= 1 MiB,
    // metadata <= 64 KiB). Apply the SAME pre-write validation the direct create
    // route uses, so an out-of-contract catalog element 422s here instead of
    // being persisted by the manager-backed store and only failing afterwards
    // in record validation — which would strand an element the console can
    // neither read nor delete.
    const issues = validateElementPayload(type, {
      name: validated.name,
      displayName,
      metadata: validated.metadata,
      content: validated.content,
      tags,
    });
    if (issues.length > 0) {
      return {
        status: 422,
        body: {
          type: 'about:blank',
          title: 'Unprocessable element',
          status: 422,
          code: 'collection_element_invalid',
          detail: 'The collection element does not meet portfolio element limits and was not installed.',
          issues,
        },
      };
    }

    try {
      const record = await this.options.portfolioStore.create({
        userId: auth.userId,
        type,
        name: validated.name,
        displayName,
        metadata: validated.metadata,
        content: validated.content,
        tags,
        now: this.now(),
      });
      return {
        status: 201,
        body: serializePortfolioElementDetail(record, null),
        headers: { ETag: portfolioElementEtag(record) },
      };
    } catch (error) {
      if (error instanceof PortfolioElementAlreadyExistsError) {
        return problem(409, 'portfolio_element_exists', 'Conflict',
          'A portfolio element with that name already exists.');
      }
      throw error;
    }
  }
}

function collectionPathFromBody(body: unknown):
  | { readonly kind: 'valid'; readonly value: string }
  | { readonly kind: 'invalid'; readonly detail: string } {
  if (!body || typeof body !== 'object') {
    return { kind: 'invalid', detail: 'Request body must be a JSON object with a "path" field.' };
  }
  const path = (body as { path?: unknown }).path;
  if (typeof path !== 'string' || path.trim() === '') {
    return { kind: 'invalid', detail: 'path is required and must be a non-empty string.' };
  }
  if (path.length > CATALOG_PATH_MAX_LENGTH) {
    return { kind: 'invalid', detail: `path must be at most ${CATALOG_PATH_MAX_LENGTH} characters.` };
  }
  // Fail fast on obviously-wrong shapes; the installer's validatePath +
  // resolveCollectionElementType do the authoritative traversal/type checks.
  if (!path.startsWith('library/')) {
    return { kind: 'invalid', detail: 'path must be a collection library path (library/<type>/...).' };
  }
  return { kind: 'valid', value: path };
}

function classifyFetchError(error: unknown): ConsoleHandlerResult {
  // Typed classification first — stable against message rewording, and
  // cause-chain-aware so a typed error survives the GitHub client's McpError
  // wrapper. The installer/GitHub client throw CollectionErrors for their own
  // failures; the shared input validators (validatePath / validateContentSize)
  // throw ApplicationError with VALIDATION_ERROR category: INVALID_PATH codes
  // are bad path input (400), the rest are content-shape failures (422 — e.g.
  // GitHub's contents API omitting inline content for oversized files).
  if (isCollectionError(error, CollectionElementNotFoundError)) {
    return problem(404, 'collection_element_not_found', 'Not found', 'Collection element was not found.');
  }
  if (isCollectionError(error, CollectionPathInvalidError)) {
    return problem(400, 'invalid_request', 'Invalid request', 'The collection path is not valid.');
  }
  if (error instanceof ApplicationError && error.code === ValidationErrorCodes.INVALID_PATH) {
    return problem(400, 'invalid_request', 'Invalid request', 'The collection path is not valid.');
  }
  if (isCollectionError(error, CollectionContentInvalidError) ||
      (error instanceof ApplicationError && error.category === ErrorCategory.VALIDATION_ERROR)) {
    return problem(422, 'collection_element_invalid', 'Unprocessable element',
      'The collection element failed validation and was not installed.');
  }

  // Message fallback, retained as belt-and-braces for errors from layers that
  // neither throw typed collection errors nor preserve them as `cause`.
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('File not found in collection') || message.includes('Path does not point to a file')) {
    return problem(404, 'collection_element_not_found', 'Not found', 'Collection element was not found.');
  }
  if (
    message.includes('Invalid collection path format') ||
    message.includes('Unknown element type') ||
    message.includes('Invalid file type') ||
    message.includes('Path traversal') ||
    message.includes('Invalid path') ||
    message.includes('Path too deep')
  ) {
    return problem(400, 'invalid_request', 'Invalid request', 'The collection path is not valid.');
  }
  if (
    message.includes('Security threat') ||
    message.includes('Security validation failed') ||
    message.includes('missing required name or description') ||
    message.includes('File too large') ||
    message.includes('Content must be a non-empty string')
  ) {
    return problem(422, 'collection_element_invalid', 'Unprocessable element',
      'The collection element failed validation and was not installed.');
  }
  return problem(503, 'collection_unavailable', 'Collection unavailable',
    'The collection element could not be retrieved. Try again later.');
}

function displayNameFrom(metadata: Readonly<Record<string, unknown>>): string | null {
  return typeof metadata.name === 'string' && metadata.name !== '' ? metadata.name : null;
}

function tagsFrom(metadata: Readonly<Record<string, unknown>>): readonly string[] {
  return Array.isArray(metadata.tags)
    ? metadata.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
}

function invalidRequest(detail: string): ConsoleHandlerResult {
  return problem(400, 'invalid_request', 'Invalid request', detail);
}

function problem(status: number, code: string, title: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: 'about:blank',
      title,
      status,
      code,
      detail,
    },
  };
}
