/**
 * Prescriptive Digest — Issue #492
 *
 * Appends a small text block to every MCP tool response when elements are
 * active. During normal operation the LLM already has full instructions and
 * ignores it. After context compaction, the digest tells the LLM to call
 * get_active_elements to recover the lost instructions.
 *
 * ~30-50 tokens overhead when active; zero when no elements are active.
 */

export interface ActiveElementSummary {
  type: string;  // Element type (e.g., 'persona', 'skill', 'ensemble')
  name: string;
}

/**
 * Generate a compact, prescriptive digest line from a list of active elements.
 * Returns an empty string when the list is empty (caller should check length first).
 *
 * @example
 * generatePrescriptiveDigest([
 *   { type: 'persona', name: 'architect' },
 *   { type: 'skill', name: 'reviewer' },
 * ]);
 * // "[Active elements: persona: architect; skill: reviewer. If you lack instructions for these, call get_active_elements for each type to refresh.]"
 */
export function generatePrescriptiveDigest(activeElements: ActiveElementSummary[]): string {
  if (activeElements.length === 0) {
    return '';
  }

  // Group element names by type for compact output
  const byType = new Map<string, string[]>();
  for (const el of activeElements) {
    const names = byType.get(el.type) || [];
    names.push(el.name);
    byType.set(el.type, names);
  }

  const parts = Array.from(byType.entries())
    .map(([type, names]) => `${type}: ${names.join(', ')}`)
    .join('; ');

  return (
    `[Active elements: ${parts}. ` +
    `If you lack instructions for these, call get_active_elements for each type to refresh.]`
  );
}
