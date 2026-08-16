const REDACTED = '[redacted]';
const MIN_EMBEDDED_CREDENTIAL_LENGTH = 8;

export interface EffectiveCredentialInjection {
  readonly location: 'header' | 'query';
  readonly name: string;
  /** Exact value placed into Headers or URLSearchParams after platform normalization. */
  readonly value: string;
  /** Credential-bearing suffix as it appears in `value`. */
  readonly sensitiveValue: string;
  readonly caseInsensitivePrefixLength?: number;
  /** Pre-normalization value retained only as an additional defense-in-depth redaction candidate. */
  readonly configuredValue?: string;
  readonly configuredSensitiveValue?: string;
  readonly configuredCaseInsensitivePrefixLength?: number;
}

export interface CredentialRedactions {
  readonly exact: ReadonlySet<string>;
  readonly percentExact: ReadonlySet<string>;
  readonly embedded: readonly string[];
  readonly percentEmbedded: readonly string[];
  readonly headers: readonly CredentialHeaderRedaction[];
  readonly queries: readonly CredentialQueryRedaction[];
  readonly boundedValues: readonly CredentialBoundedValueRedaction[];
}

interface CredentialHeaderRedaction {
  readonly name: string;
  readonly value: string;
  readonly caseInsensitivePrefixLength?: number;
  readonly requireValueBoundary: boolean;
}

interface CredentialHeaderEchoMatch {
  readonly start: number;
  readonly end: number;
}

interface ParsedJsonString {
  readonly value: string;
  readonly end: number;
}

interface ScannedJsonString {
  readonly value: string | null;
  readonly end: number;
}

interface CredentialQueryRedaction {
  readonly name: string;
  readonly value: string;
}

interface CredentialBoundedValueRedaction {
  readonly value: string;
  readonly caseInsensitivePrefixLength: number;
}

export function redactIntegrationResponseBody(
  text: string,
  contentType: string | null,
  credentialRedactions: CredentialRedactions,
): unknown {
  if (text === '') return null;
  if (isJsonMediaType(contentType)) {
    try {
      return redactResponseCredentials(JSON.parse(text) as unknown, credentialRedactions);
    } catch {
      return REDACTED;
    }
  }
  return redactCredentialText(text, credentialRedactions);
}

function isJsonMediaType(contentType: string | null): boolean {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

function redactResponseCredentials(value: unknown, credentialRedactions: CredentialRedactions): unknown {
  if (typeof value === 'string') return redactCredentialText(value, credentialRedactions);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    const serialized = String(value);
    return redactCredentialText(serialized, credentialRedactions) === serialized ? value : REDACTED;
  }
  if (Array.isArray(value)) return value.map(item => redactResponseCredentials(item, credentialRedactions));
  if (typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const redactedKey = redactCredentialText(key, credentialRedactions);
    const redactedField = isCredentialKey(key)
      ? REDACTED
      : redactResponseCredentials(field, credentialRedactions);
    Object.defineProperty(output, redactedKey, {
      value: redactedField,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function redactCredentialText(value: string, credentialRedactions: CredentialRedactions): string {
  if (credentialRedactions.exact.has(value) ||
      credentialRedactions.percentExact.has(normalizePercentEscapes(value))) {
    return REDACTED;
  }
  let redacted = redactCredentialHeaderEchoes(value, credentialRedactions.headers);
  redacted = redactCredentialQueryEchoes(redacted, credentialRedactions.queries);
  redacted = redactBoundedCredentialValues(redacted, credentialRedactions.boundedValues);
  for (const secret of credentialRedactions.embedded) {
    redacted = redacted.replaceAll(secret, REDACTED);
  }
  redacted = redactPercentEncodedCredentials(redacted, credentialRedactions.percentEmbedded);
  return redacted;
}

function redactCredentialQueryEchoes(
  value: string,
  queries: readonly CredentialQueryRedaction[],
): string {
  let redacted = value;
  for (const query of queries) redacted = redactCredentialQueryEcho(redacted, query);
  return redacted;
}

function redactCredentialQueryEcho(value: string, query: CredentialQueryRedaction): string {
  const jsonRedacted = redactJsonCredentialQueryEchoes(value, query);
  const normalizedValue = normalizePercentEscapes(jsonRedacted);
  const normalizedQueryValue = normalizePercentEscapes(query.value);
  const marker = normalizePercentEscapes(`${query.name}=`);
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const index = normalizedValue.indexOf(marker, searchFrom);
    if (index < 0) break;
    const before = index === 0 ? '' : jsonRedacted[index - 1];
    const valueStart = index + marker.length;
    const valueEnd = valueStart + query.value.length;
    const after = jsonRedacted[valueEnd] ?? '';
    const nameBoundary = before === '' || !/[A-Za-z0-9_.~-]/.test(before);
    const valueBoundary = isCredentialValueBoundary(after);
    if (nameBoundary && valueBoundary &&
        normalizedValue.startsWith(normalizedQueryValue, valueStart)) {
      parts.push(jsonRedacted.slice(copyFrom, index), REDACTED);
      copyFrom = valueEnd;
      searchFrom = valueEnd;
      continue;
    }
    searchFrom = index + marker.length;
  }
  if (parts.length === 0) return jsonRedacted;
  parts.push(jsonRedacted.slice(copyFrom));
  return parts.join('');
}

function redactJsonCredentialQueryEchoes(
  value: string,
  query: CredentialQueryRedaction,
): string {
  const normalizedName = normalizePercentEscapes(query.name);
  const normalizedQueryValue = normalizePercentEscapes(query.value);
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const start = value.indexOf('"', searchFrom);
    if (start < 0) break;
    const scannedName = scanJsonStringAt(value, start, maxJsonStringSourceLength(query.name.length));
    // Advance one code unit so a quote consumed by malformed surrounding text
    // can still be considered as the start of the next bounded candidate.
    searchFrom = start + 1;
    if (scannedName.value === null ||
        normalizePercentEscapes(scannedName.value) !== normalizedName) continue;
    const before = start === 0 ? '' : value[start - 1];
    if (before !== '' && /[A-Za-z0-9_.~-]/.test(before)) continue;
    const valueEnd = jsonCredentialPropertyValueEnd(value, scannedName.end, normalizedQueryValue);
    if (valueEnd === null) continue;
    parts.push(value.slice(copyFrom, start), REDACTED);
    copyFrom = valueEnd;
    searchFrom = valueEnd;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(copyFrom));
  return parts.join('');
}

function jsonCredentialPropertyValueEnd(
  value: string,
  cursorAfterName: number,
  normalizedExpected: string,
): number | null {
  let cursor = skipStructuredWhitespace(value, cursorAfterName);
  if (value[cursor] !== ':') return null;
  cursor = skipStructuredWhitespace(value, cursor + 1);
  if (value[cursor] === '"') {
    const parsed = parseJsonStringAt(value, cursor);
    return parsed !== null && normalizePercentEscapes(parsed.value) === normalizedExpected
      ? parsed.end
      : null;
  }
  let end = cursor;
  while (end < value.length && !/[\s,}\]]/.test(value[end] ?? '')) end += 1;
  return normalizePercentEscapes(value.slice(cursor, end)) === normalizedExpected ? end : null;
}

function redactPercentEncodedCredentials(value: string, patterns: readonly string[]): string {
  let redacted = value;
  for (const pattern of patterns) {
    const normalizedValue = normalizePercentEscapes(redacted);
    const parts: string[] = [];
    let copyFrom = 0;
    let searchFrom = 0;
    for (;;) {
      const index = normalizedValue.indexOf(pattern, searchFrom);
      if (index < 0) break;
      parts.push(redacted.slice(copyFrom, index), REDACTED);
      copyFrom = index + pattern.length;
      searchFrom = copyFrom;
    }
    if (parts.length > 0) {
      parts.push(redacted.slice(copyFrom));
      redacted = parts.join('');
    }
  }
  return redacted;
}

function normalizePercentEscapes(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, escape => escape.toUpperCase());
}

function isCredentialValueBoundary(value: string): boolean {
  return value === '' || /[&\s"'#,.;:!?)}\]>]/.test(value);
}

function redactCredentialHeaderEchoes(
  value: string,
  headers: readonly CredentialHeaderRedaction[],
): string {
  let redacted = value;
  for (const header of headers) {
    redacted = redactCredentialHeaderEcho(redacted, header);
  }
  return redacted;
}

function redactCredentialHeaderEcho(value: string, header: CredentialHeaderRedaction): string {
  const jsonRedacted = redactJsonCredentialHeaderEchoes(value, header);
  const normalizedValue = asciiLowercase(jsonRedacted);
  const normalizedName = asciiLowercase(header.name);
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const index = normalizedValue.indexOf(normalizedName, searchFrom);
    if (index < 0) break;
    searchFrom = index + header.name.length;
    const match = credentialHeaderEchoMatch(jsonRedacted, index, header);
    if (match === null) continue;
    parts.push(jsonRedacted.slice(copyFrom, match.start), REDACTED);
    copyFrom = match.end;
    searchFrom = copyFrom;
  }
  if (parts.length === 0) return jsonRedacted;
  parts.push(jsonRedacted.slice(copyFrom));
  return parts.join('');
}

function redactJsonCredentialHeaderEchoes(
  value: string,
  header: CredentialHeaderRedaction,
): string {
  const normalizedName = asciiLowercase(header.name);
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const start = value.indexOf('"', searchFrom);
    if (start < 0) break;
    const scannedName = scanJsonStringAt(value, start, maxJsonStringSourceLength(header.name.length));
    searchFrom = start + 1;
    if (scannedName.value === null || asciiLowercase(scannedName.value) !== normalizedName) continue;
    const before = start === 0 ? '' : value[start - 1];
    if (before !== '' && isHttpFieldNameCharacter(before)) continue;
    const valueEnd = credentialHeaderValueEchoEnd(value, scannedName.end, header);
    if (valueEnd === null) continue;
    parts.push(value.slice(copyFrom, start), REDACTED);
    copyFrom = valueEnd;
    searchFrom = valueEnd;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(copyFrom));
  return parts.join('');
}

function credentialHeaderEchoMatch(
  value: string,
  headerStart: number,
  header: CredentialHeaderRedaction,
): CredentialHeaderEchoMatch | null {
  const before = headerStart === 0 ? '' : value[headerStart - 1];
  const nameQuote = before === '"' || before === "'" ? before : null;
  const matchStart = nameQuote === null ? headerStart : headerStart - 1;
  const boundaryBefore = matchStart === 0 ? '' : value[matchStart - 1];
  if (boundaryBefore !== '' && isHttpFieldNameCharacter(boundaryBefore)) return null;

  let cursor = headerStart + header.name.length;
  if (nameQuote !== null) {
    if (value[cursor] !== nameQuote) return null;
    cursor += 1;
  }
  const valueEnd = credentialHeaderValueEchoEnd(value, cursor, header);
  return valueEnd === null ? null : { start: matchStart, end: valueEnd };
}

function credentialHeaderValueEchoEnd(
  value: string,
  cursorAfterName: number,
  header: CredentialHeaderRedaction,
): number | null {
  let cursor = skipStructuredWhitespace(value, cursorAfterName);
  if (value[cursor] !== ':') return null;
  cursor = skipStructuredWhitespace(value, cursor + 1);

  const quote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor] : null;
  if (quote === '"') {
    const parsed = parseJsonStringAt(value, cursor);
    if (parsed !== null) {
      return parsed.value.length === header.value.length &&
        credentialHeaderValueMatches(parsed.value, 0, header)
        ? parsed.end
        : null;
    }
  }
  const valueStart = quote ? cursor + 1 : cursor;
  if (!credentialHeaderValueMatches(value, valueStart, header)) return null;

  const valueEnd = valueStart + header.value.length;
  if (quote !== null && value[valueEnd] === quote) return valueEnd + 1;
  if (header.requireValueBoundary && !isCredentialValueBoundary(value[valueEnd] ?? '')) return null;
  return valueEnd;
}

function parseJsonStringAt(value: string, start: number): ParsedJsonString | null {
  const scanned = scanJsonStringAt(value, start);
  return scanned.value === null ? null : { value: scanned.value, end: scanned.end };
}

function scanJsonStringAt(value: string, start: number, maxSourceLength = value.length - start): ScannedJsonString {
  let escaped = false;
  const end = Math.min(value.length, start + maxSourceLength);
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const character = value[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    try {
      const parsed = JSON.parse(value.slice(start, cursor + 1)) as unknown;
      return typeof parsed === 'string'
        ? { value: parsed, end: cursor + 1 }
        : { value: null, end: cursor + 1 };
    } catch {
      return { value: null, end: cursor + 1 };
    }
  }
  return { value: null, end };
}

function maxJsonStringSourceLength(decodedCodeUnits: number): number {
  // A JSON string can encode each UTF-16 code unit as six source characters
  // (`\uXXXX`), plus its two surrounding quotes. Bounding candidate scans by
  // this value keeps overlap recovery linear in the bounded response size.
  return 2 + (decodedCodeUnits * 6);
}

function skipStructuredWhitespace(value: string, start: number): number {
  let cursor = start;
  while (value[cursor] === ' ' || value[cursor] === '\t' ||
         value[cursor] === '\r' || value[cursor] === '\n') cursor += 1;
  return cursor;
}

function credentialHeaderValueMatches(
  value: string,
  valueStart: number,
  header: CredentialHeaderRedaction,
): boolean {
  const prefixLength = header.caseInsensitivePrefixLength ?? 0;
  if (prefixLength === 0) {
    const actualValue = value.slice(valueStart, valueStart + header.value.length);
    return normalizePercentEscapes(actualValue) === normalizePercentEscapes(header.value);
  }
  const actualPrefix = asciiLowercase(value.slice(valueStart, valueStart + prefixLength));
  const expectedPrefix = asciiLowercase(header.value.slice(0, prefixLength));
  const actualSuffix = normalizePercentEscapes(
    value.slice(valueStart + prefixLength, valueStart + header.value.length),
  );
  const expectedSuffix = normalizePercentEscapes(header.value.slice(prefixLength));
  return actualPrefix === expectedPrefix && actualSuffix === expectedSuffix;
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, character => character.toLowerCase());
}

function isHttpFieldNameCharacter(value: string): boolean {
  if (value.length !== 1) return false;
  const code = value.codePointAt(0);
  if (code === undefined) return false;
  if ((code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)) return true;
  return "!#$%&'*+-.^_`|~".includes(value);
}

export function buildCredentialRedactions(
  credential: string,
  injection: EffectiveCredentialInjection,
): CredentialRedactions {
  const exact = new Set<string>();
  const percentExact = new Set<string>();
  const embedded = new Set<string>();
  const percentEmbedded = new Set<string>();
  const headers: CredentialHeaderRedaction[] = [];
  const queries: CredentialQueryRedaction[] = [];
  const boundedValues: CredentialBoundedValueRedaction[] = [];
  const encodedVariants = (value: string): readonly string[] => [
    encodeURIComponent(value),
    new URLSearchParams({ value }).toString().slice('value='.length),
  ];
  const addExact = (value: string): void => {
    if (!value) return;
    exact.add(value);
    for (const variant of encodedVariants(value)) {
      exact.add(variant);
      if (variant.includes('%')) percentExact.add(normalizePercentEscapes(variant));
    }
  };
  const addEmbedded = (value: string): void => {
    addExact(value);
    embedded.add(value);
    for (const variant of encodedVariants(value)) {
      embedded.add(variant);
      if (variant.includes('%')) percentEmbedded.add(normalizePercentEscapes(variant));
    }
  };
  const addCredential = (
    value: string,
    allowEmbedded = value.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH,
  ): void => {
    addExact(value);
    if (allowEmbedded) addEmbedded(value);
  };
  const addHeader = (
    name: string,
    value: string,
    sensitiveValue: string,
    caseInsensitivePrefixLength = 0,
  ): void => {
    const requireValueBoundary = sensitiveValue.length < MIN_EMBEDDED_CREDENTIAL_LENGTH;
    const prefix = value.slice(0, value.length - sensitiveValue.length);
    const candidates = new Map<string, number>([[value, caseInsensitivePrefixLength]]);
    const escapedPrefix = jsonStringContent(prefix);
    candidates.set(
      jsonStringContent(value),
      caseInsensitivePrefixLength > 0 ? escapedPrefix.length : 0,
    );
    for (const encodedValue of encodedVariants(value)) {
      candidates.set(encodedValue, caseInsensitivePrefixLength > 0 ? prefix.trimEnd().length : 0);
    }
    if (prefix) {
      for (const encodedSensitiveValue of encodedVariants(sensitiveValue)) {
        candidates.set(`${prefix}${encodedSensitiveValue}`, caseInsensitivePrefixLength);
      }
      candidates.set(
        `${escapedPrefix}${jsonStringContent(sensitiveValue)}`,
        caseInsensitivePrefixLength > 0 ? escapedPrefix.length : 0,
      );
    }
    for (const [candidate, prefixLength] of candidates) {
      headers.push({
        name,
        value: candidate,
        caseInsensitivePrefixLength: prefixLength || undefined,
        requireValueBoundary,
      });
      if (requireValueBoundary && prefixLength > 0) {
        boundedValues.push({ value: candidate, caseInsensitivePrefixLength: prefixLength });
      }
    }
  };

  addCredential(credential);
  if (injection.sensitiveValue !== credential) addCredential(injection.sensitiveValue);
  addCredential(injection.value, injection.sensitiveValue.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH);
  if (injection.location === 'query') {
    addQueryCredentialRedactions(queries, injection.name, injection.value);
  } else {
    if (injection.value && injection.sensitiveValue) {
      addHeader(
        injection.name,
        injection.value,
        injection.sensitiveValue,
        injection.caseInsensitivePrefixLength,
      );
    }
    if (injection.configuredValue && injection.configuredSensitiveValue &&
        injection.configuredValue !== injection.value) {
      addCredential(
        injection.configuredValue,
        injection.configuredSensitiveValue.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH,
      );
      addHeader(
        injection.name,
        injection.configuredValue,
        injection.configuredSensitiveValue,
        injection.configuredCaseInsensitivePrefixLength,
      );
    }
  }

  return {
    exact,
    percentExact,
    embedded: [...embedded].sort((left, right) => right.length - left.length),
    percentEmbedded: [...percentEmbedded].sort((left, right) => right.length - left.length),
    headers,
    queries,
    boundedValues: deduplicateBoundedValues(boundedValues),
  };
}

function deduplicateBoundedValues(
  values: readonly CredentialBoundedValueRedaction[],
): readonly CredentialBoundedValueRedaction[] {
  const unique = new Map<string, CredentialBoundedValueRedaction>();
  for (const value of values) unique.set(`${value.caseInsensitivePrefixLength}:${value.value}`, value);
  return [...unique.values()].sort((left, right) => right.value.length - left.value.length);
}

function redactBoundedCredentialValues(
  value: string,
  patterns: readonly CredentialBoundedValueRedaction[],
): string {
  let redacted = value;
  for (const pattern of patterns) redacted = redactBoundedCredentialValue(redacted, pattern);
  return redacted;
}

function redactBoundedCredentialValue(
  value: string,
  pattern: CredentialBoundedValueRedaction,
): string {
  const prefix = asciiLowercase(pattern.value.slice(0, pattern.caseInsensitivePrefixLength));
  const normalizedValue = asciiLowercase(value);
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const index = normalizedValue.indexOf(prefix, searchFrom);
    if (index < 0) break;
    searchFrom = index + prefix.length;
    const before = index === 0 ? '' : value[index - 1] ?? '';
    const after = value[index + pattern.value.length] ?? '';
    if ((before !== '' && isHttpFieldNameCharacter(before)) ||
        !isCredentialValueBoundary(after) ||
        !credentialHeaderValueMatches(value, index, {
          name: '',
          value: pattern.value,
          caseInsensitivePrefixLength: pattern.caseInsensitivePrefixLength,
          requireValueBoundary: true,
        })) continue;
    parts.push(value.slice(copyFrom, index), REDACTED);
    copyFrom = index + pattern.value.length;
    searchFrom = copyFrom;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(copyFrom));
  return parts.join('');
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function addQueryCredentialRedactions(
  queries: CredentialQueryRedaction[],
  queryName: string,
  injectedValue: string,
): void {
  const encodedName = new URLSearchParams([[queryName, '']]).toString().slice(0, -1);
  const encodedValue = new URLSearchParams({ value: injectedValue }).toString().slice('value='.length);
  const queryNames = new Set([queryName, encodedName, encodeURIComponent(queryName)]);
  const queryValues = new Set([injectedValue, encodedValue, encodeURIComponent(injectedValue)]);
  for (const name of queryNames) {
    for (const value of queryValues) queries.push({ name, value });
  }
}

const CREDENTIAL_KEY_SUBSTRINGS = [
  'authorization', 'bearer', 'jwt', 'secret', 'credential', 'password', 'passwd', 'ciphertext',
  'apikey', 'api_key', 'api-key', 'privatekey', 'private_key', 'private-key',
];

function isCredentialKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (CREDENTIAL_KEY_SUBSTRINGS.some(fragment => lower.includes(fragment))) return true;
  return /(^|_)(access|refresh|id)?_?token($|_)/i.test(key);
}
