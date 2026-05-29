import type {
  ConsoleHandlerResult,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import {
  canonicalizePortfolioElementName,
  isConsolePortfolioElementType,
  type ConsolePortfolioElementType,
  type IPortfolioElementStore,
} from '../../stores/IPortfolioElementStore.js';
import {
  serializePortfolioElementDetail,
  serializePortfolioElementList,
  serializePortfolioSummary,
  type PortfolioElementFields,
} from './PortfolioDtos.js';

const PORTFOLIO_ELEMENT_FIELDS = new Set([
  'type',
  'name',
  'display_name',
  'version',
  'updated_at',
  'validation_status',
  'tags',
  'metadata',
  'content',
]);

export class PortfolioService {
  constructor(private readonly store: IPortfolioElementStore) {}

  async getSummary(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const records = await this.store.summarizeByUser(auth.userId);
    return {
      status: 200,
      body: serializePortfolioSummary(records),
    };
  }

  async listElements(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const type = optionalPortfolioType(req.query.type);
    if (type.kind === 'invalid') return invalidRequest('type query parameter must be a supported portfolio element type.');
    const tag = optionalSingleString(req.query.tag);
    const fields = parseFields(req.query.fields);
    if (fields.kind === 'invalid') return invalidRequest('fields query parameter contains unsupported portfolio fields.');
    const records = await this.store.listByUser(auth.userId, {
      type: type.value,
      tag: tag ?? undefined,
    });
    return {
      status: 200,
      body: serializePortfolioElementList(records, fields.value),
    };
  }

  async getElement(
    req: ConsoleRequest,
    type: string,
    name: string,
  ): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    if (!isConsolePortfolioElementType(type)) {
      return invalidRequest('type path parameter must be a supported portfolio element type.');
    }
    if (name.trim() === '') {
      return invalidRequest('name path parameter is required.');
    }
    const fields = parseFields(req.query.fields);
    if (fields.kind === 'invalid') return invalidRequest('fields query parameter contains unsupported portfolio fields.');
    const record = await this.store.findByName(auth.userId, type, canonicalizePortfolioElementName(name));
    if (!record) {
      return {
        status: 404,
        body: {
          type: 'about:blank',
          title: 'Not found',
          status: 404,
          code: 'portfolio_element_not_found',
          detail: 'Portfolio element was not found.',
        },
      };
    }
    return {
      status: 200,
      body: serializePortfolioElementDetail(record, fields.value),
    };
  }
}

function optionalPortfolioType(value: unknown):
  | { readonly kind: 'valid'; readonly value: ConsolePortfolioElementType | undefined }
  | { readonly kind: 'invalid' } {
  if (value === undefined) return { kind: 'valid', value: undefined };
  if (typeof value === 'string' && isConsolePortfolioElementType(value)) return { kind: 'valid', value };
  return { kind: 'invalid' };
}

function optionalSingleString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseFields(value: unknown):
  | { readonly kind: 'valid'; readonly value: PortfolioElementFields }
  | { readonly kind: 'invalid' } {
  if (value === undefined) return { kind: 'valid', value: null };
  if (typeof value !== 'string') return { kind: 'invalid' };
  const names = value.split(',').map(item => item.trim()).filter(Boolean);
  if (names.length === 0) return { kind: 'valid', value: null };
  const fields = new Set<string>();
  for (const name of names) {
    if (!PORTFOLIO_ELEMENT_FIELDS.has(name)) return { kind: 'invalid' };
    fields.add(name);
  }
  return { kind: 'valid', value: fields };
}

function invalidRequest(detail: string): ConsoleHandlerResult {
  return {
    status: 400,
    body: {
      type: 'about:blank',
      title: 'Invalid request',
      status: 400,
      code: 'invalid_request',
      detail,
    },
  };
}
