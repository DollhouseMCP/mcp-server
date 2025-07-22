/**
 * AgentManager - Handles CRUD operations for Agent elements
 * Follows patterns from PersonaElementManager and MemoryManager
 * 
 * SECURITY: Uses FileLockManager for atomic operations and SecureYamlParser for safe YAML parsing
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { Agent } from './Agent.js';
import { AgentMetadata, AgentState } from './types.js';
import { IElementManager, ElementValidationResult } from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import * as yaml from 'js-yaml';
import { sanitizeInput } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';

// Constants
const AGENT_FILE_EXTENSION = '.md';
const STATE_DIRECTORY = '.state';
const STATE_FILE_EXTENSION = '.state.yaml';
const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_YAML_SIZE = 64 * 1024; // 64KB for frontmatter

// Element creation result interface
interface ElementCreationResult {
  success: boolean;
  message: string;
  element?: Agent;
}

interface AgentFileData {
  metadata: AgentMetadata;
  content: string;
  state?: AgentState;
}

export class AgentManager implements IElementManager<Agent> {
  private readonly agentsPath: string;
  private readonly stateCache: Map<string, AgentState> = new Map();

  constructor(portfolioPath: string) {
    this.agentsPath = path.join(portfolioPath, 'agents');
  }

  /**
   * Initialize the agents directory structure
   */
  public async initialize(): Promise<void> {
    try {
      // Create agents directory if it doesn't exist
      await fs.mkdir(this.agentsPath, { recursive: true });
      
      // Create .state directory for agent states
      const statePath = path.join(this.agentsPath, STATE_DIRECTORY);
      await fs.mkdir(statePath, { recursive: true });
      
      logger.info('AgentManager initialized', { path: this.agentsPath });
    } catch (error) {
      logger.error('Failed to initialize AgentManager', error);
      throw error;
    }
  }

  /**
   * Create a new agent
   */
  public async create(
    name: string,
    description: string,
    content: string,
    metadata?: Partial<AgentMetadata>
  ): Promise<ElementCreationResult> {
    try {
      // Sanitize inputs
      const sanitizedName = sanitizeInput(UnicodeValidator.normalize(name).normalizedContent, 100);
      const sanitizedDescription = sanitizeInput(UnicodeValidator.normalize(description).normalizedContent, 500);
      const sanitizedContent = sanitizeInput(UnicodeValidator.normalize(content).normalizedContent, 50000);

      // Validate name
      if (!this.validateElementName(sanitizedName)) {
        return {
          success: false,
          message: 'Invalid agent name. Use only letters, numbers, hyphens, and underscores.'
        };
      }

      // Check if agent already exists
      const filename = this.getFilename(sanitizedName);
      const filepath = path.join(this.agentsPath, filename);
      
      try {
        await fs.access(filepath);
        return {
          success: false,
          message: `Agent '${sanitizedName}' already exists`
        };
      } catch {
        // File doesn't exist, we can create it
      }

      // Create agent instance
      const agent = new Agent({
        name: sanitizedName,
        description: sanitizedDescription,
        ...metadata
      });

      // Set author
      agent.metadata.author = this.getCurrentUserForAttribution();

      // Prepare file content
      const fileContent = this.serializeToFile(agent, sanitizedContent);

      // Write file atomically
      await FileLockManager.atomicWriteFile(filepath, fileContent, { encoding: 'utf-8' });

      // Log security event
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'AgentManager.create',
        details: `Agent '${sanitizedName}' created`,
        additionalData: { agentId: agent.id }
      });

      logger.info(`Agent created: ${sanitizedName}`);
      
      return {
        success: true,
        message: `🤖 **${sanitizedName}** by ${agent.metadata.author || 'anonymous'}`,
        element: agent
      };
    } catch (error) {
      logger.error('Failed to create agent', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to create agent'
      };
    }
  }

  /**
   * Read an agent by name
   */
  public async read(name: string): Promise<Agent | null> {
    try {
      const sanitizedName = sanitizeInput(name, 100);
      const filename = this.getFilename(sanitizedName);
      const filepath = path.join(this.agentsPath, filename);

      // Read file with lock
      const content = await FileLockManager.atomicReadFile(filepath, { encoding: 'utf-8' });
      
      // Check file size
      if (content.length > MAX_FILE_SIZE) {
        throw new Error(`Agent file exceeds maximum size of ${MAX_FILE_SIZE} bytes`);
      }

      // Parse file
      const agentData = this.parseAgentFile(content);
      
      // Create agent instance - ensure metadata is passed correctly
      const agent = new Agent(agentData.metadata);
      
      // Load state if available
      const state = await this.loadAgentState(sanitizedName);
      if (state) {
        agent.deserialize(JSON.stringify({
          ...JSON.parse(agent.serialize()),
          state
        }));
      }

      return agent;
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return null;
      }
      logger.error(`Failed to read agent: ${name}`, error);
      throw error;
    }
  }

  /**
   * Update an agent
   */
  public async update(
    name: string,
    updates: Partial<AgentMetadata>,
    content?: string
  ): Promise<boolean> {
    try {
      const agent = await this.read(name);
      if (!agent) {
        logger.warn(`Agent not found for update: ${name}`);
        return false;
      }

      // Apply metadata updates
      if (updates.description !== undefined) {
        agent.metadata.description = sanitizeInput(
          UnicodeValidator.normalize(updates.description).normalizedContent,
          500
        );
      }

      if (updates.specializations !== undefined) {
        agent.extensions = {
          ...agent.extensions,
          specializations: updates.specializations.map((s: string) => sanitizeInput(s, 50))
        };
      }

      if (updates.decisionFramework !== undefined) {
        agent.extensions = {
          ...agent.extensions,
          decisionFramework: updates.decisionFramework
        };
      }

      if (updates.riskTolerance !== undefined) {
        agent.extensions = {
          ...agent.extensions,
          riskTolerance: updates.riskTolerance
        };
      }

      // Update modification time
      agent.metadata.modified = new Date().toISOString();

      // Get current content if not provided
      if (content === undefined) {
        const filename = this.getFilename(name);
        const filepath = path.join(this.agentsPath, filename);
        const fileContent = await FileLockManager.atomicReadFile(filepath, { encoding: 'utf-8' });
        const parsed = this.parseAgentFile(fileContent);
        content = parsed.content;
      }

      // Save agent
      const filename = this.getFilename(name);
      const filepath = path.join(this.agentsPath, filename);
      const fileContent = this.serializeToFile(agent, content);
      
      await FileLockManager.atomicWriteFile(filepath, fileContent, { encoding: 'utf-8' });

      // Save state if needed
      if (agent.needsStatePersistence()) {
        await this.saveAgentState(name, agent.getState());
        agent.markStatePersisted();
      }

      logger.info(`Agent updated: ${name}`);
      return true;
    } catch (error) {
      logger.error(`Failed to update agent: ${name}`, error);
      return false;
    }
  }

  /**
   * Delete an agent
   */
  public async delete(name: string): Promise<void> {
    try {
      const sanitizedName = sanitizeInput(name, 100);
      const filename = this.getFilename(sanitizedName);
      const filepath = path.join(this.agentsPath, filename);

      // Check if file exists
      try {
        await fs.access(filepath);
      } catch {
        return;
      }

      // Delete main file
      await fs.unlink(filepath);

      // Delete state file if exists
      const stateFilename = `${sanitizedName}${STATE_FILE_EXTENSION}`;
      const stateFilepath = path.join(this.agentsPath, STATE_DIRECTORY, stateFilename);
      try {
        await fs.unlink(stateFilepath);
        this.stateCache.delete(sanitizedName);
      } catch {
        // State file might not exist
      }

      // Log security event
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DELETED',
        severity: 'MEDIUM',
        source: 'AgentManager.delete',
        details: `Agent '${sanitizedName}' deleted`
      });

      logger.info(`Agent deleted: ${sanitizedName}`);
    } catch (error) {
      logger.error(`Failed to delete agent: ${name}`, error);
      throw error;
    }
  }

  /**
   * List all agents
   */
  public async list(): Promise<Agent[]> {
    try {
      const files = await fs.readdir(this.agentsPath);
      
      // Filter for agent files
      const agentFiles = files.filter(file => 
        file.endsWith(AGENT_FILE_EXTENSION) && 
        !file.startsWith('.') &&
        file !== STATE_DIRECTORY
      );

      // Load all agents
      const agents: Agent[] = [];
      for (const file of agentFiles) {
        const name = file.substring(0, file.length - AGENT_FILE_EXTENSION.length);
        try {
          const agent = await this.read(name);
          if (agent) {
            agents.push(agent);
          }
        } catch (error) {
          logger.warn(`Failed to load agent ${name}:`, error);
        }
      }
      return agents;
    } catch (error) {
      logger.error('Failed to list agents', error);
      return [];
    }
  }

  /**
   * Check if an agent exists
   */
  public async exists(name: string): Promise<boolean> {
    try {
      const sanitizedName = sanitizeInput(name, 100);
      const filename = this.getFilename(sanitizedName);
      const filepath = path.join(this.agentsPath, filename);
      
      await fs.access(filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate an agent name
   */
  public validateName(name: string): { valid: boolean; error?: string } {
    if (!name || name.trim().length === 0) {
      return { valid: false, error: 'Name cannot be empty' };
    }

    if (name.length > 100) {
      return { valid: false, error: 'Name cannot exceed 100 characters' };
    }

    if (!this.validateElementName(name)) {
      return { 
        valid: false, 
        error: 'Name can only contain letters, numbers, hyphens, and underscores' 
      };
    }

    return { valid: true };
  }

  /**
   * Get element type
   */
  public getElementType(): ElementType {
    return ElementType.AGENT;
  }

  /**
   * Load agent state from file
   */
  private async loadAgentState(name: string): Promise<AgentState | null> {
    try {
      // Check cache first
      if (this.stateCache.has(name)) {
        return this.stateCache.get(name)!;
      }

      const stateFilename = `${name}${STATE_FILE_EXTENSION}`;
      const stateFilepath = path.join(this.agentsPath, STATE_DIRECTORY, stateFilename);

      const content = await FileLockManager.atomicReadFile(stateFilepath, { encoding: 'utf-8' });
      
      // Parse YAML safely
      const parsedContent = SecureYamlParser.parse(content, {
        maxYamlSize: MAX_YAML_SIZE,
        validateContent: true
      });
      const state = parsedContent.data as any;
      
      // Convert string numbers back to numbers
      if (state.sessionCount !== undefined) {
        state.sessionCount = parseInt(state.sessionCount, 10);
      }
      
      // Convert goal numbers
      if (state.goals) {
        state.goals.forEach((goal: any) => {
          if (goal.importance !== undefined) goal.importance = parseInt(goal.importance, 10);
          if (goal.urgency !== undefined) goal.urgency = parseInt(goal.urgency, 10);
          if (goal.estimatedEffort !== undefined) goal.estimatedEffort = parseFloat(goal.estimatedEffort);
        });
      }
      
      // Convert decision confidence
      if (state.decisions) {
        state.decisions.forEach((decision: any) => {
          if (decision.confidence !== undefined) decision.confidence = parseFloat(decision.confidence);
        });
      }

      // Cache the state
      this.stateCache.set(name, state);

      return state;
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return null;
      }
      logger.error(`Failed to load agent state: ${name}`, error);
      return null;
    }
  }

  /**
   * Save agent state to file
   */
  public async saveAgentState(name: string, state: AgentState): Promise<void> {
    try {
      const stateFilename = `${name}${STATE_FILE_EXTENSION}`;
      const stateFilepath = path.join(this.agentsPath, STATE_DIRECTORY, stateFilename);

      // Convert dates to ISO strings and numbers to strings for FAILSAFE_SCHEMA
      const serializedState = {
        ...state,
        lastActive: state.lastActive instanceof Date ? state.lastActive.toISOString() : state.lastActive,
        sessionCount: String(state.sessionCount),
        goals: state.goals.map(goal => ({
          ...goal,
          createdAt: goal.createdAt instanceof Date ? goal.createdAt.toISOString() : goal.createdAt,
          updatedAt: goal.updatedAt instanceof Date ? goal.updatedAt.toISOString() : goal.updatedAt,
          completedAt: goal.completedAt instanceof Date ? goal.completedAt.toISOString() : goal.completedAt,
          importance: goal.importance !== undefined ? String(goal.importance) : undefined,
          urgency: goal.urgency !== undefined ? String(goal.urgency) : undefined,
          estimatedEffort: goal.estimatedEffort !== undefined ? String(goal.estimatedEffort) : undefined
        })),
        decisions: state.decisions.map(decision => ({
          ...decision,
          timestamp: decision.timestamp instanceof Date ? decision.timestamp.toISOString() : decision.timestamp,
          confidence: decision.confidence !== undefined ? String(decision.confidence) : undefined
        }))
      };

      // Convert state to YAML
      const yamlContent = yaml.dump(serializedState, {
        schema: yaml.FAILSAFE_SCHEMA,
        noRefs: true,
        sortKeys: true
      });

      // Validate size
      if (yamlContent.length > MAX_YAML_SIZE) {
        throw new Error(`State size exceeds maximum of ${MAX_YAML_SIZE} bytes`);
      }

      // Write atomically
      await FileLockManager.atomicWriteFile(stateFilepath, yamlContent, { encoding: 'utf-8' });

      // Update cache
      this.stateCache.set(name, state);

      logger.debug(`Agent state saved: ${name}`);
    } catch (error) {
      logger.error(`Failed to save agent state: ${name}`, error);
      throw error;
    }
  }

  /**
   * Parse agent file content
   */
  private parseAgentFile(content: string): AgentFileData {
    // Extract frontmatter and content
    const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      throw new Error('Invalid agent file format - missing frontmatter');
    }

    const [, frontmatter, body] = match;

    // Parse frontmatter - SecureYamlParser expects full content with frontmatter markers
    // but we're passing just the YAML content, so we need to parse it directly
    const parsedYaml = SecureYamlParser.parse(`---\n${frontmatter}\n---`, {
      maxYamlSize: MAX_YAML_SIZE,
      validateContent: false  // We'll validate body separately
    });
    const metadata = parsedYaml.data as unknown as AgentMetadata;

    // Validate type if using the typed metadata
    const typedMetadata = metadata as any;
    if (typedMetadata.type && typedMetadata.type !== ElementType.AGENT && typedMetadata.type !== 'agent') {
      throw new Error(`Invalid element type: expected '${ElementType.AGENT}', got '${typedMetadata.type}'`);
    }

    return {
      metadata,
      content: body.trim()
    };
  }

  /**
   * Serialize agent to file format
   */
  private serializeToFile(agent: Agent, content: string): string {
    const metadata: any = {
      name: agent.metadata.name,
      type: ElementType.AGENT,
      version: agent.metadata.version,
      author: agent.metadata.author,
      created: agent.metadata.created || new Date().toISOString(),
      modified: agent.metadata.modified || new Date().toISOString(),
      description: agent.metadata.description,
      decisionFramework: agent.extensions?.decisionFramework,
      riskTolerance: agent.extensions?.riskTolerance,
      learningEnabled: agent.extensions?.learningEnabled !== undefined ? 
        String(agent.extensions.learningEnabled) : undefined,
      maxConcurrentGoals: (agent.metadata as AgentMetadata).maxConcurrentGoals,
      specializations: agent.extensions?.specializations
    };

    // Remove undefined values
    Object.keys(metadata).forEach(key => {
      if (metadata[key as keyof typeof metadata] === undefined) {
        delete metadata[key as keyof typeof metadata];
      }
    });

    const yamlContent = yaml.dump(metadata, {
      schema: yaml.FAILSAFE_SCHEMA,
      noRefs: true,
      sortKeys: true
    });
    
    return `---\n${yamlContent}---\n\n${content}`;
  }

  /**
   * Get filename for agent
   */
  private getFilename(name: string): string {
    return `${name}${AGENT_FILE_EXTENSION}`;
  }

  /**
   * Validate element name
   */
  private validateElementName(name: string): boolean {
    // Only letters, numbers, hyphens, and underscores
    return /^[a-zA-Z0-9_-]+$/.test(name);
  }

  /**
   * Get current user for attribution
   */
  private getCurrentUserForAttribution(): string {
    return process.env.DOLLHOUSE_USER || 'anonymous';
  }

  /**
   * Find an agent by predicate
   */
  public async find(predicate: (element: Agent) => boolean): Promise<Agent | undefined> {
    const agents = await this.list();
    return agents.find(predicate);
  }

  /**
   * Find many agents by predicate
   */
  public async findMany(predicate: (element: Agent) => boolean): Promise<Agent[]> {
    const agents = await this.list();
    return agents.filter(predicate);
  }

  /**
   * Validate an agent
   */
  public validate(element: Agent): ElementValidationResult {
    return element.validate();
  }

  /**
   * Validate a path
   */
  public validatePath(path: string): boolean {
    // Check for path traversal
    if (path.includes('..') || path.includes('~')) {
      return false;
    }
    // Check for absolute paths
    if (path.startsWith('/') || path.match(/^[A-Za-z]:/)) {
      return false;
    }
    return true;
  }

  /**
   * Get file extension
   */
  public getFileExtension(): string {
    return AGENT_FILE_EXTENSION;
  }

  /**
   * Import an agent from data
   */
  public async importElement(data: string, format?: 'json' | 'yaml' | 'markdown'): Promise<Agent> {
    if (format === 'json') {
      const parsed = JSON.parse(data);
      const agent = new Agent(parsed.metadata);
      if (parsed.state) {
        agent.deserialize(JSON.stringify(parsed));
      }
      return agent;
    } else {
      // Parse as markdown with YAML frontmatter
      const agentData = this.parseAgentFile(data);
      const agent = new Agent(agentData.metadata);
      if (agentData.state) {
        agent.deserialize(JSON.stringify({
          ...JSON.parse(agent.serialize()),
          state: agentData.state
        }));
      }
      return agent;
    }
  }

  /**
   * Export an agent to a format
   */
  public async exportElement(element: Agent, format?: 'json' | 'yaml' | 'markdown'): Promise<string> {
    if (format === 'json') {
      return element.serialize();
    } else {
      // Export as markdown with YAML frontmatter
      const content = `# ${element.metadata.name}\n\n${element.metadata.description || ''}`;
      return this.serializeToFile(element, content);
    }
  }

  /**
   * Save an agent to a specific path
   */
  public async save(element: Agent, targetPath: string): Promise<void> {
    const name = targetPath.replace(AGENT_FILE_EXTENSION, '');
    const content = `# ${element.metadata.name}\n\n${element.metadata.description || ''}`;
    
    // Save the agent file
    const filename = this.getFilename(name);
    const filepath = path.isAbsolute(targetPath) ? targetPath : path.join(this.agentsPath, filename);
    const fileContent = this.serializeToFile(element, content);
    await FileLockManager.atomicWriteFile(filepath, fileContent, { encoding: 'utf-8' });

    // Save state if needed
    if (element.needsStatePersistence()) {
      await this.saveAgentState(name, element.getState());
      element.markStatePersisted();
    }
  }

  /**
   * Load an agent from a specific path
   */
  public async load(targetPath: string): Promise<Agent> {
    const agent = await this.read(targetPath.replace(AGENT_FILE_EXTENSION, ''));
    if (!agent) {
      throw new Error(`Agent not found at path: ${targetPath}`);
    }
    return agent;
  }
}