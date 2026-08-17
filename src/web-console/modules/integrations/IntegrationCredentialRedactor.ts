const REDACTED = '[redacted]';
const MIN_EMBEDDED_CREDENTIAL_LENGTH = 8;

export interface EffectiveCredentialInjection {
  readonly location: 'header' | 'query';
  readonly name: string;
  /** Exact value placed into Headers or URLSearchParams after platform normalization. */
  readonly value: string;
  /** Credential-bearing suffix as it appears in `value`. */
  readonly sensitiveValue: string;
  /** Sensitive components an upstream may decode and echo independently. */
  readonly additionalSensitiveValues?: readonly string[];
  /** Sensitive composites that are safe to redact only at token boundaries. */
  readonly additionalBoundedValues?: readonly string[];
  /** Labelled sensitive components an upstream may decode and echo independently. */
  readonly additionalStructuredValues?: readonly CredentialStructuredValue[];
  readonly caseInsensitivePrefixLength?: number;
  /** Pre-normalization value retained only as an additional defense-in-depth redaction candidate. */
  readonly configuredValue?: string;
  readonly configuredSensitiveValue?: string;
  readonly configuredCaseInsensitivePrefixLength?: number;
}

export interface CredentialStructuredValue {
  readonly name: string;
  readonly value: string;
  readonly caseInsensitiveName?: boolean;
}

export interface CredentialRedactions {
  readonly exact: ReadonlySet<string>;
  readonly percentExact: ReadonlySet<string>;
  readonly embedded: readonly string[];
  readonly semanticEmbedded: readonly string[];
  readonly percentEmbedded: readonly string[];
  readonly headers: readonly CredentialHeaderRedaction[];
  readonly queries: readonly CredentialQueryRedaction[];
  readonly labelledValues: readonly string[];
  readonly boundedValues: readonly CredentialBoundedValueRedaction[];
}

interface CredentialHeaderRedaction {
  readonly name: string;
  readonly value: string;
  readonly caseInsensitivePrefixLength?: number;
  readonly requireValueBoundary: boolean;
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
  readonly caseInsensitiveName?: boolean;
}

interface CredentialBoundedValueRedaction {
  readonly value: string;
  readonly caseInsensitivePrefixLength: number;
}

interface ProtectedJsonNumbers {
  readonly text: string;
  readonly lexemesBySentinel: ReadonlyMap<string, string>;
}

interface JsonNumberToken {
  readonly start: number;
  readonly end: number;
  readonly lexeme: string;
}

interface ScannedJsonNumbers {
  readonly strings: ReadonlySet<string>;
  readonly tokens: readonly JsonNumberToken[];
}

const JSON_NUMBER_SENTINEL_PREFIX = '__DOLLHOUSE_LOSSLESS_JSON_NUMBER_';

export function redactIntegrationResponseBody(
  text: string,
  contentType: string | null,
  credentialRedactions: CredentialRedactions,
): unknown {
  const normalizedText = text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
  if (normalizedText === '') return null;
  const declaredJson = isJsonMediaType(contentType);
  if (declaredJson) {
    let protectedNumbers: ProtectedJsonNumbers;
    let parsed: unknown;
    try {
      protectedNumbers = protectJsonNumberLexemes(normalizedText);
      parsed = JSON.parse(protectedNumbers.text) as unknown;
    } catch {
      return REDACTED;
    }
    return redactResponseCredentials(
      parsed,
      credentialRedactions,
      protectedNumbers.lexemesBySentinel,
      false,
    );
  }
  if (isJsonShapedBody(normalizedText)) {
    return redactJsonShapedTextWithoutLosingNumbers(normalizedText, credentialRedactions);
  }
  return redactCredentialText(normalizedText, credentialRedactions);
}

function redactJsonShapedTextWithoutLosingNumbers(
  text: string,
  credentialRedactions: CredentialRedactions,
): string {
  let protectedNumbers: ProtectedJsonNumbers;
  let parsed: unknown;
  try {
    protectedNumbers = protectJsonNumberLexemes(text);
    parsed = JSON.parse(protectedNumbers.text) as unknown;
  } catch {
    // Only syntax failures retain the historical text-redaction fallback.
    return redactCredentialText(text, credentialRedactions);
  }
  const redacted = redactResponseCredentials(
    parsed,
    credentialRedactions,
    protectedNumbers.lexemesBySentinel,
  );
  // Parsing still removes superseded duplicate properties that could retain a
  // secret. Number sentinels prevent that safety pass from rounding identifiers
  // or rewriting exponent notation in a response that was declared as text.
  return restoreJsonNumberLexemes(JSON.stringify(redacted), protectedNumbers.lexemesBySentinel);
}

function protectJsonNumberLexemes(text: string): ProtectedJsonNumbers {
  const { strings, tokens } = scanJsonNumbers(text);
  if (tokens.length === 0) return { text, lexemesBySentinel: new Map() };
  return replaceJsonNumbersWithSentinels(text, strings, tokens);
}

function scanJsonNumbers(text: string): ScannedJsonNumbers {
  const strings = new Set<string>();
  const tokens: JsonNumberToken[] = [];
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === '"') {
      const parsed = parseJsonStringAt(text, cursor);
      if (parsed === null) throw new SyntaxError('invalid JSON string');
      strings.add(parsed.value);
      cursor = parsed.end;
      continue;
    }
    const first = text[cursor] ?? '';
    if (first === '-' || (first >= '0' && first <= '9')) {
      numberPattern.lastIndex = cursor;
      const match = numberPattern.exec(text);
      if (match !== null) {
        const lexeme = match[0];
        tokens.push({ start: cursor, end: cursor + lexeme.length, lexeme });
        cursor += lexeme.length;
        continue;
      }
    }
    cursor += 1;
  }
  return { strings, tokens };
}

function replaceJsonNumbersWithSentinels(
  text: string,
  strings: ReadonlySet<string>,
  tokens: readonly JsonNumberToken[],
): ProtectedJsonNumbers {
  const lexemesBySentinel = new Map<string, string>();
  const parts: string[] = [];
  let copyFrom = 0;
  for (const [index, token] of tokens.entries()) {
    const sentinel = uniqueJsonNumberSentinel(index, strings, lexemesBySentinel);
    lexemesBySentinel.set(sentinel, token.lexeme);
    parts.push(text.slice(copyFrom, token.start), JSON.stringify(sentinel));
    copyFrom = token.end;
  }
  parts.push(text.slice(copyFrom));
  return { text: parts.join(''), lexemesBySentinel };
}

function uniqueJsonNumberSentinel(
  index: number,
  strings: ReadonlySet<string>,
  lexemesBySentinel: ReadonlyMap<string, string>,
): string {
  let attempt = 0;
  for (;;) {
    const sentinel = `${JSON_NUMBER_SENTINEL_PREFIX}${index}_${attempt}__`;
    if (!strings.has(sentinel) && !lexemesBySentinel.has(sentinel)) return sentinel;
    attempt += 1;
  }
}

function restoreJsonNumberLexemes(
  text: string,
  lexemesBySentinel: ReadonlyMap<string, string>,
): string {
  if (lexemesBySentinel.size === 0) return text;
  const sentinelPattern = new RegExp(
    String.raw`"${JSON_NUMBER_SENTINEL_PREFIX}\d+_\d+__"`,
    'g',
  );
  return text.replace(sentinelPattern, serialized => {
    const sentinel = serialized.slice(1, -1);
    return lexemesBySentinel.get(sentinel) ?? serialized;
  });
}

function isJsonMediaType(contentType: string | null): boolean {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

function isJsonShapedBody(text: string): boolean {
  const first = text.trimStart()[0];
  return first === '{' || first === '[' || first === '"';
}

function redactResponseCredentials(
  value: unknown,
  credentialRedactions: CredentialRedactions,
  protectedNumbers: ReadonlyMap<string, string> = new Map(),
  preserveProtectedNumberLexemes = true,
): unknown {
  if (typeof value === 'string') return redactResponseString(
    value,
    credentialRedactions,
    protectedNumbers,
    preserveProtectedNumberLexemes,
  );
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return redactResponsePrimitive(value, credentialRedactions);
  }
  if (Array.isArray(value)) {
    return value.map(item => redactResponseCredentials(
      item,
      credentialRedactions,
      protectedNumbers,
      preserveProtectedNumberLexemes,
    ));
  }
  if (typeof value !== 'object') return value;
  return redactResponseObject(
    value,
    credentialRedactions,
    protectedNumbers,
    preserveProtectedNumberLexemes,
  );
}

function redactResponseString(
  value: string,
  credentialRedactions: CredentialRedactions,
  protectedNumbers: ReadonlyMap<string, string>,
  preserveProtectedNumberLexemes: boolean,
): unknown {
  const numberLexeme = protectedNumbers.get(value);
  if (numberLexeme === undefined) return redactCredentialText(value, credentialRedactions);
  if (redactCredentialText(numberLexeme, credentialRedactions) !== numberLexeme) return REDACTED;
  return preserveProtectedNumberLexemes ? value : Number(numberLexeme);
}

function redactResponsePrimitive(
  value: null | number | boolean,
  credentialRedactions: CredentialRedactions,
): unknown {
  const serialized = String(value);
  return redactCredentialText(serialized, credentialRedactions) === serialized ? value : REDACTED;
}

function redactResponseObject(
  value: object,
  credentialRedactions: CredentialRedactions,
  protectedNumbers: ReadonlyMap<string, string>,
  preserveProtectedNumberLexemes: boolean,
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const redactedKey = redactCredentialText(key, credentialRedactions);
    const redactedField = isCredentialKey(key)
      ? REDACTED
      : redactResponseCredentials(
        field,
        credentialRedactions,
        protectedNumbers,
        preserveProtectedNumberLexemes,
      );
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
  if (isExactCredentialValue(value, credentialRedactions)) return REDACTED;
  const paddedExact = redactWhitespacePaddedExactCredential(value, credentialRedactions);
  if (paddedExact !== null) return paddedExact;
  let redacted = redactCredentialHeaderEchoes(value, credentialRedactions.headers);
  redacted = redactCredentialQueryEchoes(redacted, credentialRedactions.queries);
  redacted = redactCredentialLabelEchoes(redacted, credentialRedactions.labelledValues);
  redacted = redactBoundedCredentialValues(redacted, credentialRedactions.boundedValues);
  redacted = redactEmbeddedCredentialValues(redacted, credentialRedactions.embedded);
  redacted = redactJsonEscapedEmbeddedCredentialValues(
    redacted,
    credentialRedactions.semanticEmbedded,
  );
  redacted = redactOptionallyEncodedEmbeddedCredentialValues(
    redacted,
    credentialRedactions.semanticEmbedded,
  );
  redacted = redactPercentEncodedCredentials(redacted, credentialRedactions.percentEmbedded);
  return redacted;
}

function isExactCredentialValue(value: string, credentialRedactions: CredentialRedactions): boolean {
  return credentialRedactions.exact.has(value) ||
    credentialRedactions.percentExact.has(normalizePercentEscapes(value)) ||
    hasSemanticExactCredential(value, credentialRedactions.exact);
}

function redactWhitespacePaddedExactCredential(
  value: string,
  credentialRedactions: CredentialRedactions,
): string | null {
  let start = 0;
  while (start < value.length && /[\t\n\r ]/.test(value[start] ?? '')) start += 1;
  let end = value.length;
  while (end > start && /[\t\n\r ]/.test(value[end - 1] ?? '')) end -= 1;
  if (start === 0 && end === value.length) return null;
  const candidate = value.slice(start, end);
  return candidate !== '' && isExactCredentialValue(candidate, credentialRedactions)
    ? `${value.slice(0, start)}${REDACTED}${value.slice(end)}`
    : null;
}

function hasSemanticExactCredential(value: string, patterns: ReadonlySet<string>): boolean {
  for (const pattern of patterns) {
    if (credentialValuesEqual(value, pattern)) return true;
  }
  return false;
}

function redactEmbeddedCredentialValues(value: string, patterns: readonly string[]): string {
  let redacted = value;
  for (const pattern of patterns) {
    redacted = redactLinearMatches(redacted, pattern, identityDecodedText(redacted));
  }
  return redacted;
}

function redactJsonEscapedEmbeddedCredentialValues(
  value: string,
  patterns: readonly string[],
): string {
  let redacted = value;
  for (const pattern of patterns) {
    if (!redacted.includes('\\')) break;
    redacted = redactLinearMatches(redacted, pattern, decodeJsonEscapesWithOffsets(redacted));
  }
  return redacted;
}

interface DecodedText {
  readonly value: string;
  readonly sourceStarts: readonly number[];
  readonly sourceEnds: readonly number[];
}

interface LinearMatch {
  readonly start: number;
  readonly end: number;
}

function redactOptionallyEncodedEmbeddedCredentialValues(
  value: string,
  patterns: readonly string[],
): string {
  let redacted = value;
  for (const pattern of patterns) {
    if (!/%[0-9A-Fa-f]{2}/.test(redacted)) break;
    redacted = redactLinearMatches(redacted, pattern, decodePercentEscapesWithOffsets(redacted));
    redacted = redactLinearMatches(redacted, pattern, decodePercentEscapesWithOffsets(redacted, true));
  }
  return redacted;
}

function identityDecodedText(value: string): DecodedText {
  const sourceStarts = new Array<number>(value.length);
  const sourceEnds = new Array<number>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    sourceStarts[index] = index;
    sourceEnds[index] = index + 1;
  }
  return { value, sourceStarts, sourceEnds };
}

function decodePercentEscapesWithOffsets(value: string, decodeFormSpaces = false): DecodedText {
  const decoded: string[] = [];
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (decodeFormSpaces && value[cursor] === '+') {
      decoded.push(' ');
      sourceStarts.push(cursor);
      sourceEnds.push(cursor + 1);
      cursor += 1;
      continue;
    }
    const encodedCodePoint = decodePercentEncodedCodePoint(value, cursor);
    if (encodedCodePoint !== null) {
      decoded.push(encodedCodePoint.value);
      appendDecodedSourceOffsets(
        sourceStarts,
        sourceEnds,
        cursor,
        encodedCodePoint.end,
        encodedCodePoint.value.length,
      );
      cursor = encodedCodePoint.end;
      continue;
    }
    const codePoint = value.codePointAt(cursor);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    decoded.push(character);
    appendDecodedSourceOffsets(
      sourceStarts,
      sourceEnds,
      cursor,
      cursor + character.length,
      character.length,
    );
    cursor += character.length;
  }
  return { value: decoded.join(''), sourceStarts, sourceEnds };
}

const SIMPLE_JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function decodeJsonEscapesWithOffsets(value: string): DecodedText {
  const decoded: string[] = [];
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const escape = decodeJsonEscapeAt(value, cursor);
    if (escape !== null) {
      decoded.push(escape.value);
      appendDecodedSourceOffsets(sourceStarts, sourceEnds, cursor, escape.end, escape.value.length);
      cursor = escape.end;
      continue;
    }
    const codePoint = value.codePointAt(cursor);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    decoded.push(character);
    appendDecodedSourceOffsets(
      sourceStarts,
      sourceEnds,
      cursor,
      cursor + character.length,
      character.length,
    );
    cursor += character.length;
  }
  return { value: decoded.join(''), sourceStarts, sourceEnds };
}

function decodeJsonEscapeAt(
  value: string,
  start: number,
): { readonly value: string; readonly end: number } | null {
  if (value[start] !== '\\') return null;
  const marker = value[start + 1] ?? '';
  const simple = SIMPLE_JSON_ESCAPES[marker];
  if (simple !== undefined) return { value: simple, end: start + 2 };
  return marker === 'u' ? decodeJsonUnicodeEscapeAt(value, start) : null;
}

function decodeJsonUnicodeEscapeAt(
  value: string,
  start: number,
): { readonly value: string; readonly end: number } | null {
  const firstHex = value.slice(start + 2, start + 6);
  if (!/^[0-9A-Fa-f]{4}$/.test(firstHex)) return null;
  const firstCodeUnit = Number.parseInt(firstHex, 16);
  const secondHex = value.slice(start + 8, start + 12);
  if (firstCodeUnit >= 0xd800 && firstCodeUnit <= 0xdbff &&
      value.slice(start + 6, start + 8) === String.raw`\u` && /^[0-9A-Fa-f]{4}$/.test(secondHex)) {
    const secondCodeUnit = Number.parseInt(secondHex, 16);
    if (secondCodeUnit >= 0xdc00 && secondCodeUnit <= 0xdfff) {
      const codePoint = 0x10000 + ((firstCodeUnit - 0xd800) << 10) + (secondCodeUnit - 0xdc00);
      return { value: String.fromCodePoint(codePoint), end: start + 12 };
    }
  }
  return { value: String.fromCodePoint(firstCodeUnit), end: start + 6 };
}

function appendDecodedSourceOffsets(
  sourceStarts: number[],
  sourceEnds: number[],
  sourceStart: number,
  sourceEnd: number,
  decodedLength: number,
): void {
  sourceStarts.push(sourceStart);
  sourceEnds.push(sourceEnd);
  if (decodedLength === 2) {
    sourceStarts.push(sourceStart);
    sourceEnds.push(sourceEnd);
  }
}

function decodePercentEncodedCodePoint(
  value: string,
  start: number,
): { readonly value: string; readonly end: number } | null {
  const firstByte = readPercentEncodedByte(value, start);
  if (firstByte === null) return null;
  const byteLength = utf8CodePointByteLength(firstByte);
  if (byteLength === null) return null;
  const bytes = [firstByte];
  for (let index = 1; index < byteLength; index += 1) {
    const byte = readPercentEncodedByte(value, start + (index * 3));
    if (byte === null || (byte & 0xc0) !== 0x80) return null;
    bytes.push(byte);
  }
  const encoded = bytes.map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  try {
    return { value: decodeURIComponent(encoded), end: start + (byteLength * 3) };
  } catch {
    return null;
  }
}

function readPercentEncodedByte(value: string, start: number): number | null {
  const candidate = value.slice(start, start + 3);
  return /^%[0-9A-Fa-f]{2}$/.test(candidate) ? Number.parseInt(candidate.slice(1), 16) : null;
}

function utf8CodePointByteLength(firstByte: number): number | null {
  if (firstByte <= 0x7f) return 1;
  if (firstByte >= 0xc2 && firstByte <= 0xdf) return 2;
  if (firstByte >= 0xe0 && firstByte <= 0xef) return 3;
  if (firstByte >= 0xf0 && firstByte <= 0xf4) return 4;
  return null;
}

function redactLinearMatches(
  source: string,
  pattern: string,
  decoded: DecodedText,
): string {
  if (pattern === '' || decoded.value === '') return source;
  const matches = findLinearMatches(decoded.value, pattern).flatMap(match => {
    const sourceStart = decoded.sourceStarts[match.start];
    const sourceEnd = decoded.sourceEnds[match.end - 1];
    return sourceStart !== undefined && sourceEnd !== undefined &&
      !isInsideRedactionMarker(source, sourceStart, sourceEnd)
      ? [{ start: sourceStart, end: sourceEnd }]
      : [];
  });
  return applyRedactionMatches(source, matches);
}

function findLinearMatches(
  value: string,
  pattern: string,
): readonly LinearMatch[] {
  return findLinearMatchesUsing(value, pattern, exactLinearCharactersEqual);
}

function findAsciiCaseInsensitiveLinearMatches(
  value: string,
  pattern: string,
): readonly LinearMatch[] {
  return findLinearMatchesUsing(value, pattern, asciiCaseInsensitiveLinearCharactersEqual);
}

type LinearCharacterMatcher = (actual: string, expected: string) => boolean;

function findLinearMatchesUsing(
  value: string,
  pattern: string,
  charactersEqual: LinearCharacterMatcher,
): readonly LinearMatch[] {
  if (pattern === '' || value === '') return [];
  const failure = buildMatchFailureTable(pattern, charactersEqual);
  const matches: LinearMatch[] = [];
  let matched = 0;
  for (let index = 0; index < value.length; index += 1) {
    while (matched > 0 && !charactersEqual(
      value[index] ?? '',
      pattern[matched] ?? '',
    )) matched = failure[matched - 1] ?? 0;
    if (charactersEqual(
      value[index] ?? '',
      pattern[matched] ?? '',
    )) matched += 1;
    if (matched !== pattern.length) continue;
    matches.push({ start: index - pattern.length + 1, end: index + 1 });
    matched = failure[matched - 1] ?? 0;
  }
  return matches;
}

function applyRedactionMatches(source: string, matches: readonly LinearMatch[]): string {
  if (matches.length === 0) return source;
  const parts: string[] = [];
  let copyFrom = 0;
  for (const match of matches) {
    if (match.start < copyFrom) continue;
    parts.push(source.slice(copyFrom, match.start), REDACTED);
    copyFrom = match.end;
  }
  parts.push(source.slice(copyFrom));
  return parts.join('');
}

function buildMatchFailureTable(
  pattern: string,
  charactersEqual: LinearCharacterMatcher,
): readonly number[] {
  const failure = new Array<number>(pattern.length).fill(0);
  let matched = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    while (matched > 0 && !charactersEqual(
      pattern[index] ?? '',
      pattern[matched] ?? '',
    )) matched = failure[matched - 1] ?? 0;
    if (charactersEqual(
      pattern[index] ?? '',
      pattern[matched] ?? '',
    )) matched += 1;
    failure[index] = matched;
  }
  return failure;
}

function exactLinearCharactersEqual(actual: string, expected: string): boolean {
  return actual === expected;
}

function asciiCaseInsensitiveLinearCharactersEqual(actual: string, expected: string): boolean {
  return asciiLowercase(actual) === asciiLowercase(expected);
}

function isInsideRedactionMarker(source: string, start: number, end: number): boolean {
  const markerStart = source.lastIndexOf(REDACTED, start);
  return markerStart >= 0 && start >= markerStart && end <= markerStart + REDACTED.length;
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
  const decoded = decodePercentEscapesWithOffsets(jsonRedacted, true);
  const decodedName = decodePercentEscapesWithOffsets(query.name, true).value;
  const decodedValue = decodePercentEscapesWithOffsets(query.value, true).value;
  const serializedName = `${decodedName}=`;
  const prefixes = query.caseInsensitiveName
    ? findAsciiCaseInsensitiveLinearMatches(decoded.value, serializedName)
    : findLinearMatches(decoded.value, serializedName);
  const valuesByStart = new Map(
    findLinearMatches(decoded.value, decodedValue).map(match => [match.start, match.end]),
  );
  const matches = prefixes.flatMap(prefix => {
    const valueEnd = valuesByStart.get(prefix.end);
    if (valueEnd === undefined ||
        (prefix.start > 0 && /[A-Za-z0-9_.~-]/.test(decoded.value[prefix.start - 1] ?? '')) ||
        !isCredentialValueBoundary(decoded.value[valueEnd] ?? '')) return [];
    const sourceStart = decoded.sourceStarts[prefix.start];
    const sourceEnd = decoded.sourceEnds[valueEnd - 1];
    return sourceStart !== undefined && sourceEnd !== undefined &&
      !isInsideRedactionMarker(jsonRedacted, sourceStart, sourceEnd)
      ? [{ start: sourceStart, end: sourceEnd }]
      : [];
  });
  return applyRedactionMatches(jsonRedacted, matches);
}

const MAX_CREDENTIAL_ECHO_LABEL_LENGTH = 64;

function redactCredentialLabelEchoes(value: string, patterns: readonly string[]): string {
  let redacted = redactJsonCredentialLabelEchoes(value, patterns);
  for (const pattern of patterns) {
    redacted = redactCredentialLabelEchoPattern(redacted, pattern, false);
    redacted = redactCredentialLabelEchoPattern(redacted, pattern, true);
  }
  return redacted;
}

function redactCredentialLabelEchoPattern(
  value: string,
  pattern: string,
  decodeFormSpaces: boolean,
): string {
  const hasEncodingEvidence = /%[0-9A-Fa-f]{2}/.test(value);
  const decoded = decodePercentEscapesWithOffsets(value, decodeFormSpaces);
  const decodedPattern = decodePercentEscapesWithOffsets(pattern, decodeFormSpaces).value;
  const matches = findLinearMatches(decoded.value, decodedPattern).flatMap(valueMatch => {
    const labelledMatch = credentialLabelMatch(decoded.value, valueMatch);
    if (labelledMatch === null) return [];
    const sourceStart = decoded.sourceStarts[labelledMatch.start];
    const sourceEnd = decoded.sourceEnds[labelledMatch.end - 1];
    return sourceStart !== undefined && sourceEnd !== undefined &&
      (value[sourceStart - 1] !== '+' || hasEncodingEvidence) &&
      !isInsideRedactionMarker(value, sourceStart, sourceEnd)
      ? [{ start: sourceStart, end: sourceEnd }]
      : [];
  });
  return applyRedactionMatches(value, matches);
}

function redactJsonCredentialLabelEchoes(value: string, patterns: readonly string[]): string {
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  for (;;) {
    const start = value.indexOf('"', searchFrom);
    if (start < 0) break;
    const scannedName = scanJsonStringAt(
      value,
      start,
      maxJsonStringSourceLength(MAX_CREDENTIAL_ECHO_LABEL_LENGTH),
    );
    // Advance one code unit so a quote consumed as the end of malformed
    // surrounding text can still begin the next bounded label candidate.
    searchFrom = start + 1;
    if (scannedName.value === null || !isCredentialKey(scannedName.value)) continue;
    const before = value[start - 1] ?? '';
    if (before !== '' && isHttpFieldNameCharacter(before)) continue;
    let cursor = skipStructuredWhitespace(value, scannedName.end);
    if (value[cursor] !== ':') continue;
    cursor = skipStructuredWhitespace(value, cursor + 1);
    if (value[cursor] !== '"') continue;
    const parsedValue = parseJsonStringAt(value, cursor);
    if (parsedValue === null ||
        !patterns.some(pattern => credentialValuesEqual(parsedValue.value, pattern))) continue;
    parts.push(value.slice(copyFrom, start), REDACTED);
    copyFrom = parsedValue.end;
    searchFrom = parsedValue.end;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(copyFrom));
  return parts.join('');
}

function credentialLabelMatch(value: string, valueMatch: LinearMatch): LinearMatch | null {
  const valueBounds = credentialLabelValueBounds(value, valueMatch);
  if (valueBounds === null) return null;
  const keyStart = credentialLabelKeyStart(value, valueBounds.start);
  return keyStart === null ? null : { start: keyStart, end: valueBounds.end };
}

function credentialLabelValueBounds(value: string, valueMatch: LinearMatch): LinearMatch | null {
  const valueQuote = value[valueMatch.start - 1];
  const quotedValue = valueQuote === '"' || valueQuote === "'";
  const valueStart = quotedValue ? valueMatch.start - 1 : valueMatch.start;
  const valueEnd = quotedValue ? valueMatch.end + 1 : valueMatch.end;
  if (quotedValue && value[valueMatch.end] !== valueQuote) return null;
  if (!isCredentialValueBoundary(value[valueEnd] ?? '')) return null;
  return { start: valueStart, end: valueEnd };
}

function credentialLabelKeyStart(value: string, valueStart: number): number | null {
  let cursor = skipStructuredWhitespaceBackward(value, valueStart);
  if (cursor === 0 || (value[cursor - 1] !== '=' && value[cursor - 1] !== ':')) return null;
  cursor = skipStructuredWhitespaceBackward(value, cursor - 1);
  const keyQuote = value[cursor - 1];
  const quotedKey = keyQuote === '"' || keyQuote === "'";
  const keyEnd = quotedKey ? cursor - 1 : cursor;
  let keyStart = keyEnd;
  while (keyStart > 0 && keyEnd - keyStart < MAX_CREDENTIAL_ECHO_LABEL_LENGTH &&
         (quotedKey ? value[keyStart - 1] !== keyQuote : /[A-Za-z0-9_.-]/.test(value[keyStart - 1] ?? ''))) {
    keyStart -= 1;
  }
  if (quotedKey && (keyStart === 0 || value[keyStart - 1] !== keyQuote)) return null;
  const key = value.slice(keyStart, keyEnd);
  if (!/^[A-Za-z0-9]/.test(key) || !isCredentialKey(key)) return null;
  const matchStart = quotedKey ? keyStart - 1 : keyStart;
  const before = value[matchStart - 1] ?? '';
  if (before !== '' && isHttpFieldNameCharacter(before)) return null;
  return matchStart;
}

function skipStructuredWhitespaceBackward(value: string, start: number): number {
  let cursor = start;
  while (cursor > 0 && /[\t\n\r ]/.test(value[cursor - 1] ?? '')) cursor -= 1;
  return cursor;
}

function redactJsonCredentialQueryEchoes(
  value: string,
  query: CredentialQueryRedaction,
): string {
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
    if (scannedName.value === null || !credentialQueryNamesEqual(scannedName.value, query)) continue;
    const before = start === 0 ? '' : value[start - 1];
    if (before !== '' && /[A-Za-z0-9_.~-]/.test(before)) continue;
    const valueEnd = jsonCredentialPropertyValueEnd(value, scannedName.end, query.value);
    if (valueEnd === null) continue;
    parts.push(value.slice(copyFrom, start), REDACTED);
    copyFrom = valueEnd;
    searchFrom = valueEnd;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(copyFrom));
  return parts.join('');
}

function credentialQueryNamesEqual(actual: string, query: CredentialQueryRedaction): boolean {
  return matchCredentialValueEnd(
    actual,
    0,
    query.name,
    query.caseInsensitiveName ? query.name.length : 0,
  ) === actual.length;
}

function jsonCredentialPropertyValueEnd(
  value: string,
  cursorAfterName: number,
  expected: string,
): number | null {
  let cursor = skipStructuredWhitespace(value, cursorAfterName);
  if (value[cursor] !== ':') return null;
  cursor = skipStructuredWhitespace(value, cursor + 1);
  if (value[cursor] === '"') {
    const parsed = parseJsonStringAt(value, cursor);
    return parsed !== null && credentialValuesEqual(parsed.value, expected)
      ? parsed.end
      : null;
  }
  let end = cursor;
  while (end < value.length && !/[\s,}\]]/.test(value[end] ?? '')) end += 1;
  return credentialValuesEqual(value.slice(cursor, end), expected) ? end : null;
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
  const literalRedacted = redactLinearCredentialHeaderEcho(
    jsonRedacted,
    identityDecodedText(jsonRedacted),
    header,
  );
  if (!/%[0-9A-Fa-f]{2}/.test(literalRedacted)) return literalRedacted;
  const percentRedacted = redactLinearCredentialHeaderEcho(
    literalRedacted,
    decodePercentEscapesWithOffsets(literalRedacted),
    header,
  );
  return redactLinearCredentialHeaderEcho(
    percentRedacted,
    decodePercentEscapesWithOffsets(percentRedacted, true),
    header,
    true,
  );
}

function redactLinearCredentialHeaderEcho(
  source: string,
  decoded: DecodedText,
  header: CredentialHeaderRedaction,
  allowLeadingFormSpaceBoundary = false,
): string {
  const valueMatches = credentialHeaderValueMatches(decoded.value, header);
  const matches = findAsciiCaseInsensitiveLinearMatches(decoded.value, header.name).flatMap(nameMatch => {
    const match = linearCredentialHeaderEchoMatch(decoded.value, nameMatch, header, valueMatches);
    if (match === null) return [];
    const sourceStart = decoded.sourceStarts[match.start];
    const sourceEnd = decoded.sourceEnds[match.end - 1];
    return sourceStart !== undefined && sourceEnd !== undefined &&
      (allowLeadingFormSpaceBoundary || source[sourceStart - 1] !== '+') &&
      !isInsideRedactionMarker(source, sourceStart, sourceEnd)
      ? [{ start: sourceStart, end: sourceEnd }]
      : [];
  });
  return applyRedactionMatches(source, matches);
}

function credentialHeaderValueMatches(
  value: string,
  header: CredentialHeaderRedaction,
): ReadonlyMap<number, number> {
  return findCredentialValueMatches(
    value,
    header.value,
    header.caseInsensitivePrefixLength ?? 0,
  );
}

function findCredentialValueMatches(
  value: string,
  expected: string,
  caseInsensitivePrefixLength: number,
): ReadonlyMap<number, number> {
  const prefixLength = caseInsensitivePrefixLength;
  if (prefixLength === 0) {
    return new Map(findLinearMatches(value, expected).map(match => [match.start, match.end]));
  }
  const prefix = expected.slice(0, prefixLength);
  const suffix = expected.slice(prefixLength);
  const suffixesByStart = new Map(
    findLinearMatches(value, suffix).map(match => [match.start, match.end]),
  );
  return new Map(
    findAsciiCaseInsensitiveLinearMatches(value, prefix).flatMap(prefixMatch => {
      const valueEnd = suffixesByStart.get(prefixMatch.end);
      return valueEnd === undefined ? [] : [[prefixMatch.start, valueEnd] as const];
    }),
  );
}

function linearCredentialHeaderEchoMatch(
  value: string,
  nameMatch: LinearMatch,
  header: CredentialHeaderRedaction,
  valueMatches: ReadonlyMap<number, number>,
): LinearMatch | null {
  const nameBounds = credentialHeaderNameBounds(value, nameMatch);
  if (nameBounds === null) return null;
  const valueEnd = credentialHeaderEchoValueEnd(value, nameBounds.end, header, valueMatches);
  return valueEnd === null ? null : { start: nameBounds.start, end: valueEnd };
}

function credentialHeaderNameBounds(value: string, nameMatch: LinearMatch): LinearMatch | null {
  const before = value[nameMatch.start - 1] ?? '';
  const nameQuote = before === '"' || before === "'" ? before : null;
  const matchStart = nameQuote === null ? nameMatch.start : nameMatch.start - 1;
  const boundaryBefore = value[matchStart - 1] ?? '';
  if (boundaryBefore !== '' && isHttpFieldNameCharacter(boundaryBefore)) return null;

  let cursor = nameMatch.end;
  if (nameQuote !== null) {
    if (value[cursor] !== nameQuote) return null;
    cursor += 1;
  }
  cursor = skipStructuredWhitespace(value, cursor);
  if (value[cursor] !== ':') return null;
  return { start: matchStart, end: cursor + 1 };
}

function credentialHeaderEchoValueEnd(
  value: string,
  cursorAfterDelimiter: number,
  header: CredentialHeaderRedaction,
  valueMatches: ReadonlyMap<number, number>,
): number | null {
  const cursor = skipStructuredWhitespace(value, cursorAfterDelimiter);
  const valueQuote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor] : null;
  const valueStart = valueQuote === null ? cursor : cursor + 1;
  const matchedValueEnd = valueMatches.get(valueStart);
  if (matchedValueEnd === undefined) return null;
  if (valueQuote !== null) return value[matchedValueEnd] === valueQuote ? matchedValueEnd + 1 : null;
  if (header.requireValueBoundary && !isCredentialValueBoundary(value[matchedValueEnd] ?? '')) return null;
  return matchedValueEnd;
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
      return credentialHeaderValueMatchEnd(parsed.value, 0, header) === parsed.value.length
        ? parsed.end
        : null;
    }
  }
  const valueStart = quote ? cursor + 1 : cursor;
  const valueEnd = credentialHeaderValueMatchEnd(value, valueStart, header);
  if (valueEnd === null) return null;
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

function credentialHeaderValueMatchEnd(
  value: string,
  valueStart: number,
  header: CredentialHeaderRedaction,
): number | null {
  return matchCredentialValueEnd(
    value,
    valueStart,
    header.value,
    header.caseInsensitivePrefixLength ?? 0,
  );
}

function credentialValuesEqual(actual: string, expected: string): boolean {
  return matchCredentialValueEnd(actual, 0, expected) === actual.length;
}

function matchCredentialValueEnd(
  value: string,
  valueStart: number,
  expected: string,
  caseInsensitivePrefixLength = 0,
): number | null {
  let valueCursor = valueStart;
  let expectedCursor = 0;
  while (expectedCursor < expected.length) {
    const matchingEscapeLength = matchEquivalentPercentEscape(
      value,
      valueCursor,
      expected,
      expectedCursor,
    );
    if (matchingEscapeLength !== null) {
      valueCursor += matchingEscapeLength;
      expectedCursor += matchingEscapeLength;
      continue;
    }
    const codePoint = expected.codePointAt(expectedCursor);
    if (codePoint === undefined) return null;
    const character = String.fromCodePoint(codePoint);
    const prefixCharacter = expectedCursor < caseInsensitivePrefixLength;
    const matchedLength = prefixCharacter
      ? matchCredentialCharacterCaseInsensitive(value, valueCursor, character)
      : matchCredentialCharacter(value, valueCursor, character);
    if (matchedLength === null) return null;
    valueCursor += matchedLength;
    expectedCursor += character.length;
  }
  return valueCursor;
}

function matchEquivalentPercentEscape(
  value: string,
  valueCursor: number,
  expected: string,
  expectedCursor: number,
): number | null {
  const expectedEscape = expected.slice(expectedCursor, expectedCursor + 3);
  if (!/^%[0-9A-Fa-f]{2}$/.test(expectedEscape)) return null;
  const actualEscape = value.slice(valueCursor, valueCursor + 3);
  return normalizePercentEscapes(actualEscape) === normalizePercentEscapes(expectedEscape) ? 3 : null;
}

function matchCredentialCharacter(value: string, start: number, expected: string): number | null {
  const rawCandidate = value.slice(start, start + expected.length);
  if (expected === ' ' && rawCandidate === '+') return 1;
  if (rawCandidate === expected) return expected.length;
  return matchPercentEncodedCharacter(value, start, expected);
}

function matchCredentialCharacterCaseInsensitive(
  value: string,
  start: number,
  expected: string,
): number | null {
  const rawCandidate = value.slice(start, start + expected.length);
  if (expected === ' ' && rawCandidate === '+') return 1;
  if (asciiLowercase(rawCandidate) === asciiLowercase(expected)) return expected.length;
  return matchPercentEncodedCharacterCaseInsensitive(value, start, expected);
}

function matchPercentEncodedCharacter(
  value: string,
  start: number,
  expected: string,
): number | null {
  const encoded = percentEncodeUtf8(expected);
  return normalizePercentEscapes(value.slice(start, start + encoded.length)) === encoded
    ? encoded.length
    : null;
}

function matchPercentEncodedCharacterCaseInsensitive(
  value: string,
  start: number,
  expected: string,
): number | null {
  if (!/^[A-Za-z]$/.test(expected)) return matchPercentEncodedCharacter(value, start, expected);
  for (const candidate of [expected.toLowerCase(), expected.toUpperCase()]) {
    const length = matchPercentEncodedCharacter(value, start, candidate);
    if (length !== null) return length;
  }
  return null;
}

function percentEncodeUtf8(value: string): string {
  return [...Buffer.from(value, 'utf8')]
    .map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
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

interface MutableCredentialRedactions {
  readonly exact: Set<string>;
  readonly percentExact: Set<string>;
  readonly embedded: Set<string>;
  readonly semanticEmbedded: Set<string>;
  readonly percentEmbedded: Set<string>;
  readonly headers: CredentialHeaderRedaction[];
  readonly queries: CredentialQueryRedaction[];
  readonly labelledValues: Set<string>;
  readonly boundedValues: CredentialBoundedValueRedaction[];
}

function createMutableCredentialRedactions(): MutableCredentialRedactions {
  return {
    exact: new Set(),
    percentExact: new Set(),
    embedded: new Set(),
    semanticEmbedded: new Set(),
    percentEmbedded: new Set(),
    headers: [],
    queries: [],
    labelledValues: new Set(),
    boundedValues: [],
  };
}

function credentialEncodedVariants(value: string): readonly string[] {
  return [
    encodeURIComponent(value),
    new URLSearchParams({ value }).toString().slice('value='.length),
  ];
}

function addExactCredentialRedaction(state: MutableCredentialRedactions, value: string): void {
  if (!value) return;
  state.exact.add(value);
  for (const variant of credentialEncodedVariants(value)) {
    state.exact.add(variant);
    if (variant.includes('%')) state.percentExact.add(normalizePercentEscapes(variant));
  }
}

function addEmbeddedCredentialRedaction(state: MutableCredentialRedactions, value: string): void {
  addExactCredentialRedaction(state, value);
  state.embedded.add(value);
  state.semanticEmbedded.add(value);
  for (const variant of credentialEncodedVariants(value)) {
    state.embedded.add(variant);
    if (variant.includes('%')) state.percentEmbedded.add(normalizePercentEscapes(variant));
  }
}

function addCredentialRedaction(
  state: MutableCredentialRedactions,
  value: string,
  allowEmbedded = value.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH,
): void {
  addExactCredentialRedaction(state, value);
  if (allowEmbedded) addEmbeddedCredentialRedaction(state, value);
}

function addHeaderCredentialRedactions(
  state: MutableCredentialRedactions,
  name: string,
  value: string,
  sensitiveValue: string,
  caseInsensitivePrefixLength = 0,
): void {
  const requireValueBoundary = sensitiveValue.length < MIN_EMBEDDED_CREDENTIAL_LENGTH;
  const prefix = value.slice(0, value.length - sensitiveValue.length);
  const candidates = new Map<string, number>([[value, caseInsensitivePrefixLength]]);
  const escapedPrefix = jsonStringContent(prefix);
  candidates.set(
    jsonStringContent(value),
    caseInsensitivePrefixLength > 0 ? escapedPrefix.length : 0,
  );
  const encodedValues = credentialEncodedVariants(value);
  const encodedPrefixes = credentialEncodedVariants(prefix);
  for (const [index, encodedValue] of encodedValues.entries()) {
    candidates.set(
      encodedValue,
      caseInsensitivePrefixLength > 0 ? encodedPrefixes[index]?.length ?? 0 : 0,
    );
  }
  if (prefix) addPartiallyEncodedHeaderCandidates(
    candidates,
    prefix,
    sensitiveValue,
    escapedPrefix,
    caseInsensitivePrefixLength,
  );
  for (const [candidate, prefixLength] of candidates) {
    state.headers.push({
      name,
      value: candidate,
      caseInsensitivePrefixLength: prefixLength || undefined,
      requireValueBoundary,
    });
    if (requireValueBoundary && prefix.length > 0) {
      state.boundedValues.push({ value: candidate, caseInsensitivePrefixLength: prefixLength });
    }
  }
}

function addPartiallyEncodedHeaderCandidates(
  candidates: Map<string, number>,
  prefix: string,
  sensitiveValue: string,
  escapedPrefix: string,
  caseInsensitivePrefixLength: number,
): void {
  for (const encodedSensitiveValue of credentialEncodedVariants(sensitiveValue)) {
    candidates.set(`${prefix}${encodedSensitiveValue}`, caseInsensitivePrefixLength);
  }
  candidates.set(
    `${escapedPrefix}${jsonStringContent(sensitiveValue)}`,
    caseInsensitivePrefixLength > 0 ? escapedPrefix.length : 0,
  );
}

function addShortBoundedCredentialVariants(
  state: MutableCredentialRedactions,
  value: string,
): void {
  for (const candidate of new Set([value, ...credentialEncodedVariants(value)])) {
    state.boundedValues.push({ value: candidate, caseInsensitivePrefixLength: 0 });
  }
}

function addBaseCredentialRedactions(
  state: MutableCredentialRedactions,
  credential: string,
  injection: EffectiveCredentialInjection,
): void {
  addCredentialRedaction(state, credential);
  state.labelledValues.add(credential);
  if (injection.sensitiveValue !== credential) {
    addCredentialRedaction(state, injection.sensitiveValue);
    state.labelledValues.add(injection.sensitiveValue);
  }
  for (const sensitiveValue of injection.additionalSensitiveValues ?? []) {
    addCredentialRedaction(state, sensitiveValue);
  }
  for (const boundedValue of injection.additionalBoundedValues ?? []) {
    addCredentialRedaction(state, boundedValue);
    if (boundedValue.length < MIN_EMBEDDED_CREDENTIAL_LENGTH) {
      addShortBoundedCredentialVariants(state, boundedValue);
    }
  }
  for (const structuredValue of injection.additionalStructuredValues ?? []) {
    addQueryCredentialRedactions(
      state.queries,
      structuredValue.name,
      structuredValue.value,
      structuredValue.caseInsensitiveName,
    );
    addHeaderCredentialRedactions(state, structuredValue.name, structuredValue.value, structuredValue.value);
  }
  addCredentialRedaction(
    state,
    injection.value,
    injection.sensitiveValue.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH,
  );
}

function addQueryInjectionRedactions(
  state: MutableCredentialRedactions,
  injection: EffectiveCredentialInjection,
): void {
  addQueryCredentialRedactions(state.queries, injection.name, injection.value);
  const prefixLength = injection.value.length - injection.sensitiveValue.length;
  if (injection.sensitiveValue.length < MIN_EMBEDDED_CREDENTIAL_LENGTH && prefixLength > 0) {
    addShortBoundedCredentialVariants(state, injection.value);
  }
}

function addHeaderInjectionRedactions(
  state: MutableCredentialRedactions,
  injection: EffectiveCredentialInjection,
): void {
  if (injection.value && injection.sensitiveValue) {
    addHeaderCredentialRedactions(
      state,
      injection.name,
      injection.value,
      injection.sensitiveValue,
      injection.caseInsensitivePrefixLength,
    );
  }
  if (injection.configuredValue && injection.configuredSensitiveValue &&
      injection.configuredValue !== injection.value) {
    addCredentialRedaction(
      state,
      injection.configuredValue,
      injection.configuredSensitiveValue.length >= MIN_EMBEDDED_CREDENTIAL_LENGTH,
    );
    addHeaderCredentialRedactions(
      state,
      injection.name,
      injection.configuredValue,
      injection.configuredSensitiveValue,
      injection.configuredCaseInsensitivePrefixLength,
    );
  }
}

function addEffectiveCredentialRedactions(
  state: MutableCredentialRedactions,
  credential: string,
  injection: EffectiveCredentialInjection,
): void {
  addBaseCredentialRedactions(state, credential, injection);
  if (injection.location === 'query') addQueryInjectionRedactions(state, injection);
  else addHeaderInjectionRedactions(state, injection);
}

function mergeCredentialRedactions(
  state: MutableCredentialRedactions,
  additional: CredentialRedactions,
): void {
  for (const value of additional.exact) state.exact.add(value);
  for (const value of additional.percentExact) state.percentExact.add(value);
  for (const value of additional.embedded) state.embedded.add(value);
  for (const value of additional.semanticEmbedded) state.semanticEmbedded.add(value);
  for (const value of additional.percentEmbedded) state.percentEmbedded.add(value);
  state.headers.push(...additional.headers);
  state.queries.push(...additional.queries);
  for (const value of additional.labelledValues) state.labelledValues.add(value);
  state.boundedValues.push(...additional.boundedValues);
}

function finalizeCredentialRedactions(state: MutableCredentialRedactions): CredentialRedactions {
  return {
    exact: state.exact,
    percentExact: state.percentExact,
    embedded: [...state.embedded].sort((left, right) => right.length - left.length),
    semanticEmbedded: [...state.semanticEmbedded].sort((left, right) => right.length - left.length),
    percentEmbedded: [...state.percentEmbedded].sort((left, right) => right.length - left.length),
    headers: state.headers,
    queries: state.queries,
    labelledValues: [...state.labelledValues],
    boundedValues: deduplicateBoundedValues(state.boundedValues),
  };
}

export function buildCredentialRedactions(
  credential: string,
  injection: EffectiveCredentialInjection,
  additionalCredentials: readonly {
    readonly credential: string;
    readonly injection: EffectiveCredentialInjection;
  }[] = [],
): CredentialRedactions {
  const state = createMutableCredentialRedactions();
  addEffectiveCredentialRedactions(state, credential, injection);
  for (const additionalInput of additionalCredentials) {
    mergeCredentialRedactions(
      state,
      buildCredentialRedactions(additionalInput.credential, additionalInput.injection),
    );
  }
  return finalizeCredentialRedactions(state);
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
  const literalRedacted = redactLinearBoundedCredentialValue(
    value,
    identityDecodedText(value),
    pattern,
  );
  if (!/%[0-9A-Fa-f]{2}/.test(literalRedacted)) return literalRedacted;
  const percentRedacted = redactLinearBoundedCredentialValue(
    literalRedacted,
    decodePercentEscapesWithOffsets(literalRedacted),
    pattern,
  );
  return redactLinearBoundedCredentialValue(
    percentRedacted,
    decodePercentEscapesWithOffsets(percentRedacted, true),
    pattern,
  );
}

function redactLinearBoundedCredentialValue(
  source: string,
  decoded: DecodedText,
  pattern: CredentialBoundedValueRedaction,
): string {
  const valueMatches = findCredentialValueMatches(
    decoded.value,
    pattern.value,
    pattern.caseInsensitivePrefixLength,
  );
  const matches = [...valueMatches].flatMap(([start, end]) => {
    const before = decoded.value[start - 1] ?? '';
    const after = decoded.value[end] ?? '';
    if ((before !== '' && isHttpFieldNameCharacter(before)) ||
        !isCredentialValueBoundary(after)) return [];
    const sourceStart = decoded.sourceStarts[start];
    const sourceEnd = decoded.sourceEnds[end - 1];
    return sourceStart !== undefined && sourceEnd !== undefined &&
      !isInsideRedactionMarker(source, sourceStart, sourceEnd)
      ? [{ start: sourceStart, end: sourceEnd }]
      : [];
  });
  return applyRedactionMatches(source, matches);
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function addQueryCredentialRedactions(
  queries: CredentialQueryRedaction[],
  queryName: string,
  injectedValue: string,
  caseInsensitiveName = false,
): void {
  const encodedName = new URLSearchParams([[queryName, '']]).toString().slice(0, -1);
  const encodedValue = new URLSearchParams({ value: injectedValue }).toString().slice('value='.length);
  const queryNames = new Set([queryName, encodedName, encodeURIComponent(queryName)]);
  const queryValues = new Set([injectedValue, encodedValue, encodeURIComponent(injectedValue)]);
  for (const name of queryNames) {
    for (const value of queryValues) queries.push({ name, value, caseInsensitiveName });
  }
}

const CREDENTIAL_KEY_SUBSTRINGS = [
  'authorization', 'bearer', 'jwt', 'secret', 'credential', 'password', 'passwd', 'ciphertext',
  'apikey', 'api_key', 'api-key', 'privatekey', 'private_key', 'private-key',
  'accesstoken', 'refreshtoken', 'idtoken',
];

function isCredentialKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (CREDENTIAL_KEY_SUBSTRINGS.some(fragment => lower.includes(fragment))) return true;
  return /(^|_)(access|refresh|id)?_?token($|_)/i.test(lower);
}
