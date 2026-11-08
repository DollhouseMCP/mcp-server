import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let insensitive = false;
jest.unstable_mockModule('node:fs/promises', () => ({ ...fs,
  stat: (file: string) => {
    if (path.basename(file) !== 'upper') return fs.stat(file);
    if (insensitive) return fs.stat(path.join(path.dirname(file), 'Upper'));
    return Promise.reject(Object.assign(new Error('Distinct filename is absent'), { code: 'ENOENT' }));
  },
}));
const { caseSensitiveTest } = await import('../../helpers/caseSensitiveTest.js');
afterEach(() => { insensitive = false; });

describe('case-sensitive fixture registration', () => {
  it.each([true, false])('selects the correct test registrar for insensitive=%s', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'case-probe-test-'));
    insensitive = mode;
    try {
      expect(await caseSensitiveTest(root)).toBe(mode ? it.skip : it);
      expect(await fs.readdir(root)).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
