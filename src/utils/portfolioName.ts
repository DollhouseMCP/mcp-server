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
  if (canonicalizePortfolioName(actual) === canonicalizePortfolioName(requested)) return true;
  const actualStem = portfolioFilenameStem(actual);
  const requestedStem = portfolioFilenameStem(requested);
  return actualStem.length > 0 && requestedStem.length > 0 && actualStem === requestedStem;
}
