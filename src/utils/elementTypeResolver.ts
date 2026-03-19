/**
 * Element Type Resolver - Shared utility for resolving missing element_type
 * fields by searching the portfolio across all element managers.
 *
 * Used by any composite element type (ensembles, and future types like
 * teams, workflows, pipelines) that references other elements.
 *
 * Issue #466: Replaces the silent '|| skill' default with portfolio lookup.
 */

import { logger } from './logger.js';
import { ELEMENT_TYPE_MAP } from './elementTypeNormalization.js';

/**
 * Interface for managers passed to resolveElementTypes().
 * Each manager is optional — only available managers are searched.
 *
 * PersonaManager uses findPersona() (synchronous) instead of the standard
 * findByName() — both are supported.
 */
export interface ElementManagersForResolution {
  skillManager?: { findByName(name: string): Promise<any> };
  templateManager?: { findByName(name: string): Promise<any> };
  agentManager?: { findByName(name: string): Promise<any> };
  memoryManager?: { findByName(name: string): Promise<any> };
  personaManager?: { findPersona?(name: string): any };
  ensembleManager?: { findByName(name: string): Promise<any> };
}

/**
 * Structured result from resolveElementTypes().
 * Callers can inspect ambiguous/notFound to surface warnings to the user.
 */
export interface ResolveElementTypesResult {
  /** Elements successfully resolved or already typed */
  resolved: any[];
  /** Elements found in multiple types — user must provide element_type */
  ambiguous: Array<{ element_name: string; found_in: string[] }>;
  /** Element names not found in any manager */
  notFound: string[];
}

/**
 * Resolve missing element_type fields by searching the portfolio.
 *
 * For each element without an element_type (or legacy type field), searches
 * all provided managers to find which type the element belongs to.
 *
 * Resolution outcomes:
 * - Found in exactly 1 type → element_type is set automatically
 * - Found in multiple types → element is skipped with ambiguity warning
 * - Not found in any type → element is skipped with not-found warning
 * - Already has element_type → passed through unchanged
 *
 * @param elements - Raw element array (may have missing element_type)
 * @param managers - Available element managers for portfolio lookup
 * @returns Structured result with resolved elements and disambiguation info
 */
export async function resolveElementTypes(
  elements: any[],
  managers: ElementManagersForResolution
): Promise<ResolveElementTypesResult> {
  const resolved = [];
  const ambiguous: Array<{ element_name: string; found_in: string[] }> = [];
  const notFound: string[] = [];

  for (let i = 0; i < elements.length; i++) {
    const elem = elements[i];

    // Issue #507: Guard against non-object elements (e.g., bare strings like "my-skill")
    if (typeof elem !== 'object' || elem === null) {
      const valueType = elem === null ? 'null' : typeof elem;
      logger.warn(
        `[resolveElementTypes] Element at index ${i} is a ${valueType} ("${String(elem).substring(0, 50)}"), ` +
        `but must be an object with { element_name, element_type }. Skipping.`
      );
      notFound.push(String(elem));
      continue;
    }

    const elementName = elem.element_name || elem.name;
    const elementType = elem.element_type || elem.type;

    if (elementType || !elementName) {
      // Type is already known, or no name to search for — pass through as-is
      resolved.push(elem);
      continue;
    }

    // Search all managers for this element name
    const typeMap: [string, any][] = [
      ['skill', managers.skillManager],
      ['template', managers.templateManager],
      ['agent', managers.agentManager],
      ['memory', managers.memoryManager],
      ['persona', managers.personaManager],
      ['ensemble', managers.ensembleManager],
    ];

    const matches: string[] = [];
    for (const [typeName, manager] of typeMap) {
      if (!manager) continue;
      try {
        if (typeName === 'persona' && manager.findPersona) {
          const found = manager.findPersona(elementName);
          if (found) matches.push(typeName);
        } else if (manager.findByName) {
          const found = await manager.findByName(elementName);
          if (found) matches.push(typeName);
        }
      } catch {
        // Manager lookup failed — skip this type silently
      }
    }

    if (matches.length === 1) {
      const resolvedType = matches[0];
      // Validate the resolved type against the canonical element type map
      if (!(resolvedType in ELEMENT_TYPE_MAP)) {
        logger.warn(
          `[resolveElementTypes] Element '${elementName}': resolved to unrecognized type '${resolvedType}'. Skipping element.`
        );
        notFound.push(elementName);
        continue;
      }
      resolved.push({ ...elem, element_type: resolvedType });
    } else if (matches.length > 1) {
      ambiguous.push({ element_name: elementName, found_in: [...matches] });
      logger.warn(
        `[resolveElementTypes] Element '${elementName}': found in multiple types (${matches.join(', ')}). ` +
        `Provide element_type explicitly. Skipping element.`
      );
    } else {
      notFound.push(elementName);
      logger.warn(
        `[resolveElementTypes] Element '${elementName}': not found in any element type. ` +
        `Provide element_type explicitly or ensure the element exists in the portfolio. Skipping element.`
      );
    }
  }

  return { resolved, ambiguous, notFound };
}
