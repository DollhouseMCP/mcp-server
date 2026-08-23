const AUDIT_PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const SECRET_LIKE_PROVIDER_PATTERN = /^(?:gh[opusr]_|github_pat_|sk[-_]|pk_(?:live|test)_|rk_(?:live|test)_|xox[a-z]-|glpat-|npm_|pypi-)/i;
const OPAQUE_PROVIDER_FRAGMENT_PATTERN = /(?:^|[-_])[a-z0-9]{20,}(?:$|[-_])/;

/** Keep untrusted provider input out of security logs while retaining useful correlation. */
export function safeIntegrationAuditProvider(provider: string): string {
  return AUDIT_PROVIDER_PATTERN.test(provider)
    && !SECRET_LIKE_PROVIDER_PATTERN.test(provider)
    && !OPAQUE_PROVIDER_FRAGMENT_PATTERN.test(provider)
    ? provider
    : '<invalid>';
}
