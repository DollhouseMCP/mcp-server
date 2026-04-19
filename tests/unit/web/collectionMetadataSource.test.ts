import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = join(process.cwd(), 'src', 'web', 'public');

describe('collection metadata author rendering', () => {
  it('normalizes author text before rendering card and modal metadata', () => {
    const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');

    expect(appJs).toContain("function normalizeInlineMetaText(value)");
    expect(appJs).toContain("const author = normalizeInlineMetaText(el.author);");
    expect(appJs).toContain('${author      ? `<span class="meta-author">by ${escapeHtml(author)}</span>` : \'\'}');
    expect(appJs).toContain("const author = normalizeInlineMetaText(element.author);");
    expect(appJs).toContain("modal.querySelector('.modal-author').textContent  = author ? `by ${author}` : '';");
  });

  it('does not inject a CSS-only by prefix for author metadata chips', () => {
    const styles = readFileSync(join(PUBLIC_DIR, 'styles.css'), 'utf-8');

    expect(styles).not.toContain('.meta-author::before');
    expect(styles).not.toContain('content: "by\\00a0";');
  });
});
