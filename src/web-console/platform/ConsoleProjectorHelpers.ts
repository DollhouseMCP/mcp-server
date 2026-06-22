export type UnknownRecord = Readonly<Record<string, unknown>>;

export function objectValue(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null ? value as UnknownRecord : {};
}

export function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringField(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

export function nullableStringField(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

export function numberField(record: UnknownRecord, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function nullableNumberField(record: UnknownRecord, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function optionalStringField(record: UnknownRecord, key: string): Record<string, string> {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? { [key]: value } : {};
}

export function projectConsoleStreamEndStatus(value: unknown): { readonly status: 'complete' | 'closed' } {
  const record = objectValue(value);
  return { status: record.status === 'complete' ? 'complete' : 'closed' };
}
