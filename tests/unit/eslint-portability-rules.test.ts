import { describe, expect, it } from '@jest/globals';
import { Linter } from 'eslint';

import { dmcpPathPlugin } from '../../eslint.config.js';

type PortabilityRule =
  | 'no-posix-interpreter-path'
  | 'no-literal-path-delimiter'
  | 'prefer-resolve-for-absolute-join';

function verify(code: string, rule: PortabilityRule) {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { dmcp: dmcpPathPlugin },
    rules: { [`dmcp/${rule}`]: 'error' },
  });
}

describe('DMCP cross-platform ESLint rules', () => {
  describe('DMCP-XPLAT-001', () => {
    it('detects named and namespace child-process imports, including aliases', () => {
      const messages = verify(`
        import childProcess, { spawn as run } from 'node:child_process';
        run('/bin/bash', ['-lc', 'true']);
        childProcess.execFile('/usr/bin/python3', ['script.py']);
      `, 'no-posix-interpreter-path');

      expect(messages.map(message => message.messageId)).toEqual([
        'posixInterpreter',
        'posixInterpreter',
      ]);
    });

    it('accepts PATH lookup, platform-selected variables, and unrelated local methods', () => {
      const messages = verify(`
        import { spawn } from 'node:child_process';
        const shell = process.platform === 'win32' ? 'bash' : '/bin/bash';
        spawn(shell, ['-lc', 'true']);
        const runner = { execFile() {} };
        runner.execFile('/bin/bash');
      `, 'no-posix-interpreter-path');

      expect(messages).toHaveLength(0);
    });
  });

  describe('DMCP-XPLAT-002', () => {
    it('detects a literal colon used to assemble PATH', () => {
      const messages = verify(
        'const env = { PATH: `${bin}:${process.env.PATH}` };',
        'no-literal-path-delimiter',
      );

      expect(messages.map(message => message.messageId)).toEqual(['literalDelimiter']);
    });

    it('accepts path.delimiter and colons outside PATH properties', () => {
      const messages = verify(`
        import path from 'node:path';
        const env = { PATH: ` + "`${bin}${path.delimiter}${process.env.PATH}`" + ` };
        const endpoint = { URL: 'https://example.com' };
      `, 'no-literal-path-delimiter');

      expect(messages).toHaveLength(0);
    });
  });

  describe('DMCP-XPLAT-003', () => {
    it('detects path.join through default and namespace import aliases', () => {
      const messages = verify(`
        import path from 'node:path';
        import * as nodePath from 'path';
        path.join('/tmp', 'cache');
        nodePath.join('/var', 'state');
      `, 'prefer-resolve-for-absolute-join');

      expect(messages.map(message => message.messageId)).toEqual([
        'absoluteJoin',
        'absoluteJoin',
      ]);
    });

    it('accepts resolve, relative joins, and unrelated objects named path', () => {
      const messages = verify(`
        import nodePath from 'node:path';
        nodePath.resolve('/tmp', 'cache');
        nodePath.join('tmp', 'cache');
        const path = { join() {} };
        path.join('/tmp', 'cache');
      `, 'prefer-resolve-for-absolute-join');

      expect(messages).toHaveLength(0);
    });
  });
});
