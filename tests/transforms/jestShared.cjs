/**
 * Shared Jest configuration utilities.
 *
 * Centralizes the ESM/CJS dual-mode detection, transform setup, and
 * workspace package mapping that both jest.config.cjs and
 * jest.integration.config.cjs need.
 */
const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.resolve(__dirname, '../..');
const TESTS_DIR = __dirname;

// ---------------------------------------------------------------------------
// ESM detection
// ---------------------------------------------------------------------------

/**
 * True when --experimental-vm-modules is active (ESM mode).
 * When false, configs use CJS fallback transforms via cjsCompat.cjs
 * so that `npx jest` works without the flag.
 * @type {boolean}
 */
const hasVMModules = (
  (process.env.NODE_OPTIONS || '').includes('--experimental-vm-modules') ||
  process.execArgv.some(arg => arg.includes('--experimental-vm-modules'))
);

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Module-name mapper shared by all Jest projects (maps .js imports → .ts).
 * @type {Record<string, string>}
 */
const MODULE_NAME_MAPPER = {
  '^(\\.{1,2}/(?:[^/]+/)*src/.*)\\.js$': '$1.ts',
  '^(\\.{1,2}/(?:[^/]+/)*tests/.*)\\.js$': '$1.ts',
  '^(\\.{1,2}/(?:[^/]+/)*integration/.*)\\.js$': '$1.ts'
};

const packagesDir = path.join(ROOT_DIR, 'packages');
if (fs.existsSync(packagesDir)) {
  for (const pkg of fs.readdirSync(packagesDir)) {
    const pkgJsonPath = path.join(packagesDir, pkg, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      continue;
    }

    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (pkgJson.name && pkgJson.type === 'module') {
        MODULE_NAME_MAPPER[`^${pkgJson.name}$`] =
          `<rootDir>/packages/${pkg}/src/index.ts`;
      }
    } catch (err) {
      console.warn(`[jestShared] skipping malformed package.json: ${pkgJsonPath}`);
    }
  }
}

/** Default ESM-mode transformIgnorePatterns (both configs).
 * @type {string[]}
 */
const ESM_TRANSFORM_IGNORE = [
  'node_modules/(?!(@modelcontextprotocol|zod)/)'
];

/** Expanded CJS-mode transformIgnorePatterns (allows processing ESM-only deps).
 * @type {string[]}
 */
const CJS_TRANSFORM_IGNORE = [
  'node_modules/(?!(@modelcontextprotocol|zod|@dollhousemcp|chalk|#ansi-styles|ansi-styles)/)'
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply ESM-mode settings to a Jest config.
 *
 * Configures ts-jest's ESM preset so that Jest runs TypeScript sources
 * natively via `--experimental-vm-modules`.
 *
 * @param {import('jest').Config} config - Jest config object to mutate
 * @param {string | Record<string, unknown>} tsconfig - path to tsconfig.json
 *   or an inline tsconfig object (e.g. `{ module: 'esnext' }`)
 * @returns {void}
 */
function applyEsmMode(config, tsconfig) {
  config.preset = 'ts-jest/presets/default-esm';
  config.extensionsToTreatAsEsm = ['.ts'];
  config.transform = {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig
    }]
  };
}

/**
 * Apply CJS-fallback settings to a Jest config.
 *
 * Used when `--experimental-vm-modules` is absent so that `npx jest`
 * works out of the box. Mutates the config in place:
 *
 * - Installs the cjsCompat transformer for .ts and .js files
 * - Auto-maps ESM-only workspace packages to their dist entry points
 * - Sets expanded transformIgnorePatterns for ESM-only node_modules
 *
 * @param {import('jest').Config} config - Jest config object to mutate.
 *   Must already have a `moduleNameMapper` object (spread from MODULE_NAME_MAPPER).
 * @returns {void}
 */
function applyCjsFallback(config) {
  config.extensionsToTreatAsEsm = [];

  const cjsTransformOpts = [path.join(TESTS_DIR, 'cjsCompat.cjs'), {
    tsconfig: {
      allowJs: true,
      rootDir: '.',
      isolatedModules: true,
      module: 'commonjs',
      moduleResolution: 'node',
      esModuleInterop: true
    }
  }];

  config.transform = {
    '^.+\\.tsx?$': cjsTransformOpts,
    '^.+\\.js$': cjsTransformOpts
  };

  // Auto-map ESM-only workspace packages to their dist entry points for CJS resolution.
  // These packages use "type": "module" with import-only exports, which CJS can't resolve.
  if (fs.existsSync(packagesDir)) {
    for (const pkg of fs.readdirSync(packagesDir)) {
      const pkgJsonPath = path.join(packagesDir, pkg, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          if (pkgJson.type === 'module' && pkgJson.main) {
            config.moduleNameMapper[`^${pkgJson.name}$`] =
              `<rootDir>/packages/${pkg}/${pkgJson.main}`;
          }
        } catch (err) {
          // Skip malformed package.json files — don't break Jest startup
          console.warn(`[jestShared] skipping malformed package.json: ${pkgJsonPath}`);
        }
      }
    }
  }

  config.transformIgnorePatterns = CJS_TRANSFORM_IGNORE;
}

module.exports = {
  hasVMModules,
  ROOT_DIR,
  MODULE_NAME_MAPPER,
  ESM_TRANSFORM_IGNORE,
  CJS_TRANSFORM_IGNORE,
  applyEsmMode,
  applyCjsFallback
};
