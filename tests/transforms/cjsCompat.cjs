'use strict';

/**
 * CJS-compatible Jest transformer for running tests without --experimental-vm-modules.
 *
 * Pre-processes TypeScript source to replace `import.meta.url` with a CJS-compatible
 * expression BEFORE ts-jest compiles it, so TypeScript's CJS output mode works normally.
 *
 * Replacement strategy:
 *   - `fileURLToPath(import.meta.url)` → `__filename` (direct CJS equivalent)
 *   - bare `import.meta.url` → `require("url").pathToFileURL(__filename).href`
 *   - `const __filename = __filename` lines → eliminated (redundant in CJS)
 *   - `const __dirname = ...dirname(__filename)` → eliminated (redundant in CJS)
 *   - top-level `await import(...)` → `require(...)` (invalid in CJS)
 *
 * This allows `npx jest <path>` to work without the --experimental-vm-modules flag.
 */

const { TsJestTransformer } = require('ts-jest');
const crypto = require('crypto');

// Pattern: fileURLToPath(import.meta.url) → __filename (handles the common idiom directly)
const FILE_URL_TO_PATH_RE = /\bfileURLToPath\s*\(\s*import\.meta\.url\s*\)/g;

// Pattern: bare import.meta.url → CJS file URL equivalent
const IMPORT_META_URL_RE = /\bimport\.meta\.url\b/g;

// Pattern: const __filename = __filename (left over after fileURLToPath replacement)
const REDUNDANT_FILENAME_RE = /^\s*const __filename\s*=\s*__filename\s*;\s*$/gm;

// Pattern: const __dirname = path.dirname(__filename) or similar
const REDUNDANT_DIRNAME_RE = /^\s*(?:const|let|var) __dirname\s*=\s*(?:path\.dirname|dirname)\s*\(\s*__filename\s*\)\s*;\s*$/gm;

// Pattern: top-level `await import('...')` → `require('...')`
// Handles single-line and multi-line variants:
//   const { foo } = await import('module');
//   const { foo } = await import(
//     'module'
//   );
const TOP_LEVEL_AWAIT_IMPORT_RE = /^((?:const|let|var)\s+(?:\{[^}]*\}|[a-zA-Z_$]\w*)\s*=\s*)await\s+import\s*\(([\s\S]*?)\)\s*;/gm;

function preProcessSource(source) {
  let result = source;

  // Step 1: Replace fileURLToPath(import.meta.url) → __filename
  result = result.replace(FILE_URL_TO_PATH_RE, '__filename');

  // Step 2: Replace remaining bare import.meta.url → file URL from __filename
  result = result.replace(IMPORT_META_URL_RE, 'require("url").pathToFileURL(__filename).href');

  // Step 3: Eliminate `const __filename = __filename;` (redundant in CJS)
  result = result.replace(REDUNDANT_FILENAME_RE, '// [cjs-compat] __filename available in CJS');

  // Step 4: Eliminate `const __dirname = path.dirname(__filename);` (redundant in CJS)
  result = result.replace(REDUNDANT_DIRNAME_RE, '// [cjs-compat] __dirname available in CJS');

  // Step 5: Convert top-level `await import(...)` to `require(...)` for CJS compatibility.
  // Trims whitespace from the module path to handle multi-line imports cleanly.
  result = result.replace(TOP_LEVEL_AWAIT_IMPORT_RE, (_, prefix, modulePath) => {
    return `${prefix}require(${modulePath.trim()});`;
  });

  return result;
}

class CjsCompatTransformer extends TsJestTransformer {
  process(sourceText, sourcePath, options) {
    try {
      // Pre-process TypeScript source before ts-jest compilation
      const processed = preProcessSource(sourceText);
      return super.process(processed, sourcePath, options);
    } catch (error) {
      // If pre-processing breaks compilation, fall back to unmodified source
      // so the error message reflects the original code, not our transform
      console.warn(`[cjs-compat] Transform failed for ${sourcePath}: ${error.message}`);
      return super.process(sourceText, sourcePath, options);
    }
  }

  getCacheKey(sourceText, sourcePath, options) {
    const baseKey = super.getCacheKey(sourceText, sourcePath, options);
    // Append a suffix so CJS-mode cache entries never collide with ESM-mode entries
    return crypto.createHash('sha256').update(baseKey + ':cjs-compat-v4').digest('hex');
  }
}

module.exports = {
  createTransformer(tsJestConfig) {
    return new CjsCompatTransformer(tsJestConfig);
  },
  // Exported for unit testing
  _preProcessSource: preProcessSource,
};
