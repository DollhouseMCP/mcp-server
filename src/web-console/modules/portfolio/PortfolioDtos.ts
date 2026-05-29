import type {
  ConsolePortfolioElementSummaryRecord,
  ConsolePortfolioElementDetailRecord,
  ConsolePortfolioElementType,
  ConsolePortfolioValidationStatus,
} from '../../stores/IPortfolioElementStore.js';
import { CONSOLE_PORTFOLIO_ELEMENT_TYPES } from '../../stores/IPortfolioElementStore.js';

export interface PortfolioSummaryDto {
  readonly total_elements: number;
  readonly counts_by_type: Readonly<Record<ConsolePortfolioElementType, number>>;
  readonly updated_at: string | null;
}

export interface PortfolioElementSummaryDto {
  readonly type: ConsolePortfolioElementType;
  readonly name: string;
  readonly display_name: string | null;
  readonly version: number;
  readonly updated_at: string;
  readonly validation_status: ConsolePortfolioValidationStatus;
  readonly tags: readonly string[];
}

export interface PortfolioElementDetailDto extends PortfolioElementSummaryDto {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly content: string;
}

export interface PortfolioElementValidationIssueDto {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface PortfolioElementValidationDto {
  readonly valid: boolean;
  readonly issues: readonly PortfolioElementValidationIssueDto[];
}

export interface PortfolioElementRenderDto {
  readonly type: ConsolePortfolioElementType;
  readonly name: string;
  readonly preview: string;
}

export interface PortfolioElementDeleteDto {
  readonly deleted: true;
  readonly type: ConsolePortfolioElementType;
  readonly name: string;
  readonly version: number;
  readonly deleted_at: string;
}

export interface PortfolioElementListDto {
  readonly elements: readonly Partial<PortfolioElementSummaryDto>[];
}

export type PortfolioElementFields = ReadonlySet<string> | null;

export function serializePortfolioSummary(
  records: readonly ConsolePortfolioElementSummaryRecord[],
): PortfolioSummaryDto {
  const counts = Object.fromEntries(
    CONSOLE_PORTFOLIO_ELEMENT_TYPES.map(type => [type, 0]),
  ) as Record<ConsolePortfolioElementType, number>;
  let updatedAt: Date | null = null;
  for (const record of records) {
    counts[record.type] += 1;
    if (!updatedAt || record.updatedAt > updatedAt) updatedAt = record.updatedAt;
  }
  return {
    total_elements: records.length,
    counts_by_type: counts,
    updated_at: updatedAt?.toISOString() ?? null,
  };
}

export function serializePortfolioElementList(
  records: readonly ConsolePortfolioElementSummaryRecord[],
  fields: PortfolioElementFields,
): PortfolioElementListDto {
  return {
    elements: records.map(record => applyFields(serializePortfolioElementSummary(record), fields)),
  };
}

export function serializePortfolioElementSummary(
  record: ConsolePortfolioElementSummaryRecord,
): PortfolioElementSummaryDto {
  return {
    type: record.type,
    name: record.name,
    display_name: record.displayName,
    version: record.version,
    updated_at: record.updatedAt.toISOString(),
    validation_status: record.validationStatus,
    tags: [...record.tags],
  };
}

export function serializePortfolioElementDetail(
  record: ConsolePortfolioElementDetailRecord,
  fields: PortfolioElementFields,
): Partial<PortfolioElementDetailDto> {
  return applyFields({
    ...serializePortfolioElementSummary(record),
    metadata: record.metadata,
    content: record.content,
  }, fields);
}

export function portfolioElementEtag(record: ConsolePortfolioElementSummaryRecord): string {
  return `W/"portfolio:${record.type}:${record.canonicalName}:v${record.version}"`;
}

function applyFields<T extends object>(
  dto: T,
  fields: PortfolioElementFields,
): Partial<T> {
  if (!fields) return dto;
  const projected: Partial<T> = {};
  for (const [key, value] of Object.entries(dto)) {
    if (fields.has(key)) {
      projected[key as keyof T] = value as T[keyof T];
    }
  }
  return projected;
}
