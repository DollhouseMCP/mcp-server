/**
 * PortfolioSyncComparer - Compares local and GitHub portfolio elements
 * 
 * Determines what actions need to be taken based on the sync mode:
 * - additive: Only add missing elements
 * - mirror: Make local exactly match GitHub
 * - backup: Treat GitHub as authoritative source
 */

import { ElementType } from '../portfolio/types.js';
import { GitHubIndexEntry } from '../portfolio/GitHubPortfolioIndexer.js';
import { logger } from '../utils/logger.js';

export type SyncMode = 'additive' | 'mirror' | 'backup';

export interface SyncAction {
  type: ElementType;
  name: string;
  path: string;
  action: 'add' | 'update' | 'delete' | 'skip';
  reason?: string;
  localSha?: string;
  remoteSha?: string;
}

export interface SyncActions {
  toAdd: SyncAction[];
  toUpdate: SyncAction[];
  toDelete: SyncAction[];
  toSkip: SyncAction[];
}

export class PortfolioSyncComparer {
  /**
   * Compare GitHub and local elements to determine sync actions
   */
  compareElements(
    githubElements: Map<ElementType, GitHubIndexEntry[]>,
    localElements: Map<ElementType, any[]>,
    mode: SyncMode
  ): SyncActions {
    const actions: SyncActions = {
      toAdd: [],
      toUpdate: [],
      toDelete: [],
      toSkip: []
    };

    logger.info('Comparing elements', { 
      githubCount: this.countElements(githubElements),
      localCount: this.countElements(localElements),
      mode 
    });

    // Process each element type
    const allTypes = new Set([
      ...githubElements.keys(),
      ...localElements.keys()
    ]);

    for (const type of allTypes) {
      const githubTypeElements = githubElements.get(type) || [];
      const localTypeElements = localElements.get(type) || [];
      
      this.compareTypeElements(
        type,
        githubTypeElements,
        localTypeElements,
        mode,
        actions
      );
    }

    logger.info('Comparison complete', {
      toAdd: actions.toAdd.length,
      toUpdate: actions.toUpdate.length,
      toDelete: actions.toDelete.length,
      toSkip: actions.toSkip.length
    });

    return actions;
  }

  /**
   * Compare elements of a specific type
   */
  private compareTypeElements(
    type: ElementType,
    githubElements: GitHubIndexEntry[],
    localElements: any[],
    mode: SyncMode,
    actions: SyncActions
  ): void {
    // Create maps for efficient lookup
    const githubMap = new Map(
      githubElements.map(e => [this.normalizeElementName(e.name), e])
    );
    const localMap = new Map(
      localElements.map(e => [this.normalizeElementName(e.name || e.metadata?.name), e])
    );

    // Process GitHub elements (additions and updates)
    for (const [name, githubElement] of githubMap) {
      const localElement = localMap.get(name);
      
      if (!localElement) {
        // Element exists on GitHub but not locally
        actions.toAdd.push({
          type,
          name: githubElement.name,
          path: githubElement.path,
          action: 'add',
          remoteSha: githubElement.sha
        });
      } else if (mode === 'backup' || this.shouldUpdate(githubElement, localElement, mode)) {
        // Element needs updating
        actions.toUpdate.push({
          type,
          name: githubElement.name,
          path: githubElement.path,
          action: 'update',
          reason: mode === 'backup' ? 'backup mode' : 'newer on GitHub',
          localSha: localElement.sha,
          remoteSha: githubElement.sha
        });
      } else {
        // Element is up to date or should be skipped
        actions.toSkip.push({
          type,
          name: githubElement.name,
          path: githubElement.path,
          action: 'skip',
          reason: 'up to date',
          localSha: localElement.sha,
          remoteSha: githubElement.sha
        });
      }
    }

    // Process local elements (deletions - only in mirror mode)
    if (mode === 'mirror') {
      for (const [name, localElement] of localMap) {
        if (!githubMap.has(name)) {
          // Element exists locally but not on GitHub
          actions.toDelete.push({
            type,
            name: localElement.name || localElement.metadata?.name || name,
            path: `${type}/${name}.md`,
            action: 'delete',
            reason: 'not on GitHub',
            localSha: localElement.sha
          });
        }
      }
    }
  }

  /**
   * Determine if an element should be updated
   */
  private shouldUpdate(
    githubElement: GitHubIndexEntry,
    localElement: any,
    mode: SyncMode
  ): boolean {
    // In backup mode, always update from GitHub
    if (mode === 'backup') {
      return true;
    }

    // In additive mode, never update existing elements
    if (mode === 'additive') {
      return false;
    }

    // In mirror mode, update if SHAs differ
    // If we don't have SHAs, compare modified dates
    if (githubElement.sha && localElement.sha) {
      return githubElement.sha !== localElement.sha;
    }

    // Compare modified dates if available
    if (githubElement.lastModified && localElement.lastModified) {
      const githubDate = new Date(githubElement.lastModified).getTime();
      const localDate = new Date(localElement.lastModified).getTime();
      return githubDate > localDate;
    }

    // If we can't determine, skip updating in mirror mode
    return false;
  }

  /**
   * Normalize element name for comparison
   * Handles different naming formats and extensions
   */
  private normalizeElementName(name: string): string {
    if (!name) return '';
    
    // Remove .md extension if present
    let normalized = name.replace(/\.md$/i, '');
    
    // Convert to lowercase for comparison
    normalized = normalized.toLowerCase();
    
    // Replace spaces with hyphens (some systems use different formats)
    normalized = normalized.replace(/\s+/g, '-');
    
    return normalized;
  }

  /**
   * Count total elements in a map
   */
  private countElements(elements: Map<ElementType, any[]>): number {
    let count = 0;
    for (const typeElements of elements.values()) {
      count += typeElements.length;
    }
    return count;
  }
}