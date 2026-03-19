import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DependencyScanner } from '../../../../src/security/audit/scanners/DependencyScanner.js';

const scannerConfig = {
  enabled: true,
  severityThreshold: 'low' as const,
  checkLicenses: true,
  allowedLicenses: ['MIT', 'Apache-2.0']
};

describe('DependencyScanner', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dep-scan-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeLock(dependencies: Record<string, any>): Promise<void> {
    const lockPath = path.join(tempDir, 'package-lock.json');
    const content = {
      name: 'test-project',
      lockfileVersion: 2,
      dependencies
    };
    await fs.writeFile(lockPath, JSON.stringify(content, null, 2), 'utf-8');
  }

  it('flags known vulnerable dependencies', async () => {
    await writeLock({
      lodash: { version: '4.17.20', license: 'MIT' }
    });

    const scanner = new DependencyScanner(scannerConfig);
    const findings = await scanner.scan({ projectRoot: tempDir });

    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('DEPENDENCY-LODASH-2021-23337');
    expect(findings[0].severity).toBe('high');
  });

  it('reports disallowed licenses when enabled', async () => {
    await writeLock({
      custom: { version: '1.0.0', license: 'GPL-3.0' }
    });

    const scanner = new DependencyScanner(scannerConfig);
    const findings = await scanner.scan({ projectRoot: tempDir });

    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('DEPENDENCY-DISALLOWED-LICENSE');
    expect(findings[0].message).toContain('custom@1.0.0');
  });

  it('respects severity threshold', async () => {
    await writeLock({
      xml2js: { version: '0.4.19', license: 'MIT' }
    });

    const scanner = new DependencyScanner({
      ...scannerConfig,
      severityThreshold: 'high'
    });
    const findings = await scanner.scan({ projectRoot: tempDir });

    expect(findings).toHaveLength(0);
  });
});
