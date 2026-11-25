/**
 * upgradeElement - Upgrade element from v1 single-body to v2 dual-field format
 *
 * v1 format: Body text after YAML frontmatter, no `instructions` key in YAML
 * v2 format: `instructions` in YAML frontmatter, `content` as markdown body
 *
 * Detection: If YAML frontmatter contains `instructions` key → already v2.
 * Otherwise → v1, apply per-type default mapping.
 *
 * @see Plan: Dual-Field Element Architecture
 */

import { ElementType } from '../../portfolio/PortfolioManager.js';
import { ElementCrudContext } from './types.js';
import { logger } from '../../utils/logger.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import {
  normalizeElementTypeInput,
  formatValidElementTypesList,
  getElementTypeLabel,
  resolveElementByName,
  ElementManagerOperations,
} from './helpers.js';

type ElementManagerWithPersistence<T> = ElementManagerOperations<T> & {
  save(element: T, filePath: string): Promise<void>;
};

export interface UpgradeElementArgs {
  name: string;
  type: string;
  /** Preview changes without writing to disk */
  dry_run?: boolean;
  /** Manually specify instructions (overrides auto-detection) */
  instructions_override?: string;
  /** Manually specify content (overrides auto-detection) */
  content_override?: string;
}

/**
 * Per-type default mapping for v1 body text.
 * Returns which field the body text should be assigned to.
 */
function getV1BodyMapping(elementType: ElementType): 'instructions' | 'content' {
  switch (elementType) {
    case ElementType.PERSONA:
    case ElementType.SKILL:
    case ElementType.AGENT:
      return 'instructions';
    case ElementType.TEMPLATE:
    case ElementType.MEMORY:
    case ElementType.ENSEMBLE:
      return 'content';
    default:
      return 'content';
  }
}

/**
 * Detect whether an element is in v2 dual-field format.
 *
 * v2 indicators vary by element type:
 * - For persona/skill/agent (body→instructions): v2 means instructions were in
 *   YAML frontmatter. If both instructions AND content are populated, it's
 *   definitively v2. If only instructions is populated (no content), it COULD be
 *   v1 (body→instructions) or v2 (instructions in YAML, empty body). Since we
 *   can't distinguish after loading, we treat instructions-only as v1 — the
 *   re-save is safe either way (it just writes v2 format to disk).
 * - For template/memory/ensemble (body→content): v2 means instructions were added
 *   (since v1 would have empty instructions). Any non-empty instructions = v2.
 */
function isV2Format(element: any, elementType: ElementType): boolean {
  const bodyMapping = getV1BodyMapping(elementType);
  const instructions = (element.instructions || '').trim();
  const content = getElementContent(element);

  if (bodyMapping === 'instructions') {
    // Persona/Skill/Agent: v1 has body→instructions (content empty).
    // v2 has instructions in YAML frontmatter AND content as markdown body.
    // Instructions-only (no content) is ambiguous — treated as v1, which is safe:
    // the re-save writes v2 format without changing field values.
    return instructions.length > 0 && content.length > 0;
  } else {
    // Template/Memory/Ensemble: v1 has body→content (instructions empty).
    // v2 has instructions in YAML AND content as body.
    return instructions.length > 0;
  }
}

/**
 * Get content from element, handling Memory's getter pattern.
 */
function getElementContent(element: any): string {
  return (typeof element.content === 'string' ? element.content : '').trim();
}

/**
 * Upgrade an element from v1 single-body format to v2 dual-field format.
 */
export async function upgradeElement(
  context: ElementCrudContext,
  args: UpgradeElementArgs,
) {
  const { type: guardedType } = normalizeElementTypeInput(args.type);
  if (guardedType === ElementType.MEMORY && context.memoryManager.isGuardedHeadUpdateEnabled?.()) {
    return error('Guarded memory supports immediate append/clear and console UPDATE only');
  }
  await context.ensureInitialized();

  const { name, type, dry_run, instructions_override, content_override } = args;

  if (!name) {
    return error('Missing required parameter: element_name');
  }

  const { type: normalizedType } = normalizeElementTypeInput(type);
  if (!normalizedType) {
    return error(`Invalid element type '${type}'. Valid types: ${formatValidElementTypesList()}`);
  }

  const manager = getManagerForType(context, normalizedType);
  if (!manager) {
    const label = getElementTypeLabel(normalizedType, { plural: true });
    return error(`Element type '${label}' is not yet supported for upgrade`);
  }

  const element = await resolveElementByName(manager, name);
  if (!element) {
    const label = getElementTypeLabel(normalizedType);
    throw new ElementNotFoundError(label, name);
  }

  const displayName = (element as any).metadata?.name || name;
  const label = getElementTypeLabel(normalizedType);
  const current = { instructions: ((element as any).instructions || '').trim(), content: getElementContent(element) };

  // Check if already v2 format (and no overrides provided)
  if (isV2Format(element, normalizedType) && !instructions_override && !content_override) {
    return {
      content: [{
        type: 'text',
        text: `ℹ️ ${label} '${displayName}' is already in v2 dual-field format.\n\n` +
          `**Instructions** (${current.instructions.length} chars): ${truncate(current.instructions, 100)}\n` +
          `**Content** (${current.content.length} chars): ${truncate(current.content, 100)}`
      }]
    };
  }

  // Manual override mode, or auto-detection: field values stay the same — the managers already
  // assigned the body text to the correct field during load (per getV1BodyMapping). The upgrade
  // is the re-save itself: serializeElement() writes instructions to YAML frontmatter and content
  // as the markdown body, converting the on-disk format from v1 to v2.
  const next = { instructions: instructions_override ?? current.instructions, content: content_override ?? current.content };

  if (dry_run) return previewUpgrade(label, displayName, current, next);

  // Apply upgrade
  (element as any).instructions = next.instructions;
  // For Memory, content is a getter — skip direct assignment
  if (normalizedType !== ElementType.MEMORY) {
    (element as any).content = next.content;
  }

  const filename = upgradeTarget(element);
  if (!filename) {
    return error(`Cannot determine file path for ${label} '${name}'`);
  }

  try {
    await manager.save(element, filename);
  } catch (err) {
    return error(`Failed to save upgraded element: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  logger.info(`[upgradeElement] Upgraded ${label} '${displayName}' to v2 dual-field format`, {
    elementType: normalizedType,
    elementName: displayName,
    instructionsLength: next.instructions.length,
    contentLength: next.content.length,
  });

  return {
    content: [{
      type: 'text',
      text: `✅ Upgraded ${label} '${displayName}' to v2 dual-field format.\n\n` +
        `**instructions** (${next.instructions.length} chars): ${truncate(next.instructions, 150)}\n` +
        `**content** (${next.content.length} chars): ${truncate(next.content, 150)}`
    }]
  };
}

type UpgradeFields = { instructions: string; content: string };

/** Preview mode — show what would change. */
function previewUpgrade(label: string, displayName: string, current: UpgradeFields, next: UpgradeFields) {
  const changes: string[] = [];
  if (next.instructions !== current.instructions) {
    changes.push(`**instructions**: "${truncate(current.instructions, 80)}" → "${truncate(next.instructions, 80)}"`);
  }
  if (next.content !== current.content) {
    changes.push(`**content**: "${truncate(current.content, 80)}" → "${truncate(next.content, 80)}"`);
  }

  if (changes.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `ℹ️ ${label} '${displayName}' — no field changes needed for upgrade.\n\n` +
          `The file will be re-saved in v2 format (instructions in YAML frontmatter, content as body).\n\n` +
          `**instructions** (${next.instructions.length} chars): ${truncate(next.instructions, 150)}\n` +
          `**content** (${next.content.length} chars): ${truncate(next.content, 150)}`
      }]
    };
  }

  return {
    content: [{
      type: 'text',
      text: `🔍 Dry run — ${label} '${displayName}' upgrade preview:\n\n` +
        changes.join('\n') + '\n\n' +
        `Run without dry_run to apply these changes.`
    }]
  };
}

/** The storage reference the element was loaded under, or '' when it has none. */
function upgradeTarget(element: any): string {
  const candidate = typeof element.getFilePath === 'function' ? element.getFilePath() : (element.filePath || element.filename);
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : '';
}

function error(message: string) {
  return {
    content: [{
      type: 'text',
      text: `❌ ${message}`
    }]
  };
}

function truncate(text: string, maxLength: number): string {
  if (!text) return '(empty)';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function getManagerForType(context: ElementCrudContext, type: ElementType): ElementManagerWithPersistence<any> | null {
  return (context.getManagerForType(type) as ElementManagerWithPersistence<any> | undefined) ?? null;
}
