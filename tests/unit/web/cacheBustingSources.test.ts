/**
 * Source-level checks for cache-busting and forced reload wiring.
 *
 * These assertions stay small and deterministic: they verify that the
 * server-rendered HTML stamps local asset URLs with a version placeholder
 * and that app.js exposes a forced reload helper for stale tabs.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = join(process.cwd(), 'src', 'web', 'public');

describe('cache busting source wiring', () => {
  it('index.html stamps local assets with the asset-version placeholder', () => {
    const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf-8');
    expect(html).toContain('name="dollhouse-console-asset-version"');
    expect(html).toContain('{{DOLLHOUSE_ASSET_VERSION}}');
    expect(html).toContain('styles.css?v={{DOLLHOUSE_ASSET_VERSION}}');
    expect(html).toContain('app.js?v={{DOLLHOUSE_ASSET_VERSION}}');
    expect(html).toContain('sessions.js?v={{DOLLHOUSE_ASSET_VERSION}}');
    expect(html).toContain('dollhouse-logo.png?v={{DOLLHOUSE_ASSET_VERSION}}');
  });

  it('app.js exposes a cache-busted forced reload helper', () => {
    const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf-8');
    expect(appJs).toContain('dollhousemcp-last-forced-reload');
    expect(appJs).toContain('buildCacheBustedConsoleUrl');
    expect(appJs).toContain('globalThis.DollhouseConsole.forceReload = forceConsoleReload');
    expect(appJs).toContain("window.DollhouseConsole.forceReload(\\'session-expired\\')");
  });
});
