import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

interface VendorAssetManifest {
  readonly version: number;
  readonly assets: readonly {
    readonly file: string;
    readonly package: string;
    readonly packageVersion: string;
    readonly license: string;
    readonly source: string;
    readonly sha256: string;
  }[];
}

const vendorDir = path.resolve(process.cwd(), 'src/web-console/ui/vendor');

describe('web-console vendored asset integrity', () => {
  it('records provenance and verifies every vendored JavaScript asset', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(vendorDir, 'manifest.json'), 'utf8'),
    ) as VendorAssetManifest;
    const vendoredFiles = fs.readdirSync(vendorDir)
      .filter(file => file.endsWith('.js'))
      .sort();
    const recordedFiles = manifest.assets.map(asset => asset.file).sort();

    expect(manifest.version).toBe(1);
    expect(recordedFiles).toEqual(vendoredFiles);
    for (const asset of manifest.assets) {
      expect(asset.source).toBe(`https://registry.npmjs.org/${asset.package}/-/${asset.package}-${asset.packageVersion}.tgz`);
      expect(asset.license).not.toBe('');
      const digest = createHash('sha256')
        .update(fs.readFileSync(path.join(vendorDir, asset.file)))
        .digest('hex');
      expect(digest).toBe(asset.sha256);
    }
  });
});
