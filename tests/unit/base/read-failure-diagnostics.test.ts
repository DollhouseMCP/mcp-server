import { describe, expect, it, jest } from '@jest/globals';
import { elementReadFailure, ElementReadError, READ_FAILURE_REASONS } from '../../../src/elements/base/ElementReadError.js';
import { collectionReportEvidence, collectionReportNotice } from '../../../src/elements/base/CollectionReport.js';
import { PolicyUnavailableError } from '../../../src/services/policy/PolicyUnavailableError.js';
import { markContentRejection } from '../../../src/security/contentRejection.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { ElementNotFoundError } from '../../../src/utils/ErrorHandler.js';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ElementType } from '../../../src/portfolio/types.js';

describe('public read failure diagnostics', () => {
  it('places safe details before exact-reference recovery without claiming deadlock authority', () => {
    const error = new PolicyUnavailableError('Policy definitions are unavailable.', { failures: [
      { type: 'skills', reference: 'guard.md', reason: 'Definition could not be read' },
    ] });
    expect(error.message).toBe('Policy definitions are unavailable: "guard.md": Definition could not be read. Deactivate that exact reference: skills/guard.md.');
    expect(new PolicyUnavailableError('Policy manager is unavailable').message).toBe('Policy manager is unavailable.');
  });

  it('lists typed references from multiple failures and omits incomplete recovery targets', () => {
    const error = new PolicyUnavailableError('Policy definitions are unavailable.', { failures: [
      { type: 'skills', reference: 'guard.md', reason: 'Skill unreadable' },
      { type: 'personas', reference: 'reviewer.md', reason: 'Persona unreadable' },
      { reference: 'unknown.md', reason: 'Type unavailable' },
      { type: 'agents', reason: 'Reference unavailable' },
      { reason: 'Collection unavailable' },
    ] });
    expect(error.message).toBe('Policy definitions are unavailable: "guard.md": Skill unreadable; "reviewer.md": Persona unreadable; "unknown.md": Type unavailable; collection: Reference unavailable; collection: Collection unavailable. Deactivate that exact reference: skills/guard.md, personas/reviewer.md.');
  });

  it('does not promote an unproven ENOENT to definition absence', () => {
    const cause = Object.assign(new Error('Auxiliary file missing'), { code: 'ENOENT' });
    const error = elementReadFailure(cause, 'agent.md');
    expect(error).toMatchObject({ kind: 'unreadable', cause });
    expect(error.code).not.toBe('ENOENT');
  });

  it('withholds historical diagnostic text from invalid-definition details', () => {
    const handler: ElementCRUDHandler = Object.create(ElementCRUDHandler.prototype);
    jest.spyOn(handler as any, 'getManagerForType').mockReturnValue({ getInvalidElement: () => ({
      filePath: 'broken.md', contentRejected: true, clientSafeReason: READ_FAILURE_REASONS.contentRejected,
      reason: 'Failed query: select private_table; params: secret-value',
    }) });
    const response = handler['invalidElementDetails']('broken', ElementType.SKILL,
      new ElementNotFoundError(ElementType.SKILL, 'broken'));
    expect(response.content[0].text).toContain('Skill Invalid');
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('broken.md');
    expect(response.content[0].text).toContain(READ_FAILURE_REASONS.contentRejected);
    expect(response.content[0].text).not.toContain('private_table');
    expect(response.content[0].text).not.toContain('secret-value');
  });

  it('propagates unexpected evidence errors even when discovery holds the reference', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'held-evidence-error-'));
    const suite = createRealManagerSuite(root);
    try {
      const manager = suite.skillManager;
      const unexpected = new TypeError('Unexpected evidence failure');
      jest.spyOn(manager['storageLayer'], 'isExactStorageReference')
        .mockReturnValueOnce(false).mockReturnValue(true);
      jest.spyOn(manager as any, 'storedNameHolds').mockRejectedValue(unexpected as never);
      await expect(manager['classifyCallerText']('save-50%25.md')).rejects.toBe(unexpected);
    } finally {
      await Promise.all([suite.skillManager.dispose(), suite.memoryManager.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(['driver', 'yaml', 'unknown'])('withholds %s diagnostics while retaining the original cause', kind => {
    const secret = 'private-bound-parameter';
    const cause = kind === 'driver'
      ? Object.assign(new Error(`Failed query: select * from private_table\nparams: ${secret}`), { name: 'DrizzleQueryError' })
      : new Error(`Invalid input: ${secret}`);
    if (kind === 'yaml') markContentRejection(cause);
    const error = elementReadFailure(cause, 'definition.md');
    expect(error).toBeInstanceOf(ElementReadError);
    if (!(error instanceof ElementReadError)) throw new Error('Expected typed read failure');
    const report = { items: [], complete: false, failures: [{ reference: 'definition.md', error }] };
    const policy = new PolicyUnavailableError('Active policy unavailable', { cause: error,
      failures: [{ type: 'skills', reference: 'definition.md', reason: error.message }] });
    for (const publicText of [error.message, JSON.stringify(collectionReportEvidence(report)),
      collectionReportNotice(report), policy.message]) {
      expect(publicText).not.toContain(secret);
      expect(publicText).not.toContain('private_table');
      expect(publicText).toContain('definition.md');
    }
    expect(error.cause).toBe(cause);
    expect(policy.cause).toBe(error);
  });
});
