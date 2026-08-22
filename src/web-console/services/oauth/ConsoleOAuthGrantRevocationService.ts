import type { IAuthStorageLayer } from '../../../auth/embedded-as/storage/IAuthStorageLayer.js';
import {
  type ConsoleOAuthGrantRevocationInput,
  type ConsoleOAuthGrantRevocationSummary,
  type ConsoleOAuthSubjectResolver,
  type ConsoleOAuthSubjectRevocationSummary,
  type IOAuthGrantRevocationService,
  requireOAuthRevocationCapableStorage,
  validateOAuthGrantRevocationInput,
} from './IConsoleOAuthGrantRevocationService.js';

export class ConsoleOAuthGrantRevocationService implements IOAuthGrantRevocationService {
  constructor(
    private readonly subjectResolver: ConsoleOAuthSubjectResolver,
    private readonly authStorage: IAuthStorageLayer,
  ) {}

  async revokePrincipalGrants(
    input: ConsoleOAuthGrantRevocationInput,
  ): Promise<ConsoleOAuthGrantRevocationSummary> {
    validateOAuthGrantRevocationInput(input);
    const revocationStorage = requireOAuthRevocationCapableStorage(this.authStorage);
    const subjects = await this.subjectResolver.listLinkedSubjects(input.userId);
    const discoveredGrantIds = new Set<string>();
    const revokedGrantIds = new Set<string>();
    const subjectSummaries: ConsoleOAuthSubjectRevocationSummary[] = [];

    for (const sub of subjects) {
      const grants = await this.authStorage.findGrantsByAccountId(sub);
      let grantsRevoked = 0;
      for (const grantId of grants) {
        discoveredGrantIds.add(grantId);
        if (revokedGrantIds.has(grantId)) continue;
        await revocationStorage.genericRevokeByGrantId(grantId);
        revokedGrantIds.add(grantId);
        grantsRevoked += 1;
      }
      subjectSummaries.push({
        sub,
        grantsDiscovered: grants.length,
        grantsRevoked,
      });
    }

    return {
      userId: input.userId,
      revokedAt: new Date(input.revokedAt),
      linkedSubjectsProcessed: subjects.length,
      oauthGrantFamiliesDiscovered: discoveredGrantIds.size,
      oauthGrantFamiliesRevoked: revokedGrantIds.size,
      subjects: subjectSummaries,
    };
  }

  async revokeSubjectGrants(
    sub: string,
    revokedAt: Date,
  ): Promise<ConsoleOAuthSubjectRevocationSummary> {
    if (!sub.trim() || sub.length > 320 || Number.isNaN(revokedAt.getTime())) {
      throw new Error('OAuth subject grant revocation input is invalid');
    }
    const revocationStorage = requireOAuthRevocationCapableStorage(this.authStorage);
    const grants = await this.authStorage.findGrantsByAccountId(sub);
    const uniqueGrants = new Set(grants);
    for (const grantId of uniqueGrants) {
      await revocationStorage.genericRevokeByGrantId(grantId);
    }
    return {
      sub,
      grantsDiscovered: uniqueGrants.size,
      grantsRevoked: uniqueGrants.size,
    };
  }
}
