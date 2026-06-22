import type { ConsolePortfolioElementType } from '../../stores/IPortfolioElementStore.js';

export type ConsoleActivatableElementType = Exclude<ConsolePortfolioElementType, 'templates'>;

export const CONSOLE_ACTIVATABLE_ELEMENT_TYPES = [
  'personas',
  'skills',
  'agents',
  'memories',
  'ensembles',
] as const satisfies readonly ConsoleActivatableElementType[];

export function isConsoleActivatableElementType(value: string): value is ConsoleActivatableElementType {
  return CONSOLE_ACTIVATABLE_ELEMENT_TYPES.includes(value as ConsoleActivatableElementType);
}
