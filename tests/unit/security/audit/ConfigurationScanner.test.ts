import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ConfigurationScanner } from '../../../../src/security/audit/scanners/ConfigurationScanner.js';

const scannerConfig = {
  enabled: true,
  checkFiles: ['*.json', '*.yml', '.env.example']
};

describe('ConfigurationScanner', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-scan-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('detects insecure env overrides', async () => {
    const envPath = path.join(tempDir, '.env.example');
    await fs.writeFile(envPath, 'DOLLHOUSE_TELEMETRY=true\n', 'utf-8');

    const scanner = new ConfigurationScanner(scannerConfig);
    const findings = await scanner.scan({ projectRoot: tempDir });

    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('CONFIG-TELEMETRY-OPT-IN');
  });

  it('flags bulk preview disabled in JSON config', async () => {
    const configPath = path.join(tempDir, 'app.config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ sync: { bulk: { require_preview: false } } }, null, 2),
      'utf-8'
    );

    const scanner = new ConfigurationScanner(scannerConfig);
    const findings = await scanner.scan({ projectRoot: tempDir });

    expect(findings.map(f => f.ruleId)).toContain('CONFIG-BULK-PREVIEW');
  });

  it('flags disabled secret scanning in YAML config', async () => {
    const yamlPath = path.join(tempDir, 'settings.yml');
    await fs.writeFile(
      yamlPath,
      'sync:\n  privacy:\n    scan_for_secrets: false\n',
      'utf-8'
    );

    const scanner = new ConfigurationScanner(scannerConfig);
    const findings = await scanner.scan({ projectRoot: tempDir });

    expect(findings.map(f => f.ruleId)).toContain('CONFIG-SECRET-SCANNING');
  });
});
