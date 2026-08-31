import { describe, expect, it } from '@jest/globals';
import { Linter } from 'eslint';
import { fileURLToPath } from 'node:url';

import eslintConfig, { dmcpPathPlugin } from '../../eslint.config.js';

const SERVICE_CONFIG_FIXTURE_PATH = fileURLToPath(
  new URL('../../src/services/BuildInfoService.ts', import.meta.url),
);
const AUTH_CONFIG_FIXTURE_PATH = fileURLToPath(
  new URL('../../src/auth/GitHubAuthManager.ts', import.meta.url),
);
const CLI_CONFIG_FIXTURE_PATH = fileURLToPath(
  new URL('../../src/cli/console-token.ts', import.meta.url),
);
const OAUTH_CONFIG_FIXTURE_PATHS = [AUTH_CONFIG_FIXTURE_PATH, CLI_CONFIG_FIXTURE_PATH];

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

function verifyConfigured(code: string, filename: string) {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(code, eslintConfig, { filename });
}

function messagesContaining(code: string, filename: string, marker: string) {
  return verifyConfigured(code, filename).filter(message => message.message.includes(marker));
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

  describe('DMCP-DI-001', () => {
    it('detects fallback construction and accepts required injection', () => {
      const rejected = verifyConfigured(
        'class Service {}\nlet dependency; dependency = dependency ?? new Service();',
        SERVICE_CONFIG_FIXTURE_PATH,
      );
      const accepted = messagesContaining(
        'class Consumer { constructor(dependency) { this.dependency = dependency; } }',
        SERVICE_CONFIG_FIXTURE_PATH,
        'Bastard Injection',
      );

      expect(rejected.filter(message => message.message.includes('Bastard Injection')).map(message => message.message)).toEqual([
        expect.stringContaining('Bastard Injection'),
      ]);
      expect(accepted).toHaveLength(0);
    });
  });

  describe('DMCP-ENV-001', () => {
    it.each(OAUTH_CONFIG_FIXTURE_PATHS)(
      'detects raw Dollhouse and GitHub env reads in %s',
      filename => {
        const messages = verifyConfigured(
          'const enabled = process.env.DOLLHOUSE_FEATURE; const token = process.env.GITHUB_TOKEN;',
          filename,
        );

        expect(messages.filter(message => message.message.includes('DMCP-ENV-001')).map(message => message.message)).toEqual([
          expect.stringContaining('DMCP-ENV-001'),
          expect.stringContaining('DMCP-ENV-001'),
        ]);
      },
    );

    it.each(OAUTH_CONFIG_FIXTURE_PATHS)(
      'accepts schema-routed env reads in %s',
      filename => {
        const messages = messagesContaining(
          "import { env } from '../config/env.js'; const enabled = env.DOLLHOUSE_FEATURE; const token = env.GITHUB_TOKEN;",
          filename,
          'DMCP-ENV-001',
        );

        expect(messages).toHaveLength(0);
      },
    );
  });

  describe('DMCP-PATH-001', () => {
    it('detects hardcoded absolute filesystem I/O paths', () => {
      const messages = verifyConfigured(
        "import fs from 'node:fs'; fs.readFileSync('/tmp/private.json', 'utf8');",
        SERVICE_CONFIG_FIXTURE_PATH,
      );

      const pathMessages = messages.filter(message => message.ruleId === 'dmcp/no-absolute-fs-io-paths');
      expect(pathMessages.map(message => message.messageId)).toEqual(['absolute']);
      expect(pathMessages.map(message => message.ruleId)).toEqual(['dmcp/no-absolute-fs-io-paths']);
    });

    it('accepts resolved filesystem I/O paths', () => {
      const messages = verifyConfigured(
        "import fs from 'node:fs'; import path from 'node:path'; fs.readFileSync(path.resolve('data', 'private.json'), 'utf8');",
        SERVICE_CONFIG_FIXTURE_PATH,
      ).filter(message => message.ruleId === 'dmcp/no-absolute-fs-io-paths');

      expect(messages).toHaveLength(0);
    });
  });

  describe('DMCP-FO2-001', () => {
    it.each(OAUTH_CONFIG_FIXTURE_PATHS)(
      'preserves raw integration-authority restrictions in %s',
      filename => {
        const messages = verifyConfigured(
          'new IntegrationRequestGateway(); new IntegrationOperationCatalog(); new IntegrationRemoteMcpBridge();',
          filename,
        );

        expect(messages.filter(message => message.message.includes('DMCP-FO2-001')).map(message => message.message)).toEqual([
          expect.stringContaining('DMCP-FO2-001'),
          expect.stringContaining('DMCP-FO2-001'),
          expect.stringContaining('DMCP-FO2-001'),
        ]);
      },
    );

    it.each(OAUTH_CONFIG_FIXTURE_PATHS)(
      'accepts authorized integration facades in %s',
      filename => {
        const messages = messagesContaining(
          'new AuthorizedIntegrationGateway(); new AuthorizedIntegrationRemoteMcpBridge();',
          filename,
          'DMCP-FO2-001',
        );

        expect(messages).toHaveLength(0);
      },
    );
  });
});
