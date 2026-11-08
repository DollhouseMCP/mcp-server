/**
 * Stored names that are path syntax ('Pros // Cons', 'Save 50%25 Now', 'C:') are listed, found,
 * activated, enforced and deleted by name like any other name: path-syntax caller text is offered
 * as a tier 0/1 name first and refused only when no stored name holds it. Only the layer's own
 * canonical form is a storage reference: 'x/../alpha.md', './alpha.md', 'a//alpha.md' are not.
 */
import { describe, expect, it, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { ActivePolicyCollector } from '../../../src/services/policy/ActivePolicyCollector.js';
import { ValidationError } from '../../../src/security/errors.js';
import { PathValidator } from '../../../src/security/pathValidator.js';

const skill = (name: string) => `---\nname: ${JSON.stringify(name)}\ndescription: Path syntax fixture\n---\nFollow these detailed instructions.`;
const NAMES = ['Pros // Cons', 'Input/Output/', 'and/or/..', 'Save 50%25 Now', 'C:', '/slash first'];

describe('stored names that are path syntax (file backend)', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'path-syntax-names-'));
    suite = createRealManagerSuite(root);
    dir = (suite.skillManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    for (const [index, name] of NAMES.entries()) await writeFile(path.join(dir, `s${index}.md`), skill(name));
    await writeFile(path.join(dir, 'alpha.md'), skill('Alpha'));
  });
  afterEach(async () => {
    await Promise.all([suite.skillManager.dispose(), suite.ensembleManager.dispose(), suite.agentManager.dispose(), suite.personaManager.dispose()]);
    await rm(root, { recursive: true, force: true });
  });

  it('recognizes drive references using the shared extension aliases in either case', async () => {
    for (const extension of ['yaml', 'yml', 'YAML', 'YML']) {
      expect(PathValidator.isPathSyntax(`C:Notes.${extension}`, '.yaml')).toBe(true);
      expect(PathValidator.isPathSyntax(`C:Notes.${extension}`)).toBe(true);
    }
    expect(PathValidator.isPathSyntax('C:Notes.markdown')).toBe(false);
    await expect(suite.skillManager.findByName('C:Notes.markdown')).resolves.toBeUndefined();
    expect(PathValidator.isPathSyntax('Q: Interview Prep')).toBe(false);
  });

  const collector = () => new ActivePolicyCollector({
    personaManager: suite.personaManager, skillManager: suite.skillManager, agentManager: suite.agentManager,
    ensembleManager: suite.ensembleManager, getManagerForType: () => undefined, ensureInitialized: async () => {},
  });

  it('lists every name healthy and finds each by its listed name', async () => {
    const manager = suite.skillManager;
    const report = await manager.listReport();
    expect(report.failures).toEqual([]);
    expect(report.items.map(item => item.metadata.name).sort()).toEqual([...NAMES, 'Alpha'].sort());
    for (const name of NAMES) expect((await manager.findByName(name))?.metadata.name).toBe(name);
  });

  it.each(NAMES.map((name, index) => [name, index] as const))('activates %j by name and by reference, and enforcement stays available', async (name, index) => {
    const manager = suite.skillManager;
    for (const identifier of [name, `s${index}.md`]) {
      const activated = await manager.activateSkill(identifier);
      expect(activated.success ? 'activated' : activated.message).toBe('activated');
      await expect(manager.getActiveReferenceReport()).resolves.toMatchObject({ complete: true, failures: [] });
      await expect(collector().collectActiveElementsForReport()).resolves.toMatchObject({ complete: true, failures: [] });
      expect((await manager.deactivateSkill(name)).success).toBe(true);
    }
  });

  it('deletes each by its name, and nothing else', async () => {
    const manager = suite.skillManager;
    for (const [index, name] of NAMES.entries()) {
      await manager.delete(name);
      await expect(access(path.join(dir, `s${index}.md`))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(access(path.join(dir, 'alpha.md'))).resolves.toBeUndefined();
  });

  it('still refuses path syntax that no stored name holds, with the type\'s path policy first', async () => {
    const manager = suite.skillManager;
    for (const text of ['../alpha', 'Pros /// Cons', '%2e%2e/alpha']) {
      await expect(manager.findByName(text)).rejects.toThrow(ValidationError);
    }
  });
});

describe('only the canonical reference form is a reference (file backend, every type)', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'canonical-references-'));
    suite = createRealManagerSuite(root);
    const skills = (suite.skillManager as any)['elementDir'];
    const memories = (suite.memoryManager as any)['elementDir'];
    await mkdir(skills, { recursive: true });
    await mkdir(memories, { recursive: true });
    await writeFile(path.join(skills, 'alpha.md'), skill('Alpha'));
    await writeFile(path.join(skills, 'beta.md'), skill('Beta'));
    await writeFile(path.join(memories, 'alpha.yaml'), 'name: Alpha\ndescription: memory\nentries: []\n');
  });
  afterEach(async () => {
    await Promise.all([suite.skillManager.dispose(), suite.memoryManager.dispose()]);
    await rm(root, { recursive: true, force: true });
  });

  it.each(['skill', 'memory'] as const)('refuses non-canonical %s references as path syntax', async type => {
    const manager = suite[`${type}Manager`] as any;
    const extension = type === 'memory' ? 'yaml' : 'md';
    for (const text of [`x/../alpha.${extension}`, `./alpha.${extension}`, `a//alpha.${extension}`, `C:/alpha.${extension}`, `C:alpha.${extension}`, `%2e%2e/alpha.${extension}`]) {
      expect(await manager.classifyCallerText(text).catch((error: Error) => error.name)).toBe('ValidationError');
      await expect(manager.load(text)).rejects.toThrow(ValidationError);
    }
    expect(await manager.classifyCallerText(`alpha.${extension}`)).toBe('reference');
  });

  it('deletes nothing for a traversal form of an existing reference', async () => {
    const skills = (suite.skillManager as any)['elementDir'];
    await expect(suite.skillManager.delete('x/../beta.md')).rejects.toThrow(ValidationError);
    await expect(access(path.join(skills, 'beta.md'))).resolves.toBeUndefined();
    await expect(suite.skillManager.activateSkill('x/../alpha.md')).rejects.toThrow(ValidationError);
    expect([...(suite.skillManager as any).getActivationSet()]).toEqual([]);
  });
});
