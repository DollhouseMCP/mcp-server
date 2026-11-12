/** Jest's limit for an ordinary storage case; the same value as the global default. */
export const STORAGE_CASE_TIMEOUT_MS = 10_000;

/**
 * Jest's limit for a storage case that builds and verifies a 1,000-item
 * portfolio.
 *
 * Each of these cases does several thousand small durable file operations, so
 * its wall-clock time follows the runner's disk, not the code under test. On
 * the hosted macOS runner the same case has taken anywhere from 4 to 13
 * seconds from one run to the next (#3247), which put it on either side of the
 * 10-second default by chance.
 *
 * The limit only has to say "this finishes". What the cases qualify is the
 * read, census and reservation budgets they assert, and those are unchanged.
 */
export const THOUSAND_ITEM_CASE_TIMEOUT_MS = 30_000;

/** The limit for a populated-portfolio case of the given size. */
export function populatedCaseTimeoutMs(count: number): number {
  return count >= 1000 ? THOUSAND_ITEM_CASE_TIMEOUT_MS : STORAGE_CASE_TIMEOUT_MS;
}
