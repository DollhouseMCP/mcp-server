import { describe, it, expect } from '@jest/globals';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _preProcessSource: preProcessSource } = require('../../transforms/cjsCompat.cjs');

describe('cjsCompat preProcessSource', () => {
  describe('fileURLToPath(import.meta.url) replacement', () => {
    it('should replace fileURLToPath(import.meta.url) with __filename', () => {
      const input = `const __filename = fileURLToPath(import.meta.url);`;
      const result = preProcessSource(input);
      // After step 1: const __filename = __filename;
      // After step 3: eliminated as redundant
      expect(result).toBe('// [cjs-compat] __filename available in CJS');
    });

    it('should handle whitespace variations in fileURLToPath call', () => {
      const input = `const f = fileURLToPath( import.meta.url );`;
      const result = preProcessSource(input);
      expect(result).toBe('const f = __filename;');
    });
  });

  describe('bare import.meta.url replacement', () => {
    it('should replace bare import.meta.url with pathToFileURL expression', () => {
      const input = `const url = import.meta.url;`;
      const result = preProcessSource(input);
      expect(result).toBe('const url = require("url").pathToFileURL(__filename).href;');
    });

    it('should replace import.meta.url in comparisons', () => {
      const input = `if (import.meta.url === \`file://\${process.argv[1]}\`) {`;
      const result = preProcessSource(input);
      expect(result).toContain('require("url").pathToFileURL(__filename).href');
      expect(result).not.toContain('import.meta.url');
    });

    it('should replace multiple occurrences', () => {
      const input = `const a = import.meta.url;\nconst b = import.meta.url;`;
      const result = preProcessSource(input);
      expect(result).not.toContain('import.meta.url');
      const count = (result.match(/pathToFileURL/g) || []).length;
      expect(count).toBe(2);
    });
  });

  describe('redundant __filename elimination', () => {
    it('should eliminate const __filename = __filename after replacement', () => {
      const input = `const __filename = fileURLToPath(import.meta.url);\nconst __dirname = path.dirname(__filename);`;
      const result = preProcessSource(input);
      expect(result).toContain('// [cjs-compat] __filename available in CJS');
      expect(result).toContain('// [cjs-compat] __dirname available in CJS');
    });

    it('should preserve __filename inside function scopes', () => {
      // Inside a function, fileURLToPath(import.meta.url) → __filename is fine
      // because the const doesn't shadow the CJS global at module level
      const input = `  constructor() {\n    const __filename = fileURLToPath(import.meta.url);\n  }`;
      const result = preProcessSource(input);
      // Step 1 replaces fileURLToPath(import.meta.url) → __filename
      // Step 3 eliminates the redundant const __filename = __filename (even indented)
      expect(result).toContain('// [cjs-compat] __filename available in CJS');
    });
  });

  describe('redundant __dirname elimination', () => {
    it('should eliminate const __dirname = dirname(__filename)', () => {
      const input = `const __dirname = dirname(__filename);`;
      const result = preProcessSource(input);
      expect(result).toBe('// [cjs-compat] __dirname available in CJS');
    });

    it('should eliminate const __dirname = path.dirname(__filename)', () => {
      const input = `const __dirname = path.dirname(__filename);`;
      const result = preProcessSource(input);
      expect(result).toBe('// [cjs-compat] __dirname available in CJS');
    });

    it('should handle let and var declarations', () => {
      const input = `let __dirname = path.dirname(__filename);`;
      const result = preProcessSource(input);
      expect(result).toBe('// [cjs-compat] __dirname available in CJS');
    });
  });

  describe('top-level await import() conversion', () => {
    it('should convert single-line destructured import', () => {
      const input = `const { foo } = await import('./module.js');`;
      const result = preProcessSource(input);
      expect(result).toBe(`const { foo } = require('./module.js');`);
    });

    it('should convert single-line simple binding import', () => {
      const input = `const ConfigModule = await import('../config.js');`;
      const result = preProcessSource(input);
      expect(result).toBe(`const ConfigModule = require('../config.js');`);
    });

    it('should convert multi-line await import', () => {
      const input = [
        `const { evaluateAutonomy, wouldAutoApprove } = await import(`,
        `  '../../../../src/elements/agents/autonomyEvaluator.js'`,
        `);`,
      ].join('\n');
      const result = preProcessSource(input);
      expect(result).toBe(
        `const { evaluateAutonomy, wouldAutoApprove } = require('../../../../src/elements/agents/autonomyEvaluator.js');`
      );
    });

    it('should convert multiple top-level imports', () => {
      const input = [
        `const { foo } = await import('./foo.js');`,
        `const { bar } = await import('./bar.js');`,
      ].join('\n');
      const result = preProcessSource(input);
      expect(result).toContain(`require('./foo.js')`);
      expect(result).toContain(`require('./bar.js')`);
      expect(result).not.toContain('await');
    });

    it('should handle let declarations', () => {
      const input = `let mod = await import('./module.js');`;
      const result = preProcessSource(input);
      expect(result).toBe(`let mod = require('./module.js');`);
    });

    it('should not replace indented await import (inside function bodies)', () => {
      // Indented await import (inside async function) should be left alone —
      // the regex anchors to ^ so only unindented (top-level) lines match
      const input = `  const mod = await import('./module.js');`;
      const result = preProcessSource(input);
      expect(result).toBe(input);
    });
  });

  describe('combined patterns (real-world source)', () => {
    it('should handle a typical ESM file header', () => {
      const input = [
        `import { fileURLToPath } from 'url';`,
        `import path from 'path';`,
        ``,
        `const __filename = fileURLToPath(import.meta.url);`,
        `const __dirname = path.dirname(__filename);`,
        ``,
        `export class Foo {`,
        `  getDir() { return __dirname; }`,
        `}`,
      ].join('\n');
      const result = preProcessSource(input);

      // __filename and __dirname declarations should be eliminated
      expect(result).toContain('// [cjs-compat] __filename available in CJS');
      expect(result).toContain('// [cjs-compat] __dirname available in CJS');

      // Original imports and class body should be untouched
      expect(result).toContain(`import { fileURLToPath } from 'url';`);
      expect(result).toContain('export class Foo');
      expect(result).toContain('return __dirname');
    });

    it('should handle import.meta.url comparison pattern from migrate-legacy-memories', () => {
      const input = `if (import.meta.url === \`file://\${process.argv[1]}\`) {`;
      const result = preProcessSource(input);
      expect(result).toBe(
        'if (require("url").pathToFileURL(__filename).href === `file://${process.argv[1]}`) {'
      );
    });
  });

  describe('passthrough for unrelated code', () => {
    it('should not modify code without ESM patterns', () => {
      const input = `const x = 42;\nconsole.log(x);`;
      expect(preProcessSource(input)).toBe(input);
    });

    it('should not modify import.meta properties other than url', () => {
      // import.meta.resolve etc. should be left alone
      const input = `const resolved = import.meta.resolve('./foo');`;
      expect(preProcessSource(input)).toBe(input);
    });
  });
});
