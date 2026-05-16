import * as path from 'path';

import type { AgentState } from '../elements/agents/types.js';
import { ElementType } from '../portfolio/types.js';
import type { FileLockManager } from '../security/fileLockManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { IFileOperationsService } from '../services/FileOperationsService.js';
import type { SerializationService } from '../services/SerializationService.js';
import { logger } from '../utils/logger.js';
import type { AgentStateKey, IAgentStateStore } from './IAgentStateStore.js';

export const AGENT_STATE_FILE_EXTENSION = '.state.yaml';
export const AGENT_STATE_MAX_YAML_SIZE = 64 * 1024;

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

  constructor(private readonly deps: FileAgentStateStoreDeps) {
    const stateDir = deps.stateDir;
    this.stateDirProvider = typeof stateDir === 'function'
      ? stateDir
      : () => stateDir;
    this.maxYamlSize = deps.maxYamlSize ?? AGENT_STATE_MAX_YAML_SIZE;
  }

  async load(key: AgentStateKey): Promise<AgentState | null> {
    const normalizedName = this.normalizeFilename(key.name);

    if (this.deps.stateCache.has(normalizedName)) {
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

      const state = result.data as AgentState;
      this.normalizeLoadedState(state);
      this.deps.stateCache.set(normalizedName, state);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.error(`Failed to load agent state: ${key.name}`, error);
      return null;
    }
  }

  async save(key: AgentStateKey, state: AgentState, _expectedVersion: number): Promise<number> {
    await this.ensureStateDirectory();

    const normalizedName = this.normalizeFilename(key.name);
    const filePath = path.join(this.stateDir, `${normalizedName}${AGENT_STATE_FILE_EXTENSION}`);

    await this.deps.fileLockManager.withLock(`agent-state:${normalizedName}`, async () => {
      const existingState = await this.load(key);
      if (existingState && existingState.stateVersion !== undefined && state.stateVersion !== undefined) {
        if (existingState.stateVersion > state.stateVersion) {
          logger.warn(`State version conflict detected for agent ${key.name}`, {
            existingVersion: existingState.stateVersion,
            attemptedVersion: state.stateVersion,
          });

          SecurityMonitor.logSecurityEvent({
            type: 'MEMORY_SAVE_FAILED',
            severity: 'MEDIUM',
            source: 'FileAgentStateStore.save',
            details: 'State version conflict: attempted to save stale state',
            additionalData: {
              agentName: key.name,
              existingVersion: existingState.stateVersion,
              attemptedVersion: state.stateVersion,
            },
          });

          throw new Error(
            `State version conflict: current version is ${existingState.stateVersion}, ` +
            `but attempted to save version ${state.stateVersion}. ` +
            `State may have been modified concurrently.`,
          );
        }
      }

      state.stateVersion = (state.stateVersion || 0) + 1;
      const serializedState = this.prepareStateForSerialization(state);
      const yamlContent = this.deps.serializationService.dumpYaml(serializedState, {
        schema: 'json',
        noRefs: true,
        sortKeys: true,
      });

      this.deps.serializationService.validateSize(yamlContent, this.maxYamlSize, 'Agent state');
      await this.deps.fileOperations.writeFile(filePath, yamlContent, { encoding: 'utf-8' });
      this.deps.stateCache.set(normalizedName, state);

      logger.debug('Agent state saved successfully', {
        agentName: key.name,
        normalizedName,
        stateVersion: state.stateVersion,
        goalCount: state.goals?.length ?? 0,
      });
    });

    return state.stateVersion!;
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
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[\s_]+/g, '-')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private prepareStateForSerialization(state: AgentState): Record<string, unknown> {
    return {
      ...state,
      lastActive: state.lastActive instanceof Date ? state.lastActive.toISOString() : state.lastActive,
      sessionCount: String(state.sessionCount ?? 0),
      stateVersion: state.stateVersion !== undefined ? String(state.stateVersion) : '1',
      goals: state.goals.map(goal => ({
        ...goal,
        createdAt: goal.createdAt instanceof Date ? goal.createdAt.toISOString() : goal.createdAt,
        updatedAt: goal.updatedAt instanceof Date ? goal.updatedAt.toISOString() : goal.updatedAt,
        completedAt: goal.completedAt instanceof Date ? goal.completedAt.toISOString() : goal.completedAt,
        importance: goal.importance !== undefined ? String(goal.importance) : undefined,
        urgency: goal.urgency !== undefined ? String(goal.urgency) : undefined,
        estimatedEffort: goal.estimatedEffort !== undefined ? String(goal.estimatedEffort) : undefined,
      })),
      decisions: state.decisions.map(decision => ({
        ...decision,
        timestamp: decision.timestamp instanceof Date ? decision.timestamp.toISOString() : decision.timestamp,
        confidence: decision.confidence !== undefined ? String(decision.confidence) : undefined,
      })),
    };
  }

  private normalizeLoadedState(state: AgentState): void {
    state.goals ??= [];
    state.decisions ??= [];
    state.context ??= {};

    if (state.sessionCount !== undefined) {
      state.sessionCount = Number.parseInt(String(state.sessionCount), 10);
    }
    if (state.stateVersion !== undefined) {
      state.stateVersion = Number.parseInt(String(state.stateVersion), 10);
    } else {
      state.stateVersion = 1;
    }
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
}
