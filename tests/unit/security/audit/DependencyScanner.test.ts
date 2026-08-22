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

  async function writeLock(dependencies: Record<string, unknown>): Promise<void> {
    const lockPath = path.join(tempDir, 'package-lock.json');
    const content = {
      name: 'test-project',
      lockfileVersion: 2,
      dependencies
    };
    await fs.writeFile(lockPath, JSON.stringify(content, null, 2), 'utf-8');
  }

  async function writeModernLock(packages: Record<string, unknown>): Promise<void> {
    const lockPath = path.join(tempDir, 'package-lock.json');
    const content = {
      name: 'test-project',
      lockfileVersion: 3,
      packages
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

  it('accepts an SPDX OR expression when one complete alternative is allowed', async () => {
    await writeLock({
      custom: { version: '1.0.0', license: '(MPL-2.0 OR Apache-2.0)' }
    });

    const findings = await new DependencyScanner(scannerConfig).scan({ projectRoot: tempDir });

    expect(findings).toEqual([]);
  });

  it('requires every term in an SPDX AND expression to be allowed', async () => {
    await writeLock({
      custom: { version: '1.0.0', license: 'MIT AND GPL-3.0' }
    });

    const findings = await new DependencyScanner(scannerConfig).scan({ projectRoot: tempDir });

    expect(findings.map(({ ruleId }) => ruleId)).toEqual(['DEPENDENCY-DISALLOWED-LICENSE']);
  });

  it('applies reviewed license overrides only to the named package', async () => {
    await writeLock({
      inspector: { version: '1.0.0', license: 'SEE LICENSE IN LICENSE' },
      impersonator: { version: '1.0.0', license: 'SEE LICENSE IN LICENSE' }
    });

    const scanner = new DependencyScanner({
      ...scannerConfig,
      licenseOverrides: { inspector: 'Apache-2.0 OR MIT' }
    });
    const findings = await scanner.scan({ projectRoot: tempDir });

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('impersonator@1.0.0');
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

  it('detects every cooling-policy advisory, including parallel js-yaml majors', async () => {
    await writeModernLock({
      '': { name: 'test-project', version: '1.0.0' },
      'node_modules/fast-uri': { name: 'fast-uri', version: '3.1.0', license: 'MIT' },
      'node_modules/ip-address': { name: 'ip-address', version: '10.1.0', license: 'MIT' },
      'node_modules/js-yaml': { name: 'js-yaml', version: '4.1.1', license: 'MIT' },
      'node_modules/legacy/node_modules/js-yaml': { name: 'js-yaml', version: '3.14.2', license: 'MIT' },
      'node_modules/dompurify': { name: 'dompurify', version: '3.3.1', license: 'MIT' },
      'node_modules/hono': { name: 'hono', version: '4.11.10', license: 'MIT' },
      'node_modules/@hono/node-server': { name: '@hono/node-server', version: '1.19.9', license: 'MIT' },
      'node_modules/body-parser': { name: 'body-parser', version: '2.2.2', license: 'MIT' }
    });

    const findings = await new DependencyScanner(scannerConfig).scan({ projectRoot: tempDir });
    const ruleIds = findings.map(({ ruleId }) => ruleId);

    expect(ruleIds).toEqual(expect.arrayContaining([
      'DEPENDENCY-FAST-URI-HOST-CONFUSION',
      'DEPENDENCY-IP-ADDRESS-TRUST-BOUNDARY',
      'DEPENDENCY-JS-YAML-3X-DOS',
      'DEPENDENCY-JS-YAML-4X-DOS',
      'DEPENDENCY-DOMPURIFY-XSS',
      'DEPENDENCY-HONO-4X-REQUEST-SAFETY',
      'DEPENDENCY-HONO-NODE-SERVER-PATH-TRAVERSAL',
      'DEPENDENCY-BODY-PARSER-LIMIT-DOS'
    ]));
  });

  it('retains high cooling-policy advisories at a high severity threshold', async () => {
    await writeModernLock({
      'node_modules/fast-uri': { name: 'fast-uri', version: '3.1.0', license: 'MIT' },
      'node_modules/dompurify': { name: 'dompurify', version: '3.3.1', license: 'MIT' },
      'node_modules/body-parser': { name: 'body-parser', version: '2.2.2', license: 'MIT' }
    });

    const scanner = new DependencyScanner({ ...scannerConfig, severityThreshold: 'high' });
    const findings = await scanner.scan({ projectRoot: tempDir });

    expect(findings.map(({ ruleId }) => ruleId)).toEqual(['DEPENDENCY-FAST-URI-HOST-CONFUSION']);
  });

  it('fails closed when package-lock.json is malformed', async () => {
    await fs.writeFile(path.join(tempDir, 'package-lock.json'), '{broken', 'utf-8');

    const scanner = new DependencyScanner(scannerConfig);

    await expect(scanner.scan({ projectRoot: tempDir })).rejects.toThrow(
      /DependencyScanner could not read or parse/,
    );
  });
});
