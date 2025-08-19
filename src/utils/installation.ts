/**
 * Installation detection utilities
 * Determines whether the application is running from npm or git installation
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

export type InstallationType = 'npm' | 'git' | 'unknown';

export class InstallationDetector {
  private static cachedType: InstallationType | null = null;
  
  // Maximum directory levels to search upward for .git directory
  private static readonly MAX_SEARCH_DEPTH = 10;
  
  /**
   * Detect the installation type (npm global, git clone, or unknown)
   */
  static getInstallationType(): InstallationType {
    // Return cached result if available
    if (this.cachedType !== null) {
      return this.cachedType;
    }
    
    try {
      // Get the directory where this file is located
      const currentFileUrl = import.meta.url;
      const currentFilePath = fileURLToPath(currentFileUrl);
      let currentDir = path.dirname(currentFilePath);
      
      // Resolve symlinks to get the real path
      try {
        currentDir = fs.realpathSync(currentDir);
      } catch (error) {
        // If realpath fails, continue with original path
        logger.debug('[InstallationDetector] Could not resolve real path, using original');
      }
      
      // Check if we're in a node_modules directory (npm installation)
      // Use path separator to ensure we match the exact package name
      const npmPattern = path.sep + path.join('node_modules', '@dollhousemcp', 'mcp-server') + path.sep;
      if (currentDir.includes(npmPattern)) {
        logger.debug('[InstallationDetector] Detected npm installation');
        this.cachedType = 'npm';
        return 'npm';
      }
      
      // Check for .git directory (git installation)
      // Search up from current directory
      let searchDir = currentDir;
      for (let i = 0; i < this.MAX_SEARCH_DEPTH; i++) {
        const gitDir = path.join(searchDir, '.git');
        try {
          if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
            logger.debug('[InstallationDetector] Detected git installation');
            this.cachedType = 'git';
            return 'git';
          }
        } catch (error) {
          // Ignore errors and continue searching
        }
        
        const parentDir = path.dirname(searchDir);
        if (parentDir === searchDir) {
          // Reached root directory
          break;
        }
        searchDir = parentDir;
      }
      
      logger.warn('[InstallationDetector] Could not determine installation type');
      this.cachedType = 'unknown';
      return 'unknown';
    } catch (error) {
      logger.error('[InstallationDetector] Error detecting installation type:', error);
      this.cachedType = 'unknown';
      return 'unknown';
    }
  }
  
  /**
   * Get the npm global installation path if running from npm
   */
  static getNpmGlobalPath(): string | null {
    if (this.getInstallationType() !== 'npm') {
      return null;
    }
    
    try {
      const currentFileUrl = import.meta.url;
      const currentFilePath = fileURLToPath(currentFileUrl);
      let currentDir = path.dirname(currentFilePath);
      
      // Find the root of the npm package
      while (currentDir.includes('node_modules/@dollhousemcp/mcp-server')) {
        const packageJsonPath = path.join(currentDir, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          return currentDir;
        }
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
      }
    } catch (error) {
      logger.error('[InstallationDetector] Error finding npm global path:', error);
    }
    
    return null;
  }
  
  /**
   * Get the git repository root path if running from git
   */
  static getGitRepositoryPath(): string | null {
    if (this.getInstallationType() !== 'git') {
      return null;
    }
    
    try {
      const currentFileUrl = import.meta.url;
      const currentFilePath = fileURLToPath(currentFileUrl);
      let currentDir = path.dirname(currentFilePath);
      
      // Search up for .git directory
      for (let i = 0; i < 10; i++) {
        const gitDir = path.join(currentDir, '.git');
        if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
          return currentDir;
        }
        
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
      }
    } catch (error) {
      logger.error('[InstallationDetector] Error finding git repository path:', error);
    }
    
    return null;
  }
  
  /**
   * Get a human-readable description of the installation
   */
  static getInstallationDescription(): string {
    const type = this.getInstallationType();
    
    switch (type) {
      case 'npm':
        const npmPath = this.getNpmGlobalPath();
        return npmPath 
          ? `npm global installation at ${npmPath}`
          : 'npm global installation';
          
      case 'git':
        const gitPath = this.getGitRepositoryPath();
        return gitPath
          ? `git installation at ${gitPath}`
          : 'git installation';
          
      default:
        return 'unknown installation type';
    }
  }
  
  /**
   * Clear the cached installation type (mainly for testing)
   */
  static clearCache(): void {
    this.cachedType = null;
  }
}