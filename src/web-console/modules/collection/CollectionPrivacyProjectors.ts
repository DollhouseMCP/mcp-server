import {
  CONSOLE_PORTFOLIO_ELEMENT_TYPES,
  type ConsolePortfolioElementType,
} from '../../stores/IPortfolioElementStore.js';
import type {
  CollectionElementDetailDto,
  CollectionElementListDto,
  CollectionElementSummaryDto,
  CollectionSourceStatus,
} from './CollectionDtos.js';

export function projectCollectionElementList(value: unknown): CollectionElementListDto {
  const input = asRecord(value);
  return {
    elements: Array.isArray(input.elements)
      ? input.elements.map(projectCollectionElementSummary)
      : [],
    total: nonNegativeInteger(input.total),
    page: positiveInteger(input.page),
    page_size: positiveInteger(input.page_size),
    has_more: input.has_more === true,
    source_status: sourceStatus(input.source_status),
    source_detail: nullableString(input.source_detail),
    install_enabled: input.install_enabled === true,
  };
}

export function projectCollectionElementSummary(value: unknown): CollectionElementSummaryDto {
  const input = asRecord(value);
  return {
    type: elementType(input.type),
    name: stringField(input.name),
    display_name: nullableString(input.display_name),
    description: stringField(input.description),
    version: stringField(input.version),
    author: stringField(input.author),
    tags: stringArray(input.tags),
    path: stringField(input.path),
    source: 'collection',
  };
}

export function projectCollectionElementDetail(value: unknown): CollectionElementDetailDto {
  const input = asRecord(value);
  return {
    ...projectCollectionElementSummary(input),
    metadata: asRecord(input.metadata),
    content: stringField(input.content),
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function elementType(value: unknown): ConsolePortfolioElementType {
  if (typeof value === 'string' && CONSOLE_PORTFOLIO_ELEMENT_TYPES.includes(value as ConsolePortfolioElementType)) {
    return value as ConsolePortfolioElementType;
  }
  return 'skills';
}

function sourceStatus(value: unknown): CollectionSourceStatus {
  return value === 'degraded' ? 'degraded' : 'ok';
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
