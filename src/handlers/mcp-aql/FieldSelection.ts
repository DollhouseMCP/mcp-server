import { filterFields, isValidPreset, normalizeFieldNames } from '../../utils/FieldFilter.js';
import { logger } from '../../utils/logger.js';

type FieldPreset = 'minimal' | 'standard' | 'full';

interface FieldSelectionResult {
  fields?: string[];
  preset?: FieldPreset;
}

export function applyFieldSelection(
  result: unknown,
  params?: Record<string, unknown>
): unknown {
  if (isMCPResponse(result)) {
    return result;
  }

  const fieldsParam = params?.fields;
  if (fieldsParam === undefined) {
    return transformWithArrayAwareness(result);
  }

  const selection = resolveFieldSelection(fieldsParam);
  if (!selection.fields && !selection.preset) {
    return transformWithArrayAwareness(result);
  }

  return filterWithArrayAwareness(result, selection.fields, selection.preset);
}

function resolveFieldSelection(fieldsParam: unknown): FieldSelectionResult {
  if (typeof fieldsParam === 'string') {
    return resolveStringFieldSelection(fieldsParam);
  }
  if (Array.isArray(fieldsParam)) {
    return { fields: resolveArrayFieldSelection(fieldsParam) };
  }
  return {};
}

function resolveStringFieldSelection(fieldsParam: string): FieldSelectionResult {
  if (!isValidPreset(fieldsParam)) {
    return { fields: [fieldsParam] };
  }
  return fieldsParam === 'full' ? {} : { preset: fieldsParam };
}

function resolveArrayFieldSelection(fieldsParam: unknown[]): string[] | undefined {
  const nonStringCount = fieldsParam.filter(f => typeof f !== 'string').length;
  if (nonStringCount > 0) {
    logger.warn(`Field selection: ${nonStringCount} non-string element(s) in fields array ignored`);
  }

  const stringFields = fieldsParam.filter((f): f is string => typeof f === 'string');
  if (stringFields.length === 0) {
    return undefined;
  }

  const { normalized, warnings } = normalizeFieldNames(stringFields);
  if (warnings) {
    logger.warn(`Field selection Unicode normalization: ${warnings.join('; ')}`);
  }
  return normalized;
}

function transformWithArrayAwareness(result: unknown): unknown {
  const container = getArrayContainer(result);
  if (container) {
    return {
      ...transformTopLevel(container.obj, [container.key]),
      [container.key]: filterFields(container.items, { transformNames: true }).data,
    };
  }

  const { data } = filterFields(result, { transformNames: true });
  return data;
}

function filterWithArrayAwareness(
  result: unknown,
  fields?: string[],
  preset?: 'minimal' | 'standard' | 'full'
): unknown {
  const container = getArrayContainer(result);
  if (container) {
    return {
      ...transformTopLevel(container.obj, [container.key]),
      [container.key]: filterFields(container.items, { fields, preset, transformNames: true }).data,
    };
  }

  const { data } = filterFields(result, { fields, preset, transformNames: true });
  return data;
}

function getArrayContainer(result: unknown): {
  obj: Record<string, unknown>;
  key: 'results' | 'items';
  items: unknown[];
} | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.results)) {
    return { obj, key: 'results', items: obj.results };
  }
  if (Array.isArray(obj.items)) {
    return { obj, key: 'items', items: obj.items };
  }
  return null;
}

function transformTopLevel(
  obj: Record<string, unknown>,
  excludeKeys: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!excludeKeys.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

function isMCPResponse(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === 'object' &&
    'content' in result &&
    Array.isArray((result as Record<string, unknown>).content)
  );
}
