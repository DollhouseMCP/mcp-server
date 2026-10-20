import type { SerializationService } from '../../../src/services/SerializationService.js';
import { jest } from '@jest/globals';
import postgres from 'postgres';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';
import { FrontmatterParser } from '../../../src/storage/FrontmatterParser.js';

export interface OperationCounts {
  dataStatements: number;
  setupStatements: number;
  otherStatements: number;
  rawContentBytes: number;
  fileReads: number;
  fileBytes: number;
  yamlParses: number;
  indexParses: number;
}

/** Counts completed reads and submitted SQL; no clock, polling or cache decisions. */
export class OperationCounter {
  private counts: OperationCounts = this.empty();
  private nestedParseDepth = 0;

  private empty(): OperationCounts {
    return { dataStatements: 0, setupStatements: 0, otherStatements: 0,
      rawContentBytes: 0, fileReads: 0, fileBytes: 0, yamlParses: 0, indexParses: 0 };
  }

  reset(): void { this.counts = this.empty(); }
  snapshot(): OperationCounts { return { ...this.counts }; }

  statement(query: string): void {
    const text = query.trim();
    if (/^(?:begin|commit|rollback|savepoint|release|set)\b/i.test(text) || /\bset_config\s*\(/i.test(text)) {
      this.counts.setupStatements++;
    } else if (/^(?:select|insert|update|delete)\b/i.test(text) &&
      /\b(?:from|join|into|update)\s+(?:"?\w+"?\.)?"?(?:elements|memory_entries|element_tags)"?\b/i.test(text)) {
      this.counts.dataStatements++;
    } else {
      this.counts.otherStatements++;
    }
  }

  returnedValue(value: unknown, column: string): unknown {
    if (column === 'raw_content' && typeof value === 'string') {
      this.counts.rawContentBytes += Buffer.byteLength(value, 'utf8');
    }
    return value;
  }

  /** Driver hooks cover transactions and array-mode Drizzle results without changing either. */
  client(url: string): ReturnType<typeof postgres> {
    return postgres(url, { max: 1, ssl: false,
      debug: (_connection, query) => { this.statement(query); },
      transform: { value: { from: (value, column) => this.returnedValue(value, column.name) } },
    });
  }

  /** Install per fixture, restore before disposing; predicate excludes config and other files. */
  observeFiles(service: FileOperationsService, isElementFile: (file: string) => boolean): () => void {
    const read = service.readFile.bind(service);
    const spy = jest.spyOn(service, 'readFile').mockImplementation(async (file, options) => {
      const content = await read(file, options);
      if (isElementFile(file)) {
        this.counts.fileReads++;
        this.counts.fileBytes += Buffer.byteLength(content, 'utf8');
      }
      return content;
    });
    return () => spy.mockRestore();
  }

  /** Count loader entry calls, excluding nested validation and index parsing. */
  observeYaml(): () => void {
    const raw = SecureYamlParser.parseRawYaml.bind(SecureYamlParser);
    const rawSpy = jest.spyOn(SecureYamlParser, 'parseRawYaml').mockImplementation((...args) => {
      if (this.nestedParseDepth === 0) this.counts.yamlParses++;
      return raw(...args);
    });
    const direct = SecureYamlParser.parse.bind(SecureYamlParser);
    const directSpy = jest.spyOn(SecureYamlParser, 'parse').mockImplementation((...args) => {
      if (this.nestedParseDepth === 0) this.counts.yamlParses++;
      return direct(...args);
    });
    const parse = SecureYamlParser.safeMatter.bind(SecureYamlParser);
    const spy = jest.spyOn(SecureYamlParser, 'safeMatter').mockImplementation((...args) => {
      this.counts.yamlParses++;
      this.nestedParseDepth++;
      try { return parse(...args); } finally { this.nestedParseDepth--; }
    });
    return () => { spy.mockRestore(); directSpy.mockRestore(); rawSpy.mockRestore(); };
  }

  /** Shared pure-YAML parser seam, including memory documents; no manager hooks. */
  observePureYaml(service: SerializationService): () => void {
    const parse = service.parsePureYaml.bind(service);
    const spy = jest.spyOn(service, 'parsePureYaml').mockImplementation((...args) => {
      this.counts.yamlParses++;
      return parse(...args);
    });
    return () => spy.mockRestore();
  }

  /** Index extraction is separate from loader parsing and safeMatter's internal parse. */
  observeIndexParses(): () => void {
    const parse = FrontmatterParser.extractMetadata.bind(FrontmatterParser);
    const spy = jest.spyOn(FrontmatterParser, 'extractMetadata').mockImplementation((...args) => {
      this.counts.indexParses++;
      this.nestedParseDepth++;
      try { return parse(...args); } finally { this.nestedParseDepth--; }
    });
    return () => spy.mockRestore();
  }
}
