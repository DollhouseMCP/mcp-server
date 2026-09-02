import * as path from 'node:path';
import { types as utilTypes } from 'node:util';

import type { AgentDecision, AgentGoal, AgentState } from '../elements/agents/types.js';
import { ElementType } from '../portfolio/types.js';
import type { FileLockManager } from '../security/fileLockManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { IFileOperationsService } from '../services/FileOperationsService.js';
import type { SerializationService } from '../services/SerializationService.js';
import { logger } from '../utils/logger.js';
import type {
  AgentStateKey,
  AgentStateLoadOptions,
  AgentStateReclaimOptions,
  AgentStateSaveOptions,
  IAgentStateStore,
} from './IAgentStateStore.js';

export const AGENT_STATE_FILE_EXTENSION = '.state.yaml';
export const AGENT_STATE_MAX_YAML_SIZE = 64 * 1024;
export const AGENT_STATE_RECOVERY_MAX_YAML_SIZE = 100 * 1024;

export class AgentStateSizeLimitError extends Error {
  constructor() {
    super('Agent state exceeds allowed size for the normal persistence limit');
    this.name = 'AgentStateSizeLimitError';
  }
}

export class AgentStateReductionRequiredError extends Error {
  constructor() {
    super('Oversized agent state recovery must strictly reduce durable state');
    this.name = 'AgentStateReductionRequiredError';
  }
}

export class AgentStateParsedSizeLimitError extends Error {
  constructor(actualBytes: number) {
    super(`Parsed agent state exceeds allowed size of ${AGENT_STATE_RECOVERY_MAX_YAML_SIZE} bytes (actual: ${actualBytes} bytes)`);
    this.name = 'AgentStateParsedSizeLimitError';
  }
}

export interface FileAgentStateStoreDeps {
  stateDir: string | (() => string);
  fileLockManager: FileLockManager;
  fileOperations: IFileOperationsService;
  serializationService: SerializationService;
  stateCache: Map<string, AgentState>;
  maxYamlSize?: number;
}

type SerializedAgentGoal = Omit<
  AgentGoal,
  'importance' | 'urgency' | 'estimatedEffort' | 'createdAt' | 'updatedAt' | 'completedAt'
> & {
  importance?: unknown;
  urgency?: unknown;
  estimatedEffort?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown;
};

type SerializedAgentDecision = Omit<AgentDecision, 'confidence' | 'timestamp'> & {
  confidence?: unknown;
  timestamp?: unknown;
};

type SerializedAgentState = Omit<
  AgentState,
  'goals' | 'decisions' | 'context' | 'lastActive' | 'sessionCount' | 'stateVersion'
> & {
  goals?: SerializedAgentGoal[];
  decisions?: SerializedAgentDecision[];
  context?: Record<string, unknown>;
  lastActive?: unknown;
  sessionCount?: unknown;
  stateVersion?: unknown;
};

export class FileAgentStateStore implements IAgentStateStore {
  private readonly stateDirProvider: () => string;
  private readonly maxYamlSize: number;

  constructor(private readonly deps: FileAgentStateStoreDeps) {
    const stateDir = deps.stateDir;
    this.stateDirProvider = typeof stateDir === 'function'
      ? stateDir
      : () => stateDir;
    this.maxYamlSize = deps.maxYamlSize ?? AGENT_STATE_MAX_YAML_SIZE;
  }

  async load(key: AgentStateKey, options: AgentStateLoadOptions = {}): Promise<AgentState | null> {
    const normalizedName = this.normalizeFilename(key.name);

    const cachedState = this.deps.stateCache.get(normalizedName);
    if (!options.strict && cachedState !== undefined) {
      return cachedState;
    }

    const statePath = path.join(this.stateDir, `${normalizedName}${AGENT_STATE_FILE_EXTENSION}`);

    try {
      const content = await this.deps.fileOperations.readFile(statePath, { encoding: 'utf-8' });
      const durableContentLimit = options.allowOversizedRecovery
        ? AGENT_STATE_RECOVERY_MAX_YAML_SIZE
        : this.maxYamlSize;
      if (Buffer.byteLength(content, 'utf8') > durableContentLimit) {
        throw new AgentStateSizeLimitError();
      }
      const result = this.deps.serializationService.parseFrontmatter(content, {
        maxYamlSize: durableContentLimit,
        validateContent: true,
        source: 'FileAgentStateStore.load',
      });

      const state = this.normalizeLoadedState(result.data as SerializedAgentState);
      const parsedStateBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
      if (parsedStateBytes > AGENT_STATE_RECOVERY_MAX_YAML_SIZE) {
        throw new AgentStateParsedSizeLimitError(parsedStateBytes);
      }
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
        }
        return null;
      }
      logger.error(`Failed to load agent state: ${key.name}`, error);
      if (options.strict
          || error instanceof AgentStateParsedSizeLimitError
          || error instanceof AgentStateSizeLimitError) {
        throw error;
      }
      return null;
    }
  }

  reclaimOrphaned(
    _key: AgentStateKey,
    _options: AgentStateReclaimOptions = {},
  ): Promise<AgentState | null> {
    // A single file contains session-neutral state and carries no durable
    // ownership or presence record. Reclaiming it could therefore steal a
    // still-live execution from another local transport session.
    return Promise.resolve(null);
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

    return this.deps.fileLockManager.withLock(`agent-state:${normalizedName}`, async () => {
      // load() does not acquire an `agent-state:*` lock. Its disk read uses
      // FileOperationsService's distinct `file:<absolute path>` namespace, so
      // this is not a reentrant acquisition of the transaction lock.
      const existingState = await this.load(key, {
        strict: options.requireExisting,
        allowOversizedRecovery: options.allowOversizedReduction,
      });
      if (options.requireExisting && !existingState) {
        throw new Error(`Agent state disappeared while updating '${key.name}'`);
      }
      const existingVersion = existingState?.stateVersion ?? 0;
      const incomingVersionConflict = state.stateVersion !== undefined
        && state.stateVersion !== expectedVersion;
      const durableVersionConflict = options.requireExisting
        ? existingVersion !== expectedVersion
        : existingState?.stateVersion !== undefined && existingVersion > expectedVersion;
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

      const durableContentLength = options.allowOversizedReduction && existingState
        ? Buffer.byteLength(
            await this.deps.fileOperations.readFile(filePath, { encoding: 'utf-8' }),
            'utf8',
          )
        : undefined;

      const nextVersion = expectedVersion + 1;
      const candidateState = structuredClone(state);
      candidateState.stateVersion = nextVersion;
      const serializedState = this.prepareStateForSerialization(candidateState);
      const yamlContent = this.deps.serializationService.dumpYaml(serializedState, {
        schema: 'json',
        noRefs: true,
        sortKeys: true,
      });

      this.validateCandidateSize(
        yamlContent,
        existingState,
        options.allowOversizedReduction === true,
        durableContentLength,
      );
      await this.deps.fileOperations.writeFile(filePath, yamlContent, { encoding: 'utf-8' });
      state.stateVersion = nextVersion;
      this.deps.stateCache.set(normalizedName, state);

      logger.debug('Agent state saved successfully', {
        agentName: key.name,
        normalizedName,
        stateVersion: state.stateVersion,
        goalCount: state.goals.length,
      });
      return nextVersion;
    });
  }

  async delete(key: AgentStateKey): Promise<void> {
    const normalizedName = this.normalizeFilename(key.name);
    const statePath = path.join(this.stateDir, `${normalizedName}${AGENT_STATE_FILE_EXTENSION}`);

    try {
      await this.deps.fileOperations.deleteFile(statePath, ElementType.AGENT, {
        source: 'AgentManager.delete (state file)',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    this.deps.stateCache.delete(normalizedName);
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

  private prepareStateForSerialization(state: AgentState): Record<string, unknown> {
    return {
      ...state,
      lastActive: this.serializeDate(state.lastActive),
      sessionCount: String(state.sessionCount),
      stateVersion: state.stateVersion === undefined ? '1' : String(state.stateVersion),
      goals: state.goals.map(goal => ({
        ...goal,
        createdAt: this.serializeDate(goal.createdAt),
        updatedAt: this.serializeDate(goal.updatedAt),
        completedAt: this.serializeDate(goal.completedAt),
        importance: String(goal.importance),
        urgency: String(goal.urgency),
        estimatedEffort: goal.estimatedEffort === undefined ? undefined : String(goal.estimatedEffort),
      })),
      decisions: state.decisions.map(decision => ({
        ...decision,
        timestamp: this.serializeDate(decision.timestamp),
        confidence: String(decision.confidence),
      })),
    };
  }

  private serializeDate(value: unknown): unknown {
    return utilTypes.isDate(value) ? value.toISOString() : value;
  }

  private validateCandidateSize(
    yamlContent: string,
    existingState: AgentState | null,
    allowOversizedReduction: boolean,
    durableContentLength?: number,
  ): void {
    const yamlBytes = Buffer.byteLength(yamlContent, 'utf8');
    if (yamlBytes <= this.maxYamlSize) {
      return;
    }
    if (yamlBytes > AGENT_STATE_RECOVERY_MAX_YAML_SIZE) {
      if (allowOversizedReduction && existingState) {
        throw new AgentStateReductionRequiredError();
      }
      throw new AgentStateSizeLimitError();
    }
    if (!allowOversizedReduction || !existingState) {
      throw new AgentStateSizeLimitError();
    }
    if (durableContentLength === undefined
      || yamlBytes >= durableContentLength) {
      throw new AgentStateReductionRequiredError();
    }
  }

  private normalizeLoadedState(state: SerializedAgentState): AgentState {
    state.goals ??= [];
    state.decisions ??= [];
    state.context ??= {};

    state.sessionCount = this.parseIntegerOrDefault(state.sessionCount, 0);
    state.stateVersion = this.parseIntegerOrDefault(state.stateVersion, 1);
    if (state.lastActive) {
      state.lastActive = this.deserializeDate(state.lastActive);
    }

    state.goals.forEach(goal => {
      if (goal.importance !== undefined) goal.importance = this.parsePersistedNumber(goal.importance, true);
      if (goal.urgency !== undefined) goal.urgency = this.parsePersistedNumber(goal.urgency, true);
      if (goal.estimatedEffort !== undefined) goal.estimatedEffort = this.parsePersistedNumber(goal.estimatedEffort, false);
      if (goal.createdAt) goal.createdAt = this.deserializeDate(goal.createdAt);
      if (goal.updatedAt) goal.updatedAt = this.deserializeDate(goal.updatedAt);
      if (goal.completedAt) goal.completedAt = this.deserializeDate(goal.completedAt);
    });

    state.decisions.forEach(decision => {
      if (decision.confidence !== undefined) decision.confidence = this.parsePersistedNumber(decision.confidence, false);
      if (decision.timestamp) decision.timestamp = this.deserializeDate(decision.timestamp);
    });

    return state as AgentState;
  }

  private deserializeDate(value: unknown): Date {
    if (utilTypes.isDate(value)) {
      return new Date(value);
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return new Date(value);
    }
    return new Date(Number.NaN);
  }

  private parsePersistedNumber(value: unknown, integer: boolean): number {
    if (typeof value !== 'number' && typeof value !== 'string') {
      return Number.NaN;
    }
    const text = String(value);
    if (integer) {
      return Number.parseInt(text, 10);
    }
    return Number.parseFloat(text);
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
