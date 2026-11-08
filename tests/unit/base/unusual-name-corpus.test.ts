/**
 * The unusual-name corpus (28 cases), pinned as invariants: every listed definition is found by its
 * own listed name, warm and cold, and by its storage reference; and no lookup of any asked text ever
 * returns a definition the shared acceptance rule does not accept for that text (an absence or a
 * typed refusal is allowed).
 */
import { describe, expect, it } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { ElementReadError } from '../../../src/elements/base/ElementReadError.js';
import { ValidationError } from '../../../src/security/errors.js';
import { acceptsDirectDefinition } from '../../../src/elements/base/ElementNameEvidence.js';

const q = JSON.stringify;
const md = (nameLine: string, extra = '') => `---\n${nameLine}\ndescription: fixture\n${extra}---\nYou are a careful and detailed assistant; follow these detailed instructions.`;
let personaId = 0;
const persona = (nameLine: string) => md(nameLine, `unique_id: p-unusual-${personaId++}\n`);
const yaml = (nameLine: string) => `${nameLine}\ndescription: fixture\nentries: []\n`;
type Case = { label: string; type: 'skillManager' | 'personaManager' | 'memoryManager'; files: [string, string][]; ask?: string[] };

const cases: Case[] = [
  { label: 'skill separator-only ---', type: 'skillManager', files: [['unnamed.md', md('name: "---"')]], ask: ['unnamed'] },
  { label: 'skill separator-only ___', type: 'skillManager', files: [['unnamed.md', md('name: "___"')]], ask: ['unnamed'] },
  { label: 'skill separator-only ...', type: 'skillManager', files: [['dots.md', md('name: "..."')]] },
  { label: 'skill separator-only ///', type: 'skillManager', files: [['slashes.md', md('name: "///"')]] },
  { label: 'skill stripped <> (default)', type: 'skillManager', files: [['stripped.md', md('name: "<>"')]], ask: ['Untitled Skill', '<>'] },
  { label: 'skill nameless (stem)', type: 'skillManager', files: [['nameless.md', md('author: x')]], ask: ['nameless', 'Untitled Skill'] },
  { label: 'skill numeric name', type: 'skillManager', files: [['num.md', md('name: 123')]], ask: ['123', 'Untitled Skill', 'num'] },
  { label: 'skill boolean name', type: 'skillManager', files: [['bool.md', md('name: true')]], ask: ['true', 'Untitled Skill', 'bool'] },
  { label: 'skill explicit default', type: 'skillManager', files: [['untitled-skill.md', md('name: "Untitled Skill"')]] },
  { label: 'skill percent file', type: 'skillManager', files: [['save-50%25.md', md('name: "Save Fifty"')]], ask: ['save-50%25.md', 'save-50%25'] },
  { label: 'skill path-syntax stored names', type: 'skillManager', files: [['team-notes.md', md('name: "team/notes"')], ['ci-cd-helper.md', md('name: "CI/CD Helper"')], ['and-or.md', md('name: "and/or/.."')]] },
  { label: 'skill sanitized <b>x</b>', type: 'skillManager', files: [['bx.md', md('name: "<b>x</b>"')]], ask: ['<b>x</b>'] },
  { label: 'persona stripped <> (stored identity)', type: 'personaManager', files: [['stripped.md', persona('name: "<>"')]], ask: ['Untitled Persona', '<>'] },
  { label: 'persona nameless', type: 'personaManager', files: [['nameless.md', persona('author: x')]], ask: ['nameless', 'Untitled Persona'] },
  { label: 'persona numeric', type: 'personaManager', files: [['num.md', persona('name: 123')]], ask: ['123', 'Untitled Persona'] },
  { label: 'persona raw R&D / Cafe', type: 'personaManager', files: [['rd.md', persona('name: "R&D"')], ['cafe.md', persona(`name: ${q('Cafe"́')}`)]] },
  { label: 'persona ---', type: 'personaManager', files: [['unnamed.md', persona('name: "---"')]], ask: ['unnamed'] },
  { label: 'persona <b>x</b>', type: 'personaManager', files: [['bx.md', persona('name: "<b>x</b>"')]], ask: ['<b>x</b>', 'x'] },
  { label: 'memory nameless root', type: 'memoryManager', files: [['nameless.yaml', yaml('version: 1.0.0')]], ask: ['Unnamed Memory', 'nameless'] },
  { label: 'memory nameless dated', type: 'memoryManager', files: [['2026-01-01/nameless.yaml', yaml('version: 1.0.0')]], ask: ['Unnamed Memory', 'nameless'] },
  { label: 'memory stripped <>', type: 'memoryManager', files: [['stripped.yaml', yaml('name: "<>"')]], ask: ['Unnamed Memory', '<>'] },
  { label: 'memory numeric', type: 'memoryManager', files: [['num.yaml', yaml('name: 123')]], ask: ['123', 'Unnamed Memory', 'num'] },
  { label: 'memory raw R&D / Cafe (metadata block)', type: 'memoryManager', files: [['2026-01-01/rd.yaml', `metadata:\n  name: "R&D"\n  description: d\nentries: []\n`], ['2026-01-01/cafe.yaml', `metadata:\n  name: ${q('Cafe"́')}\n  description: d\nentries: []\n`]] },
  { label: 'memory top-level and metadata names differ', type: 'memoryManager', files: [['both.yaml', `name: top-name\nmetadata:\n  name: inner-name\n  description: d\nentries: []\n`]], ask: ['top-name', 'inner-name'] },
  { label: 'memory ---', type: 'memoryManager', files: [['unnamed.yaml', yaml('name: "---"')]], ask: ['unnamed'] },
  { label: 'memory percent file', type: 'memoryManager', files: [['2026-01-01/save%41.yaml', yaml('name: "percent-dated"')], ['save-50%25.yaml', yaml('name: "Save Fifty"')]], ask: ['save-50%25.yaml', '2026-01-01/save%41.yaml'] },
  { label: 'memory path-syntax name', type: 'memoryManager', files: [['a-b.yaml', yaml('name: "a/b"')], ['system/sys.yaml', yaml('name: "CI/CD Notes"')]] },
  { label: 'memory same basename', type: 'memoryManager', files: [['notes.yaml', yaml('name: root-notes')], ['system/notes.yaml', yaml('name: system-notes')], ['2026-01-01/notes.yaml', yaml('name: dated-notes')]], ask: ['notes.yaml', 'notes', 'system/notes.yaml'] },
];

/** Per case: how many definitions list, and which files are reported failures; an empty listing cannot pass. */
const EXPECTED_LISTING: Record<string, [number, string[]]> = {
  'skill separator-only ---': [1, []],
  'skill separator-only ___': [1, []],
  'skill separator-only ...': [1, []],
  'skill separator-only ///': [1, []],
  'skill stripped <> (default)': [1, []],
  'skill nameless (stem)': [1, []],
  'skill numeric name': [0, ['num.md']],
  'skill boolean name': [0, ['bool.md']],
  'skill explicit default': [1, []],
  'skill percent file': [1, []],
  'skill path-syntax stored names': [3, []],
  'skill sanitized <b>x</b>': [1, []],
  'persona stripped <> (stored identity)': [1, []],
  'persona nameless': [1, []],
  'persona numeric': [0, ['num.md']],
  'persona raw R&D / Cafe': [2, []],
  'persona ---': [1, []],
  'persona <b>x</b>': [1, []],
  'memory nameless root': [1, []],
  'memory nameless dated': [1, []],
  'memory stripped <>': [0, ['stripped.yaml']],
  'memory numeric': [0, ['num.yaml']],
  'memory raw R&D / Cafe (metadata block)': [2, []],
  'memory top-level and metadata names differ': [1, []],
  'memory ---': [1, []],
  'memory percent file': [2, []],
  'memory path-syntax name': [0, ['a-b.yaml', 'system/sys.yaml']],
  'memory same basename': [3, []],
};

/** A lookup outcome the corpus allows: nothing, a typed refusal, or a definition the rule accepts. */
async function expectAcceptedOrRefused(manager: any, text: string): Promise<void> {
  let found: any;
  try {
    found = await manager.findByName(text);
  } catch (error) {
    expect(error instanceof ElementReadError || error instanceof ValidationError).toBe(true);
    return;
  }
  if (!found) return;
  const reference = found.getFilePath?.() ?? found.filePath;
  expect(acceptsDirectDefinition(text, reference, found.metadata.name, (name: string) => manager.getElementFilename(name))).toBe(true);
}

describe('unusual-name corpus', () => {
  it('pins the expected listing of every case', () => {
    expect(Object.keys(EXPECTED_LISTING).sort()).toEqual(cases.map(testCase => testCase.label).sort());
  });

  it.each(cases.map(testCase => [testCase.label, testCase] as const))('%s', async (_label, testCase) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unusual-names-'));
    const suite: any = createRealManagerSuite(root);
    const manager = suite[testCase.type];
    try {
      const dir = testCase.type === 'memoryManager' ? manager['memoriesDir'] : manager['elementDir'];
      for (const [relative, body] of testCase.files) {
        await mkdir(path.dirname(path.join(dir, ...relative.split('/'))), { recursive: true });
        await writeFile(path.join(dir, ...relative.split('/')), body);
      }
      const report = await manager.listReport();
      expect([report.items.length, report.failures.map((failure: { reference: string }) => failure.reference).sort()])
        .toEqual(EXPECTED_LISTING[testCase.label]);
      const listed: Array<[string, string]> = report.items.map((item: any) => [item.metadata.name, item.getFilePath?.() ?? item.filePath]);
      for (const [name, reference] of listed) {
        for (const temperature of ['warm', 'cold']) {
          if (temperature === 'cold') manager.clearCache();
          const found = await manager.findByName(name);
          expect([temperature, found?.getFilePath?.() ?? found?.filePath]).toEqual([temperature, reference]);
        }
        manager.clearCache();
        expect((await manager.findByStorageIdentity(reference))?.metadata.name).toBe(name);
      }
      for (const text of new Set([...listed.map(([name]) => name), ...(testCase.ask ?? [])])) {
        manager.clearCache();
        await expectAcceptedOrRefused(manager, text);
      }
    } finally {
      await Promise.all([suite.memoryManager.dispose(), suite.skillManager.dispose(), suite.personaManager.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
