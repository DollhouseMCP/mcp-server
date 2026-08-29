import { fileURLToPath } from 'node:url';
import path from 'node:path';
import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslintPlugin from '@typescript-eslint/eslint-plugin';
import tseslintParser from '@typescript-eslint/parser';

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

// DMCP-PATH-001 (cycle 24): custom rule that flags absolute-path string
// literals passed to filesystem I/O calls. Implemented as an inline plugin
// because esquery's value-regex syntax doesn't escape forward-slashes
// cleanly inside selector strings — easier to validate at runtime here.
// Tests that intentionally pass absolute-path inputs (path-classification
// fixtures, cross-platform mock homedirs) are exempt by virtue of NOT being
// inside fs-IO calls; the rule only fires on the actual bug shape.
const FS_IO_CALLS = new Set([
  'readFileSync', 'writeFileSync', 'readFile', 'writeFile',
  'appendFile', 'appendFileSync', 'access', 'accessSync',
  'stat', 'statSync', 'mkdir', 'mkdirSync', 'unlink', 'unlinkSync',
  'open', 'openSync', 'rm', 'rmSync', 'rename', 'renameSync',
]);
const ABSOLUTE_PATH_RE = /^\/(?:mnt|home|Users|opt|var|etc|tmp)\//;
const dmcpPathPlugin = {
  rules: {
    'no-absolute-fs-io-paths': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          absolute:
            'DMCP-PATH-001: Hardcoded absolute path "{{value}}" passed to filesystem I/O. ' +
            'Use import.meta.url-relative resolution, path.join(os.homedir(), ...), or ' +
            'resolveDataDirectory() — never bake a developer-machine path into the codebase.',
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            let fnName = null;
            if (callee.type === 'Identifier') fnName = callee.name;
            else if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
              fnName = callee.property.name;
            }
            if (!fnName || !FS_IO_CALLS.has(fnName)) return;
            const firstArg = node.arguments[0];
            if (firstArg?.type === 'Literal' && typeof firstArg.value === 'string'
                && ABSOLUTE_PATH_RE.test(firstArg.value)) {
              context.report({ node: firstArg, messageId: 'absolute', data: { value: firstArg.value } });
            }
          },
        };
      },
    },
  },
};

// DMCP-DI-001: shared "Bastard Injection" restriction, spread into every
// scoped no-restricted-syntax block (flat-config rule values replace rather
// than merge, so each block must restate the selectors it keeps).
const BASTARD_INJECTION_RESTRICTION = {
  selector: 'AssignmentExpression > LogicalExpression[operator="??"] > NewExpression',
  message: 'Avoid "Bastard Injection" pattern (dependency ?? new Service()). Dependencies should be required and provided exclusively by the DI container. This pattern creates unmanaged instances that bypass the container.'
};

// DMCP-FO2-001: the raw integration execution authorities run without any
// policy check, so only the DI composition root (src/di/Container.ts) may
// construct them; everything else consumes the policy-authorized facades in
// src/web-console/modules/integrations/AuthorizedIntegrationGateway.ts.
// Tests may construct the raw classes (the base src+tests block deliberately
// omits these selectors).
const INTEGRATION_AUTHORITY_RESTRICTIONS = [
  'IntegrationRequestGateway',
  'IntegrationOperationCatalog',
  'IntegrationRemoteMcpBridge',
].map(name => ({
  selector: `NewExpression[callee.name='${name}']`,
  message: `DMCP-FO2-001: new ${name}() executes without policy gating. Only src/di/Container.ts may construct it; consume the Authorized* facade from modules/integrations instead.`,
}));

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'coverage-*/**',
      'tests/fixtures/**',
      'src/web-console/ui/vendor/**',
      'scripts/**/*.js',
      'scripts/**/*.cjs',
      'eslint.config.js',
      'jest*.cjs',
      // Auto-generated coverage reports
      'tests/coverage/**/*.js',
    ],
  },
  {
    files: ['src/web-console/ui/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        DOMPurify: 'readonly',
        jsyaml: 'readonly',
        marked: 'readonly',
      },
    },
    rules: {
      ...pluginJs.configs.recommended.rules,
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tseslintParser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir,
      },
      globals: {
        ...globals.node,
        ...globals.jest,
        NodeJS: 'readonly',
        BufferEncoding: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslintPlugin,
      'dmcp': dmcpPathPlugin,
    },
    rules: {
      ...pluginJs.configs.recommended.rules,
      ...tseslintPlugin.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-useless-escape': 'off',
      // DMCP-PATH-001 (cycle 24): catch hardcoded absolute paths in fs I/O calls.
      // Applies to all src/ and tests/ (the cycle-23 bug shape was in a test).
      'dmcp/no-absolute-fs-io-paths': 'error',
      // DMCP-DI-001: Prevent "Bastard Injection" anti-pattern.
      'no-restricted-syntax': ['error', BASTARD_INJECTION_RESTRICTION],
    },
  },
  // DMCP-FO2-001: raw integration authority construction is composition-root
  // only (see INTEGRATION_AUTHORITY_RESTRICTIONS above). Applies to src/**
  // except the DI container; tests are exempt via the base block. src/auth/**
  // and src/cli/** are excluded here only because the DMCP-ENV-001 block
  // below would clobber this rule for them — it restates the same selectors.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/di/Container.ts', 'src/auth/**/*.ts', 'src/cli/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        BASTARD_INJECTION_RESTRICTION,
        ...INTEGRATION_AUTHORITY_RESTRICTIONS,
      ],
    },
  },
  // DMCP-ENV-001 (cycle 24): Block raw `process.env.DOLLHOUSE_*` and
  // `process.env.GITHUB_TOKEN` reads in the OAuth domain (src/auth/** + src/cli/**).
  //
  // Scope rationale:
  //   - src/auth/** + src/cli/** : 'error' — these paths were swept clean by
  //     cycles 19/21/23. Regressions here are the recurring drift class the
  //     rule exists to catch and MUST fail CI.
  //   - rest of src/** : raw env reads are pre-existing and out of scope for
  //     §8.1. Tracked as future env-routing-sweep PR.
  //   - tests/** : `process.env` mutation is a legitimate test fixture pattern;
  //     this rule does not apply.
  //   - src/config/env.ts + src/utils/logger.ts : own the schema / run before
  //     schema parse completes; documented exemptions via inline comments.
  //
  // Per-site exceptions in this scope: add
  //   // eslint-disable-next-line no-restricted-syntax -- DMCP-ENV-001 documented exception: <reason>
  // immediately above the offending line. The rationale becomes part of the diff.
  {
    files: ['src/auth/**/*.ts', 'src/cli/**/*.ts'],
    ignores: ['src/config/env.ts', 'src/utils/logger.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        BASTARD_INJECTION_RESTRICTION,
        ...INTEGRATION_AUTHORITY_RESTRICTIONS,
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][property.name=/^DOLLHOUSE_/]",
          message: 'DMCP-ENV-001: Read DOLLHOUSE_* env vars through `env.X` (src/config/env.ts), not raw `process.env`. The Zod schema validates types and catches misspellings at config load. Add a schema entry and import `env` from `config/env.js`.'
        },
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][property.name='GITHUB_TOKEN']",
          message: 'DMCP-ENV-001: Read GITHUB_TOKEN through `env.GITHUB_TOKEN` (src/config/env.ts), not raw process.env.'
        },
      ],
    },
  },
  // Scripts directory - uses separate tsconfig for type-checking
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      parser: tseslintParser,
      parserOptions: {
        project: './tsconfig.scripts.json',
        tsconfigRootDir,
      },
      globals: {
        ...globals.node,
        NodeJS: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslintPlugin,
    },
    rules: {
      ...pluginJs.configs.recommended.rules,
      ...tseslintPlugin.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-useless-escape': 'off',
    },
  },
];
