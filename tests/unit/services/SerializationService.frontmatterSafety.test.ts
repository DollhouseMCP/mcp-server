import { afterEach, describe, expect, it } from '@jest/globals';
import { load, JSON_SCHEMA, FAILSAFE_SCHEMA } from 'js-yaml';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';
import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { Skill } from '../../../src/elements/skills/Skill.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { createTestMetadataService } from '../../helpers/di-mocks.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class SerializationProbe extends SkillManager {
  serializeForTest(skill: Skill): Promise<string> { return this.serializeElement(skill); }
}

const marker = '__dollhouseFrontmatterNonexecutionTest';
const state = globalThis as typeof globalThis & { [marker]?: boolean };
const service = new SerializationService();
function frontmatter(output: string): Record<string, unknown> {
  return load(output.split('---')[1], { schema: JSON_SCHEMA }) as Record<string, unknown>;
}

afterEach(() => { delete state[marker]; });

describe('frontmatter serialization safety', () => {
  it.each(['javascript', 'js', 'JAVASCRIPT', 'bom-javascript'])('refuses %s before executing a Skill body', async language => {
    const lock = new FileLockManager();
    const files = new FileOperationsService(lock);
    const metadata = createTestMetadataService();
    const registry = new ValidationRegistry(new ValidationService(), new TriggerValidationService(), metadata);
    const manager = new SerializationProbe({
      portfolioManager: new PortfolioManager(files, { baseDir: join(tmpdir(), 'unused-skill-serialization-probe') }),
      fileLockManager: lock, fileOperationsService: files, validationRegistry: registry,
      serializationService: service, metadataService: metadata,
      eventDispatcher: new ElementEventDispatcher(), storageLayerFactory: createTestStorageFactory()
    });
    const prefix = language === 'bom-javascript' ? '\ufeff---javascript' : `---${language}`;
    const body = `${prefix}\n(globalThis.${marker} = true, { name: 'body' })\n---\nReference text`;
    const skill = new Skill({ name: 'Safe skill' }, 'Instructions', metadata, body);
    try {
      let failure: unknown;
      try { await manager.serializeForTest(skill); } catch (error) { failure = error; }
      expect(state[marker]).toBeUndefined();
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/Unsupported frontmatter language/);
    } finally { manager.dispose(); }
  });

  it('preserves ordinary Markdown and default scalar metadata', () => {
    const output = service.createFrontmatter({ name: 'skill', enabled: true, count: 2 }, '# Reference\n\nKeep this text.', { method: 'matter' });
    expect(frontmatter(output)).toEqual({ name: 'skill', enabled: true, count: 2 });
    expect(output).toContain('# Reference\n\nKeep this text.');
  });

  it.each(['', 'yaml', 'yml'])('preserves supported %s YAML unwrapping and metadata precedence', language => {
    const output = service.createFrontmatter({ name: 'outer' }, `---${language}\nname: inner\nenabled: true\ncount: 3\n---\nReference text`, { method: 'matter', schema: 'json' });
    expect(frontmatter(output)).toEqual({ name: 'outer', enabled: true, count: 3 });
    expect(output.split('---')).toHaveLength(3);
    expect(output.endsWith('Reference text\n')).toBe(true);
  });

  it('preserves the supported JSON body language without a default YAML parser', () => {
    const output = service.createFrontmatter({ name: 'outer' }, '---json\n{"name":"inner","enabled":true,"count":2}\n---\nReference', { method: 'matter', schema: 'json' });
    expect(frontmatter(output)).toEqual({ name: 'outer', enabled: true, count: 2 });
    expect(output.endsWith('Reference\n')).toBe(true);
  });

  it('honors requested failsafe scalar parsing', () => {
    const output = service.createFrontmatter({ name: 'skill' }, '---\nenabled: true\ncount: 2\n---\nBody', { method: 'matter', schema: 'failsafe' });
    expect(load(output.split('---')[1], { schema: FAILSAFE_SCHEMA })).toEqual({ name: 'skill', enabled: 'true', count: '2' });
    expect(() => service.createFrontmatter({ name: 'skill' }, '---\nenabled: !!bool true\n---\nBody', { method: 'matter', schema: 'failsafe' })).toThrow();
  });

  it('refuses an explicitly requested default schema for body parsing', () => {
    expect(() => service.createFrontmatter({ name: 'skill' }, 'Body', { method: 'matter', schema: 'default' })).toThrow(/Default YAML schema/);
  });

  it('refuses default-only tagged types', () => {
    expect(() => service.createFrontmatter({ name: 'skill' }, '---\nextra: !!omap\n  - a: 1\n---\nBody', { method: 'matter', schema: 'json' })).toThrow();
  });

  it('does not expand implicit YAML merge authority', () => {
    const output = service.createFrontmatter({ name: 'skill' }, '---\nbase: &base {enabled: true}\nextra: {<<: *base}\n---\nBody', { method: 'matter', schema: 'json' });
    expect(frontmatter(output).extra).toEqual({ '<<': { enabled: true } });
  });

  it('refuses an oversized body frontmatter before parsing', () => {
    expect(() => service.createFrontmatter({ name: 'skill' }, `---\nvalue: ${'x'.repeat(64 * 1024)}\n---\nBody`, { method: 'matter', schema: 'json' })).toThrow(/exceeds/);
  });

  it('refuses cyclic metadata before dumping', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => service.createFrontmatter({ name: 'skill', value }, 'Body', { method: 'matter', schema: 'json' })).toThrow(/cyclic/);
  });

  it('bounds repeated alias expansion before a noRefs dump', () => {
    const body = '---\na: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\n---\nBody';
    expect(() => service.createFrontmatter({ name: 'skill' }, body, { method: 'matter', schema: 'json' })).toThrow(/structure limit/);
  });
});
