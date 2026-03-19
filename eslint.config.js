import { fileURLToPath } from 'node:url';
import path from 'node:path';
import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslintPlugin from '@typescript-eslint/eslint-plugin';
import tseslintParser from '@typescript-eslint/parser';

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'coverage-*/**',
      'tests/fixtures/**',
      'scripts/**/*.js',
      'scripts/**/*.cjs',
      'eslint.config.js',
      'jest*.cjs',
      // Auto-generated coverage reports
      'tests/coverage/**/*.js',
    ],
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
      // DMCP-DI-001: Prevent "Bastard Injection" anti-pattern
      // Dependencies should be provided by DI container, not defaulted with new instances
      'no-restricted-syntax': ['error', {
        selector: 'AssignmentExpression > LogicalExpression[operator="??"] > NewExpression',
        message: 'Avoid "Bastard Injection" pattern (dependency ?? new Service()). Dependencies should be required and provided exclusively by the DI container. This pattern creates unmanaged instances that bypass the container.'
      }],
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
