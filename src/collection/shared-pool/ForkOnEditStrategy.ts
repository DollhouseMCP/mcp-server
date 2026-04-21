/**
 * ForkOnEditStrategy
 *
 * Detects when a user attempts to edit a shared-pool element and
 * materializes a private copy (fork) in the user's own portfolio
 * before the edit is applied.
 *
 * Detection:
 * - DB mode: element's user_id === SYSTEM_USER_UUID && visibility === 'public'
 * - File mode: element's file path is under the shared/ directory
 *
 * The fork flow:
 * 1. Copy the element content to the user's portfolio
 * 2. Create a provenance record with origin='fork', forked_from=original
 * 3. Return the fork's identity so the edit flow applies changes to it
 *
 * After fork, subsequent edits to the same element name resolve to the
 * user's copy (which is in their portfolio, not shared/), so no re-fork.
 *
 * @module collection/shared-pool/ForkOnEditStrategy
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import type { IProvenanceStore } from './IProvenanceStore.js';
import type { ProvenanceRecord } from './types.js';
import { SYSTEM_USER_UUID } from './SharedPoolConfig.js';

export interface ForkResult {
  forked: true;
  forkedElementPath: string;
  originalElementId: string;
}

export interface NoForkNeeded {
  forked: false;
}

export type ForkDecision = ForkResult | NoForkNeeded;

/**
 * Context needed to evaluate and execute a fork decision.
 */
export interface ForkContext {
  /** The resolved element being edited. */
  element: {
    metadata: { name: string };
    id?: string;
    getFilePath?: () => string;
    rawContent?: string;
  };
  /** The element type (e.g. 'personas'). */
  elementType: string;
  /** The user's portfolio directory for this element type. */
  userElementDir: string;
}

export class ForkOnEditStrategy {
  constructor(
    private readonly provenanceStore: IProvenanceStore,
    private readonly sharedPoolDir: string,
  ) {}

  /**
   * Check if the element is shared and needs forking.
   * If yes, materialize the fork and return its path.
   */
  async evaluateAndFork(ctx: ForkContext): Promise<ForkDecision> {
    if (!this.isSharedElement(ctx)) {
      return { forked: false };
    }

    return this.materializeFork(ctx);
  }

  /**
   * Check if an element belongs to the shared pool.
   *
   * File mode: element path starts with the shared pool directory.
   * DB mode: caller should check user_id === SYSTEM_USER_UUID externally
   * (this class focuses on file mode; DB mode fork is handled by RLS
   *  blocking the direct write, which triggers the fork path).
   */
  private isSharedElement(ctx: ForkContext): boolean {
    const filePath = ctx.element.getFilePath?.();
    if (!filePath) return false;

    const resolvedPath = path.resolve(filePath);
    const resolvedShared = path.resolve(this.sharedPoolDir);

    return resolvedPath.startsWith(resolvedShared + path.sep) ||
           resolvedPath === resolvedShared;
  }

  private async materializeFork(ctx: ForkContext): Promise<ForkResult> {
    const originalPath = ctx.element.getFilePath?.() ?? '';
    const fileName = path.basename(originalPath);
    const forkPath = path.join(ctx.userElementDir, fileName);

    const content = ctx.element.rawContent ??
      await fs.readFile(originalPath, 'utf-8');

    await fs.mkdir(ctx.userElementDir, { recursive: true });
    const tmpPath = `${forkPath}.tmp`;
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, forkPath);

    const contentHash = createHash('sha256').update(content, 'utf-8').digest('hex');
    const originalId = ctx.element.id ?? originalPath;

    const provenanceRecord: ProvenanceRecord = {
      elementId: `${ctx.elementType}/${fileName}`,
      origin: 'fork',
      sourceUrl: null,
      sourceVersion: null,
      contentHash,
      forkedFrom: originalId,
      installedAt: new Date().toISOString(),
    };

    try {
      await this.provenanceStore.save(provenanceRecord);
    } catch {
      // Provenance already exists (re-fork of same element) — update instead
      await this.provenanceStore.update(provenanceRecord);
    }

    logger.info('[ForkOnEditStrategy] Element forked from shared pool', {
      originalPath,
      forkPath,
      elementType: ctx.elementType,
      name: ctx.element.metadata.name,
    });

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED' as const,
      severity: 'LOW',
      source: 'ForkOnEditStrategy.materializeFork',
      details: `Forked shared element '${ctx.element.metadata.name}' to user portfolio`,
      additionalData: {
        originalPath,
        forkPath,
        elementType: ctx.elementType,
      },
    });

    return {
      forked: true,
      forkedElementPath: forkPath,
      originalElementId: originalId,
    };
  }

  /** Expose SYSTEM_USER_UUID for DB-mode fork detection by callers. */
  static get SYSTEM_USER_UUID(): string {
    return SYSTEM_USER_UUID;
  }
}
