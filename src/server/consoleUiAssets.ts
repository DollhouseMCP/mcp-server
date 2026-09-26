import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';

function versionLocalAssetReferences(template: string, assetBasePath: string): string {
  let rewritten = 0;
  const html = template.replace(/(\s(?:href|src)=)(["'])([^"']+)\2/g, (attribute, name: string, quote: string, target: string) => {
    if (target.startsWith('/') || target.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(target)) {
      return attribute;
    }
    if (!/^[a-z\d][a-z\d._/-]*$/i.test(target) || target.split('/').includes('..')) {
      throw new Error(`Unsafe hosted console asset reference: ${target}`);
    }
    rewritten += 1;
    return `${name}${quote}${assetBasePath}/${target}${quote}`;
  });
  if (rewritten === 0) throw new Error('Hosted console index.html has no local asset references');
  return html;
}

/** Derive one URL namespace from every file served by the hosted console. */
export async function loadVersionedConsoleUi(directory: string): Promise<{ assetBasePath: string; html: string }> {
  const hash = createHash('sha256');

  async function hashTree(relativeDirectory: string): Promise<void> {
    const entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await hashTree(relativePath);
      } else if (entry.isFile()) {
        hash.update(relativePath).update('\0');
        hash.update(await readFile(join(directory, relativePath))).update('\0');
      } else {
        throw new Error(`Unsupported hosted console asset: ${relativePath}`);
      }
    }
  }

  await hashTree('');
  const assetBasePath = `/ui/__assets/${hash.digest('hex').slice(0, 16)}`;
  const template = await readFile(join(directory, 'index.html'), 'utf8');
  return { assetBasePath, html: versionLocalAssetReferences(template, assetBasePath) };
}
