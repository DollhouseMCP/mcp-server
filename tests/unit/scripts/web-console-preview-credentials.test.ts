import { afterEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPreviewCredentialFile,
  removePreviewCredentialFile,
} from '../../../scripts/lib/web-console-preview-credentials.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('web console preview credentials', () => {
  it('writes credentials to an unpredictable owner-readable file', () => {
    const directory = createTempDirectory();
    const firstPath = createPreviewCredentialFile(directory, {
      username: 'e2e_admin',
      password: 'first-secret',
    });
    const secondPath = createPreviewCredentialFile(directory, {
      username: 'e2e_admin',
      password: 'second-secret',
    });

    expect(firstPath).not.toBe(secondPath);
    expect(JSON.parse(fs.readFileSync(firstPath, 'utf8'))).toEqual({
      username: 'e2e_admin',
      password: 'first-secret',
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(firstPath).mode & 0o777).toBe(0o600);
    }
  });

  it('removes the credential file and tolerates repeated cleanup', () => {
    const directory = createTempDirectory();
    const credentialPath = createPreviewCredentialFile(directory, {
      username: 'e2e_admin',
      password: 'temporary-secret',
    });

    removePreviewCredentialFile(credentialPath);
    expect(fs.existsSync(credentialPath)).toBe(false);
    expect(() => removePreviewCredentialFile(credentialPath)).not.toThrow();
  });

  it('keeps the preview launcher from writing the password to stdout', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'web-console-preview.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/console\.log\([^\n]*SEED_PASSWORD/);
    expect(source).toContain('createPreviewCredentialFile');
    expect(source).toContain('removePreviewCredentialFile');
  });
});

function createTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dollhouse-preview-credentials-'));
  tempDirectories.push(directory);
  return directory;
}
