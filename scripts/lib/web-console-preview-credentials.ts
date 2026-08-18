import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface PreviewCredentials {
  readonly username: string;
  readonly password: string;
}

interface NodeError extends Error {
  readonly code?: string;
}

export function createPreviewCredentialFile(
  directory: string,
  credentials: PreviewCredentials,
): string {
  const credentialPath = path.join(
    directory,
    `.preview-credentials-${process.pid}-${randomUUID()}.json`,
  );
  const content = `${JSON.stringify(credentials, null, 2)}\n`;

  writeFileSync(credentialPath, content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });

  return credentialPath;
}

export function removePreviewCredentialFile(credentialPath: string): void {
  try {
    unlinkSync(credentialPath);
  } catch (error) {
    if ((error as NodeError).code !== 'ENOENT') {
      throw error;
    }
  }
}
