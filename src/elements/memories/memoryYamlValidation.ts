import * as yaml from 'js-yaml';
import { ContentValidator } from '../../security/contentValidator.js';
import { MEMORY_CONSTANTS } from './constants.js';

const MEMORY_ENTRY_PROSE_FIELDS = new Set([
  'content',
  'sanitizedContent',
  'sanitizedPatterns',
]);

/**
 * Validate memory control fields while leaving entry prose to the trust-level
 * scanner. Auxiliary entry fields remain part of the blocking validation.
 */
export function validateMemoryControlFields(parsedYaml: Record<string, unknown>): boolean {
  const controlFields = Object.fromEntries(
    Object.entries(parsedYaml).filter(([fieldName]) => fieldName !== 'entries')
  );
  const entries = Array.isArray(parsedYaml.entries)
    ? parsedYaml.entries.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        return Object.fromEntries(
          Object.entries(entry).filter(([fieldName]) => !MEMORY_ENTRY_PROSE_FIELDS.has(fieldName))
        );
      })
    : parsedYaml.entries;
  try {
    const controlYaml = yaml.dump(
      { ...controlFields, entries },
      { schema: yaml.JSON_SCHEMA, noRefs: true, sortKeys: true }
    );

    return ContentValidator.validateYamlContent(controlYaml, MEMORY_CONSTANTS.MAX_YAML_SIZE);
  } catch {
    // Unsupported values must not disappear from the security validation input.
    return false;
  }
}
