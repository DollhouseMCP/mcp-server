import { MAX_RETAINED_NOTICE_LINES } from '../../../src/elements/base/BaseElementManager.js';
import { SkillActivationStrategy } from '../../../src/handlers/strategies/SkillActivationStrategy.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRealSkillManager, createRealEnsembleManager } from '../../helpers/di-mocks.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';
import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { EnsembleManager } from '../../../src/elements/ensembles/EnsembleManager.js';
import { ActivationMetricsTracker } from '../../../src/metrics/ActivationMetricsTracker.js';
import { PathValidator } from '../../../src/security/pathValidator.js';
import { ValidationError } from '../../../src/security/errors.js';
import { logger } from '../../../src/utils/logger.js';

const names = Array.from({ length: 5 }, (_, index) => `item-${index}`);

describe.each(['skill', 'ensemble'] as const)('%s uncertain activation cleanup', type => {
  let dir: string;
  let manager: SkillManager | EnsembleManager;
  let tracker: ActivationMetricsTracker;
  const envKey = `DOLLHOUSE_MAX_ACTIVE_${type.toUpperCase()}S`;
  let originalLimit: string | undefined;
  const cleanup = () => manager['collectRetainedReferenceNotices']();
  const deactivate = (name: string) => manager instanceof SkillManager
    ? manager.deactivateSkill(name) : manager.deactivateEnsemble(name);
  beforeEach(async () => {
    originalLimit = process.env[envKey];
    process.env[envKey] = '5';
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retained-activation-'));
    tracker = new ActivationMetricsTracker(() => 'test-user');
    manager = (type === 'skill' ? createRealSkillManager : createRealEnsembleManager)(dir, { activationMetricsTracker: tracker });
    await fs.mkdir(path.join(dir, `${type}s`), { recursive: true });
    await Promise.all(names.map(name => fs.writeFile(path.join(dir, `${type}s`, `${name}.md`),
      `---\nname: ${name}\ndescription: test\nversion: 1.0.0\n---\nTest instructions.`)));
    for (const name of names) manager['getActivationSet']().add(name);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await manager.dispose();
    if (originalLimit === undefined) delete process.env[envKey];
    else process.env[envKey] = originalLimit;
    await fs.rm(dir, { recursive: true, force: true });
  });
  it.each(['unparseable', 'removed'])('retains a %s reference and returns neutral advice', async state => {
    if (state === 'removed') await fs.unlink(path.join(dir, `${type}s`, 'item-0.md'));
    else await fs.writeFile(path.join(dir, `${type}s`, 'item-0.md'), '---\nname: [invalid\n---\n');
    expect((await manager.list()).map(item => item.metadata.name)).toEqual(names.slice(1));
    const warn = jest.spyOn(logger, 'warn');
    const result = await (manager instanceof SkillManager ? manager.activateSkill('item-1') : manager.activateEnsemble('item-1'));
    expect(result.success).toBe(true);
    await cleanup();
    expect([...manager['getActivationSet']()]).toEqual(names);
    if (manager instanceof SkillManager) {
      const response = await new SkillActivationStrategy(manager).activate('item-1');
      expect(response.content[0].text).toContain('Active skill reference');
    }
    expect(result.message).toContain('limit reached');
    expect(result.message).toContain(`Active ${type} reference "item-0" could not be loaded and is kept.`);
    expect(result.message).toContain('Check its definition and storage, or deactivate this exact reference if it was deleted or is no longer needed.');
    expect(result.message.includes('While it fails to load, no active')).toBe(state === 'unparseable');
    expect(tracker.getMetrics()).toBe(1);
    expect(warn.mock.calls.filter(([message]) => message.startsWith('[Activation]'))).toHaveLength(1);
    expect((await deactivate('item-0')).success).toBe(true);
    expect(manager['getActivationSet']().has('item-0')).toBe(false);
  });
  it.each(['unreadable', 'resolved', 'alias'])('resets warning lifetime after direct %s deactivation', async lookup => {
    const file = path.join(dir, `${type}s`, 'item-0.md');
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, '---\nname: [invalid\n---');
    const warn = jest.spyOn(logger, 'warn');
    await cleanup();
    expect(tracker.getMetrics()).toBe(1);
    if (lookup !== 'unreadable') {
      await fs.writeFile(file, original);
      manager.clearCache();
    }
    const identifier = lookup === 'alias' ? 'ITEM-0' : 'item-0';
    expect((await deactivate(identifier)).success).toBe(true);
    expect(manager['getActivationSet']().has('item-0')).toBe(false);
    // A new live reference has its own warning lifetime even when still unreadable.
    manager['getActivationSet']().add('item-0');
    await fs.writeFile(file, '---\nname: [invalid\n---');
    manager.clearCache();
    await cleanup();
    await cleanup();
    expect(tracker.getMetrics()).toBe(2);
    expect(warn.mock.calls.filter(([message]) => message.startsWith('[Activation] Retained'))).toHaveLength(2);
  });
  it('retains every active reference when every lookup fails at the storage layer', async () => {
    await manager.dispose();
    const fileFactory = createTestStorageFactory();
    // A writable storage test double exercises listFromDatabase's swallowed-error path.
    const storageLayerFactory = { createForElement: (...args: Parameters<typeof fileFactory.createForElement>) =>
      Object.assign(fileFactory.createForElement(...args), { writeContent: async () => undefined }) };
    manager = (type === 'skill' ? createRealSkillManager : createRealEnsembleManager)(dir,
      { storageLayerFactory, activationMetricsTracker: tracker });
    for (const name of names) manager['getActivationSet']().add(name);
    const scan = jest.spyOn(manager['storageLayer'], 'scan').mockRejectedValue(new Error('storage unavailable'));
    expect(await manager.list()).toEqual([]);
    const notices = await cleanup();
    expect(notices).toHaveLength(Math.min(names.length, MAX_RETAINED_NOTICE_LINES));
    expect(notices[0]).toContain('could not be loaded and is kept.');
    await cleanup();
    expect(scan).toHaveBeenCalled();
    expect([...manager['getActivationSet']()]).toEqual(names);
    expect(tracker.getMetrics()).toBe(names.length);
    expect((await deactivate(names[0])).success).toBe(true);
    expect(manager['getActivationSet']().has(names[0])).toBe(false);
  });
  it('caps response notices while retaining and counting every missing reference', async () => {
    for (let index = 0; index < MAX_RETAINED_NOTICE_LINES + 3; index++) manager['getActivationSet']().add(`missing-${index}`);
    const notices = await cleanup();
    expect(notices).toHaveLength(MAX_RETAINED_NOTICE_LINES + 1);
    expect(notices[MAX_RETAINED_NOTICE_LINES - 1]).toContain(`missing-${MAX_RETAINED_NOTICE_LINES - 1}`);
    expect(notices[MAX_RETAINED_NOTICE_LINES]).toBe(`…and 3 more retained ${type} references`);
    expect(tracker.getMetrics()).toBe(MAX_RETAINED_NOTICE_LINES + 3);
    expect(manager['getActivationSet']().size).toBe(names.length + MAX_RETAINED_NOTICE_LINES + 3);
  });
  it.each(['../../outside', '/outside', 'C:\\outside', '', '   ', 'item\0', 'safe/../item', '..\\outside'])(
    'refuses invalid identifier %j without changing the live set', async identifier => {
    const lookup = jest.spyOn(manager, 'findByName');
    await expect(deactivate(identifier)).rejects.toBeInstanceOf(ValidationError);
    expect(lookup).not.toHaveBeenCalled();
    expect([...manager['getActivationSet']()]).toEqual(names);
  });
  it('reports a lookup failure instead of claiming an unknown reference is missing', async () => {
    jest.spyOn(manager, 'findByName').mockRejectedValue(new Error('unavailable'));
    expect(await deactivate('unknown')).toMatchObject({ success: false, lookupFailed: true,
      message: '"unknown" could not be loaded (storage or definition error)' });
  });
  it('refreshes warm definitions once before pressure reporting', async () => {
    await manager.list();
    const file = path.join(dir, `${type}s`, 'item-0.md');
    await fs.writeFile(file, '---\nname: [invalid\n---');
    await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
    const scan = jest.spyOn(manager['storageLayer'], 'scan');
    const result = await (manager instanceof SkillManager ? manager.activateSkill('item-1') : manager.activateEnsemble('item-1'));
    expect(result.notices?.join(' ')).toContain('"item-0" could not be loaded and is kept');
    expect(scan).toHaveBeenCalledTimes(1);
  });
  it('clears the exact live key after path validation encounters an I/O failure', async () => {
    const validation = jest.spyOn(PathValidator, 'validateElementPathOnly')
      .mockRejectedValue(Object.assign(new Error('storage unavailable'), { code: 'EIO' }));
    expect((await deactivate(names[0])).success).toBe(true);
    expect(validation).toHaveBeenCalled();
    expect([...manager['getActivationSet']()]).toEqual(names.slice(1));
  });
  it('deactivates only an exact missing live key and keeps unknown names not-found', async () => {
    manager['getActivationSet']().add('missing');
    expect((await deactivate('MISSING')).success).toBe(false);
    expect(manager['getActivationSet']().has('missing')).toBe(true);
    expect((await deactivate('missing')).success).toBe(true);
    expect(manager['getActivationSet']().has('missing')).toBe(false);
    expect((await deactivate('unknown')).success).toBe(false);
  });
});
