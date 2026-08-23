import type {
  AuthAllowlistEntry,
  AllowlistMatchValues,
} from '../../../auth/embedded-as/storage/IAuthStorageLayer.js';
import type {
  AtomicAccountProvisioningInput,
  AllowlistGateResult,
  SignInAllowlistAuthority,
} from '../../../auth/embedded-as/allowlistGate.js';
import type { IConsoleAccountAllowlistStore } from '../../stores/IConsoleAccountAllowlistStore.js';

export class ConsoleAccountAllowlistSignInAuthority implements SignInAllowlistAuthority {
  readonly provisionAccountIfAllowed?: (
    input: AtomicAccountProvisioningInput,
  ) => Promise<AllowlistGateResult>;

  constructor(private readonly store: IConsoleAccountAllowlistStore) {
    if (store.provisionAccountIfAllowed) {
      this.provisionAccountIfAllowed = input => store.provisionAccountIfAllowed!(input);
    }
  }

  async matchesIdentity(values: AllowlistMatchValues): Promise<boolean> {
    return this.store.matchesIdentity(values);
  }

  async deniesIdentity(values: AllowlistMatchValues): Promise<boolean> {
    return this.store.deniesIdentity(values);
  }

  async hasAnyEntries(): Promise<boolean> {
    return this.store.hasActiveEntries();
  }

  async listEntries(): Promise<AuthAllowlistEntry[]> {
    const entries = await this.store.listActive();
    return entries.map(entry => ({
      id: entry.id,
      kind: entry.kind,
      value: entry.normalizedValue,
      note: entry.note,
      createdBy: entry.createdByUserId,
      createdAt: new Date(entry.createdAt),
    }));
  }
}
