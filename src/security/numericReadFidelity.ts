import * as yaml from 'js-yaml';
import { SecurityError } from '../errors/SecurityError.js';

// Qualification bounds work on an individual numeric scalar. Native JSON
// numbers emitted by supported writers are far smaller; exponents stay compact.
const MAX_NUMERIC_SCALAR_UNITS = 1024;
type Decimal = { negative: boolean; digits: string; scale: bigint };

function refuse(): never {
  throw new SecurityError('Numeric scalar cannot be faithfully read', 'YAML_NUMERIC_PRECISION', 'medium');
}

function decimal(token: string): Decimal {
  if (token.length > MAX_NUMERIC_SCALAR_UNITS) refuse();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(token);
  if (!match || !(match[2] || match[3])) refuse();
  const fraction = match[3] ?? '';
  let digits = (match[2] + fraction).replace(/^0+/u, '');
  let scale = BigInt(match[4] ?? '0') - BigInt(fraction.length);
  if (!digits) return { negative: match[1] === '-', digits: '0', scale: 0n };
  const trailing = /0+$/u.exec(digits)?.[0].length ?? 0;
  if (trailing) { digits = digits.slice(0, -trailing); scale += BigInt(trailing); }
  return { negative: match[1] === '-', digits, scale };
}

/** Exact decimal value versus the native JS JSON representation, without expanding exponents. */
export function assertNumericReadFidelity(token: string, value: unknown, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) ||
      token.length > MAX_NUMERIC_SCALAR_UNITS) refuse();
  let original = token;
  if (integer) {
    const negative = token.startsWith('-');
    const unsigned = token.replace(/^[+-]/u, '');
    // Called only AFTER the pinned YAML type has resolved this integer.
    original = (negative ? '-' : '') + BigInt(unsigned).toString();
  }
  const expected = decimal(original);
  const represented = decimal(JSON.stringify(value));
  if (expected.negative !== represented.negative || expected.digits !== represented.digits ||
      expected.scale !== represented.scale) refuse();
}

/** Private per-parse types preserve pinned resolution, including explicit tags. */
export function numericReadFidelitySchema(): yaml.Schema {
  // js-yaml exports these pinned types; its declaration package omits `types`.
  const types = (yaml as typeof yaml & { types: { int: yaml.Type; float: yaml.Type } }).types;
  const wrap = (type: yaml.Type, tag: string, integer: boolean): yaml.Type => new yaml.Type(tag, {
    kind: 'scalar',
    resolve: scalar => type.resolve(scalar),
    construct: scalar => {
      if (typeof scalar !== 'string' || scalar.length > MAX_NUMERIC_SCALAR_UNITS) refuse();
      const value: unknown = type.construct(scalar);
      assertNumericReadFidelity(scalar, value, integer);
      return value;
    },
  });
  const numeric = [wrap(types.int, 'tag:yaml.org,2002:int', true),
    wrap(types.float, 'tag:yaml.org,2002:float', false)];
  return yaml.CORE_SCHEMA.extend({ implicit: numeric, explicit: numeric });
}

/** Only user JSONB fields: typed database bigint counters/revisions do not pass here. */
export function assertJsonNumericReadFidelity(json: string): void {
  const outsideStrings = json.replace(/"(?:\\.|[^"\\])*"/gu, '""');
  const numbers = outsideStrings.matchAll(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu);
  for (const [token] of numbers) assertNumericReadFidelity(token, Number(token));
}
