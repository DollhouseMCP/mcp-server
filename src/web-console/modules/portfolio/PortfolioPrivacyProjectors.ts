import { CONSOLE_PORTFOLIO_ELEMENT_TYPES } from '../../stores/IPortfolioElementStore.js';
import type {
  ConsolePortfolioElementType,
  ConsolePortfolioValidationStatus,
} from '../../stores/IPortfolioElementStore.js';
import type {
  PortfolioElementDetailDto,
  PortfolioElementDeleteDto,
  PortfolioElementListDto,
  PortfolioElementRenderDto,
  PortfolioElementSummaryDto,
  PortfolioElementValidationDto,
  PortfolioSyncJobDto,
  PortfolioSummaryDto,
} from './PortfolioDtos.js';

export function projectPortfolioSummary(value: unknown): PortfolioSummaryDto {
  const input = asRecord(value);
  const countsInput = asRecord(input.counts_by_type);
  const counts = Object.fromEntries(
    CONSOLE_PORTFOLIO_ELEMENT_TYPES.map(type => [
      type,
      nonNegativeInteger(countsInput[type]),
    ]),
  ) as Record<ConsolePortfolioElementType, number>;
  return {
    total_elements: nonNegativeInteger(input.total_elements),
    counts_by_type: counts,
    updated_at: nullableString(input.updated_at),
  };
}

export function projectPortfolioElementList(value: unknown): PortfolioElementListDto {
  const input = asRecord(value);
  return {
    elements: Array.isArray(input.elements)
      ? input.elements.map(projectPortfolioElementPartial)
      : [],
  };
}

export function projectPortfolioElementSummary(value: unknown): PortfolioElementSummaryDto {
  return projectPortfolioElementPartial(value) as PortfolioElementSummaryDto;
}

function projectPortfolioElementPartial(value: unknown): Partial<PortfolioElementSummaryDto> {
  const input = asRecord(value);
  const projected: MutablePartial<PortfolioElementSummaryDto> = {};
  if ('type' in input) {
    const type = portfolioType(input.type);
    if (type) projected.type = type;
  }
  if ('name' in input) projected.name = stringField(input.name);
  if ('display_name' in input) projected.display_name = nullableString(input.display_name);
  if ('version' in input) projected.version = positiveInteger(input.version);
  if ('updated_at' in input) projected.updated_at = stringField(input.updated_at);
  if ('validation_status' in input) projected.validation_status = validationStatus(input.validation_status);
  if ('tags' in input) projected.tags = stringArray(input.tags);
  return projected;
}

export function projectPortfolioElementDetail(value: unknown): PortfolioElementDetailDto {
  const input = asRecord(value);
  const projected: MutablePartial<PortfolioElementDetailDto> = {
    ...projectPortfolioElementPartial(input),
  };
  if ('metadata' in input) projected.metadata = asRecord(input.metadata);
  if ('content' in input) projected.content = stringField(input.content);
  return projected as PortfolioElementDetailDto;
}

export function projectPortfolioElementValidation(value: unknown): PortfolioElementValidationDto {
  const input = asRecord(value);
  const issues = Array.isArray(input.issues)
    ? input.issues.map(issue => {
      const issueRecord = asRecord(issue);
      return {
        path: stringField(issueRecord.path),
        code: stringField(issueRecord.code),
        message: stringField(issueRecord.message),
      };
    })
    : [];
  return {
    valid: input.valid === true,
    issues,
  };
}

export function projectPortfolioElementRender(value: unknown): PortfolioElementRenderDto {
  const input = asRecord(value);
  return {
    type: portfolioType(input.type) ?? 'skills',
    name: stringField(input.name),
    preview: stringField(input.preview),
  };
}

export function projectPortfolioElementDelete(value: unknown): PortfolioElementDeleteDto {
  const input = asRecord(value);
  return {
    deleted: true,
    type: portfolioType(input.type) ?? 'skills',
    name: stringField(input.name),
    version: positiveInteger(input.version),
    deleted_at: stringField(input.deleted_at),
  };
}

export function projectPortfolioSyncJob(value: unknown): PortfolioSyncJobDto {
  const input = asRecord(value);
  return {
    job_id: stringField(input.job_id),
    status: syncJobStatus(input.status),
    direction: syncDirection(input.direction),
    conflict_policy: conflictPolicy(input.conflict_policy),
    status_url: stringField(input.status_url),
    created_at: stringField(input.created_at),
    started_at: nullableString(input.started_at),
    completed_at: nullableString(input.completed_at),
    result_summary: nullableRecord(input.result_summary),
    error_code: nullableString(input.error_code),
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type MutablePartial<T> = {
  -readonly [K in keyof T]?: T[K];
};

function portfolioType(value: unknown): ConsolePortfolioElementType | null {
  if (typeof value === 'string' && CONSOLE_PORTFOLIO_ELEMENT_TYPES.includes(value as ConsolePortfolioElementType)) {
    return value as ConsolePortfolioElementType;
  }
  return null;
}

function validationStatus(value: unknown): ConsolePortfolioValidationStatus {
  if (value === 'valid' || value === 'invalid') return value;
  return 'unknown';
}

function syncJobStatus(value: unknown): PortfolioSyncJobDto['status'] {
  if (value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled') return value;
  return 'queued';
}

function syncDirection(value: unknown): PortfolioSyncJobDto['direction'] {
  if (value === 'push' || value === 'bidirectional') return value;
  return 'pull';
}

function conflictPolicy(value: unknown): PortfolioSyncJobDto['conflict_policy'] {
  if (value === 'prefer_local' || value === 'prefer_remote') return value;
  return 'fail';
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 1;
}
