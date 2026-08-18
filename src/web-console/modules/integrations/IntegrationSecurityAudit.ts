const AUDIT_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SECRET_LIKE_PROVIDER_PATTERN = /^(?:gh[opusr]_|github_pat_)/i;

/** Keep untrusted provider input out of security logs while retaining useful correlation. */
export function safeIntegrationAuditProvider(provider: string): string {
  return AUDIT_PROVIDER_PATTERN.test(provider) && !SECRET_LIKE_PROVIDER_PATTERN.test(provider)
    ? provider
    : '<invalid>';
}
