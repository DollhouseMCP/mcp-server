import { ElementType } from '../../portfolio/PortfolioManager.js';
import type { ElementValidationResult, IElement } from '../../types/elements/IElement.js';
import {
  formatValidElementTypesList,
  getElementFilename,
  getElementTypeLabel,
  normalizeElementTypeInput,
  resolveElementByName,
  sanitizeMetadata,
  type ElementManagerOperations,
} from './helpers.js';
import type { ElementCrudContext } from './types.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';

interface ReplaceElementArgs {
  name: string;
  type: string;
  data: Record<string, unknown>;
}

type ReplaceableElement = IElement & {
  getFilePath?: () => string;
  filePath?: string;
  filename?: string;
};

type ReplacementManager = ElementManagerOperations<ReplaceableElement> & {
  importElement(data: string, format: 'json'): Promise<ReplaceableElement>;
  save(element: ReplaceableElement, filePath: string): Promise<void>;
  saveReplacement(
    expected: ReplaceableElement,
    replacement: ReplaceableElement,
    filePath?: string,
  ): Promise<void>;
  replaceFromSnapshot?(
    element: ReplaceableElement,
    filePath: string,
    options: { readonly stateIncluded: boolean; readonly expected?: ReplaceableElement },
  ): Promise<void>;
  validate(element: ReplaceableElement): ElementValidationResult;
};

/** Replace an imported element as a complete snapshot, without edit deep-merge semantics. */
export async function replaceElement(
  context: ElementCrudContext,
  args: ReplaceElementArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  await context.ensureInitialized();

  const { type: normalizedType } = normalizeElementTypeInput(args.type);
  if (!normalizedType) {
    return error(`Invalid element type '${args.type}'. Valid types: ${formatValidElementTypesList()}`);
  }

  const manager = replacementManager(context, normalizedType);
  const existing = await resolveElementByName(manager, normalizedType, args.name);
  if (!existing) {
    throw new ElementNotFoundError(getElementTypeLabel(normalizedType), args.name);
  }

  const payload = replacementPayload(
    sanitizeMetadata(args.data),
    existing.metadata.name,
    normalizedType,
  );
  const replacement = await manager.importElement(JSON.stringify(payload), 'json');
  const validation = manager.validate(replacement);
  if (!validation.valid) {
    const details = validation.errors?.map(item => item.message).join(', ') || 'unknown validation error';
    return error(`Imported replacement is invalid: ${details}`);
  }

  const candidate = existing.getFilePath?.() ?? existing.filePath ?? existing.filename;
  const filePath = typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : getElementFilename(normalizedType, existing.metadata.name);

  // Agents own a separate runtime-state store, so their manager must reconcile
  // that sidecar with the complete snapshot. Other element types use the
  // manager's durable compare-and-swap path so a concurrent edit is not lost.
  if (manager.replaceFromSnapshot) {
    await manager.replaceFromSnapshot(replacement, filePath, {
      stateIncluded: Object.prototype.hasOwnProperty.call(payload, 'state'),
      expected: existing,
    });
  } else {
    await manager.saveReplacement(existing, replacement, filePath);
  }

  return {
    content: [{
      type: 'text',
      text: `✅ Replaced ${getElementTypeLabel(normalizedType)} '${replacement.metadata.name}'`,
    }],
  };
}

function replacementPayload(
  data: Record<string, unknown>,
  canonicalName: string,
  type: ElementType,
): Record<string, unknown> {
  const nestedMetadata = isRecord(data.metadata) ? data.metadata : undefined;
  const metadata = nestedMetadata
    ? { ...nestedMetadata }
    : metadataFromTopLevel(data);

  metadata.name = canonicalName;
  if (typeof data.description === 'string') metadata.description = data.description;
  if (Array.isArray(data.tags)) metadata.tags = data.tags;
  if (type === ElementType.SKILL && Array.isArray(data.parameters)) {
    metadata.parameters = data.parameters;
  }

  if (type === ElementType.ENSEMBLE) {
    return {
      ...metadata,
      ...(typeof data.instructions === 'string' ? { instructions: data.instructions } : {}),
      ...(typeof data.content === 'string' ? { content: data.content } : {}),
      ...(Array.isArray(data.elements) ? { elements: data.elements } : {}),
    };
  }

  return {
    ...data,
    metadata,
    ...(typeof data.instructions === 'string' ? { instructions: data.instructions } : {}),
    ...(typeof data.content === 'string' ? { content: data.content } : {}),
  };
}

function metadataFromTopLevel(data: Record<string, unknown>): Record<string, unknown> {
  const nonMetadataKeys = new Set([
    'content', 'entries', 'extensions', 'id', 'instructions', 'metadata', 'state', 'type',
  ]);
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !nonMetadataKeys.has(key)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replacementManager(context: ElementCrudContext, type: ElementType): ReplacementManager {
  switch (type) {
    case ElementType.PERSONA:
      return context.personaManager as unknown as ReplacementManager;
    case ElementType.SKILL:
      return context.skillManager as unknown as ReplacementManager;
    case ElementType.TEMPLATE:
      return context.templateManager as unknown as ReplacementManager;
    case ElementType.AGENT:
      return context.agentManager as unknown as ReplacementManager;
    case ElementType.MEMORY:
      return context.memoryManager as unknown as ReplacementManager;
    case ElementType.ENSEMBLE:
      return context.ensembleManager as unknown as ReplacementManager;
  }
}

function error(message: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: `❌ ${message}` }] };
}
