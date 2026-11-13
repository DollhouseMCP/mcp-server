import { findAllowlistEntriesMissingFromAuthority } from '../../auth/embedded-as/allowlistGate.js';
import type { AuthAllowlistEntry, AuthAllowlistKind } from '../../auth/embedded-as/storage/IAuthStorageLayer.js';
import { getErrorCode } from '../../database/db-utils.js';
import type { WebConsoleSetupCheckResult, WebConsoleSetupCheckState } from './WebConsoleSetupStatus.js';

const CHECK_ID = 'allowlist_authority_parity';

export type AllowlistParityCode =
  | 'allowlists_agree'
  | 'allowlist_entries_not_carried_over'
  | 'allowlists_unreadable';

export interface AllowlistParityResult extends WebConsoleSetupCheckResult {
  readonly id: typeof CHECK_ID;
  readonly state: Exclude<WebConsoleSetupCheckState, 'not_applicable'>;
  /** Stable code for surfaces that show codes, not prose. */
  readonly code: AllowlistParityCode;
  readonly detail: string;
}

type AllowlistIdentity = Pick<AuthAllowlistEntry, 'kind' | 'value'>;

export interface AllowlistParitySources {
  /** The earlier sign-in allowlist, which `dollhouse-allowlist` still writes. */
  readonly listEarlier: () => Promise<readonly AllowlistIdentity[]>;
  /** The allowlist sign-in consults: the one the console manages. */
  readonly listAuthority: () => Promise<readonly AllowlistIdentity[]>;
}

const KIND_LABELS: Readonly<Record<AuthAllowlistKind, string>> = {
  email: 'by email',
  github_username: 'by GitHub username',
  github_id: 'by GitHub ID',
};

/**
 * Compares the earlier sign-in allowlist with the one sign-in consults.
 *
 * It applies the rule start-up enforces, so a failure here means two things
 * at once: sign-in is not honouring the entries counted, and the server will
 * refuse to start at its next restart until the two lists agree.
 *
 * The detail gives counts by kind and never the identities themselves, which
 * are personal data and are one click away for an admin in the console.
 */
export function compareAllowlistParity(
  earlier: readonly AllowlistIdentity[],
  authority: readonly AllowlistIdentity[],
): AllowlistParityResult {
  const missing = findAllowlistEntriesMissingFromAuthority(earlier, authority);
  if (missing.length === 0) {
    return {
      id: CHECK_ID,
      state: 'passed',
      code: 'allowlists_agree',
      detail: agreementDetail(earlier.length),
    };
  }
  const one = missing.length === 1;
  const byKind = (Object.keys(KIND_LABELS) as AuthAllowlistKind[])
    .map(kind => ({ kind, count: missing.filter(entry => entry.kind === kind).length }))
    .filter(group => group.count > 0)
    .map(group => `${group.count} ${KIND_LABELS[group.kind]}`)
    .join(', ');
  return {
    id: CHECK_ID,
    state: 'failed',
    code: 'allowlist_entries_not_carried_over',
    detail: `${missing.length} of ${earlier.length} ${earlier.length === 1 ? 'entry' : 'entries'} in the earlier sign-in allowlist ` +
      `${one ? 'is' : 'are'} not in the allowlist sign-in uses (${byKind}). Sign-in does not honour ${one ? 'it' : 'them'}, ` +
      'and this server will refuse to start at its next restart until the two lists agree. ' +
      `Add ${one ? 'it' : 'them'} in the console, or remove ${one ? 'it' : 'them'} from the earlier list with dollhouse-allowlist.`,
  };
}

function agreementDetail(count: number): string {
  if (count === 0) return 'The earlier sign-in allowlist is empty, so there is nothing to carry over.';
  if (count === 1) return 'The 1 entry in the earlier sign-in allowlist is in the allowlist sign-in uses.';
  return `All ${count} entries in the earlier sign-in allowlist are in the allowlist sign-in uses.`;
}

/**
 * Reads both allowlists and compares them. Read-only.
 *
 * A list that cannot be read is reported as pending: nothing has been learned
 * about whether the two agree. The driver's message is left out of the detail,
 * since it can carry connection details; only the error code is used.
 */
export async function probeAllowlistParity(sources: AllowlistParitySources): Promise<AllowlistParityResult> {
  let earlier: readonly AllowlistIdentity[];
  let authority: readonly AllowlistIdentity[];
  try {
    [earlier, authority] = await Promise.all([sources.listEarlier(), sources.listAuthority()]);
  } catch (error) {
    const pgCode = getErrorCode(error);
    const reason = pgCode ? `error ${pgCode}` : 'the store did not answer';
    return {
      id: CHECK_ID,
      state: 'pending',
      code: 'allowlists_unreadable',
      detail: `The sign-in allowlists could not be read (${reason}), so whether they agree is not verified.`,
    };
  }
  return compareAllowlistParity(earlier, authority);
}
