/**
 * SharedPoolInstaller
 *
 * The admin-elevated write path for shared-pool content. This is the
 * ONLY code path that creates SYSTEM-owned elements — admin elevation
 * is code-path-scoped, not user-role-scoped.
 *
 * Backend-agnostic: delegates to IProvenanceStore for provenance and
 * uses either the DB admin path or file writes depending on mode.
 *
 * Two consumers:
 * - `install_collection_content` MCP tool (collection origin)
 * - `DeploymentSeedLoader` at bootstrap (deployment_seed origin)
 *
 * @module collection/shared-pool/SharedPoolInstaller
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import type { IProvenanceStore } from './IProvenanceStore.js';
import type { ISharedPoolInstaller } from './ISharedPoolInstaller.js';
import type {
  SharedPoolInstallRequest,
  SharedPoolInstallResult,
  ProvenanceRecord,
} from './types.js';
import { SYSTEM_USER_UUID } from './SharedPoolConfig.js';

/**
 * Strategy for writing element content to the shared pool.
 * Injected at construction so the installer stays backend-agnostic.
 */
export interface SharedPoolWriteStrategy {
  /**
   * Write element content to the shared pool and return the element ID.
   *
   * @param request - The install request with content and metadata.
   * @param contentHash - Pre-computed SHA-256 hex digest.
   * @returns The element identifier (UUID in DB mode, relative path in file mode).
   */
  writeElement(request: SharedPoolInstallRequest, contentHash: string): Promise<string>;
}

export class SharedPoolInstaller implements ISharedPoolInstaller {
  constructor(
    private readonly provenanceStore: IProvenanceStore,
    private readonly writeStrategy: SharedPoolWriteStrategy,
  ) {}

  async install(request: SharedPoolInstallRequest): Promise<SharedPoolInstallResult> {
    const contentHash = createHash('sha256')
      .update(request.content, 'utf-8')
      .digest('hex');

    const lookupResult = await this.provenanceStore.lookup(
      request.origin,
      request.sourceUrl,
      request.sourceVersion,
      contentHash,
    );

    switch (lookupResult.status) {
      case 'match':
        return {
          action: 'skipped',
          elementId: lookupResult.record.elementId,
          provenance: lookupResult.record,
          reason: 'Identical content already exists in the shared pool',
        };

      case 'hash_mismatch':
        return this.handleHashMismatch(request, lookupResult, contentHash);

      case 'not_found':
        return this.installNew(request, contentHash);
    }
  }

  private async handleHashMismatch(
    request: SharedPoolInstallRequest,
    lookupResult: { record: ProvenanceRecord; actualHash: string },
    contentHash: string,
  ): Promise<SharedPoolInstallResult> {
    if (request.origin === 'deployment_seed') {
      const elementId = await this.writeStrategy.writeElement(request, contentHash);

      const updatedRecord: ProvenanceRecord = {
        ...lookupResult.record,
        elementId,
        contentHash,
        installedAt: new Date().toISOString(),
      };

      await this.provenanceStore.update(updatedRecord);
      this.logSecurityEvent('SHARED_POOL_UPDATED', request, elementId);

      logger.info('[SharedPoolInstaller] Deployment seed updated', {
        name: request.name,
        elementType: request.elementType,
      });

      return {
        action: 'installed',
        elementId,
        provenance: updatedRecord,
      };
    }

    this.logSecurityEvent('SHARED_POOL_TAMPER_DETECTED', request, lookupResult.record.elementId);

    return {
      action: 'rejected',
      elementId: lookupResult.record.elementId,
      provenance: lookupResult.record,
      reason: `Content hash mismatch for ${request.origin} element '${request.name}' — ` +
        `stored hash ${lookupResult.record.contentHash.slice(0, 12)}... does not match ` +
        `incoming ${contentHash.slice(0, 12)}...`,
    };
  }

  private async installNew(
    request: SharedPoolInstallRequest,
    contentHash: string,
  ): Promise<SharedPoolInstallResult> {
    const elementId = await this.writeStrategy.writeElement(request, contentHash);

    const record: ProvenanceRecord = {
      elementId,
      origin: request.origin,
      sourceUrl: request.sourceUrl,
      sourceVersion: request.sourceVersion,
      contentHash,
      forkedFrom: null,
      installedAt: new Date().toISOString(),
    };

    await this.provenanceStore.save(record);
    this.logSecurityEvent('SHARED_POOL_INSTALLED', request, elementId);

    logger.info('[SharedPoolInstaller] Element installed to shared pool', {
      name: request.name,
      elementType: request.elementType,
      origin: request.origin,
    });

    return {
      action: 'installed',
      elementId,
      provenance: record,
    };
  }

  private logSecurityEvent(
    type: string,
    request: SharedPoolInstallRequest,
    elementId: string,
  ): void {
    SecurityMonitor.logSecurityEvent({
      type: type as 'ELEMENT_CREATED',
      severity: 'MEDIUM',
      source: 'SharedPoolInstaller.install',
      details: `Shared pool ${type}: ${request.elementType}/${request.name} [${request.origin}]`,
      additionalData: {
        elementId,
        elementType: request.elementType,
        origin: request.origin,
        sourceUrl: request.sourceUrl,
        sourceVersion: request.sourceVersion,
      },
    });
  }
}

// ── Write Strategy Implementations ────────────────────────────────

/**
 * File-mode write strategy — writes element content to `shared/<type>/<name>.md`.
 */
export class FileSharedPoolWriteStrategy implements SharedPoolWriteStrategy {
  constructor(private readonly sharedPoolDir: string) {}

  private static readonly VALID_ELEMENT_TYPES = new Set([
    'personas', 'skills', 'templates', 'agents', 'memories', 'ensembles',
  ]);

  async writeElement(request: SharedPoolInstallRequest, _contentHash: string): Promise<string> {
    if (!FileSharedPoolWriteStrategy.VALID_ELEMENT_TYPES.has(request.elementType)) {
      throw new Error(`Invalid element type for shared pool: ${request.elementType}`);
    }

    const typeDir = path.join(this.sharedPoolDir, request.elementType);
    await fs.mkdir(typeDir, { recursive: true });

    const safeName = path.basename(request.name.replaceAll('\\', '/').replaceAll('\0', ''));
    const filename = safeName.endsWith('.md') ? safeName : `${safeName}.md`;
    const filePath = path.join(typeDir, filename);

    const resolvedPath = path.resolve(filePath);
    const resolvedBase = path.resolve(this.sharedPoolDir);
    if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
      throw new Error(`Path traversal detected in element name: ${request.name}`);
    }

    const relativePath = `${request.elementType}/${filename}`;

    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, request.content, 'utf-8');
    await fs.rename(tmpPath, filePath);

    return relativePath;
  }
}

/**
 * DB-mode write strategy — inserts SYSTEM-owned element via admin context.
 */
export class DatabaseSharedPoolWriteStrategy implements SharedPoolWriteStrategy {
  constructor(
    private readonly db: import('../../database/connection.js').DatabaseInstance,
  ) {}

  async writeElement(request: SharedPoolInstallRequest, contentHash: string): Promise<string> {
    const { withSystemContext } = await import('../../database/admin.js');
    const { elements } = await import('../../database/schema/elements.js');
    const { FrontmatterParser } = await import('../../storage/FrontmatterParser.js');
    const { sql } = await import('drizzle-orm');

    const frontmatter = FrontmatterParser.extractMetadata(request.content);
    const byteSize = Buffer.byteLength(request.content, 'utf-8');

    const bodyContent = this.extractBody(request.content);

    const elementId = await withSystemContext(this.db, async (tx) => {
      const values = {
        userId: SYSTEM_USER_UUID,
        rawContent: request.content,
        bodyContent,
        contentHash,
        byteSize,
        elementType: request.elementType,
        name: request.name,
        description: frontmatter.description as string ?? '',
        version: frontmatter.version as string ?? '1.0.0',
        author: frontmatter.author as string ?? 'DollhouseMCP',
        elementCreated: typeof frontmatter.created === 'string' ? frontmatter.created : null,
        metadata: this.extractMetadata(frontmatter),
        visibility: 'public',
      };

      const rows = await tx
        .insert(elements)
        .values(values)
        .onConflictDoUpdate({
          target: [elements.userId, elements.elementType, elements.name],
          set: {
            rawContent: values.rawContent,
            bodyContent: values.bodyContent,
            contentHash: values.contentHash,
            byteSize: values.byteSize,
            description: values.description,
            version: values.version,
            author: values.author,
            metadata: values.metadata,
            visibility: values.visibility,
            updatedAt: sql`NOW()`,
          },
        })
        .returning({ id: elements.id });

      if (!rows[0]) {
        throw new Error(`Failed to insert shared-pool element '${request.name}'`);
      }

      return rows[0].id;
    });

    return elementId;
  }

  private extractBody(rawContent: string): string | null {
    const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(rawContent);
    return match?.[1]?.trim() || null;
  }

  private extractMetadata(frontmatter: Record<string, unknown>): Record<string, unknown> {
    const skip = new Set([
      'name', 'description', 'version', 'author', 'created',
      'visibility', 'memoryType', 'autoLoad', 'priority',
    ]);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(frontmatter)) {
      if (!skip.has(key) && value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }
}
