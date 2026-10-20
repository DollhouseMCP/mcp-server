import { SerializationService } from '../../../../src/services/SerializationService.js';
import { describe, it, expect } from '@jest/globals';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OperationCounter } from '../../../helpers/counting/OperationCounter.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { SecureYamlParser } from '../../../../src/security/secureYamlParser.js';
import { FrontmatterParser } from '../../../../src/storage/FrontmatterParser.js';

const ZERO = { dataStatements: 0, setupStatements: 0, otherStatements: 0,
  rawContentBytes: 0, fileReads: 0, fileBytes: 0, yamlParses: 0, indexParses: 0 };

describe('OperationCounter', () => {
  it('counts index extraction separately from loader parsing and restores the observer', () => {
    const counter = new OperationCounter();
    const restoreIndex = counter.observeIndexParses();
    const restoreYaml = counter.observeYaml();
    const content = '---\nname: example\n---\nBody';
    try {
      expect(FrontmatterParser.extractMetadata(content).name).toBe('example');
      expect(counter.snapshot()).toEqual({ ...ZERO, indexParses: 1 });
      SecureYamlParser.safeMatter(content);
      expect(counter.snapshot()).toEqual({ ...ZERO, indexParses: 1, yamlParses: 1 });
      counter.reset();
      expect(counter.snapshot()).toEqual(ZERO);
      restoreIndex();
      restoreYaml();
      FrontmatterParser.extractMetadata(content);
      expect(counter.snapshot()).toEqual(ZERO);
    } finally { restoreIndex(); restoreYaml(); }
  });

  it('counts direct loader parsing while excluding nested wrapper and index parses', () => {
    const counter = new OperationCounter();
    const restoreYaml = counter.observeYaml();
    const restoreIndex = counter.observeIndexParses();
    const content = '---\nname: example\n---\nBody';
    try {
      SecureYamlParser.parse(content);
      SecureYamlParser.parseRawYaml('name: example');
      SecureYamlParser.safeMatter(content);
      FrontmatterParser.extractMetadata(content);
      expect(counter.snapshot()).toEqual({ ...ZERO, yamlParses: 3, indexParses: 1 });
    } finally { restoreIndex(); restoreYaml(); }
  });

  it('counts shared pure-YAML parsing and restores the original parser', () => {
    const counter = new OperationCounter();
    const service = new SerializationService();
    const restore = counter.observePureYaml(service);
    try {
      expect(service.parsePureYaml('name: memory')).toEqual({ name: 'memory' });
      expect(counter.snapshot()).toEqual({ ...ZERO, yamlParses: 1 });
      restore();
      service.parsePureYaml('name: another');
      expect(counter.snapshot().yamlParses).toBe(1);
    } finally { restore(); }
  });

  it.each([
    'SELECT id FROM elements',
    'select "raw_content" from "public"."elements" where id = $1',
    'INSERT INTO memory_entries (id) VALUES ($1)',
    'UPDATE "element_tags" SET tag = $1',
    'DELETE FROM "elements" WHERE id = $1',
  ])('counts data SQL: %s', query => {
    const counter = new OperationCounter();
    counter.statement(query);
    expect(counter.snapshot()).toEqual({ ...ZERO, dataStatements: 1 });
  });

  it.each(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT x', 'RELEASE SAVEPOINT x',
    'SET LOCAL app.current_user_id = $1', "SELECT set_config('app.current_user_id', $1, true)",
    'SET TRANSACTION READ ONLY'])('separates setup: %s', query => {
    const counter = new OperationCounter();
    counter.statement(query);
    expect(counter.snapshot()).toEqual({ ...ZERO, setupStatements: 1 });
  });

  it('excludes unrelated tables and similarly named identifiers', () => {
    const counter = new OperationCounter();
    counter.statement('SELECT * FROM users');
    counter.statement('SELECT * FROM elements_archive');
    expect(counter.snapshot()).toEqual({ ...ZERO, otherStatements: 2 });
  });

  it('counts UTF-8 returned bytes, passes values through, and resets independently of snapshots', () => {
    const counter = new OperationCounter();
    expect(counter.returnedValue('café', 'raw_content')).toBe('café');
    expect(counter.returnedValue(null, 'raw_content')).toBeNull();
    expect(counter.returnedValue('other', 'name')).toBe('other');
    const snapshot = counter.snapshot();
    expect(snapshot).toEqual({ ...ZERO, rawContentBytes: 5 });
    counter.reset();
    expect(counter.snapshot()).toEqual(ZERO);
    expect(snapshot.rawContentBytes).toBe(5);
  });

  it('counts successful selected file reads without changing content or errors', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'count-files-'));
    const file = path.join(dir, 'element.md');
    const config = path.join(dir, 'config.json');
    const service = new FileOperationsService(new FileLockManager());
    const counter = new OperationCounter();
    const restore = counter.observeFiles(service, name => name.endsWith('.md'));
    try {
      await writeFile(file, 'café');
      await writeFile(config, '{}');
      expect(await service.readFile(file)).toBe('café');
      await service.readFile(config);
      await expect(service.readFile(path.join(dir, 'missing.md'))).rejects.toThrow();
      expect(counter.snapshot()).toEqual({ ...ZERO, fileReads: 1, fileBytes: 5 });
      restore();
      await service.readFile(file);
      expect(counter.snapshot().fileReads).toBe(1);
    } finally { restore(); await rm(dir, { recursive: true, force: true }); }
  });

  it('counts one secure parser entry per load and preserves validation failures', () => {
    const counter = new OperationCounter();
    const restore = counter.observeYaml();
    try {
      const result = SecureYamlParser.safeMatter('---\nname: example\n---\nBody');
      expect(result.data.name).toBe('example');
      expect(counter.snapshot().yamlParses).toBe(1);
      expect(() => SecureYamlParser.safeMatter('---\na: [\n---\nBody')).toThrow();
      expect(counter.snapshot().yamlParses).toBe(2);
      restore();
      SecureYamlParser.safeMatter('---\nname: example\n---\nBody');
      expect(counter.snapshot().yamlParses).toBe(2);
    } finally { restore(); }
  });
});
