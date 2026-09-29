import { describe, expect, it } from '@jest/globals';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import fastUri from 'fast-uri';

describe('fast-uri security override', () => {
  it('rejects an authority delimiter in a component port', () => {
    expect(() => fastUri.serialize({
      scheme: 'http', host: 'trusted.example', port: '@127.0.0.1:8124', path: '/app',
    })).toThrow('URI port is malformed.');
  });

  it('rejects an unbalanced bracket host instead of treating it as an HTTP destination', () => {
    const suspicious = 'http://user@[@127.0.0.1:8123/admin';
    expect(fastUri.parse(suspicious).error).toBe('URI host is malformed.');
    expect(fastUri.equal(suspicious, suspicious)).toBe(false);
  });

  it('keeps MCP SDK JSON Schema references and tool input validation working', () => {
    const validator = new AjvJsonSchemaValidator();
    const validate = validator.getValidator({
      $id: 'https://example.test/schemas/tool-input',
      type: 'object',
      $defs: { positive: { type: 'integer', minimum: 1 } },
      properties: { count: { $ref: '#/$defs/positive' } },
      required: ['count'],
      additionalProperties: false,
    });

    expect(validate({ count: 2 }).valid).toBe(true);
    expect(validate({ count: 0 }).valid).toBe(false);
    expect(validate({ count: '2' }).valid).toBe(false);
  });
});
