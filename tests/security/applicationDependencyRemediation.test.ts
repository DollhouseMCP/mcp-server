import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVersionedConsoleUi } from '../../src/server/consoleUiAssets.js';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import bodyParser from 'body-parser';
import express from 'express';
import request from 'supertest';
import fastUri from 'fast-uri';
import { Address4, Address6 } from 'ip-address';
import qs from 'qs';
import { getQueryParam, getQueryStrings } from 'hono/utils/url';
import { parse as parseToml } from 'smol-toml';

const source = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const require = createRequire(import.meta.url);

describe('application dependency security boundaries', () => {
  it.each(['invalid-limit', Number.NaN])('refuses an invalid body limit %s before accepting requests', limit => {
    expect(() => bodyParser.json({ limit })).toThrow(TypeError);
    expect(() => bodyParser.urlencoded({ limit, extended: true })).toThrow(TypeError);
  });

  it('keeps valid JSON parsing and its configured byte limit enforced', async () => {
    const app = express();
    app.use(bodyParser.json({ limit: '32b' }));
    app.post('/body', (req, res) => res.json(req.body));
    await request(app).post('/body').send({ label: 'valid' }).expect(200, { label: 'valid' });
    await request(app).post('/body').send({ label: 'x'.repeat(40) }).expect(413);
  });

  it('uses the same parser through Express and preserves UTF-8 form decoding', async () => {
    const expressRequire = createRequire(require.resolve('express'));
    expect(expressRequire.resolve('body-parser')).toBe(require.resolve('body-parser'));
    const app = express();
    app.use(express.urlencoded({ extended: true, limit: '1kb' }));
    app.post('/form', (req, res) => res.json(req.body));
    await request(app).post('/form').type('form').send('name=caf%C3%A9&items%5B%5D=one&items%5B%5D=two')
      .expect(200, { name: 'café', items: ['one', 'two'] });
  });

  it('does not interpret fragment text as Hono query parameters', () => {
    const url = 'https://example.test/path?trusted=one#fragment?injected=two&trusted=override';
    expect(getQueryStrings(url)).toBe('?trusted=one');
    expect(getQueryParam(url, 'trusted')).toBe('one');
    expect(getQueryParam(url, 'injected')).toBeUndefined();
    expect(getQueryStrings('https://example.test/path#fragment?injected=two')).toBe('');
  });

  it('normalizes percent-encoded uppercase host octets consistently', () => {
    expect(fastUri.parse('//%41.com').host).toBe('a.com');
    expect(fastUri.equal('//%41.com', '//a.com')).toBe(true);
    expect(fastUri.equal('//A.com', '//a.com')).toBe(true);
  });

  it('keeps IPv4 and IPv6 subnet allowlists separate', () => {
    const v4 = new Address4('10.0.0.0/8');
    const v6 = new Address6('a00::1');
    expect(v6.isInSubnet(v4)).toBe(false);
    expect(v6.isHostInSubnet(v4)).toBe(false);
    expect(v4.isHostInSubnet(v6)).toBe(false);
  });

  it('classifies private translation and link-local ranges independently of a CIDR suffix', () => {
    expect(new Address6('64:ff9b:1::1').isPrivate()).toBe(true);
    expect(new Address6('febf::1/0').isLinkLocal()).toBe(true);
    expect(new Address6('::ffff:127.0.0.1/0').isLoopback()).toBe(true);
  });

  it('bounds malformed IPv6 diagnostics without formatting the whole hostile input', () => {
    expect(() => new Address6('z'.repeat(4096))).toThrow('IPv6 addresses are at most 45 characters.');
  });

  it('round-trips attacker-controlled constructor keys without calling them', () => {
    const parsed = qs.parse('x%5Bconstructor%5D%5BisBuffer%5D=y', { plainObjects: true });
    expect(qs.stringify(parsed)).toBe('x%5Bconstructor%5D%5BisBuffer%5D=y');
  });

  it('enforces comma array limits for both flat and bracket query keys', () => {
    const options = { comma: true, arrayLimit: 3, throwOnLimitExceeded: true };
    expect(() => qs.parse('a=1,2,3,4', options)).toThrow(RangeError);
    expect(() => qs.parse('a[]=1,2,3,4', options)).toThrow(RangeError);
    expect(qs.parse('a[]=1,2,3', options)).toEqual({ a: [['1', '2', '3']] });
  });

  it('preserves TOML key/value parsing on a multi-key document', () => {
    const input = Array.from({ length: 1000 }, (_, i) => `key${i} = ${i}`).join('\n');
    const parsed = parseToml(input);
    expect(Object.keys(parsed)).toHaveLength(1000);
    expect(parsed.key0).toBe(0);
    expect(parsed.key999).toBe(999);
  });
});

describe('server and active browser sanitizer copies', () => {
  const vendor = source('src/web-console/ui/vendor/purify.min.js');
  const html = source('src/web/public/index.html');

  it('binds browser manifest, installed package and CDN SRI to the same bytes', () => {
    const bytes = readFileSync(vendor);
    const installed = readFileSync(require.resolve('dompurify').replace(/purify\.cjs\.js$/, 'purify.min.js'));
    expect(bytes.equals(installed)).toBe(true);
    const manifest = JSON.parse(readFileSync(source('src/web-console/ui/vendor/manifest.json'), 'utf8'));
    const asset = manifest.assets.find((item: { package: string }) => item.package === 'dompurify');
    expect(asset.packageVersion).toBe('3.4.16');
    expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const document = new JSDOM(readFileSync(html, 'utf8'));
    try {
      const tag = document.window.document.querySelector('script[src*="/dompurify@"]');
      expect(tag?.getAttribute('src')).toBe('https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.min.js');
      expect(tag?.getAttribute('integrity')).toBe(`sha384-${createHash('sha384').update(bytes).digest('base64')}`);
    } finally { document.window.close(); }
  });

  it('changes the existing asset namespace when vendored sanitizer bytes change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sanitizer-assets-'));
    try {
      await mkdir(join(directory, 'vendor'));
      await writeFile(join(directory, 'index.html'), '<script src="vendor/purify.min.js"></script>');
      const asset = join(directory, 'vendor/purify.min.js');
      await writeFile(asset, 'previous sanitizer bytes');
      const previous = await loadVersionedConsoleUi(directory);
      await writeFile(asset, readFileSync(vendor));
      const current = await loadVersionedConsoleUi(directory);
      expect(current.assetBasePath).not.toBe(previous.assetBasePath);
      expect(current.html).toContain(`${current.assetBasePath}/vendor/purify.min.js`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('sanitizes attacker markup through the actual portfolio detail renderer', async () => {
    const { renderElementDetail } = await import(source('src/web-console/ui/portfolio-detail.js'));
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    const prior = ['marked', 'DOMPurify'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    try {
      dom.window.eval(readFileSync(source('src/web-console/ui/vendor/marked.min.js'), 'utf8'));
      dom.window.eval(readFileSync(vendor, 'utf8'));
      Reflect.set(globalThis, 'marked', Reflect.get(dom.window, 'marked'));
      Reflect.set(globalThis, 'DOMPurify', Reflect.get(dom.window, 'DOMPurify'));
      const rendered = renderElementDetail({
        metadata: {}, type: 'skills',
        content: '**retained** <img src=x onerror=alert(1)><script>alert(2)</script>',
      });
      const container = dom.window.document.createElement('div');
      container.innerHTML = rendered;
      expect(container.querySelector('strong')?.textContent).toBe('retained');
      expect(container.querySelector('img')?.hasAttribute('onerror')).toBe(false);
      expect(container.querySelector('script')).toBeNull();
      Reflect.deleteProperty(globalThis, 'DOMPurify');
      const fallback = renderElementDetail({ metadata: {}, type: 'skills', content: '<img src=x onerror=alert(1)>' });
      container.innerHTML = fallback;
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('<img');
    } finally {
      for (const [name, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    }
  });

  it.each(['server', 'browser'])('%s sanitizer refuses returning a force-removed rawtext root', mode => {
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    try {
      const purify = mode === 'server' ? createDOMPurify(dom.window) : (() => {
        // Execute only the exact hash-bound local upstream browser artifact.
        dom.window.eval(readFileSync(vendor, 'utf8'));
        return (dom.window as unknown as { DOMPurify: ReturnType<typeof createDOMPurify> }).DOMPurify;
      })();
      expect(purify.sanitize('<p>kept <b>format</b><img src=x onerror=alert(1)></p>'))
        .toBe('<p>kept <b>format</b><img src="x"></p>');
      const root = dom.window.document.createElement('style');
      root.textContent = '</style><img src=x onerror=1>';
      dom.window.document.body.appendChild(root);
      expect(() => purify.sanitize(root, { IN_PLACE: true }))
        .toThrow('a node selected for removal could not be safely returned; refusing to sanitize in place');
    } finally { dom.window.close(); }
  });
});


describe('active browser YAML artifact', () => {
  const vendor = source('src/web-console/ui/vendor/js-yaml.min.js');

  it('matches the installed patched server package and exact versioned CDN integrity', () => {
    const bytes = readFileSync(vendor);
    const installed = readFileSync(require.resolve('js-yaml').replace(/index\.js$/, 'dist/js-yaml.min.js'));
    expect(bytes.equals(installed)).toBe(true);
    const manifest = JSON.parse(readFileSync(source('src/web-console/ui/vendor/manifest.json'), 'utf8'));
    const asset = manifest.assets.find((item: { package: string }) => item.package === 'js-yaml');
    expect(asset.packageVersion).toBe('4.3.2');
    expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const dom = new JSDOM(readFileSync(source('src/web/public/index.html'), 'utf8'));
    try {
      const tag = dom.window.document.querySelector('script[src*="/js-yaml@"]');
      expect(tag?.getAttribute('src')).toBe('https://cdn.jsdelivr.net/npm/js-yaml@4.3.2/dist/js-yaml.min.js');
      expect(tag?.getAttribute('integrity')).toBe(`sha384-${createHash('sha384').update(bytes).digest('base64')}`);
    } finally { dom.window.close(); }
  });

  it('preserves browser YAML parsing and refuses empty-source merge budget exhaustion', async () => {
    const { parseBrowserYaml } = await import(source('src/web-console/ui/yaml-safety.js'));
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'jsyaml');
    try {
      dom.window.eval(readFileSync(vendor, 'utf8'));
      const yaml = Reflect.get(dom.window, 'jsyaml') as typeof import('js-yaml');
      Reflect.set(globalThis, 'jsyaml', yaml);
      expect(parseBrowserYaml('name: retained\ncount: 2')).toEqual({ name: 'retained', count: 2 });
      expect(() => parseBrowserYaml('value: &ref [*ref]')).toThrow('YAML aliases may not create cyclic data.');
      const options = { json: false, maxTotalMergeKeys: 4 };
      expect(() => yaml.load('arr: &arr [{}, {}, {}]\ntargets:\n  - <<: *arr\n  - <<: *arr\n', options))
        .toThrow('merge keys exceeded maxTotalMergeKeys (4)');
      const parsed = yaml.load('base: &base\n  __proto__: { polluted: true }\nresult:\n  <<: *base\n') as { result: Record<string, unknown> };
      expect(Object.getPrototypeOf(parsed.result)).toBe(dom.window.Object.prototype);
      expect(parsed.result.polluted).toBeUndefined();
    } finally {
      if (previous) Object.defineProperty(globalThis, 'jsyaml', previous);
      else Reflect.deleteProperty(globalThis, 'jsyaml');
      dom.window.close();
    }
  });
});
