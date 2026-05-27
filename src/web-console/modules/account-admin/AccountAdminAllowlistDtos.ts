import type {
  ConsoleAccountAllowlistEntry,
  ConsoleAccountAllowlistKind,
} from '../../stores/IConsoleAccountAllowlistStore.js';

export interface AccountAllowlistEntryDto {
  readonly id: string;
  readonly kind: ConsoleAccountAllowlistKind;
  readonly value: string;
  readonly note: string | null;
  readonly created_by_user_id: string | null;
  readonly created_at: string;
}

export interface AccountAllowlistListDto {
  readonly entries: readonly AccountAllowlistEntryDto[];
}

export function serializeAccountAllowlistEntry(
  entry: ConsoleAccountAllowlistEntry,
): AccountAllowlistEntryDto {
  return {
    id: entry.id,
    kind: entry.kind,
    value: entry.displayValue,
    note: entry.note,
    created_by_user_id: entry.createdByUserId,
    created_at: entry.createdAt.toISOString(),
  };
}

export function serializeAccountAllowlistList(
  entries: readonly ConsoleAccountAllowlistEntry[],
): AccountAllowlistListDto {
  return {
    entries: entries.map(entry => serializeAccountAllowlistEntry(entry)),
  };
}
