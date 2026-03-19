/**
 * Bundled Template Validation Gate (Issue #720)
 *
 * Validates that all bundled data/templates/*.md files conform to the
 * template engine's supported syntax:
 * - Variable declarations must be arrays (not maps)
 * - Template bodies must use only {{variable_name}} substitution
 * - No Handlebars block helpers ({{#...}}, {{/...}}, {{else}})
 *
 * This test runs in CI via `npm test` and prevents regressions.
 *
 * @see docs/reference/element-format-guide.md — Template Syntax and Pre-Formatted String Pattern
 * @see src/handlers/mcp-aql/IntrospectionResolver.ts — FORMAT_SPECS template syntaxNotes
 */

import * as fs from 'fs';
import * as path from 'path';
import { FrontmatterParser } from '../../../src/storage/FrontmatterParser.js';

const TEMPLATES_DIR = path.resolve(process.cwd(), 'data/templates');

// Discover all template files
const templateFiles = fs.readdirSync(TEMPLATES_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => ({
    filename: f,
    filepath: path.join(TEMPLATES_DIR, f),
  }));

// Pre-parse all templates
const templates = templateFiles.map(({ filename, filepath }) => {
  const raw = fs.readFileSync(filepath, 'utf-8');
  const metadata = FrontmatterParser.extractMetadata(raw);
  // Extract body (content after second ---)
  const parts = raw.split(/^---\s*$/m);
  const body = parts.length >= 3 ? parts.slice(2).join('---') : '';
  return { filename, metadata, body };
});

const templateEntries = templates.map(t => [t.filename, t] as const);

describe('Bundled Template Validation (Issue #720)', () => {
  describe('Template count', () => {
    it('should find at least one template file', () => {
      expect(templateFiles.length).toBeGreaterThan(0);
    });
  });

  describe('Required metadata', () => {
    it.each(templateEntries)(
      '%s has a non-empty name',
      (_filename, template) => {
        expect(template.metadata.name).toBeTruthy();
        expect(template.metadata.name).not.toBe('unnamed');
      }
    );

    it.each(templateEntries)(
      '%s has a non-empty description',
      (_filename, template) => {
        expect(template.metadata.description).toBeTruthy();
        expect(template.metadata.description.length).toBeGreaterThan(0);
      }
    );
  });

  describe('Variable declarations use array format', () => {
    it.each(templateEntries)(
      '%s variables are either undefined or an array (not a map)',
      (_filename, template) => {
        const vars = template.metadata.variables;
        if (vars !== undefined) {
          expect(Array.isArray(vars)).toBe(true);
        }
      }
    );

    it.each(templateEntries)(
      '%s variable entries each have name and type',
      (_filename, template) => {
        const vars = template.metadata.variables;
        if (Array.isArray(vars)) {
          for (const v of vars) {
            expect(v).toHaveProperty('name');
            expect(typeof v.name).toBe('string');
            expect(v).toHaveProperty('type');
            expect(typeof v.type).toBe('string');
          }
        }
      }
    );
  });

  describe('No unsupported Handlebars syntax', () => {
    it.each(templateEntries)(
      '%s body contains no {{# block helpers',
      (_filename, template) => {
        expect(template.body).not.toMatch(/\{\{#/);
      }
    );

    it.each(templateEntries)(
      '%s body contains no {{/ closing tags',
      (_filename, template) => {
        expect(template.body).not.toMatch(/\{\{\//);
      }
    );

    it.each(templateEntries)(
      '%s body contains no {{else}}',
      (_filename, template) => {
        expect(template.body).not.toMatch(/\{\{else\}\}/);
      }
    );
  });

  describe('Frontmatter robustness', () => {
    it.each(templateEntries)(
      '%s has well-formed frontmatter (type field is "template")',
      (_filename, template) => {
        expect(template.metadata.type).toBe('template');
      }
    );

    it.each(templateEntries)(
      '%s has version 2.0.0 (post-Handlebars cleanup)',
      (_filename, template) => {
        expect(template.metadata.version).toBe('2.0.0');
      }
    );

    it.each(templateEntries)(
      '%s has no migration artifacts (outputFormats, includes, suite, migrated)',
      (_filename, template) => {
        expect(template.metadata).not.toHaveProperty('outputFormats');
        expect(template.metadata).not.toHaveProperty('includes');
        expect(template.metadata).not.toHaveProperty('suite');
        expect(template.metadata).not.toHaveProperty('migrated');
        expect(template.metadata).not.toHaveProperty('originalPath');
      }
    );
  });
});
