import { randomBytes, randomUUID } from 'node:crypto';

import type { IInvitationManagementStore, InvitationManagementAudit } from './IInvitationManagementStore.js';
import { MAX_INVITATION_TTL_HOURS, MIN_INVITATION_TTL_HOURS, readInvitationConfig } from './InvitationConfig.js';
import { normalizeInvitationEmail } from './InvitationEmail.js';
import { generateInvitationToken, INVITATION_SECRET_BYTES } from './InvitationToken.js';
import {
  InvitationError, type IInvitationLifecycleService, type IssuedInvitation,
  type IssueInvitationInput, type RegenerateInvitationInput, type RevokeInvitationInput,
} from './InvitationTypes.js';

/**
 * Request-scoped management facade: callers supply authorized audit context.
 * Returns credentials only after the store commits. It never logs, caches, or
 * persists credential responses; HTTP integration must keep them out of generic
 * console idempotency records. No live route or delivery is enabled here.
 */
export class InvitationManagementService implements Pick<IInvitationLifecycleService,
  'issue' | 'inspect' | 'regenerate' | 'revoke'> {
  private readonly defaultTtlHours: number;

  constructor(
    private readonly store: IInvitationManagementStore,
    private readonly audit: InvitationManagementAudit,
    defaultTtlHours: number = readInvitationConfig().ttlHours,
  ) {
    this.defaultTtlHours = validateTtl(defaultTtlHours);
  }

  async issue(input: IssueInvitationInput): Promise<IssuedInvitation> {
    // Snapshot caller-owned data before the transaction runner's first await.
    const owned = { ...input, intendedRoles: [...input.intendedRoles] };
    const ttlHours = validateTtl(owned.ttlHours ?? this.defaultTtlHours);
    let emailNormalized: string;
    try { emailNormalized = normalizeInvitationEmail(owned.email); } catch {
      throw new InvitationError('invitation_invalid', 'Invalid invitation email');
    }
    const invitationId = randomUUID();
    const userId = randomUUID();
    const secret = randomBytes(INVITATION_SECRET_BYTES);
    try {
      const invitation = await this.store.runMutation(this.audit, mutation => mutation.issue({
        invitationId, userId, username: owned.username, displayName: owned.displayName,
        emailOriginal: owned.email, emailNormalized, inviterUserId: owned.inviterUserId,
        intendedRoles: owned.intendedRoles, generation: 1, credentialSecret: secret,
        ttlHours, correlationId: owned.correlationId,
      }));
      return { invitation, credential: generateInvitationToken(invitation.id, 1, () => secret).token };
    } finally {
      secret.fill(0);
    }
  }

  inspect(invitationId: string) {
    return this.store.inspect(invitationId);
  }

  async regenerate(input: RegenerateInvitationInput): Promise<IssuedInvitation> {
    const owned = { ...input };
    const ttlHours = validateTtl(owned.ttlHours ?? this.defaultTtlHours);
    const secret = randomBytes(INVITATION_SECRET_BYTES);
    try {
      // Generation comes from the locked transaction; inspecting before mutation
      // would race with another administrator regenerating the same invitation.
      const invitation = await this.store.runMutation(this.audit, mutation => mutation.regenerate({
        invitationId: owned.invitationId, credentialSecret: secret,
        ttlHours, correlationId: owned.correlationId,
      }));
      return {
        invitation,
        credential: generateInvitationToken(invitation.id, invitation.currentGeneration.generation, () => secret).token,
      };
    } finally {
      secret.fill(0);
    }
  }

  revoke(input: RevokeInvitationInput) {
    const { invitationId, correlationId } = input;
    return this.store.runMutation(this.audit, mutation => mutation.revoke(invitationId, correlationId));
  }
}

function validateTtl(value: number): number {
  if (!Number.isInteger(value) || value < MIN_INVITATION_TTL_HOURS || value > MAX_INVITATION_TTL_HOURS) {
    throw new InvitationError('configuration_invalid', 'Invalid invitation TTL');
  }
  return value;
}
