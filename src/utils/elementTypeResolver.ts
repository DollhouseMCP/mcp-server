/**
 * Resolve missing element types and display-name references for composite elements.
 *
 * Used by any composite element type (ensembles, and future types like
 * teams, workflows, pipelines) that references other elements.
 *
 * Issue #466: Replaces the silent '|| skill' default with portfolio lookup.
 */

import { logger } from './logger.js';
import { normalizeElementType, toSingularLabel } from './elementTypeNormalization.js';
import { elementReadFailure } from '../elements/base/ElementReadError.js';
import { ENSEMBLE_PATTERNS } from '../elements/ensembles/constants.js';
import { foldedNameKey, slugNameKey } from '../storage/ElementNameKeys.js';
import { ValidationError } from '../security/errors.js';
import { ElementType } from '../portfolio/types.js';
import type { IElement } from '../types/elements/IElement.js';
import { visitSequentially } from './visitSequentially.js';

type LookupDefinition = Pick<IElement, 'id' | 'metadata'>;
type NameLookup = (name: string) => Promise<LookupDefinition | undefined>;

/**
 * Interface for managers passed to resolveElementTypes().
 * Each manager is optional — only available managers are searched.
 *
 * PersonaManager uses findPersonaAsync() (storage-backed) instead of the standard
 * findByName() — both are supported.
 */
export interface ElementManagersForResolution {
  skillManager?: { findByName: NameLookup };
  templateManager?: { findByName: NameLookup };
  agentManager?: { findByName: NameLookup };
  memoryManager?: { findByName: NameLookup };
  personaManager?: { findPersonaAsync?: NameLookup };
  ensembleManager?: { findByName: NameLookup };
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
 * - Already has element_type → only look up names outside the member reference pattern
 *
 * @param elements - Raw element array (may have missing element_type)
 * @param managers - Available element managers for portfolio lookup
 * @returns Structured result with resolved elements and disambiguation info
 */
export async function resolveElementTypes(
  elements: any[],
  managers: ElementManagersForResolution
): Promise<ResolveElementTypesResult> {
  const resolved: ResolveElementTypesResult['resolved'] = [];
  const ambiguous: Array<{ element_name: string; found_in: string[] }> = [];
  const notFound: string[] = [];
  const lookups = new Map<ElementType, NameLookup | undefined>([
    [ElementType.SKILL, managers.skillManager?.findByName?.bind(managers.skillManager)],
    [ElementType.TEMPLATE, managers.templateManager?.findByName?.bind(managers.templateManager)],
    [ElementType.AGENT, managers.agentManager?.findByName?.bind(managers.agentManager)],
    [ElementType.MEMORY, managers.memoryManager?.findByName?.bind(managers.memoryManager)],
    [ElementType.PERSONA, managers.personaManager?.findPersonaAsync?.bind(managers.personaManager)],
    [ElementType.ENSEMBLE, managers.ensembleManager?.findByName?.bind(managers.ensembleManager)],
  ]);

  await visitSequentially(elements.entries(), async ([i, elem]) => {

    // Issue #507: Guard against non-object elements (e.g., bare strings like "my-skill")
    if (typeof elem !== 'object' || elem === null) {
      const valueType = elem === null ? 'null' : typeof elem;
      logger.warn(
        `[resolveElementTypes] Element at index ${i} is a ${valueType} ("${String(elem).substring(0, 50)}"), ` +
        `but must be an object with { element_name, element_type }. Skipping.`
      );
      notFound.push(String(elem));
      return;
    }

    const elementName = elem.element_name || elem.name;
    const elementType = elem.element_type || elem.type;

    if (!elementName) {
      resolved.push(elem);
      return;
    }

    if (elementType) {
      const type = normalizeElementType(elementType);
      const lookup = type && lookups.get(type);
      const canonical = lookup && needsDisplayNameLookup(elementName)
        ? await resolveCanonicalMemberName(lookup, elementName, await readDefinition(lookup, elementName))
        : undefined;
      resolved.push(canonical ? { ...elem, element_name: canonical } : elem);
      return;
    }

    const matches: Array<{ type: ElementType; lookup: NameLookup; definition: LookupDefinition }> = [];
    await visitSequentially(lookups.entries(), async ([type, lookup]) => {
      if (!lookup) return;
      const definition = await readDefinition(lookup, elementName);
      if (definition) matches.push({ type, lookup, definition });
    });
    const match = matches[0];
    const canonical = matches.length === 1 && needsDisplayNameLookup(elementName)
      ? await resolveCanonicalMemberName(match.lookup, elementName, match.definition)
      : undefined;
    const member = canonical ? { ...elem, element_name: canonical } : elem;
    recordResolution(member, elementName, matches.map(({ type }) => toSingularLabel(type)), { resolved, ambiguous, notFound });
  });

  return { resolved, ambiguous, notFound };
}

function needsDisplayNameLookup(name: unknown): name is string {
  return typeof name === 'string' && !ENSEMBLE_PATTERNS.ELEMENT_NAME_PATTERN.test(name);
}

async function readDefinition(lookup: NameLookup, name: string): Promise<LookupDefinition | undefined> {
  try {
    return await lookup(name);
  } catch (cause) {
    // The name is caller input: its own syntax refusal is not a storage failure.
    if (cause instanceof ValidationError) throw cause;
    throw elementReadFailure(cause, name);
  }
}

async function resolveCanonicalMemberName(
  lookup: NameLookup,
  displayName: string,
  definition: LookupDefinition | undefined,
): Promise<string | undefined> {
  if (!definition || foldedNameKey(displayName) !== foldedNameKey(definition.metadata.name)) {
    return undefined;
  }
  const canonical = slugNameKey(definition.metadata.name);
  if (!canonical) return undefined;
  // Refuse a canonical reference that would select a different definition on activation.
  const target = await readDefinition(lookup, canonical);
  return target?.id === definition.id && target?.metadata.name === definition.metadata.name
    ? canonical
    : undefined;
}

function recordResolution(elem: any, elementName: string, matches: string[], result: ResolveElementTypesResult): void {
  const { resolved, ambiguous, notFound } = result;
  if (matches.length === 1) {
    const resolvedType = matches[0];
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
