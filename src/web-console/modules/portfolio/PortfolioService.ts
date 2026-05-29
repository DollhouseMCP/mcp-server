import type {
  ConsoleHandlerResult,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import {
  canonicalizePortfolioElementName,
  isConsolePortfolioElementType,
  PortfolioElementAlreadyExistsError,
  PORTFOLIO_ELEMENT_CONTENT_MAX_BYTES,
  PORTFOLIO_ELEMENT_METADATA_MAX_BYTES,
  PORTFOLIO_ELEMENT_TAGS_MAX,
  PortfolioElementVersionConflictError,
  type ConsolePortfolioElementSummaryRecord,
  type ConsolePortfolioElementType,
  type IPortfolioElementStore,
} from '../../stores/IPortfolioElementStore.js';
import type { IUserIntegrationStore, UserIntegrationRecord } from '../../stores/IUserIntegrationStore.js';
import {
  isPortfolioSyncJobConflictPolicy,
  isPortfolioSyncJobDirection,
  type IPortfolioSyncJobStore,
  PortfolioSyncAlreadyPendingError,
  type PortfolioSyncJobConflictPolicy,
  type PortfolioSyncJobDirection,
} from '../../stores/IPortfolioSyncJobStore.js';
import {
  portfolioElementEtag,
  type PortfolioElementValidationIssueDto,
  serializePortfolioSyncJob,
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
  constructor(
    private readonly store: IPortfolioElementStore,
    private readonly integrationStore: IUserIntegrationStore,
    private readonly syncJobStore: IPortfolioSyncJobStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
      headers: { ETag: portfolioElementEtag(record) },
    };
  }

  async createElement(
    req: ConsoleRequest,
    type: string,
  ): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    if (!isConsolePortfolioElementType(type)) {
      return invalidRequest('type path parameter must be a supported portfolio element type.');
    }
    const parsed = parseElementBody(req.body, { requireName: true, requireContent: true });
    if (parsed.kind === 'problem') return parsed.result;
    const issues = validateElementPayload(parsed.value);
    if (issues.length > 0) return validationFailed(issues);
    try {
      const record = await this.store.create({
        userId: auth.userId,
        type,
        name: parsed.value.name ?? '',
        displayName: parsed.value.displayName ?? null,
        metadata: parsed.value.metadata ?? {},
        content: parsed.value.content ?? '',
        tags: parsed.value.tags ?? [],
        now: this.now(),
      });
      return {
        status: 201,
        body: serializePortfolioElementDetail(record, null),
        headers: { ETag: portfolioElementEtag(record) },
      };
    } catch (error) {
      if (error instanceof PortfolioElementAlreadyExistsError) {
        return problem(409, 'portfolio_element_exists', 'Conflict', 'Portfolio element already exists.');
      }
      throw error;
    }
  }

  async updateElement(
    req: ConsoleRequest,
    type: string,
    name: string,
  ): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const path = parseElementPath(type, name);
    if (path.kind === 'problem') return path.result;
    const existing = await this.store.findByName(auth.userId, path.type, path.canonicalName);
    if (!existing) return notFound();
    const precondition = requireCurrentElementEtag(req, existing);
    if (precondition.kind === 'problem') return precondition.result;
    const parsed = parseElementBody(req.body, { requireName: false, requireContent: false });
    if (parsed.kind === 'problem') return parsed.result;
    if (!parsed.value.hasMutationField) {
      return validationFailed([issue('', 'empty_patch', 'At least one editable field is required.')]);
    }
    let displayName = existing.displayName;
    if (parsed.value.displayName !== undefined) displayName = parsed.value.displayName;
    const candidate = {
      name: existing.name,
      displayName,
      metadata: parsed.value.metadata ?? existing.metadata,
      content: parsed.value.content ?? existing.content,
      tags: parsed.value.tags ?? existing.tags,
    };
    const issues = validateElementPayload(candidate);
    if (issues.length > 0) return validationFailed(issues);
    try {
      const updated = await this.store.update({
        userId: auth.userId,
        type: path.type,
        canonicalName: path.canonicalName,
        expectedVersion: precondition.version,
        displayName: parsed.value.displayName,
        metadata: parsed.value.metadata,
        content: parsed.value.content,
        tags: parsed.value.tags,
        now: this.now(),
      });
      if (!updated) return notFound();
      return {
        status: 200,
        body: serializePortfolioElementDetail(updated, null),
        headers: { ETag: portfolioElementEtag(updated) },
      };
    } catch (error) {
      if (error instanceof PortfolioElementVersionConflictError) {
        return problem(412, 'precondition_failed', 'Precondition failed', 'Portfolio element changed before the write completed.');
      }
      throw error;
    }
  }

  async deleteElement(
    req: ConsoleRequest,
    type: string,
    name: string,
  ): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const path = parseElementPath(type, name);
    if (path.kind === 'problem') return path.result;
    const existing = await this.store.findByName(auth.userId, path.type, path.canonicalName);
    if (!existing) return notFound();
    const precondition = requireCurrentElementEtag(req, existing);
    if (precondition.kind === 'problem') return precondition.result;
    try {
      const deleted = await this.store.delete({
        userId: auth.userId,
        type: path.type,
        canonicalName: path.canonicalName,
        expectedVersion: precondition.version,
        now: this.now(),
      });
      if (!deleted) return notFound();
      return {
        status: 200,
        body: {
          deleted: true,
          type: deleted.type,
          name: deleted.name,
          version: deleted.version,
          deleted_at: deleted.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof PortfolioElementVersionConflictError) {
        return problem(412, 'precondition_failed', 'Precondition failed', 'Portfolio element changed before the delete completed.');
      }
      throw error;
    }
  }

  async validateElement(
    req: ConsoleRequest,
    type: string,
    name: string,
  ): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const path = parseElementPath(type, name);
    if (path.kind === 'problem') return path.result;
    const existing = await this.store.findByName(auth.userId, path.type, path.canonicalName);
    const parsed = parseElementBody(req.body, { requireName: false, requireContent: false });
    if (parsed.kind === 'problem') return parsed.result;
    let displayName = existing?.displayName ?? null;
    if (parsed.value.displayName !== undefined) displayName = parsed.value.displayName;
    const candidate = {
      name,
      displayName,
      metadata: parsed.value.metadata ?? existing?.metadata ?? {},
      content: parsed.value.content ?? existing?.content ?? '',
      tags: parsed.value.tags ?? existing?.tags ?? [],
    };
    const issues = validateElementPayload(candidate);
    return {
      status: 200,
      body: {
        valid: issues.length === 0,
        issues,
      },
    };
  }

  async renderElement(
    req: ConsoleRequest,
    type: string,
    name: string,
  ): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const path = parseElementPath(type, name);
    if (path.kind === 'problem') return path.result;
    const existing = await this.store.findByName(auth.userId, path.type, path.canonicalName);
    if (!existing) return notFound();
    const parsed = parseElementBody(req.body, { requireName: false, requireContent: false });
    if (parsed.kind === 'problem') return parsed.result;
    const content = parsed.value.content ?? existing.content;
    let displayName = existing.displayName;
    if (parsed.value.displayName !== undefined) displayName = parsed.value.displayName;
    const issues = validateElementPayload({
      name: existing.name,
      displayName,
      metadata: parsed.value.metadata ?? existing.metadata,
      content,
      tags: parsed.value.tags ?? existing.tags,
    });
    if (issues.length > 0) return validationFailed(issues);
    return {
      status: 200,
      body: {
        type: existing.type,
        name: existing.name,
        preview: content,
      },
    };
  }

  async startSync(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const parsed = parseSyncBody(req.body);
    if (parsed.kind === 'problem') return parsed.result;
    const integration = await this.integrationStore.findByProvider(auth.userId, parsed.value.provider);
    if (integration?.status !== 'connected') {
      return problem(409, 'integration_required', 'Conflict', 'A connected GitHub integration is required for portfolio sync.');
    }
    if (!syncDirectionAllowed(integration, parsed.value.direction)) {
      return problem(
        409,
        'integration_permission_required',
        'Conflict',
        'The connected GitHub integration does not grant the requested portfolio sync direction.',
      );
    }
    let record;
    try {
      record = await this.syncJobStore.create({
        userId: auth.userId,
        integrationId: integration.id,
        direction: parsed.value.direction,
        conflictPolicy: parsed.value.conflictPolicy,
        createdAt: this.now(),
      });
    } catch (error) {
      if (error instanceof PortfolioSyncAlreadyPendingError) {
        return problem(409, 'sync_already_pending', 'Conflict', 'A portfolio sync job is already queued or running.');
      }
      throw error;
    }
    return {
      status: 202,
      body: serializePortfolioSyncJob(record),
    };
  }

  async getSyncJob(req: ConsoleRequest, jobId: string): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    if (!looksLikeUuid(jobId)) return invalidRequest('job_id path parameter must be a UUID.');
    const record = await this.syncJobStore.findById(auth.userId, jobId);
    if (!record) {
      return problem(404, 'portfolio_sync_job_not_found', 'Not found', 'Portfolio sync job was not found.');
    }
    return {
      status: 200,
      body: serializePortfolioSyncJob(record),
    };
  }
}

interface ParsedElementBody {
  readonly name?: string;
  readonly displayName?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly hasMutationField: boolean;
}

interface ParsedSyncBody {
  readonly provider: 'github';
  readonly direction: PortfolioSyncJobDirection;
  readonly conflictPolicy: PortfolioSyncJobConflictPolicy;
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
  return problem(400, 'invalid_request', 'Invalid request', detail);
}

function parseElementPath(type: string, name: string):
  | { readonly kind: 'valid'; readonly type: ConsolePortfolioElementType; readonly canonicalName: string }
  | { readonly kind: 'problem'; readonly result: ConsoleHandlerResult } {
  if (!isConsolePortfolioElementType(type)) {
    return { kind: 'problem', result: invalidRequest('type path parameter must be a supported portfolio element type.') };
  }
  if (name.trim() === '') {
    return { kind: 'problem', result: invalidRequest('name path parameter is required.') };
  }
  return { kind: 'valid', type, canonicalName: canonicalizePortfolioElementName(name) };
}

function parseElementBody(
  body: unknown,
  options: { readonly requireName: boolean; readonly requireContent: boolean },
):
  | { readonly kind: 'valid'; readonly value: ParsedElementBody }
  | { readonly kind: 'problem'; readonly result: ConsoleHandlerResult } {
  if (!isRecord(body)) return { kind: 'problem', result: invalidRequest('Request body must be a JSON object.') };
  const parsed: ParsedElementBody = {
    name: stringValue(body.name),
    displayName: optionalNullableString(body.display_name),
    metadata: Object.hasOwn(body, 'metadata') ? recordValue(body.metadata) : undefined,
    content: stringValue(body.content),
    tags: Object.hasOwn(body, 'tags') ? stringArrayValue(body.tags) : undefined,
    hasMutationField: ['display_name', 'metadata', 'content', 'tags'].some(field => Object.hasOwn(body, field)),
  };
  if (options.requireName && !parsed.name) {
    return { kind: 'problem', result: validationFailed([issue('name', 'required', 'name is required.')]) };
  }
  if (options.requireContent && parsed.content === undefined) {
    return { kind: 'problem', result: validationFailed([issue('content', 'required', 'content is required.')]) };
  }
  if (Object.hasOwn(body, 'metadata') && !parsed.metadata) {
    return { kind: 'problem', result: validationFailed([issue('metadata', 'invalid_type', 'metadata must be a JSON object.')]) };
  }
  if (Object.hasOwn(body, 'tags') && !parsed.tags) {
    return { kind: 'problem', result: validationFailed([issue('tags', 'invalid_type', 'tags must be an array of strings.')]) };
  }
  return { kind: 'valid', value: parsed };
}

function parseSyncBody(body: unknown):
  | { readonly kind: 'valid'; readonly value: ParsedSyncBody }
  | { readonly kind: 'problem'; readonly result: ConsoleHandlerResult } {
  if (!isRecord(body)) return { kind: 'problem', result: invalidRequest('Request body must be a JSON object.') };
  if (body.provider !== 'github') {
    return { kind: 'problem', result: validationFailed([issue('provider', 'unsupported', 'provider must be github.')]) };
  }
  if (typeof body.direction !== 'string' || !isPortfolioSyncJobDirection(body.direction)) {
    return {
      kind: 'problem',
      result: validationFailed([issue('direction', 'unsupported', 'direction must be pull, push, or bidirectional.')]),
    };
  }
  const conflictPolicy = typeof body.conflict_policy === 'string' ? body.conflict_policy : 'fail';
  if (!isPortfolioSyncJobConflictPolicy(conflictPolicy)) {
    return {
      kind: 'problem',
      result: validationFailed([issue('conflict_policy', 'unsupported', 'conflict_policy must be fail, prefer_local, or prefer_remote.')]),
    };
  }
  return {
    kind: 'valid',
    value: {
      provider: body.provider,
      direction: body.direction,
      conflictPolicy,
    },
  };
}

function validateElementPayload(input: {
  readonly name?: string;
  readonly displayName?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly content?: string;
  readonly tags?: readonly string[];
}): readonly PortfolioElementValidationIssueDto[] {
  const issues: PortfolioElementValidationIssueDto[] = [];
  if (!input.name || input.name.trim() === '') issues.push(issue('name', 'required', 'name is required.'));
  if (input.name && canonicalizePortfolioElementName(input.name) === '') issues.push(issue('name', 'invalid', 'name must have a canonical form.'));
  if (input.displayName?.trim() === '') {
    issues.push(issue('display_name', 'invalid', 'display_name must be non-empty when provided.'));
  }
  issues.push(...validateMetadataPayload(input.metadata));
  if (input.content === undefined || input.content.trim() === '') issues.push(issue('content', 'required', 'content is required.'));
  if (input.content !== undefined && Buffer.byteLength(input.content, 'utf8') > PORTFOLIO_ELEMENT_CONTENT_MAX_BYTES) {
    issues.push(issue('content', 'too_large', 'content must be at most 1 MiB.'));
  }
  issues.push(...validateTagsPayload(input.tags ?? []));
  return issues;
}

function validateMetadataPayload(metadata: Readonly<Record<string, unknown>> | undefined): readonly PortfolioElementValidationIssueDto[] {
  if (!metadata || !isRecord(metadata)) return [issue('metadata', 'invalid_type', 'metadata must be a JSON object.')];
  const metadataBytes = serializedJsonByteLength(metadata);
  if (metadataBytes === null) return [issue('metadata', 'invalid', 'metadata must be JSON-serializable.')];
  if (metadataBytes > PORTFOLIO_ELEMENT_METADATA_MAX_BYTES) {
    return [issue('metadata', 'too_large', `metadata must be at most ${PORTFOLIO_ELEMENT_METADATA_MAX_BYTES} bytes.`)];
  }
  return [];
}

function validateTagsPayload(tags: readonly string[]): readonly PortfolioElementValidationIssueDto[] {
  const issues: PortfolioElementValidationIssueDto[] = [];
  if (tags.length > PORTFOLIO_ELEMENT_TAGS_MAX) {
    issues.push(issue('tags', 'too_many', `tags must contain at most ${PORTFOLIO_ELEMENT_TAGS_MAX} entries.`));
  }
  for (const [index, tag] of tags.entries()) {
    if (tag.trim() === '') issues.push(issue(`tags.${index}`, 'invalid', 'tags must be non-empty strings.'));
  }
  return issues;
}

function requireCurrentElementEtag(
  req: ConsoleRequest,
  record: ConsolePortfolioElementSummaryRecord,
):
  | { readonly kind: 'valid'; readonly version: number }
  | { readonly kind: 'problem'; readonly result: ConsoleHandlerResult } {
  const value = singleHeader(req.headers['if-match']);
  if (!value) {
    return {
      kind: 'problem',
      result: problem(428, 'precondition_required', 'Precondition required', 'If-Match is required for portfolio mutations.'),
    };
  }
  const current = portfolioElementEtag(record);
  if (value !== current) {
    return {
      kind: 'problem',
      result: problem(412, 'precondition_failed', 'Precondition failed', 'If-Match does not match the current portfolio element ETag.'),
    };
  }
  return { kind: 'valid', version: record.version };
}

function validationFailed(issues: readonly PortfolioElementValidationIssueDto[]): ConsoleHandlerResult {
  return {
    status: 422,
    body: {
      type: 'about:blank',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      issues,
    },
  };
}

function notFound(): ConsoleHandlerResult {
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

function issue(path: string, code: string, message: string): PortfolioElementValidationIssueDto {
  return { path, code, message };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function serializedJsonByteLength(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringArrayValue(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1) return value[0] ?? null;
  return null;
}

function syncDirectionAllowed(
  integration: UserIntegrationRecord,
  direction: PortfolioSyncJobDirection,
): boolean {
  const contents = integrationContentsPermission(integration);
  if (direction === 'pull') return contents === 'read' || contents === 'write';
  return contents === 'write';
}

function integrationContentsPermission(integration: UserIntegrationRecord): 'none' | 'read' | 'write' {
  const rawPermissions = integration.authorizedPermissions.permissions;
  const contents = isRecord(rawPermissions) ? rawPermissions.contents : null;
  if (contents === 'read' || contents === 'write') return contents;
  return 'none';
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
