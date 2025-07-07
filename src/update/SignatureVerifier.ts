/**
 * SignatureVerifier - Verifies GitHub release signatures to ensure authenticity
 * 
 * Security features:
 * - Verifies GPG signatures on git tags
 * - Validates release artifacts checksums
 * - Ensures releases come from trusted sources
 * - Prevents tampering and supply chain attacks
 */

import { safeExec } from '../utils/git.js';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface SignatureVerificationResult {
  verified: boolean;
  signerKey?: string;
  signerEmail?: string;
  signatureDate?: Date;
  error?: string;
}

export interface ChecksumVerificationResult {
  verified: boolean;
  expectedChecksum?: string;
  actualChecksum?: string;
  error?: string;
}

export class SignatureVerifier {
  private trustedKeys: Set<string>;
  private allowUnsignedInDev: boolean;
  
  constructor(options?: {
    trustedKeys?: string[];
    allowUnsignedInDev?: boolean;
  }) {
    // Default trusted keys - should be GPG key IDs of maintainers
    this.trustedKeys = new Set(options?.trustedKeys || [
      // Add trusted GPG key fingerprints here
      // Example: '1234567890ABCDEF1234567890ABCDEF12345678'
    ]);
    
    // Allow unsigned releases in development mode
    this.allowUnsignedInDev = options?.allowUnsignedInDev ?? true;
  }
  
  /**
   * Verify a git tag signature
   * @param tagName The tag to verify (e.g., 'v1.2.0')
   * @returns Verification result with signer information
   */
  async verifyTagSignature(tagName: string): Promise<SignatureVerificationResult> {
    try {
      // Check if GPG is available
      try {
        await safeExec('gpg', ['--version']);
      } catch {
        return {
          verified: false,
          error: 'GPG is not installed or not available in PATH'
        };
      }
      
      // Verify the tag signature
      const { stdout, stderr } = await safeExec('git', ['verify-tag', tagName]);
      
      // Parse GPG output (comes on stderr)
      const output = stderr || stdout;
      
      // Check for good signature
      if (!output.includes('Good signature')) {
        // Check if tag is unsigned
        if (output.includes('error: no signature found')) {
          if (this.allowUnsignedInDev && process.env.NODE_ENV !== 'production') {
            return {
              verified: true,
              error: 'Tag is unsigned (allowed in development mode)'
            };
          }
          return {
            verified: false,
            error: 'Tag is not signed'
          };
        }
        
        return {
          verified: false,
          error: 'Invalid signature'
        };
      }
      
      // Extract signer information
      const keyMatch = output.match(/key (?:ID )?([A-F0-9]+)/i);
      const emailMatch = output.match(/"([^"]+)"/);
      const dateMatch = output.match(/made (\w+ \w+ \d+ \d+:\d+:\d+ \d+ \w+)/);
      
      const signerKey = keyMatch ? keyMatch[1] : undefined;
      const signerEmail = emailMatch ? emailMatch[1] : undefined;
      const signatureDate = dateMatch ? new Date(dateMatch[1]) : undefined;
      
      // Check if key is trusted
      if (this.trustedKeys.size > 0 && signerKey) {
        // Check if the key ID ends with any of our trusted keys
        const isTrusted = Array.from(this.trustedKeys).some(trustedKey => 
          signerKey.endsWith(trustedKey.toUpperCase())
        );
        
        if (!isTrusted) {
          return {
            verified: false,
            signerKey,
            signerEmail,
            signatureDate,
            error: `Signature is valid but key ${signerKey} is not in trusted keys list`
          };
        }
      }
      
      return {
        verified: true,
        signerKey,
        signerEmail,
        signatureDate
      };
      
    } catch (error) {
      return {
        verified: false,
        error: `Failed to verify signature: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * Verify a file checksum against expected value
   * @param filePath Path to the file to verify
   * @param expectedChecksum Expected SHA256 checksum
   * @returns Verification result
   */
  async verifyChecksum(filePath: string, expectedChecksum: string): Promise<ChecksumVerificationResult> {
    try {
      // Read file and calculate checksum
      const fileBuffer = await fs.readFile(filePath);
      const hash = crypto.createHash('sha256');
      hash.update(fileBuffer);
      const actualChecksum = hash.digest('hex');
      
      // Compare checksums
      const verified = actualChecksum.toLowerCase() === expectedChecksum.toLowerCase();
      
      return {
        verified,
        expectedChecksum,
        actualChecksum,
        error: verified ? undefined : 'Checksum mismatch'
      };
      
    } catch (error) {
      return {
        verified: false,
        expectedChecksum,
        error: `Failed to verify checksum: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * Verify release artifacts using a checksums file
   * @param checksumsFile Path to checksums file (e.g., SHA256SUMS)
   * @param artifactDir Directory containing artifacts to verify
   * @returns Map of filename to verification result
   */
  async verifyReleaseArtifacts(
    checksumsFile: string, 
    artifactDir: string
  ): Promise<Map<string, ChecksumVerificationResult>> {
    const results = new Map<string, ChecksumVerificationResult>();
    
    try {
      // Read checksums file
      const checksumsContent = await fs.readFile(checksumsFile, 'utf-8');
      const lines = checksumsContent.split('\n').filter(line => line.trim());
      
      // Parse checksums (format: "checksum  filename" or "checksum *filename")
      for (const line of lines) {
        const match = line.match(/^([a-f0-9]+)\s+\*?(.+)$/i);
        if (!match) continue;
        
        const [, checksum, filename] = match;
        const filePath = path.join(artifactDir, filename);
        
        // Verify each file
        const result = await this.verifyChecksum(filePath, checksum);
        results.set(filename, result);
      }
      
      return results;
      
    } catch (error) {
      // If we can't read the checksums file, mark all as unverified
      results.set('*', {
        verified: false,
        error: `Failed to read checksums file: ${error instanceof Error ? error.message : String(error)}`
      });
      return results;
    }
  }
  
  /**
   * Add a trusted key for signature verification
   * @param keyId GPG key ID or fingerprint
   */
  addTrustedKey(keyId: string): void {
    this.trustedKeys.add(keyId.toUpperCase());
  }
  
  /**
   * Remove a trusted key
   * @param keyId GPG key ID or fingerprint
   */
  removeTrustedKey(keyId: string): void {
    this.trustedKeys.delete(keyId.toUpperCase());
  }
  
  /**
   * Get list of trusted keys
   */
  getTrustedKeys(): string[] {
    return Array.from(this.trustedKeys);
  }
  
  /**
   * Import a GPG public key
   * @param keyData The public key data to import
   * @returns Success status
   */
  async importPublicKey(keyData: string): Promise<boolean> {
    try {
      // Write key data to temporary file
      const tempFile = path.join(process.cwd(), `.gpg-import-${Date.now()}.asc`);
      await fs.writeFile(tempFile, keyData);
      
      try {
        // Import the key
        await safeExec('gpg', ['--import', tempFile]);
        return true;
      } finally {
        // Clean up temp file
        await fs.unlink(tempFile).catch(() => {});
      }
      
    } catch (error) {
      console.error('Failed to import GPG key:', error);
      return false;
    }
  }
}