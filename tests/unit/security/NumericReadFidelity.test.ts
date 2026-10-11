import { describe, expect, it } from '@jest/globals';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';
import { assertJsonNumericReadFidelity } from '../../../src/security/numericReadFidelity.js';

const parse = (content: string) => SecureYamlParser.parseRawYaml(content, {
  contentPolicy: 'structure-only', numericPolicy: 'read-fidelity',
});

describe('non-destructive numeric read fidelity', () => {
  it.each(['0.5', '5e-1', '0.5000', '!!float 0.5', '!!int 16', '0x10', '0o20', '0b10000',
    '!!int 0x10', '9007199254740992', '1e300', '5e-324'])('retains exact native value for %s', scalar => {
    const value = parse(`value: ${scalar}`).value;
    expect(typeof value).toBe('number');
    expect(Number.isFinite(value)).toBe(true);
  });

  it.each(['9007199254740993', '!!int 9007199254740993', '!!float 0.10000000000000001',
    '0.10000000000000001', '1e-999', '-0', '-0.0', '.inf', '.nan'])(
    'refuses precision loss before hydration for %s', scalar => {
      expect(() => parse(`value: ${scalar}`)).toThrow('Numeric scalar cannot be faithfully read');
    });

  it('preserves quoted numeric strings, original underscore resolution and aliases', () => {
    expect(parse('value: "9007199254740993"\nunderscore: 1_000\nfirst: &n 0.5\nsecond: *n')).toEqual({
      value: '9007199254740993', underscore: '1_000', first: 0.5, second: 0.5,
    });
    expect(() => parse('value: !!int 1_000')).toThrow();
    expect(() => parse('first: &n 9007199254740993\nsecond: *n')).toThrow();
  });

  it('bounds original numeric scalar work without exponent-sized allocation', () => {
    expect(() => parse(`value: 1e-${'9'.repeat(1024)}`)).toThrow('Numeric scalar cannot be faithfully read');
    expect(() => parse(`value: !!int ${'0'.repeat(1025)}`)).toThrow('Numeric scalar cannot be faithfully read');
  });

  it('preserves pinned overflow resolution as a string and refuses an explicit invalid numeric tag', () => {
    expect(parse('value: 1e999').value).toBe('1e999');
    expect(() => parse('value: !!float 1e999')).toThrow();
  });

  it('does not change ordinary or maintenance safe-integer parsing', () => {
    expect(SecureYamlParser.parseRawYaml('value: 9007199254740993').value).toBe(9007199254740992);
    expect(() => SecureYamlParser.parseRawYaml('value: 0.5', {
      numericPolicy: 'safe-integers', contentPolicy: 'structure-only',
    })).toThrow('YAML numeric scalar must be a safe integer');
    expect(() => SecureYamlParser.parseRawYaml('value: 0.5', {
      numericPolicy: 'read-fidelity', schema: 'failsafe',
    })).toThrow('Unsupported YAML numeric policy');
  });

  it('checks only original JSON numeric tokens, preserving strings and native fraction/exponent values', () => {
    expect(() => assertJsonNumericReadFidelity('{"confidence":0.5000,"exponent":5e-1,"quoted":"9007199254740993","escaped":"\\\"123\\\""}')).not.toThrow();
    expect(() => assertJsonNumericReadFidelity('{"confidence":0.10000000000000001}')).toThrow();
    expect(() => assertJsonNumericReadFidelity('{"integer":9007199254740993}')).toThrow();
    expect(() => assertJsonNumericReadFidelity('{"zero":-0}')).toThrow();
  });
});
