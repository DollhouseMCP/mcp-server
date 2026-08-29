import { describe, expect, it } from '@jest/globals';
import { parse, quote } from 'shell-quote';

describe('shell-quote compatibility for MCP Inspector', () => {
  it('parses a command with no arguments', () => {
    expect(parse('node')).toEqual(['node']);
  });

  it.each([
    {
      command: 'node dist/index.js --transport stdio',
      expected: ['node', 'dist/index.js', '--transport', 'stdio'],
    },
    {
      command: 'node "dist/server entry.js" --label "Dollhouse MCP"',
      expected: ['node', 'dist/server entry.js', '--label', 'Dollhouse MCP'],
    },
    {
      command: "node dist/index.js --env 'value with spaces'",
      expected: ['node', 'dist/index.js', '--env', 'value with spaces'],
    },
  ])('parses an Inspector-style command: $command', ({ command, expected }) => {
    expect(parse(command)).toEqual(expected);
  });

  it('preserves arguments through a quote and parse round trip', () => {
    const args = [
      'node',
      'dist/server entry.js',
      '--label',
      "Dollhouse MCP's hosted server",
      '--empty',
      '',
    ];

    expect(parse(quote(args))).toEqual(args);
  });

  it('retains the established environment substitution behavior', () => {
    expect(parse('node $ENTRY --label "$LABEL"', {
      ENTRY: 'dist/index.js',
      LABEL: 'Dollhouse MCP',
    })).toEqual(['node', 'dist/index.js', '--label', 'Dollhouse MCP']);
  });
});
