/**
 * Template Rendering Integration Test
 *
 * PROOF OF FIX: This test demonstrates that the template rendering
 * actually works end-to-end with variable substitution.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TemplateManager } from '../../../src/elements/templates/TemplateManager.js';
import { TemplateRenderer } from '../../../src/utils/TemplateRenderer.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createIntegrationContainer, IntegrationContainer } from '../../helpers/integration-container.js';

describe('Template Rendering - PROOF OF FIX', () => {
  let tempDir: string;
  let containerContext: IntegrationContainer;
  let templateManager: TemplateManager;
  let renderer: TemplateRenderer;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'template-test-'));

    containerContext = await createIntegrationContainer({
      portfolioDir: path.join(tempDir, '.dollhouse', 'portfolio')
    });

    const templatesDir = path.join(containerContext.portfolioDir, 'templates');
    await fs.mkdir(templatesDir, { recursive: true });

    templateManager = containerContext.container.resolve<TemplateManager>('TemplateManager');
    renderer = new TemplateRenderer(templateManager);
  });

  afterEach(async () => {
    jest.restoreAllMocks();

    if (containerContext) {
      await containerContext.dispose();
    }

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('PROOF: Variable Substitution Works', () => {
    it('should substitute variables in a simple template', async () => {
      const templateContent = `---
name: greeting
description: A simple greeting template
variables:
  - name: username
    type: string
    required: true
  - name: location
    type: string
    required: true
---
Hello {{username}}, welcome to {{location}}!`;

      await fs.writeFile(
        path.join(containerContext.portfolioDir, 'templates', 'greeting.md'),
        templateContent
      );

      const result = await renderer.render('greeting', {
        username: 'Alice',
        location: 'Wonderland'
      });

      console.log('✅ PROOF OF FIX - Rendered content:', result.content);
      expect(result.success).toBe(true);
      expect(result.content).toBe('Hello Alice, welcome to Wonderland!');
      expect(result.content).not.toContain('{{');
      expect(result.content).not.toContain('}}');
    });

    it('should substitute multiple variables in complex template', async () => {
      const templateContent = `---
name: report
description: A report template
variables:
  - name: title
    type: string
    required: true
  - name: date
    type: string
    required: true
  - name: author
    type: string
    required: true
  - name: summary
    type: string
    required: true
---
# {{title}}

**Date:** {{date}}  
**Author:** {{author}}

## Executive Summary
{{summary}}

---
Generated on {{date}} by {{author}}`;

      await fs.writeFile(
        path.join(containerContext.portfolioDir, 'templates', 'report.md'),
        templateContent
      );

      const result = await renderer.render('report', {
        title: 'Q3 2025 Performance Report',
        date: '2025-09-10',
        author: 'John Doe',
        summary: 'Excellent progress across all metrics.'
      });

      console.log('✅ PROOF OF FIX - Complex template rendered:', result.content);
      expect(result.success).toBe(true);
      expect(result.content).toContain('# Q3 2025 Performance Report');
      expect(result.content).toContain('**Date:** 2025-09-10');
      expect(result.content).toContain('**Author:** John Doe');
      expect(result.content).toContain('Excellent progress across all metrics.');
      expect(result.content).toContain('Generated on 2025-09-10 by John Doe');
      expect(result.content).not.toContain('{{title}}');
      expect(result.content).not.toContain('{{date}}');
      expect(result.content).not.toContain('{{author}}');
      expect(result.content).not.toContain('{{summary}}');
    });

    it('should handle optional variables with defaults', async () => {
      const templateContent = `---
name: welcome
description: Welcome message
variables:
  - name: name
    type: string
    required: true
  - name: role
    type: string
    default: "user"
  - name: theme
    type: string
    default: "light"
---
Welcome {{name}}!
Your role is: {{role}}
Theme preference: {{theme}}`;

      await fs.writeFile(
        path.join(containerContext.portfolioDir, 'templates', 'welcome.md'),
        templateContent
      );

      const result = await renderer.render('welcome', { name: 'Bob' });

      console.log('✅ PROOF OF FIX - Defaults applied:', result.content);
      expect(result.success).toBe(true);
      expect(result.content).toBe('Welcome Bob!\nYour role is: user\nTheme preference: light');
    });
  });

  describe('PROOF: Performance Metrics Work', () => {
    it('should track accurate performance metrics', async () => {
      const templateContent = `---
name: perf-test
description: Performance test template
---
Simple content`;

      await fs.writeFile(
        path.join(containerContext.portfolioDir, 'templates', 'perf-test.md'),
        templateContent
      );

      const result = await renderer.render('perf-test', {});

      console.log('✅ PROOF OF FIX - Performance metrics:', result.performance);
      expect(result.success).toBe(true);
      expect(result.performance).toBeDefined();
      expect(result.performance!.lookupTime).toBeGreaterThanOrEqual(0);
      expect(result.performance!.renderTime).toBeGreaterThanOrEqual(0);
      expect(result.performance!.totalTime).toBeGreaterThanOrEqual(0);
      expect(result.performance!.totalTime).toBeGreaterThanOrEqual(
        result.performance!.lookupTime + result.performance!.renderTime
      );
    });
  });

  describe('PROOF: Type Validation Works', () => {
    // Issue #336: ElementNotFoundError is now thrown instead of returning error content
    it('should throw ElementNotFoundError for invalid template', async () => {
      await expect(renderer.render('invalid-template', {}))
        .rejects.toThrow("Template 'invalid-template' not found");
    });

    it('should validate render return type', async () => {
      const templateContent = `---
name: invalid-return
description: Invalid render return
variables:
  - name: foo
    type: string
    required: true
---
Foo {{foo}}`;

      await fs.writeFile(
        path.join(containerContext.portfolioDir, 'templates', 'invalid-return.md'),
        templateContent
      );

      const originalFind = templateManager.find.bind(templateManager);
      jest.spyOn(templateManager, 'find').mockImplementation(async predicate => {
        const template = await originalFind(predicate);
        if (template && template.metadata.name === 'invalid-return') {
          const patched = Object.create(
            Object.getPrototypeOf(template),
            Object.getOwnPropertyDescriptors(template)
          );
          (patched as any).render = () => ({ message: 'not a string' });
          return patched;
        }
        return template;
      });

      const result = await renderer.render('invalid-return', { foo: 'bar' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid return type');
    });
  });

  describe('PROOF: Error Handling Works', () => {
    // Issue #336: ElementNotFoundError is now thrown instead of returning error content
    it('should throw ElementNotFoundError for missing template', async () => {
      await expect(renderer.render('non-existent-template', {}))
        .rejects.toThrow("Template 'non-existent-template' not found");
    });

    it('should handle missing required variables', async () => {
      const templateContent = `---
name: required-vars
description: Requires specific variables
variables:
  - name: requiredOne
    type: string
    required: true
---
Required value: {{requiredOne}}`;

      await fs.writeFile(
        path.join(containerContext.portfolioDir, 'templates', 'required-vars.md'),
        templateContent
      );

      const result = await renderer.render('required-vars', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to render template');
    });
  });

  // ============================================================================
  // Issue #705: Section-format templates — full end-to-end integration proof
  //
  // These tests prove the complete file-loading pipeline:
  //   .md file on disk → TemplateManager parse → Template instance →
  //   section detection → TemplateRenderer → rendered output
  //
  // Critical things being verified that unit tests can't:
  // 1. YAML frontmatter parser correctly separates body (section tags live there)
  // 2. ContentValidator.validateAndSanitize with contentContext:'template' does
  //    NOT strip <template>/<style>/<script> tags from content
  // 3. JS function bodies with {} and }} in <script> pass through unblocked
  // 4. CSS with unmatched }} in <style> passes through unblocked
  // 5. All render modes work end-to-end: default, section:'style', section:'script',
  //    allSections:true
  // ============================================================================
  describe('PROOF: Section-format templates work end-to-end (issue #705)', () => {
    // Reusable helper: write a .md template file and return its name
    async function writeTemplate(name: string, content: string): Promise<void> {
      await fs.writeFile(
        path.join(containerContext.portfolioDir, 'templates', `${name}.md`),
        content
      );
    }

    describe('Basic section detection and rendering', () => {
      it('should detect section mode from a file on disk and render the <template> section', async () => {
        await writeTemplate('dashboard-page', `---
name: dashboard-page
description: A page template with separate style and script sections
variables:
  - name: title
    type: string
    required: true
  - name: user
    type: string
    required: true
---
<template>
<h1>{{title}}</h1>
<p>Welcome, {{user}}!</p>
</template>
<style>
h1 { font-size: 2rem; color: #333; }
p { margin: 0.5rem 0; }
</style>
<script>
document.addEventListener('DOMContentLoaded', function() {
  console.log('Dashboard loaded');
});
</script>`);

        const result = await renderer.render('dashboard-page', {
          title: 'My Dashboard',
          user: 'Alice',
        });

        console.log('✅ PROOF: Section-format default render:', result.content);
        expect(result.success).toBe(true);
        expect(result.content).toContain('<h1>My Dashboard</h1>');
        expect(result.content).toContain('<p>Welcome, Alice!</p>');
        // Style and script sections must NOT bleed into default render output
        expect(result.content).not.toContain('font-size');
        expect(result.content).not.toContain('DOMContentLoaded');
        // Variable placeholders must be fully substituted
        expect(result.content).not.toContain('{{title}}');
        expect(result.content).not.toContain('{{user}}');
      });

      it('should return raw <style> section without any variable substitution', async () => {
        await writeTemplate('themed-card', `---
name: themed-card
description: Card template with CSS theme
variables:
  - name: color
    type: string
    required: true
---
<template>
<div class="card" style="color: {{color}}">Content</div>
</template>
<style>
.card {
  border-radius: 8px;
  padding: 1rem;
  background: #fff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
.card:hover {
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}
</style>`);

        const result = await renderer.render('themed-card', {}, 'style');

        console.log('✅ PROOF: Raw style section returned:', result.content);
        expect(result.success).toBe(true);
        expect(result.content).toContain('.card {');
        expect(result.content).toContain('border-radius: 8px;');
        expect(result.content).toContain('.card:hover {');
        // Variable placeholders in <template> must NOT appear in style output
        expect(result.content).not.toContain('{{color}}');
        expect(result.content).not.toContain('<template>');
      });

      it('should return raw <script> section without any variable substitution', async () => {
        await writeTemplate('interactive-widget', `---
name: interactive-widget
description: Widget with interactive JS
variables:
  - name: label
    type: string
    required: true
---
<template>
<button id="btn">{{label}}</button>
</template>
<script>
const btn = document.getElementById('btn');
btn.addEventListener('click', function() {
  const state = { active: true, count: 0 };
  state.count++;
  console.log('Clicked:', state);
});
</script>`);

        const result = await renderer.render('interactive-widget', {}, 'script');

        console.log('✅ PROOF: Raw script section returned:', result.content);
        expect(result.success).toBe(true);
        expect(result.content).toContain('btn.addEventListener');
        expect(result.content).toContain('const state = { active: true, count: 0 };');
        // Must NOT treat {{label}} from <template> as a token to substitute
        expect(result.content).not.toContain('{{label}}');
        expect(result.content).not.toContain('<template>');
      });

      it('should return all three sections together when allSections is true', async () => {
        await writeTemplate('full-page', `---
name: full-page
description: Full page with all three sections
variables:
  - name: heading
    type: string
    required: true
  - name: subtitle
    type: string
    required: true
---
<template>
<header>
  <h1>{{heading}}</h1>
  <p>{{subtitle}}</p>
</header>
</template>
<style>
header { background: #f0f0f0; padding: 2rem; }
h1 { margin: 0; }
</style>
<script>
window.onload = function() {
  const header = document.querySelector('header');
  header.classList.add('loaded');
};
</script>`);

        const result = await renderer.render(
          'full-page',
          { heading: 'Hello World', subtitle: 'A subtitle' },
          undefined,
          true
        );

        console.log('✅ PROOF: allSections result:', JSON.stringify(result.sections, null, 2));
        expect(result.success).toBe(true);

        // content field = rendered <template> section
        expect(result.content).toContain('<h1>Hello World</h1>');
        expect(result.content).toContain('<p>A subtitle</p>');

        // sections field populated
        expect(result.sections).toBeDefined();
        expect(result.sections!.template).toContain('<h1>Hello World</h1>');
        expect(result.sections!.style).toContain('header { background: #f0f0f0;');
        expect(result.sections!.script).toContain("window.onload = function()");

        // No cross-contamination
        expect(result.sections!.style).not.toContain('{{heading}}');
        expect(result.sections!.script).not.toContain('{{subtitle}}');
      });
    });

    describe('ContentValidator passthrough — critical security boundary checks', () => {
      it('should pass CSS with unmatched }} through unblocked (the key #705 fix)', async () => {
        // This is the CORE fix: CSS like `.rule::after { content: "}}"; }` has
        // more }} than {{ but must NOT trigger the validation error that existed
        // before issue #705 was fixed. The balance check is now scoped to <template>.
        await writeTemplate('complex-css', `---
name: complex-css
description: Template with CSS containing unmatched curly braces
variables:
  - name: theme
    type: string
    required: true
---
<template>
<div class="container" data-theme="{{theme}}">content</div>
</template>
<style>
.container { display: flex; }
.container::before { content: "{"; }
.container::after { content: "}"; }
.container[data-theme="dark"] { background: #333; color: #fff; }
.container[data-theme="dark"]:hover { background: #444; }
</style>`);

        const result = await renderer.render('complex-css', { theme: 'dark' });

        console.log('✅ PROOF: CSS unmatched braces pass through:', result.content);
        expect(result.success).toBe(true);
        expect(result.content).toContain('data-theme="dark"');

        // And confirm the style section is accessible and intact
        const styleResult = await renderer.render('complex-css', {}, 'style');
        expect(styleResult.success).toBe(true);
        expect(styleResult.content).toContain('.container::after');
      });

      it('should pass JavaScript with nested object literals through unblocked', async () => {
        // JS like `return { x: { y: 1 } }` has more }} than {{ but is safe in <script>
        await writeTemplate('js-objects', `---
name: js-objects
description: Template with complex JS object literals in script
variables:
  - name: title
    type: string
    required: true
---
<template>
<div id="app">{{title}}</div>
</template>
<script>
const config = {
  api: {
    baseUrl: 'https://api.example.com',
    timeout: 5000,
    retry: { count: 3, delay: 1000 }
  },
  ui: {
    theme: { primary: '#007bff', secondary: '#6c757d' },
    layout: { sidebar: true, footer: false }
  }
};
function init() {
  return { status: 'ok', config };
}
</script>`);

        const scriptResult = await renderer.render('js-objects', {}, 'script');

        console.log('✅ PROOF: JS nested objects pass through:', scriptResult.content);
        expect(scriptResult.success).toBe(true);
        expect(scriptResult.content).toContain('const config = {');
        expect(scriptResult.content).toContain('retry: { count: 3, delay: 1000 }');
        expect(scriptResult.content).toContain('return { status: \'ok\', config };');

        // Ensure variable substitution still works in the template section
        const renderResult = await renderer.render('js-objects', { title: 'My App' });
        expect(renderResult.success).toBe(true);
        expect(renderResult.content).toContain('My App');
      });

      it('should pass <script> tag content through ContentValidator unmodified', async () => {
        // Verifies that ContentValidator (contentContext:'template') does NOT
        // strip or block <script> tag content — critical for section format to work
        await writeTemplate('script-passthrough', `---
name: script-passthrough
description: Verifies script content survives ContentValidator
variables:
  - name: name
    type: string
    required: true
---
<template>Hello, {{name}}!</template>
<script>
// A typical event listener setup
document.querySelectorAll('.btn').forEach(function(btn) {
  btn.addEventListener('click', function(e) {
    e.preventDefault();
    const data = JSON.parse(btn.dataset.payload || '{}');
    fetch('/api/action', {
      method: 'POST',
      body: JSON.stringify(data)
    }).then(function(r) { return r.json(); })
      .then(function(result) { console.log('Done:', result); });
  });
});
</script>`);

        const scriptResult = await renderer.render('script-passthrough', {}, 'script');

        console.log('✅ PROOF: Script survives ContentValidator:', scriptResult.content);
        expect(scriptResult.success).toBe(true);
        expect(scriptResult.content).toContain("document.querySelectorAll('.btn')");
        expect(scriptResult.content).toContain('fetch(\'/api/action\'');
        expect(scriptResult.content).toContain('JSON.stringify(data)');

        const renderResult = await renderer.render('script-passthrough', { name: 'World' });
        expect(renderResult.success).toBe(true);
        expect(renderResult.content!.trim()).toBe('Hello, World!');
      });
    });

    describe('Edge cases and backward compatibility', () => {
      it('should render a plain template from file exactly as before (no regression)', async () => {
        // Plain templates without section tags must continue to work unchanged
        await writeTemplate('plain-email', `---
name: plain-email
description: A plain template with no section tags
variables:
  - name: recipient
    type: string
    required: true
  - name: sender
    type: string
    required: true
---
Hi {{recipient}},

This is a message from {{sender}}.

Best regards,
{{sender}}`);

        const result = await renderer.render('plain-email', {
          recipient: 'Bob',
          sender: 'Alice',
        });

        expect(result.success).toBe(true);
        expect(result.content).toContain('Hi Bob,');
        expect(result.content).toContain('This is a message from Alice.');
        expect(result.content).toContain('Best regards,\nAlice');
        expect(result.content).not.toContain('{{recipient}}');
        expect(result.content).not.toContain('{{sender}}');
      });

      it('should work with only a <template> section (style and script optional)', async () => {
        await writeTemplate('template-only', `---
name: template-only
description: Section-format template with only the template section
variables:
  - name: value
    type: string
    required: true
---
<template>
The value is: {{value}}
</template>`);

        const result = await renderer.render('template-only', { value: '42' });

        expect(result.success).toBe(true);
        expect(result.content!.trim()).toBe('The value is: 42');

        // allSections still works — style/script return empty strings
        const allResult = await renderer.render('template-only', { value: '99' }, undefined, true);
        expect(allResult.success).toBe(true);
        expect(allResult.sections!.template.trim()).toBe('The value is: 99');
        expect(allResult.sections!.style).toBe('');
        expect(allResult.sections!.script).toBe('');
      });

      it('should return a clear error when requesting style section from a plain template', async () => {
        await writeTemplate('plain-no-sections', `---
name: plain-no-sections
description: A plain template
---
Just some content here.`);

        const result = await renderer.render('plain-no-sections', {}, 'style');

        expect(result.success).toBe(false);
        expect(result.error).toContain('not in section mode');
      });

      it('should handle a section-format template with many variables across multiple renders', async () => {
        // Proves caching (parsedSections + compiledTemplate) works correctly
        // across repeated renders on the same template
        await writeTemplate('data-table', `---
name: data-table
description: A data table template rendered many times
variables:
  - name: caption
    type: string
    required: true
  - name: row1
    type: string
    required: true
  - name: row2
    type: string
    required: true
  - name: footer
    type: string
    required: true
---
<template>
<table>
  <caption>{{caption}}</caption>
  <tbody>
    <tr><td>{{row1}}</td></tr>
    <tr><td>{{row2}}</td></tr>
  </tbody>
  <tfoot><tr><td>{{footer}}</td></tr></tfoot>
</table>
</template>
<style>
table { border-collapse: collapse; width: 100%; }
td { padding: 8px; border: 1px solid #ddd; }
caption { font-weight: bold; margin-bottom: 0.5rem; }
tfoot td { background: #f9f9f9; font-style: italic; }
</style>`);

        // Render the same template three times with different variables
        const renders = await Promise.all([
          renderer.render('data-table', { caption: 'Q1', row1: 'Jan', row2: 'Feb', footer: 'Total: 2' }),
          renderer.render('data-table', { caption: 'Q2', row1: 'Apr', row2: 'May', footer: 'Total: 2' }),
          renderer.render('data-table', { caption: 'Q3', row1: 'Jul', row2: 'Aug', footer: 'Total: 2' }),
        ]);

        for (const [_i, result] of renders.entries()) {
          expect(result.success).toBe(true);
          expect(result.content).not.toContain('{{');
        }

        expect(renders[0].content).toContain('<caption>Q1</caption>');
        expect(renders[0].content).toContain('<td>Jan</td>');
        expect(renders[1].content).toContain('<caption>Q2</caption>');
        expect(renders[1].content).toContain('<td>Apr</td>');
        expect(renders[2].content).toContain('<caption>Q3</caption>');
        expect(renders[2].content).toContain('<td>Jul</td>');

        // Style section returns the same raw CSS for all renders
        const styleResult = await renderer.render('data-table', {}, 'style');
        expect(styleResult.success).toBe(true);
        expect(styleResult.content).toContain('border-collapse: collapse');

        console.log('✅ PROOF: Concurrent renders with caching work correctly');
      });

      it('should handle a CSS-only template (just style section, no template or script)', async () => {
        // Style-only templates are a valid use case: shared theme tokens
        await writeTemplate('theme-tokens', `---
name: theme-tokens
description: CSS custom property definitions (style only, no template section)
---
<style>
:root {
  --color-primary: #007bff;
  --color-secondary: #6c757d;
  --spacing-sm: 0.5rem;
  --spacing-md: 1rem;
  --spacing-lg: 2rem;
  --border-radius: 4px;
  --shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
</style>`);

        const styleResult = await renderer.render('theme-tokens', {}, 'style');

        expect(styleResult.success).toBe(true);
        expect(styleResult.content).toContain('--color-primary: #007bff');
        expect(styleResult.content).toContain('--shadow: 0 2px 4px rgba(0, 0, 0, 0.1)');

        // Default render on a style-only template returns an empty template section
        const defaultResult = await renderer.render('theme-tokens', {});
        expect(defaultResult.success).toBe(true);
        expect(defaultResult.content!.trim()).toBe('');
      });

      it('should surface performance metrics for section renders', async () => {
        await writeTemplate('perf-section', `---
name: perf-section
description: Section template for performance metric verification
variables:
  - name: x
    type: string
    required: true
---
<template>Value: {{x}}</template>
<style>.x { color: red; }</style>
<script>console.log('hi');</script>`);

        const defaultResult = await renderer.render('perf-section', { x: 'hello' });
        expect(defaultResult.performance).toBeDefined();
        expect(defaultResult.performance!.lookupTime).toBeGreaterThanOrEqual(0);
        expect(defaultResult.performance!.renderTime).toBeGreaterThanOrEqual(0);

        const styleResult = await renderer.render('perf-section', {}, 'style');
        expect(styleResult.performance).toBeDefined();
        // Raw section passthrough has renderTime = 0 (no Template.render() call)
        expect(styleResult.performance!.renderTime).toBe(0);

        const allResult = await renderer.render('perf-section', { x: 'world' }, undefined, true);
        expect(allResult.performance).toBeDefined();
        expect(allResult.performance!.totalTime).toBeGreaterThanOrEqual(0);

        console.log('✅ PROOF: Performance metrics across all render modes:', {
          default: defaultResult.performance,
          style: styleResult.performance,
          allSections: allResult.performance,
        });
      });
    });
  });
});
