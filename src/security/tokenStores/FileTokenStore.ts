import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { homedir } from 'node:os';

import type { IFileOperationsService } from '../../services/FileOperationsService.js';
import type { PathService } from '../../paths/PathService.js';
import type { ITokenStore } from './ITokenStore.js';

export const TOKEN_FILE_NAME = 'github_token.enc';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const ITERATIONS = 100000;

/**
 * Filesystem-backed encrypted token store.
 *
 * This class deliberately stores no path string. Every operation receives an
 * explicit userId and resolves that user's auth directory at call time.
 */
export class FileTokenStore implements ITokenStore {
  constructor(
    private readonly fileOperations: IFileOperationsService,
    private readonly pathService: Pick<PathService, 'getUserAuthDir'>,
  ) {}

  async storeToken(userId: string, token: string): Promise<void> {
    const tokenDir = this.pathService.getUserAuthDir(userId);
    const tokenPath = path.join(tokenDir, TOKEN_FILE_NAME);

    await this.fileOperations.createDirectory(tokenDir);
    await this.fileOperations.chmod(tokenDir, 0o700, {
      source: 'TokenManager.storeGitHubToken',
    });

    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(getPassphrase(), salt);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const stored = Buffer.concat([salt, iv, tag, encrypted]);

    await this.fileOperations.writeFile(tokenPath, stored.toString('base64'), {
      source: 'TokenManager.storeGitHubToken',
    });
    await this.fileOperations.chmod(tokenPath, 0o600, {
      source: 'TokenManager.storeGitHubToken',
    });
  }

  async retrieveToken(userId: string): Promise<string | null> {
    const tokenPath = path.join(this.pathService.getUserAuthDir(userId), TOKEN_FILE_NAME);
    const exists = await this.fileOperations.exists(tokenPath);
    if (!exists) return null;

    const base64Content = await this.fileOperations.readFile(tokenPath, {
      source: 'TokenManager.retrieveGitHubToken',
    });
    const stored = Buffer.from(base64Content, 'base64');

    const salt = stored.subarray(0, SALT_LENGTH);
    const iv = stored.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = stored.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = stored.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

    return decryptWithFallback(salt, iv, tag, encrypted);
  }

  async deleteToken(userId: string): Promise<void> {
    const tokenPath = path.join(this.pathService.getUserAuthDir(userId), TOKEN_FILE_NAME);
    const exists = await this.fileOperations.exists(tokenPath);
    if (!exists) return;

    await this.fileOperations.deleteFile(tokenPath, undefined, {
      source: 'TokenManager.removeStoredToken',
    });
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

function getPassphrase(): string {
  return process.env.DOLLHOUSE_TOKEN_SECRET || getMachinePassphrase();
}

function getMachinePassphrase(): string {
  const hostname = crypto.createHash('sha256').update(homedir()).digest('hex').substring(0, 16);
  const username = crypto.createHash('sha256').update(process.env.USER || 'default').digest('hex').substring(0, 16);
  const appId = 'DollhouseMCP-TokenStore-v1';

  return `${appId}-${hostname}-${username}`;
}

function decryptWithFallback(salt: Buffer, iv: Buffer, tag: Buffer, encrypted: Buffer): string {
  const primaryPassphrase = getPassphrase();
  try {
    return decryptToken(primaryPassphrase, salt, iv, tag, encrypted);
  } catch {
    const machinePassphrase = getMachinePassphrase();
    if (machinePassphrase !== primaryPassphrase) {
      return decryptToken(machinePassphrase, salt, iv, tag, encrypted);
    }
    throw new Error('Token decryption failed');
  }
}

function decryptToken(passphrase: string, salt: Buffer, iv: Buffer, tag: Buffer, encrypted: Buffer): string {
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
