import { CONSOLE_ACTIVATABLE_ELEMENT_TYPES } from './ActivationTypes.js';
import type { ConsoleActivatableElementType } from './ActivationTypes.js';
import type {
  SessionActivationDto,
  SessionActivationListDto,
  SessionDeactivationDto,
} from './ActivationDtos.js';

export function projectSessionActivation(value: unknown): SessionActivationDto {
  const input = asRecord(value);
  return {
    type: activationType(input.type),
    name: stringField(input.name),
    display_name: nullableString(input.display_name),
    activated_at: stringField(input.activated_at),
  };
}

export function projectSessionActivationList(value: unknown): SessionActivationListDto {
  const input = asRecord(value);
  return {
    activations: Array.isArray(input.activations)
      ? input.activations.map(projectSessionActivation)
      : [],
  };
}

export function projectSessionDeactivation(value: unknown): SessionDeactivationDto {
  const input = asRecord(value);
  return {
    deactivated: true,
    type: activationType(input.type),
    name: stringField(input.name),
    deactivated_at: stringField(input.deactivated_at),
  };
}

function activationType(value: unknown): ConsoleActivatableElementType {
  if (
    typeof value === 'string' &&
    CONSOLE_ACTIVATABLE_ELEMENT_TYPES.includes(value as ConsoleActivatableElementType)
  ) {
    return value as ConsoleActivatableElementType;
  }
  return 'skills';
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
