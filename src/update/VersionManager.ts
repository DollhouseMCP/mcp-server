/**
 * Version management and comparison utilities
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export class VersionManager {
  /**
   * Get current version from package.json
   */
  async getCurrentVersion(): Promise<string> {
    // Use process.cwd() as a base, then search upward for package.json
    let currentDir = process.cwd();
    let packageJsonPath: string | null = null;
    
    // Search up to 5 levels for package.json
    for (let i = 0; i < 5; i++) {
      const candidatePath = path.join(currentDir, 'package.json');
      try {
        await fs.access(candidatePath);
        packageJsonPath = candidatePath;
        break;
      } catch {
        // File doesn't exist, try parent directory
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
          // We've reached the root
          break;
        }
        currentDir = parentDir;
      }
    }
    
    if (!packageJsonPath) {
      throw new Error('Could not find package.json in current directory or any parent directory');
    }
    
    const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageData = JSON.parse(packageContent);
    return packageData.version;
  }
  
  /**
   * Enhanced semantic version comparison supporting pre-release versions
   * Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
   */
  compareVersions(version1: string, version2: string): number {
    // Normalize versions by removing 'v' prefix
    const v1 = version1.replace(/^v/, '');
    const v2 = version2.replace(/^v/, '');
    
    // Split version and pre-release parts
    const [v1main, v1pre] = v1.split('-');
    const [v2main, v2pre] = v2.split('-');
    
    // Compare main version parts (x.y.z)
    const v1parts = v1main.split('.').map(part => parseInt(part) || 0);
    const v2parts = v2main.split('.').map(part => parseInt(part) || 0);
    
    const maxLength = Math.max(v1parts.length, v2parts.length);
    for (let i = 0; i < maxLength; i++) {
      const v1part = v1parts[i] || 0;
      const v2part = v2parts[i] || 0;
      
      if (v1part < v2part) return -1;
      if (v1part > v2part) return 1;
    }
    
    // If main versions are equal, compare pre-release versions
    // Version without pre-release is greater than version with pre-release
    if (!v1pre && v2pre) return 1;   // 1.0.0 > 1.0.0-beta
    if (v1pre && !v2pre) return -1;  // 1.0.0-beta < 1.0.0
    if (!v1pre && !v2pre) return 0;  // 1.0.0 == 1.0.0
    
    // Both have pre-release, compare lexicographically
    return v1pre.localeCompare(v2pre);
  }
  
  /**
   * Parse version from dependency output
   */
  parseVersionFromOutput(output: string, tool: string): string | null {
    // Git version output: "git version 2.39.2"
    // npm version output: "8.19.2" or JSON with version info
    
    if (tool === 'git') {
      const match = output.match(/git version (\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } else if (tool === 'npm') {
      // npm might return just the version number or JSON
      const cleanOutput = output.trim();
      if (cleanOutput.match(/^\d+\.\d+\.\d+/)) {
        return cleanOutput.split('\n')[0]; // First line if multiple lines
      }
      // Try to parse as JSON if it looks like JSON
      try {
        const parsed = JSON.parse(cleanOutput);
        return parsed.npm || parsed.version || null;
      } catch {
        // If not JSON, try to extract version pattern
        const match = cleanOutput.match(/(\d+\.\d+\.\d+)/);
        return match ? match[1] : null;
      }
    }
    
    return null;
  }
  
  /**
   * Validate that a dependency version meets requirements
   */
  validateDependencyVersion(
    actualVersion: string, 
    requirements: { minimum: string; maximum: string; recommended: string },
    toolName: string
  ): { valid: boolean; warning?: string; error?: string } {
    const minComparison = this.compareVersions(actualVersion, requirements.minimum);
    const maxComparison = this.compareVersions(actualVersion, requirements.maximum);
    
    // Check if version is below minimum
    if (minComparison < 0) {
      return {
        valid: false,
        error: `${toolName} version ${actualVersion} is below minimum required version ${requirements.minimum}. Please upgrade ${toolName}.`
      };
    }
    
    // Check if version is above maximum tested
    if (maxComparison > 0) {
      return {
        valid: true,
        warning: `${toolName} version ${actualVersion} is above maximum tested version ${requirements.maximum}. Some features may not work as expected.`
      };
    }
    
    // Check if not at recommended version
    const recComparison = this.compareVersions(actualVersion, requirements.recommended);
    if (recComparison !== 0) {
      return {
        valid: true,
        warning: `${toolName} version ${actualVersion} works but ${requirements.recommended} is recommended for optimal stability.`
      };
    }
    
    // Version is perfect
    return { valid: true };
  }
}