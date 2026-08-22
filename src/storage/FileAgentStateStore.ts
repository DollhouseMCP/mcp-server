import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type { AgentState } from '../elements/agents/types.js';
import { AGENT_LIMITS } from '../elements/agents/constants.js';
import { ElementType } from '../portfolio/types.js';
import type { FileLockManager } from '../security/fileLockManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { IFileOperationsService } from '../services/FileOperationsService.js';
import type { SerializationService } from '../services/SerializationService.js';
import { SECURITY_LIMITS } from '../security/constants.js';
import { logger } from '../utils/logger.js';
import { withFilesystemInterprocessGuard } from '../security/filesystemInterprocessGuard.js';
import type {
  AgentStateKey,
  AgentStateDeleteOptions,
  AgentStateLoadOptions,
  AgentStateReclaimOptions,
  AgentStateSaveOptions,
  IAgentStateStore,
} from './IAgentStateStore.js';

export const AGENT_STATE_FILE_EXTENSION = '.state.yaml';
export const AGENT_STATE_MAX_YAML_SIZE = SECURITY_LIMITS.MAX_YAML_LENGTH;

export interface FileAgentStateStoreDeps {
  stateDir: string | (() => string);
  fileLockManager: FileLockManager;
  fileOperations: IFileOperationsService;
  serializationService: SerializationService;
  stateCache: Map<string, AgentState>;
  maxYamlSize?: number;
}

export class FileAgentStateStore implements IAgentStateStore {
  private readonly stateDirProvider: () => string;
  private readonly maxYamlSize: number;
  private readonly stateRevisions = new WeakMap<AgentState, string>();
  private readonly observedRevisionByName = new Map<string, {
    readonly revision: string;
    readonly version: number;
  }>();

  constructor(private readonly deps: FileAgentStateStoreDeps) {
    const stateDir = deps.stateDir;
    this.stateDirProvider = typeof stateDir === 'function'
      ? stateDir
      : () => stateDir;
    this.maxYamlSize = deps.maxYamlSize ?? AGENT_STATE_MAX_YAML_SIZE;
  }

  async load(key: AgentStateKey, options: AgentStateLoadOptions = {}): Promise<AgentState | null> {
    const normalizedName = this.normalizeFilename(key.name);

    if (!options.strict && this.deps.stateCache.has(normalizedName)) {
      return this.deps.stateCache.get(normalizedName)!;
    }

    const statePath = path.join(this.stateDir, `${normalizedName}${AGENT_STATE_FILE_EXTENSION}`);

    try {
      const content = await this.deps.fileOperations.readFile(statePath, { encoding: 'utf-8' });
      const result = this.deps.serializationService.parseFrontmatter(content, {
        maxYamlSize: this.maxYamlSize,
        validateContent: true,
        source: 'FileAgentStateStore.load',
      });

      const parsed = result.data as Record<string, unknown>;
      const revision = typeof parsed._storageRevision === 'string'
        ? parsed._storageRevision
        : createHash('sha256').update(content, 'utf8').digest('hex');
      const state = { ...parsed } as unknown as AgentState;
      delete (state as AgentState & { _storageRevision?: string })._storageRevision;
      this.normalizeLoadedState(state);
      this.stateRevisions.set(state, revision);
      this.observedRevisionByName.set(normalizedName, {
        revision,
        version: state.stateVersion ?? 0,
      });
      if (!options.strict) {
        this.deps.stateCache.set(normalizedName, state);
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (options.strict) {
          // A missing state file is valid only when its parent directory is
          // reachable. Otherwise ENOENT may describe a failed/unmounted store.
          await this.deps.fileOperations.stat(this.stateDir);
          // A strict read is an explicit observation of durable absence. Clear
          // the name-level baseline so a fresh object can be created, while
          // object-level revision tokens continue fencing stale resurrection.
          this.observedRevisionByName.delete(normalizedName);
          this.deps.stateCache.delete(normalizedName);
        }
        return null;
      }
      logger.error(`Failed to load agent state: ${key.name}`, error);
      if (options.strict) {
        throw error;
      }
      return null;
    }
  }

  async reclaimOrphaned(
    _key: AgentStateKey,
    _options: AgentStateReclaimOptions = {},
  ): Promise<AgentState | null> {
    // A single file contains session-neutral state and carries no durable
    // ownership or presence record. Reclaiming it could therefore steal a
    // still-live execution from another local transport session.
    return null;
  }

  async save(
    key: AgentStateKey,
    state: AgentState,
    expectedVersion: number,
    options: AgentStateSaveOptions = {},
  ): Promise<number> {
    if (options.requireExisting) {
      await this.deps.fileOperations.stat(this.stateDir);
    } else {
      await this.ensureStateDirectory();
    }

    const normalizedName = this.normalizeFilename(key.name);
    const filePath = path.join(this.stateDir, `${normalizedName}${AGENT_STATE_FILE_EXTENSION}`);

    await this.deps.fileLockManager.withLock(`agent-state:${normalizedName}`, async () => {
      await this.withCrossProcessStateLock(normalizedName, async () => {
      // load() does not acquire an `agent-state:*` lock. Its disk read uses
      // FileOperationsService's distinct `file:<absolute path>` namespace, so
      // this is not a reentrant acquisition of the transaction lock.
      // The cross-process guard serializes writers, but it cannot make this
      // process's cache current. Reread an existing durable state file while
      // holding the guard so expectedVersion fences writes from other server
      // processes. A first save has no document to parse yet.
      const stateFileExists = await this.deps.fileOperations.exists(filePath);
      const previouslyObservedRevision = this.observedRevisionByName.get(normalizedName);
      const expectedRevision = this.stateRevisions.get(state)
        ?? (previouslyObservedRevision?.version === expectedVersion
          ? previouslyObservedRevision.revision
          : undefined);
      const existingState = stateFileExists
        ? await this.load(key, { strict: true })
        : null;
      this.restoreObservedRevision(normalizedName, previouslyObservedRevision);
      const existingRevision = existingState ? this.stateRevisions.get(existingState) : undefined;
      if (options.requireExisting && !existingState) {
        throw new Error(`Agent state disappeared while updating '${key.name}'`);
      }
      const existingVersion = existingState?.stateVersion ?? 0;
      const incomingVersionConflict = state.stateVersion !== undefined
        && state.stateVersion !== expectedVersion;
      const durableVersionConflict = existingState
        ? existingVersion !== expectedVersion
          || (expectedRevision !== undefined && existingRevision !== expectedRevision)
        : expectedVersion !== 0
          || previouslyObservedRevision !== undefined
          || expectedRevision !== undefined;
      const hasVersionConflict = incomingVersionConflict || durableVersionConflict;
      if (hasVersionConflict) {
        logger.warn(`State version conflict detected for agent ${key.name}`, {
          existingVersion,
          attemptedVersion: expectedVersion,
        });

        SecurityMonitor.logSecurityEvent({
          type: 'MEMORY_SAVE_FAILED',
          severity: 'MEDIUM',
          source: 'FileAgentStateStore.save',
          details: 'State version conflict: attempted to save stale state',
          additionalData: {
            agentName: key.name,
            existingVersion,
            attemptedVersion: expectedVersion,
          },
        });

        throw new Error(
          `State version conflict: current version is ${existingVersion}, ` +
          `but attempted to save version ${expectedVersion}. ` +
          `State may have been modified concurrently.`,
        );
      }

      const nextVersion = expectedVersion + 1;
      const stateForPersistence: AgentState = { ...state, stateVersion: nextVersion };
      const nextRevision = randomUUID();
      const serializedState = this.prepareStateForSerialization(stateForPersistence, nextRevision);
      const yamlContent = this.deps.serializationService.dumpYaml(serializedState, {
        schema: 'json',
        noRefs: true,
        sortKeys: true,
      });

      const persistedStateLimit = Math.min(this.maxYamlSize, AGENT_LIMITS.MAX_STATE_SIZE);
      this.deps.serializationService.validateSize(yamlContent, persistedStateLimit, 'Agent state');
      await this.deps.fileOperations.writeFile(filePath, yamlContent, {
        encoding: 'utf-8',
        durable: true,
      });
      state.stateVersion = nextVersion;
      this.stateRevisions.set(state, nextRevision);
      this.observedRevisionByName.set(normalizedName, {
        revision: nextRevision,
        version: nextVersion,
      });
      this.deps.stateCache.set(normalizedName, state);

      logger.debug('Agent state saved successfully', {
        agentName: key.name,
        normalizedName,
        stateVersion: state.stateVersion,
        goalCount: state.goals?.length ?? 0,
      });
      });
    });

    return state.stateVersion!;
  }

  async delete(
    key: AgentStateKey,
    options: AgentStateDeleteOptions = {},
  ): Promise<boolean> {
    const normalizedName = this.normalizeFilename(key.name);
    const statePath = path.join(this.stateDir, `${normalizedName}${AGENT_STATE_FILE_EXTENSION}`);
    return this.deps.fileLockManager.withLock(`agent-state:${normalizedName}`, async () =>
      this.withCrossProcessStateLock(normalizedName, async () => {
        const strict = options.requireExisting === true || options.expectedVersion !== undefined;
        const expectedRevision = this.observedRevisionByName.get(normalizedName);
        const existing = strict ? await this.load(key, { strict: true }) : null;
        this.restoreObservedRevision(normalizedName, expectedRevision);
        if (!existing) {
          if (options.requireExisting) {
            throw new Error(`Agent state disappeared while deleting '${key.name}'`);
          }
          if (strict) {
            this.deps.stateCache.delete(normalizedName);
            return false;
          }
        }
        if (
          options.expectedVersion !== undefined &&
          (existing === null
            || existing.stateVersion !== options.expectedVersion
            || (expectedRevision !== undefined
              && (expectedRevision.version !== options.expectedVersion
                || this.stateRevisions.get(existing) !== expectedRevision.revision)))
        ) {
          throw new Error(
            `State version conflict: current version is ${existing?.stateVersion ?? 0}, ` +
            `but attempted to delete version ${options.expectedVersion}.`,
          );
        }
        try {
          await this.deps.fileOperations.deleteFile(statePath, ElementType.AGENT, {
            source: 'AgentManager.delete (state file)',
            durable: true,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          this.deps.stateCache.delete(normalizedName);
          this.observedRevisionByName.delete(normalizedName);
          return false;
        }
        this.deps.stateCache.delete(normalizedName);
        this.observedRevisionByName.delete(normalizedName);
        return true;
      }),
    );
  }

  async warnIfOrphanedStateFiles(): Promise<void> {
    try {
      const entries = await this.deps.fileOperations.listDirectory(this.stateDir);
      const count = entries.filter((entry) => entry.endsWith(AGENT_STATE_FILE_EXTENSION)).length;
      if (count > 0) {
        logger.warn(
          `[AgentManager] DB mode active; ignoring ${count} orphaned .state.yaml files in ` +
          `${this.stateDir}. Agent state resets to default on first use. ` +
          `Manual migration is not supported in this release.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug('Unable to inspect orphaned agent state files', { error });
      }
    }
  }

  private get stateDir(): string {
    return this.stateDirProvider();
  }

  private async ensureStateDirectory(): Promise<void> {
    await this.deps.fileOperations.createDirectory(this.stateDir);
  }

  private async withCrossProcessStateLock<T>(
    normalizedName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockDir = path.join(this.stateDir, '.locks');
    const lockPath = path.join(lockDir, `${normalizedName}.guard`);
    await this.deps.fileOperations.createDirectory(lockDir);
    return withFilesystemInterprocessGuard(lockPath, operation, {
      timeoutMs: 5_000,
      retryMs: 25,
    });
  }

  private normalizeFilename(name: string): string {
    if (!name || name.trim().length === 0) {
      return 'unnamed';
    }

    return name
      .replaceAll(/([a-z])([A-Z])/g, '$1-$2')
      .replaceAll(/[\s_]+/g, '-')
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, '-')
      .replaceAll(/-+/g, '-')
      .replaceAll(/^-+|-+$/g, ''); // NOSONAR — anchored alternation, each branch has a single quantifier; no overlap, no backtracking
  }

  private prepareStateForSerialization(state: AgentState, storageRevision: string): Record<string, unknown> {
    return {
      ...state,
      _storageRevision: storageRevision,
      lastActive: state.lastActive instanceof Date ? state.lastActive.toISOString() : state.lastActive,
      sessionCount: String(state.sessionCount ?? 0),
      stateVersion: state.stateVersion === undefined ? '1' : String(state.stateVersion),
      goals: state.goals.map(goal => ({
        ...goal,
        createdAt: goal.createdAt instanceof Date ? goal.createdAt.toISOString() : goal.createdAt,
        updatedAt: goal.updatedAt instanceof Date ? goal.updatedAt.toISOString() : goal.updatedAt,
        completedAt: goal.completedAt instanceof Date ? goal.completedAt.toISOString() : goal.completedAt,
        importance: goal.importance === undefined ? undefined : String(goal.importance),
        urgency: goal.urgency === undefined ? undefined : String(goal.urgency),
        estimatedEffort: goal.estimatedEffort === undefined ? undefined : String(goal.estimatedEffort),
      })),
      decisions: state.decisions.map(decision => ({
        ...decision,
        timestamp: decision.timestamp instanceof Date ? decision.timestamp.toISOString() : decision.timestamp,
        confidence: decision.confidence === undefined ? undefined : String(decision.confidence),
      })),
    };
  }

  private restoreObservedRevision(
    normalizedName: string,
    revision: { readonly revision: string; readonly version: number } | undefined,
  ): void {
    if (revision === undefined) {
      this.observedRevisionByName.delete(normalizedName);
    } else {
      this.observedRevisionByName.set(normalizedName, revision);
    }
  }

  private normalizeLoadedState(state: AgentState): void {
    state.goals ??= [];
    state.decisions ??= [];
    state.context ??= {};

    state.sessionCount = this.parseIntegerOrDefault(state.sessionCount, 0);
    state.stateVersion = this.parseIntegerOrDefault(state.stateVersion, 1);
    if (state.lastActive) {
      state.lastActive = new Date(state.lastActive);
    }

    state.goals.forEach(goal => {
      if (goal.importance !== undefined) goal.importance = Number.parseInt(String(goal.importance), 10);
      if (goal.urgency !== undefined) goal.urgency = Number.parseInt(String(goal.urgency), 10);
      if (goal.estimatedEffort !== undefined) goal.estimatedEffort = Number.parseFloat(String(goal.estimatedEffort));
      if (goal.createdAt) goal.createdAt = new Date(goal.createdAt);
      if (goal.updatedAt) goal.updatedAt = new Date(goal.updatedAt);
      if (goal.completedAt) goal.completedAt = new Date(goal.completedAt);
    });

    state.decisions.forEach(decision => {
      if (decision.confidence !== undefined) decision.confidence = Number.parseFloat(String(decision.confidence));
      if (decision.timestamp) decision.timestamp = new Date(decision.timestamp);
    });
  }

  private parseIntegerOrDefault(value: unknown, fallback: number): number {
    if (typeof value !== 'number' && typeof value !== 'string') {
      return fallback;
    }
    const normalized = typeof value === 'string' ? value.trim() : value;
    if (normalized === '' || (typeof normalized === 'string' && !/^\d+$/u.test(normalized))) {
      return fallback;
    }
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }
}
