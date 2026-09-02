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

// DMCP-XPLAT-00x: catch portability defects that otherwise surface only on
// the GitHub Windows/macOS matrix. Runtime-specific behavior still requires
// the real runners; these checks cover only statically recognizable shapes.
const SPAWN_CALLS = new Set([
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync',
]);
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const PATH_MODULES = new Set(['path', 'node:path']);
const POSIX_INTERPRETER_RE = /^\/(?:bin|usr\/bin|usr\/local\/bin)\/(?:bash|sh|zsh|dash|env|node|python3?)$/;
const POSIX_ABSOLUTE_LITERAL_RE = /^\/[^/]/;

export const dmcpPathPlugin = {
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
    // DMCP-XPLAT-001: absolute POSIX interpreter paths do not exist on native
    // Windows. Tracking imports avoids flagging unrelated local functions
    // that happen to be named spawn/exec.
    'no-posix-interpreter-path': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          posixInterpreter:
            'DMCP-XPLAT-001: "{{value}}" is a POSIX-only interpreter path used as a process command. ' +
            'Guard it with process.platform or resolve the interpreter by name so PATH lookup applies.',
        },
      },
      create(context) {
        const directCalls = new Set();
        const namespaces = new Set();
        return {
          ImportDeclaration(node) {
            if (!CHILD_PROCESS_MODULES.has(node.source.value)) return;
            for (const specifier of node.specifiers) {
              if (specifier.type === 'ImportSpecifier'
                  && specifier.imported.type === 'Identifier'
                  && SPAWN_CALLS.has(specifier.imported.name)) {
                directCalls.add(specifier.local.name);
              } else if (specifier.type === 'ImportDefaultSpecifier'
                  || specifier.type === 'ImportNamespaceSpecifier') {
                namespaces.add(specifier.local.name);
              }
            }
          },
          CallExpression(node) {
            const callee = node.callee;
            const isDirectCall = callee.type === 'Identifier' && directCalls.has(callee.name);
            const isNamespaceCall = callee.type === 'MemberExpression'
              && callee.object.type === 'Identifier'
              && namespaces.has(callee.object.name)
              && callee.property.type === 'Identifier'
              && SPAWN_CALLS.has(callee.property.name);
            if (!isDirectCall && !isNamespaceCall) return;
            const first = node.arguments[0];
            if (first?.type === 'Literal' && typeof first.value === 'string'
                && POSIX_INTERPRETER_RE.test(first.value)) {
              context.report({ node: first, messageId: 'posixInterpreter', data: { value: first.value } });
            }
          },
        };
      },
    },
    // DMCP-XPLAT-002: Windows uses ';', not ':', as its PATH delimiter.
    'no-literal-path-delimiter': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          literalDelimiter:
            'DMCP-XPLAT-002: PATH is built with a literal ":" delimiter. Use path.delimiter.',
        },
      },
      create(context) {
        return {
          Property(node) {
            const key = node.key;
            let keyName = null;
            if (key?.type === 'Identifier') {
              keyName = key.name;
            } else if (key?.type === 'Literal') {
              keyName = key.value;
            }
            if (keyName !== 'PATH') return;
            const value = node.value;
            if (value?.type === 'TemplateLiteral'
                && value.quasis.some(quasi => quasi.value.raw.includes(':'))) {
              context.report({ node: value, messageId: 'literalDelimiter' });
            }
          },
        };
      },
    },
    // DMCP-XPLAT-003: a POSIX-rooted literal passed to path.join() becomes
    // current-drive-rooted on Windows. path.resolve() supplies the intended
    // platform-specific absolute anchoring.
    'prefer-resolve-for-absolute-join': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          absoluteJoin:
            'DMCP-XPLAT-003: path.join("{{value}}", ...) is not drive-anchored on Windows. ' +
            'Use path.resolve() when the first segment is intended to be an absolute filesystem path.',
        },
      },
      create(context) {
        const pathBindings = new Set();
        return {
          ImportDeclaration(node) {
            if (!PATH_MODULES.has(node.source.value)) return;
            for (const specifier of node.specifiers) {
              if (specifier.type === 'ImportDefaultSpecifier'
                  || specifier.type === 'ImportNamespaceSpecifier') {
                pathBindings.add(specifier.local.name);
              }
            }
          },
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== 'MemberExpression'
                || callee.property?.type !== 'Identifier'
                || callee.property.name !== 'join') return;
            const object = callee.object;
            if (object.type !== 'Identifier' || !pathBindings.has(object.name)) return;
            const first = node.arguments[0];
            if (first?.type === 'Literal' && typeof first.value === 'string'
                && POSIX_ABSOLUTE_LITERAL_RE.test(first.value)) {
              context.report({ node: first, messageId: 'absoluteJoin', data: { value: first.value } });
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
      'dmcp/no-posix-interpreter-path': 'error',
      'dmcp/no-literal-path-delimiter': 'error',
      'dmcp/prefer-resolve-for-absolute-join': 'error',
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
      'dmcp/no-absolute-fs-io-paths': 'error',
      'dmcp/no-posix-interpreter-path': 'error',
      'dmcp/no-literal-path-delimiter': 'error',
      'dmcp/prefer-resolve-for-absolute-join': 'error',
    },
  },
];
