import { CONSOLE_PORTFOLIO_ELEMENT_TYPES } from '../../stores/IPortfolioElementStore.js';
import type {
  ConsolePortfolioElementType,
  ConsolePortfolioValidationStatus,
} from '../../stores/IPortfolioElementStore.js';
import type {
  PortfolioElementDetailDto,
  PortfolioElementListDto,
  PortfolioElementSummaryDto,
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

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
