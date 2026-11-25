import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import nativePath from 'node:path';

// Exercise the Windows absolute-path policy while keeping fixture I/O native.
const policyPath = { ...nativePath, isAbsolute: nativePath.win32.isAbsolute };
jest.unstable_mockModule('node:path', () => ({ ...policyPath, default: policyPath }));
const { createRealManagerSuite } = await import('../../helpers/di-mocks.js');
const { ValidationError } = await import('../../../src/security/errors.js');

afterEach(() => jest.restoreAllMocks());

describe('Windows drive syntax at the caller-text path policy', () => {
  it.each([
    ['C:alpha.md', 'C:alpha.md', false],
    ['C:/alpha', 'C:/alpha.md', true],
    ['C:', 'C:.md', false],
  ] as const)('rejects %s with the exact policy message', async (text, reference, absolute) => {
    const root = await mkdtemp(nativePath.join(os.tmpdir(), 'held-win-policy-'));
    const suite = createRealManagerSuite(root);
    try {
      await mkdir(nativePath.join(root, 'skills'), { recursive: true });
      expect(policyPath.isAbsolute(reference)).toBe(absolute);
      const message = absolute
        ? 'Absolute skill paths are not allowed'
        : 'Invalid skill reference: elements are addressed by name or storage reference, not by path';
      const lookup = suite.skillManager.findByName(text);
      await expect(lookup).rejects.toBeInstanceOf(ValidationError);
      await expect(lookup).rejects.toHaveProperty('message', message);
    } finally {
      await Promise.all([suite.skillManager.dispose(), suite.personaManager.dispose(),
        suite.agentManager.dispose(), suite.memoryManager.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
