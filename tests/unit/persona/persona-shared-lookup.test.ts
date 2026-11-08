/**
 * Persona lookups go through the shared read contract: the shared selector picks by name (a
 * filename alone never selects, a tie selects nothing), and a cached instance is served only while
 * the storage layer vouches it is current, so an externally edited persona file is read again.
 */
import { describe, expect, it, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';

const persona = (name: string, description: string, id: string) =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${description}\nunique_id: ${id}\n---\nYou are a careful and detailed assistant persona.`;

describe('persona lookups through the shared resolver', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'persona-shared-lookup-'));
    suite = createRealManagerSuite(root);
    dir = (suite.personaManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'helper.md'), persona('Assistant', 'renamed away from its filename', 'p-helper'));
    await writeFile(path.join(dir, 'helper-2.md'), persona('helper', 'holds the name', 'p-helper-2'));
    await suite.personaManager.list();
  });
  afterEach(async () => {
    await suite.personaManager.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const exists = (file: string) => access(path.join(dir, file)).then(() => true, () => false);

  it('selects the persona named "helper", never the file helper.md, for every caller', async () => {
    const personas = suite.personaManager;
    expect((await personas.findPersonaAsync('helper'))?.filename).toBe('helper-2.md');
    expect(personas.findPersona('helper')?.filename).toBe('helper-2.md');
    expect((await personas.activatePersona('helper')).success).toBe(true);
    expect(personas.getActivePersonas().map(item => item.filename)).toEqual(['helper-2.md']);
    personas.deactivatePersona('helper');
    expect(personas.getActivePersonas()).toEqual([]);
    expect(JSON.stringify(await personas.validatePersona('helper'))).not.toContain('Assistant');
    await personas.editPersona('helper', 'description', 'edited through its name');
    expect(await readFile(path.join(dir, 'helper-2.md'), 'utf8')).toContain('edited through its name');
    expect(await readFile(path.join(dir, 'helper.md'), 'utf8')).toContain('renamed away from its filename');
    expect((await personas.deletePersona('helper')).success).toBe(true);
    expect([await exists('helper.md'), await exists('helper-2.md')]).toEqual([true, false]);
  });

  it('serves an externally edited persona file fresh outside enforcement', async () => {
    const personas = suite.personaManager;
    expect((await personas.findPersonaAsync('helper-2.md'))?.metadata.description).toBe('holds the name');
    const file = path.join(dir, 'helper-2.md');
    await writeFile(file, persona('helper', 'edited by another process, longer', 'p-helper-2'));
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    expect((await personas.findPersonaAsync('helper-2.md'))?.metadata.description).toBe('edited by another process, longer');
    expect((await personas.findPersonaAsync('helper'))?.metadata.description).toBe('edited by another process, longer');
  });

  it('never selects by filename alone, and a tie selects nothing, on the synchronous cached path', async () => {
    const personas = suite.personaManager;
    await rm(path.join(dir, 'helper-2.md'));
    await writeFile(path.join(dir, 'twin-a.md'), persona('Twin', 'first twin', 'p-twin-a'));
    await writeFile(path.join(dir, 'twin-b.md'), persona('Twin', 'second twin', 'p-twin-b'));
    personas.clearCache();
    await personas.listReport();
    expect(personas.findPersona('helper')).toBeUndefined();
    expect(personas.findPersona('Twin')).toBeUndefined();
    expect(personas.findPersona('helper.md')?.metadata.name).toBe('Assistant');
  });
});
