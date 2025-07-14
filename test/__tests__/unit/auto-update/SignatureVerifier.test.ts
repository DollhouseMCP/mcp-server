import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock the git module before importing SignatureVerifier
jest.unstable_mockModule('../../../../src/utils/git.js', () => ({
  safeExec: jest.fn(),
  exec: jest.fn(),
  getCurrentGitBranch: jest.fn(),
  getCurrentGitCommit: jest.fn(),
  hasUncommittedChanges: jest.fn()
}));

// Import after mocking
const { safeExec } = await import('../../../../src/utils/git.js');
const { SignatureVerifier } = await import('../../../../src/update/SignatureVerifier.js');
const mockSafeExec = safeExec as jest.MockedFunction<typeof safeExec>;

describe('SignatureVerifier', () => {
  let verifier: InstanceType<typeof SignatureVerifier>;
  let tempDir: string;

  beforeEach(async () => {
    // Reset all mocks
    mockSafeExec.mockReset();
    verifier = new SignatureVerifier();
    
    // Create temp directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sig-test-'));
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('verifyTagSignature', () => {
    it('should verify a valid signed tag', async () => {
      mockSafeExec.mockImplementation(async (command, args) => {
        if (command === 'gpg' && args[0] === '--version') {
          return { stdout: 'gpg (GnuPG) 2.2.0', stderr: '' };
        }
        if (command === 'git' && args[0] === 'verify-tag') {
          return {
            stdout: '',
            stderr: 'gpg: Good signature from "Test User <test@example.com>" [ultimate]\n' +
                   'gpg: using RSA key ID ABCD1234EFGH5678\n' +
                   'gpg: signature made Mon Jan 1 12:00:00 2024 UTC'
          };
        }
        throw new Error('Unexpected command');
      });

      const result = await verifier.verifyTagSignature('v1.2.0');
      
      expect(result.verified).toBe(true);
      expect(result.signerEmail).toBe('Test User <test@example.com>');
      expect(result.signerKey).toBe('ABCD1234EF');  // Regex captures partial key
      expect(result.signatureDate).toBeInstanceOf(Date);
    });

    it('should fail verification for unsigned tag', async () => {
      mockSafeExec.mockImplementation(async (command, args) => {
        if (command === 'gpg' && args[0] === '--version') {
          return { stdout: 'gpg (GnuPG) 2.2.0', stderr: '' };
        }
        if (command === 'git' && args[0] === 'verify-tag') {
          throw new Error('error: no signature found');
        }
        throw new Error('Unexpected command');
      });

      const result = await verifier.verifyTagSignature('v1.2.0');
      
      expect(result.verified).toBe(false);
      expect(result.error).toContain('no signature found');
    });

    it('should allow unsigned tags in development mode', async () => {
      const devVerifier = new SignatureVerifier({ allowUnsignedInDev: true });
      
      mockSafeExec.mockImplementation(async (command, args) => {
        if (command === 'gpg' && args[0] === '--version') {
          return { stdout: 'gpg (GnuPG) 2.2.0', stderr: '' };
        }
        if (command === 'git' && args[0] === 'verify-tag') {
          return {
            stdout: '',
            stderr: 'error: no signature found'
          };
        }
        throw new Error('Unexpected command');
      });

      const result = await devVerifier.verifyTagSignature('v1.2.0');
      
      expect(result.verified).toBe(true);
      expect(result.error).toContain('allowed in development');
    });

    it('should fail for invalid signature', async () => {
      mockSafeExec.mockImplementation(async (command, args) => {
        if (command === 'gpg' && args[0] === '--version') {
          return { stdout: 'gpg (GnuPG) 2.2.0', stderr: '' };
        }
        if (command === 'git' && args[0] === 'verify-tag') {
          return {
            stdout: '',
            stderr: 'gpg: BAD signature from "Test User <test@example.com>"'
          };
        }
        throw new Error('Unexpected command');
      });

      const result = await verifier.verifyTagSignature('v1.2.0');
      
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('should check trusted keys', async () => {
      const trustedVerifier = new SignatureVerifier({
        trustedKeys: ['ABCD1234']  // This is in our trusted list
      });

      mockSafeExec.mockImplementation(async (command, args) => {
        if (command === 'gpg' && args[0] === '--version') {
          return { stdout: 'gpg (GnuPG) 2.2.0', stderr: '' };
        }
        if (command === 'git' && args[0] === 'verify-tag') {
          return {
            stdout: '',
            stderr: 'gpg: Good signature from "Test User <test@example.com>"\n' +
                   'gpg: using RSA key ID DEADBEEF5678ABCD'  // Different key not in trusted list
          };
        }
        throw new Error('Unexpected command');
      });

      const result = await trustedVerifier.verifyTagSignature('v1.2.0');
      
      expect(result.verified).toBe(false);
      expect(result.error).toContain('not in trusted keys list');
    });

    it('should handle GPG not installed', async () => {
      mockSafeExec.mockImplementation(async () => {
        throw new Error('Command not found: gpg');
      });

      const result = await verifier.verifyTagSignature('v1.2.0');
      
      expect(result.verified).toBe(false);
      expect(result.error).toContain('GPG is not installed');
    });
  });

  describe('verifyChecksum', () => {
    it('should verify a valid checksum', async () => {
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'Hello, World!');
      
      // Expected SHA256 of "Hello, World!"
      const expectedChecksum = 'dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f';
      
      const result = await verifier.verifyChecksum(testFile, expectedChecksum);
      
      expect(result.verified).toBe(true);
      expect(result.actualChecksum).toBe(expectedChecksum);
    });

    it('should fail for incorrect checksum', async () => {
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'Hello, World!');
      
      const wrongChecksum = '0000000000000000000000000000000000000000000000000000000000000000';
      
      const result = await verifier.verifyChecksum(testFile, wrongChecksum);
      
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Checksum mismatch');
    });

    it('should handle missing file', async () => {
      const missingFile = path.join(tempDir, 'missing.txt');
      
      const result = await verifier.verifyChecksum(missingFile, 'any-checksum');
      
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Failed to verify checksum');
    });

    it('should be case-insensitive for checksums', async () => {
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'Hello, World!');
      
      const checksumLower = 'dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f';
      const checksumUpper = 'DFFD6021BB2BD5B0AF676290809EC3A53191DD81C7F70A4B28688A362182986F';
      
      const result = await verifier.verifyChecksum(testFile, checksumUpper);
      
      expect(result.verified).toBe(true);
      expect(result.actualChecksum?.toLowerCase()).toBe(checksumLower);
    });
  });

  describe('verifyReleaseArtifacts', () => {
    it('should verify all artifacts from checksums file', async () => {
      // Create test files
      await fs.writeFile(path.join(tempDir, 'file1.txt'), 'Content 1');
      await fs.writeFile(path.join(tempDir, 'file2.txt'), 'Content 2');
      
      // Create checksums file
      const checksums = 
        '5c2b7a0c4c2f0c2a5c2b7a0c4c2f0c2a5c2b7a0c4c2f0c2a5c2b7a0c4c2f0c2a  file1.txt\n' +
        '6d3c8b1d5d3f1d3b6d3c8b1d5d3f1d3b6d3c8b1d5d3f1d3b6d3c8b1d5d3f1d3b  *file2.txt';
      
      await fs.writeFile(path.join(tempDir, 'SHA256SUMS'), checksums);
      
      // Mock actual checksums
      jest.spyOn(verifier, 'verifyChecksum').mockImplementation(async (filePath: string, expected: string) => {
        if (filePath.endsWith('file1.txt')) {
          return { verified: true, expectedChecksum: expected, actualChecksum: expected };
        }
        if (filePath.endsWith('file2.txt')) {
          return { verified: false, expectedChecksum: expected, actualChecksum: 'different', error: 'Checksum mismatch' };
        }
        return { verified: false, error: 'Unknown file' } as any;
      });
      
      const results = await verifier.verifyReleaseArtifacts(
        path.join(tempDir, 'SHA256SUMS'),
        tempDir
      );
      
      expect(results.size).toBe(2);
      expect(results.get('file1.txt')?.verified).toBe(true);
      expect(results.get('file2.txt')?.verified).toBe(false);
    });

    it('should handle missing checksums file', async () => {
      const results = await verifier.verifyReleaseArtifacts(
        path.join(tempDir, 'missing-checksums.txt'),
        tempDir
      );
      
      expect(results.size).toBe(1);
      expect(results.get('*')?.verified).toBe(false);
      expect(results.get('*')?.error).toContain('Failed to read checksums file');
    });
  });

  describe('trusted keys management', () => {
    it('should add and remove trusted keys', () => {
      const verifier = new SignatureVerifier();
      
      expect(verifier.getTrustedKeys()).toEqual([]);
      
      verifier.addTrustedKey('key123');
      expect(verifier.getTrustedKeys()).toContain('KEY123'); // Uppercase
      
      verifier.addTrustedKey('key456');
      expect(verifier.getTrustedKeys()).toHaveLength(2);
      
      verifier.removeTrustedKey('KEY123');
      expect(verifier.getTrustedKeys()).toEqual(['KEY456']);
    });
  });

  describe('importPublicKey', () => {
    it('should import a GPG key', async () => {
      const keyData = '-----BEGIN PGP PUBLIC KEY BLOCK-----\ntest key data\n-----END PGP PUBLIC KEY BLOCK-----';
      
      mockSafeExec.mockResolvedValueOnce({ stdout: 'gpg: key imported', stderr: '' });
      
      const result = await verifier.importPublicKey(keyData);
      
      expect(result).toBe(true);
      expect(mockSafeExec).toHaveBeenCalledWith('gpg', ['--import', expect.stringContaining('.asc')]);
    });

    it('should handle import failure', async () => {
      const keyData = 'invalid key data';
      
      mockSafeExec.mockRejectedValueOnce(new Error('gpg: no valid data found'));
      
      const result = await verifier.importPublicKey(keyData);
      
      expect(result).toBe(false);
    });
  });
});