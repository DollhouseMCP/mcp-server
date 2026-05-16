import { describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadPermissionAuditArtifactConfig,
  PermissionAuditArtifactWriter,
  renderPermissionAuditMarkdown,
} from '../../../src/utils/permissionAuditArtifacts.js';

describe('permissionAuditArtifacts', () => {
  it('loads disabled local-file config with a safe default path', () => {
    const homeDir = path.join(tmpdir(), 'dollhouse-audit-home');
    const config = loadPermissionAuditArtifactConfig(homeDir, {});

    expect(config).toEqual({
      enabled: false,
      destination: {
        type: 'localFile',
        path: path.join(homeDir, '.dollhouse', 'audit', 'permission-audit.md'),
      },
    });
  });

  it('expands admin-controlled local file destinations', () => {
    const homeDir = path.join(tmpdir(), 'dollhouse-audit-home');
    const config = loadPermissionAuditArtifactConfig(homeDir, {
      DOLLHOUSE_PERMISSION_AUDIT_FILE_ENABLED: 'true',
      DOLLHOUSE_PERMISSION_AUDIT_FILE_PATH: '~/.dollhouse/audit/team-permissions.md',
    });

    expect(config.enabled).toBe(true);
    expect(config.destination).toEqual({
      type: 'localFile',
      path: path.join(homeDir, '.dollhouse', 'audit', 'team-permissions.md'),
    });
  });

  it('renders captured decisions as markdown', () => {
    const markdown = renderPermissionAuditMarkdown([
      {
        id: 'd-1',
        timestamp: '2026-05-06T20:00:00.000Z',
        tool_name: 'Bash',
        command: 'npm test',
        decision: 'allow',
        reason: 'Allowed by policy',
        targetLabel: 'Command',
        target: 'npm test',
        details: [
          { label: 'Platform', value: 'codex' },
          { label: 'Session', value: 'session-1' },
        ],
      },
    ], '2026-05-06T20:01:00.000Z');

    expect(markdown).toContain('# DollhouseMCP Permissions Audit');
    expect(markdown).toContain('Generated: 2026-05-06T20:01:00.000Z');
    expect(markdown).toContain('## 1. Bash');
    expect(markdown).toContain('- Decision: ALLOW');
    expect(markdown).toContain('- Reason: Allowed by policy');
    expect(markdown).toContain('- Platform: codex');
  });

  it('writes enabled local audit artifacts and records status', async () => {
    const tempHome = await mkdtemp(path.join(tmpdir(), 'permission-audit-home-'));
    const auditPath = path.join(tempHome, '.dollhouse', 'audit', 'permissions.md');
    const writer = new PermissionAuditArtifactWriter({
      enabled: true,
      destination: { type: 'localFile', path: auditPath },
    });

    await writer.write([
      {
        id: 'd-1',
        timestamp: '2026-05-06T20:00:00.000Z',
        tool_name: 'Read',
        decision: 'allow',
        details: [{ label: 'File', value: '/workspace/README.md' }],
      },
    ]);

    const content = await readFile(auditPath, 'utf-8');
    expect(content).toContain('## 1. Read');
    expect(content).toContain('- File: /workspace/README.md');
    expect(writer.getStatus()).toEqual(expect.objectContaining({
      enabled: true,
      available: true,
      lastDecisionId: 'd-1',
      lastWriteAt: expect.any(String),
    }));

    await rm(tempHome, { recursive: true, force: true });
  });

  it('keeps unsupported destination types fail-soft and visible in status', async () => {
    const writer = new PermissionAuditArtifactWriter({
      enabled: true,
      destination: { type: 'cloudStorage' },
    });

    await writer.write([
      {
        id: 'd-1',
        timestamp: '2026-05-06T20:00:00.000Z',
        tool_name: 'Bash',
        decision: 'deny',
      },
    ]);

    expect(writer.getStatus()).toEqual(expect.objectContaining({
      enabled: true,
      available: false,
      destination: { type: 'cloudStorage' },
      lastError: expect.stringContaining('Unsupported permission audit destination type'),
    }));
  });
});
