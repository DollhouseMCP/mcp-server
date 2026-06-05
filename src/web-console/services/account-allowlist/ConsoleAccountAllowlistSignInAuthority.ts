import type {
  AuthAllowlistEntry,
  AllowlistMatchValues,
} from '../../../auth/embedded-as/storage/IAuthStorageLayer.js';
import type {
  SignInAllowlistAuthority,
} from '../../../auth/embedded-as/allowlistGate.js';
import type { IConsoleAccountAllowlistStore } from '../../stores/IConsoleAccountAllowlistStore.js';

export class ConsoleAccountAllowlistSignInAuthority implements SignInAllowlistAuthority {
  constructor(private readonly store: IConsoleAccountAllowlistStore) {}

  async matchesIdentity(values: AllowlistMatchValues): Promise<boolean> {
    return this.store.matchesIdentity(values);
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
