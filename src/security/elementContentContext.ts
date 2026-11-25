import { ElementType } from '../portfolio/types.js';
import type { SecureParseOptions } from './secureYamlParser.js';

/** Content validation policy shared by definition loaders and storage parsers. */
export const ELEMENT_TYPE_TO_CONTEXT: Partial<Record<ElementType, NonNullable<SecureParseOptions['contentContext']>>> = {
  [ElementType.PERSONA]: 'persona',
  [ElementType.SKILL]: 'skill',
  [ElementType.TEMPLATE]: 'template',
  [ElementType.AGENT]: 'agent',
  [ElementType.MEMORY]: 'memory',
};

export function elementContentContext(type?: string): SecureParseOptions['contentContext'] {
  return type === undefined ? undefined : ELEMENT_TYPE_TO_CONTEXT[type as ElementType];
}
