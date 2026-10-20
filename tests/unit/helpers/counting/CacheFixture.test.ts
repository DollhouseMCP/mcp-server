import { rm } from 'node:fs/promises';
import { describe, expect, it, jest } from '@jest/globals';
import { cacheFixture } from '../../../helpers/counting/CacheFixture.js';
import { OperationCounter } from '../../../helpers/counting/OperationCounter.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { SecureYamlParser } from '../../../../src/security/secureYamlParser.js';
import { FrontmatterParser } from '../../../../src/storage/FrontmatterParser.js';

describe('cacheFixture construction cleanup', () => {
  it.each([false, true])('restores observers and closes the client when priming fails (disposal rejects: %s)', async disposalRejects => {
    const environmentKeys = ['HOME', 'DOLLHOUSE_HOME_DIR', 'DOLLHOUSE_PORTFOLIO_DIR'] as const;
    const environment = environmentKeys.map(key => process.env[key]);
    let temporaryHome: string | undefined;
    const failure = new Error('priming failed');
    const originalParsers = [SecureYamlParser.safeMatter, SecureYamlParser.parse,
      SecureYamlParser.parseRawYaml, FrontmatterParser.extractMetadata];
    const watcherKeys = ['DOLLHOUSE_ENABLE_FILE_WATCHER', 'AUTO_RELOAD_ON_EXTERNAL_CHANGE'] as const;
    const previousWatchers = watcherKeys.map(key => process.env[key]);
    let files: FileOperationsService | undefined;
    let serialization: SerializationService | undefined;
    let originalRead: FileOperationsService['readFile'] | undefined;
    let originalPureYaml: SerializationService['parsePureYaml'] | undefined;
    const observeFiles = OperationCounter.prototype.observeFiles;
    const fileObserver = jest.spyOn(OperationCounter.prototype, 'observeFiles').mockImplementation(function (this: OperationCounter, service, predicate) {
      files = service;
      originalRead = service.readFile;
      return observeFiles.call(this, service, predicate);
    });
    const observePureYaml = OperationCounter.prototype.observePureYaml;
    const pureObserver = jest.spyOn(OperationCounter.prototype, 'observePureYaml').mockImplementation(function (this: OperationCounter, service) {
      serialization = service;
      originalPureYaml = service.parsePureYaml;
      return observePureYaml.call(this, service);
    });
    const end = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const query = Object.assign(jest.fn(async () => {
      temporaryHome = process.env.DOLLHOUSE_HOME_DIR;
      expect(jest.isMockFunction(files?.readFile)).toBe(true);
      expect(jest.isMockFunction(serialization?.parsePureYaml)).toBe(true);
      expect(jest.isMockFunction(FrontmatterParser.extractMetadata)).toBe(true);
      throw failure;
    }), { end, options: { parsers: {}, serializers: {} } });
    const client = jest.spyOn(OperationCounter.prototype, 'client')
      .mockReturnValue(query as unknown as ReturnType<OperationCounter['client']>);
    const originalDispose = DollhouseContainer.prototype.dispose;
    const dispose = jest.spyOn(DollhouseContainer.prototype, 'dispose').mockImplementation(async function (this: DollhouseContainer) {
      await originalDispose.call(this);
      if (disposalRejects) throw new Error('disposal failed');
    });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(cacheFixture('db', { url: 'postgres://unused', userId: 'unused' })).rejects.toBe(failure);
      expect(query).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(files?.readFile).toBe(originalRead);
      expect(serialization?.parsePureYaml).toBe(originalPureYaml);
      expect([SecureYamlParser.safeMatter, SecureYamlParser.parse,
        SecureYamlParser.parseRawYaml, FrontmatterParser.extractMetadata]).toEqual(originalParsers);
      expect(watcherKeys.map(key => process.env[key])).toEqual(previousWatchers);
      expect(errors).toHaveBeenCalledTimes(Number(disposalRejects));
    } finally {
      environmentKeys.forEach((key, index) => {
        if (environment[index] === undefined) delete process.env[key];
        else process.env[key] = environment[index];
      });
      if (temporaryHome?.includes('/dollhouse-integration-')) await rm(temporaryHome, { recursive: true, force: true });
      fileObserver.mockRestore(); pureObserver.mockRestore(); client.mockRestore(); dispose.mockRestore(); errors.mockRestore();
    }
  });
});
