/** Shared console discovery spelling; these names are hints, never storage authority. */
export function canonicalizePortfolioName(value: string): string {
  return value.trim().toLowerCase().replace(/\.md$|\.ya?ml$/u, '');
}

export function portfolioFilenameStem(value: string): string {
  return value.trim().replaceAll(/([a-z])([A-Z])/gu, '$1-$2')
    .replaceAll(/[\s_]+/gu, '-').toLowerCase().replaceAll(/[^a-z0-9-]/gu, '-')
    .replaceAll(/-+/gu, '-').replaceAll(/^-|-$/gu, '');
}

export function matchesPortfolioName(actual: string, requested: string): boolean {
  return canonicalizePortfolioName(actual) === canonicalizePortfolioName(requested) ||
    portfolioFilenameStem(actual) === portfolioFilenameStem(requested);
}
