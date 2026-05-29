import type { ConsoleActivatableElementType } from './ActivationTypes.js';

export interface SessionActivationDto {
  readonly type: ConsoleActivatableElementType;
  readonly name: string;
  readonly display_name: string | null;
  readonly activated_at: string;
}

export interface SessionActivationListDto {
  readonly activations: readonly SessionActivationDto[];
}

export interface SessionDeactivationDto {
  readonly deactivated: true;
  readonly type: ConsoleActivatableElementType;
  readonly name: string;
  readonly deactivated_at: string;
}
