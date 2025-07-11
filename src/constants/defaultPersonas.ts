/**
 * Default personas that ship with DollhouseMCP
 */
export const DEFAULT_PERSONAS = [
  'business-consultant.md',
  'creative-writer.md',
  'debug-detective.md',
  'eli5-explainer.md',
  'excel-expert.md',
  'technical-analyst.md'
] as const;

export type DefaultPersonaFilename = typeof DEFAULT_PERSONAS[number];

/**
 * Check if a filename is a default persona
 */
export function isDefaultPersona(filename: string): boolean {
  return DEFAULT_PERSONAS.includes(filename as DefaultPersonaFilename);
}