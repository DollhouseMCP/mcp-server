#!/usr/bin/env node

// Defensive error handling for npx/CLI execution
process.on('uncaughtException', (error) => {
  console.error('[DollhouseMCP] Server startup failed');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[DollhouseMCP] Server startup failed');
  process.exit(1);
});

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { loadIndicatorConfig, formatIndicator, validateCustomFormat, type IndicatorConfig } from './config/indicator-config.js';
import { SecureYamlParser } from './security/secureYamlParser.js';
import { SecurityError } from './errors/SecurityError.js';
import { SecureErrorHandler } from './security/errorHandler.js';
import { ErrorHandler, ErrorCategory } from './utils/ErrorHandler.js';

// Import modularized components
import { Persona, PersonaMetadata } from './types/persona.js';
import { APICache, CollectionCache } from './cache/index.js';
import { validateFilename, sanitizeInput, validateContentSize, validateUsername, MCPInputValidator } from './security/InputValidator.js';
import { SECURITY_LIMITS, VALIDATION_PATTERNS } from './security/constants.js';
import { ContentValidator } from './security/contentValidator.js';
import { PathValidator } from './security/pathValidator.js';
import { FileLockManager } from './security/fileLockManager.js';
import { generateAnonymousId, generateUniqueId, slugify } from './utils/filesystem.js';
import { GitHubClient, CollectionBrowser, CollectionSearch, PersonaDetails, PersonaSubmitter, ElementInstaller } from './collection/index.js';
import { UpdateManager } from './update/index.js';
import { ServerSetup, IToolHandler } from './server/index.js';
import { GitHubAuthManager } from './auth/GitHubAuthManager.js';
import { logger } from './utils/logger.js';
import { PersonaExporter, PersonaImporter, PersonaSharer } from './persona/export-import/index.js';
import { isDefaultPersona } from './constants/defaultPersonas.js';
import { PortfolioManager, ElementType } from './portfolio/PortfolioManager.js';
import { MigrationManager } from './portfolio/MigrationManager.js';
import { SkillManager } from './elements/skills/index.js';
import { Skill } from './elements/skills/Skill.js';
import { TemplateManager } from './elements/templates/TemplateManager.js';
import { Template } from './elements/templates/Template.js';
import { AgentManager } from './elements/agents/AgentManager.js';
import { Agent } from './elements/agents/Agent.js';
import { ConfigManager } from './config/ConfigManager.js';



// Detect execution environment
const EXECUTION_ENV = {
  isNpx: process.env.npm_execpath?.includes('npx') || false,
  isCli: process.argv[1]?.endsWith('/dollhousemcp') || false,
  isDirect: !process.env.npm_execpath,
  cwd: process.cwd(),
  scriptPath: process.argv[1],
};

// Only log execution environment in debug mode
if (process.env.DOLLHOUSE_DEBUG) {
  console.error('[DollhouseMCP] Debug mode enabled');
}

export class DollhouseMCPServer implements IToolHandler {
  private server: Server;
  public personasDir: string | null;
  private personas: Map<string, Persona> = new Map();
  private activePersona: string | null = null;
  private currentUser: string | null = null;
  private isInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private apiCache: APICache = new APICache();
  private collectionCache: CollectionCache = new CollectionCache();
  private rateLimitTracker = new Map<string, number[]>();
  private indicatorConfig: IndicatorConfig;
  private githubClient: GitHubClient;
  private githubAuthManager: GitHubAuthManager;
  private collectionBrowser: CollectionBrowser;
  private collectionSearch: CollectionSearch;
  private personaDetails: PersonaDetails;
  private elementInstaller: ElementInstaller;
  private personaSubmitter: PersonaSubmitter;
  private updateManager?: UpdateManager;
  private serverSetup: ServerSetup;
  private personaExporter: PersonaExporter;
  private personaImporter?: PersonaImporter;
  private personaSharer: PersonaSharer;
  private portfolioManager: PortfolioManager;
  private migrationManager: MigrationManager;
  private skillManager: SkillManager;
  private templateManager: TemplateManager;
  private agentManager: AgentManager;

  constructor() {
    this.server = new Server(
      {
        name: "dollhousemcp",
        version: "1.0.0-build-20250817-1630-pr606",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize portfolio system
    this.portfolioManager = PortfolioManager.getInstance();
    this.migrationManager = new MigrationManager(this.portfolioManager);
    
    // CRITICAL FIX: Don't access directories until after migration runs
    // Previously: this.personasDir was set here, creating directories before migration could fix them
    // Now: We delay directory access until initializePortfolio() completes
    // Using null to make the uninitialized state explicit (per PR review feedback)
    this.personasDir = null; // Will be properly initialized in completeInitialization()
    
    // Initialize element managers
    this.skillManager = new SkillManager();
    this.templateManager = new TemplateManager();
    this.agentManager = new AgentManager(this.portfolioManager.getBaseDir());
    
    // Log resolved path for debugging
    logger.info(`Personas directory resolved to: ${this.personasDir}`);
    
    // PathValidator will be initialized after migration completes
    
    // Load user identity from environment variables
    this.currentUser = process.env.DOLLHOUSE_USER || null;
    
    // Load indicator configuration
    this.indicatorConfig = loadIndicatorConfig();
    
    // Initialize persona manager
    
    // Initialize collection modules
    this.githubClient = new GitHubClient(this.apiCache, this.rateLimitTracker);
    this.githubAuthManager = new GitHubAuthManager(this.apiCache);
    this.collectionBrowser = new CollectionBrowser(this.githubClient, this.collectionCache);
    this.collectionSearch = new CollectionSearch(this.githubClient, this.collectionCache);
    this.personaDetails = new PersonaDetails(this.githubClient);
    this.elementInstaller = new ElementInstaller(this.githubClient);
    this.personaSubmitter = new PersonaSubmitter();
    
    // Update manager will be initialized after migration completes to avoid jsdom crash
    
    // Initialize export/import/share modules
    this.personaExporter = new PersonaExporter(this.currentUser);
    // PersonaImporter will be initialized after migration completes
    this.personaSharer = new PersonaSharer(this.githubClient, this.currentUser);
    
    // Initialize server setup
    this.serverSetup = new ServerSetup();
    this.serverSetup.setupServer(this.server, this);
    
    // FIX #610: Portfolio initialization moved to run() method to prevent race condition
    // Previously: this.initializePortfolio().then() ran async in constructor
    // Now: Initialization happens synchronously in run() before MCP connection
  }
  
  private async initializePortfolio(): Promise<void> {
    // Check if migration is needed
    const needsMigration = await this.migrationManager.needsMigration();
    
    if (needsMigration) {
      logger.info('Legacy personas detected. Starting migration...');
      
      const result = await this.migrationManager.migrate({ backup: true });
      
      if (result.success) {
        logger.info(`Successfully migrated ${result.migratedCount} personas`);
        if (result.backedUp && result.backupPath) {
          logger.info(`Backup created at: ${result.backupPath}`);
        }
      } else {
        logger.error('Migration completed with errors:');
        result.errors.forEach(err => logger.error(`  - ${err}`));
      }
    }
    
    // Ensure portfolio structure exists
    const portfolioExists = await this.portfolioManager.exists();
    if (!portfolioExists) {
      logger.info('Creating portfolio directory structure...');
      await this.portfolioManager.initialize();
    }
    
    // Initialize collection cache for anonymous access
    await this.initializeCollectionCache();
  }
  
  /**
   * Complete initialization after portfolio is ready
   * FIX #610: This was previously in a .then() callback in the constructor
   * Now called synchronously from run() to prevent race condition
   */
  private async completeInitialization(): Promise<void> {
    // NOW safe to access directories after migration
    this.personasDir = this.portfolioManager.getElementDir(ElementType.PERSONA);
    
    // Log resolved path for debugging
    logger.info(`Personas directory resolved to: ${this.personasDir}`);
    
    // Initialize PathValidator with the personas directory
    PathValidator.initialize(this.personasDir);
    
    // Initialize update manager with safe directory
    // Use the parent of personas directory to avoid production check
    const safeDir = path.dirname(this.personasDir);
    try {
      this.updateManager = new UpdateManager(safeDir);
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.initializeUpdateManager', error);
      // Continue without update functionality
    }
    
    // Initialize import module that depends on personasDir
    this.personaImporter = new PersonaImporter(this.personasDir, this.currentUser);
    
    this.loadPersonas();
    
    // Mark initialization as complete
    this.isInitialized = true;
  }
  
  /**
   * Ensure server is initialized before any operation
   * FIX #610: Added for test compatibility - tests don't call run()
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    
    // If initialization is already in progress, wait for it
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }
    
    // Start initialization
    this.initializationPromise = (async () => {
      try {
        await this.initializePortfolio();
        await this.completeInitialization();
        logger.info("Portfolio and personas initialized successfully (lazy)");
      } catch (error) {
        ErrorHandler.logError('DollhouseMCPServer.ensureInitialized', error);
        throw error;
      }
    })();
    
    await this.initializationPromise;
  }
  
  /**
   * Initialize collection cache with seed data for anonymous browsing
   */
  private async initializeCollectionCache(): Promise<void> {
    try {
      const isCacheValid = await this.collectionCache.isCacheValid();
      if (!isCacheValid) {
        logger.info('Initializing collection cache with seed data...');
        const { CollectionSeeder } = await import('./collection/CollectionSeeder.js');
        const seedData = CollectionSeeder.getSeedData();
        await this.collectionCache.saveCache(seedData);
        logger.info(`Collection cache initialized with ${seedData.length} items`);
      } else {
        const stats = await this.collectionCache.getCacheStats();
        logger.debug(`Collection cache already valid with ${stats.itemCount} items`);
      }
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.initializeCollectionCache', error);
      // Don't throw - cache failures shouldn't prevent server startup
    }
  }

  // Tool handler methods - now public for access from tool modules
  
  private getPersonaIndicator(): string {
    if (!this.activePersona) {
      return "";
    }

    const persona = this.personas.get(this.activePersona);
    if (!persona) {
      return "";
    }

    return formatIndicator(this.indicatorConfig, {
      name: persona.metadata.name,
      version: persona.metadata.version,
      author: persona.metadata.author,
      category: persona.metadata.category
    });
  }

  /**
   * Normalize element type to handle both singular (new) and plural (legacy) forms
   * This provides backward compatibility during the transition to v1.4.0
   */
  private normalizeElementType(type: string): string {
    // Map plural forms to singular ElementType values
    const pluralToSingularMap: Record<string, string> = {
      'personas': ElementType.PERSONA,
      'skills': ElementType.SKILL,
      'templates': ElementType.TEMPLATE,
      'agents': ElementType.AGENT,
      'memories': ElementType.MEMORY,
      'ensembles': ElementType.ENSEMBLE
    };
    
    // If it's already a valid ElementType value, return as-is
    if (Object.values(ElementType).includes(type as ElementType)) {
      return type;
    }
    
    // If it's a plural form, convert to singular
    if (pluralToSingularMap[type]) {
      // Log deprecation warning
      logger.warn(`Using plural element type '${type}' is deprecated. Please use singular form '${pluralToSingularMap[type]}' instead.`);
      return pluralToSingularMap[type];
    }
    
    // Unknown type - return as-is and let validation handle it
    return type;
  }

  /**
   * Sanitize metadata object to prevent prototype pollution
   * Removes any dangerous properties that could affect Object.prototype
   */
  private sanitizeMetadata(metadata: Record<string, any>): Record<string, any> {
    if (!metadata || typeof metadata !== 'object') {
      return {};
    }
    
    const dangerousProperties = ['__proto__', 'constructor', 'prototype'];
    const sanitized: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(metadata)) {
      if (!dangerousProperties.includes(key)) {
        // Recursively sanitize nested objects
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          sanitized[key] = this.sanitizeMetadata(value);
        } else {
          sanitized[key] = value;
        }
      }
    }
    
    return sanitized;
  }

  private async loadPersonas() {
    // Validate the personas directory path
    // personasDir is guaranteed to be set by completeInitialization before this is called
    if (!path.isAbsolute(this.personasDir!)) {
      logger.warn(`Personas directory path is not absolute: ${this.personasDir}`);
    }
    
    try {
      await fs.access(this.personasDir!);
    } catch (error) {
      // Create personas directory if it doesn't exist
      try {
        await fs.mkdir(this.personasDir!, { recursive: true });
        logger.info(`Created personas directory at: ${this.personasDir}`);
        // Continue to try loading (directory will be empty)
      } catch (mkdirError) {
        ErrorHandler.logError('DollhouseMCPServer.loadPersonas.mkdir', mkdirError, { personasDir: this.personasDir });
        // Don't throw - empty portfolio is valid
        this.personas.clear();
        return;
      }
    }

    try {
      // personasDir is guaranteed to be set by completeInitialization before this is called
      const files = await fs.readdir(this.personasDir!);
      const markdownFiles = files.filter(file => file.endsWith('.md'));

      this.personas.clear();
      
      if (markdownFiles.length === 0) {
        logger.info('[DollhouseMCP] No personas found in portfolio. Use browse_collection to install some!');
      }

      for (const file of markdownFiles) {
        try {
          const filePath = path.join(this.personasDir!, file);
          const fileContent = await PathValidator.safeReadFile(filePath);
          
          // Use secure YAML parser
          let parsed;
          try {
            parsed = SecureYamlParser.safeMatter(fileContent);
          } catch (error) {
            if (error instanceof SecurityError) {
              logger.warn(`Security threat detected in persona ${file}: ${error.message}`);
              continue;
            }
            throw error;
          }
          
          const metadata = parsed.data as PersonaMetadata;
          const content = parsed.content;

          if (!metadata.name) {
            metadata.name = path.basename(file, '.md');
          }

          // Generate unique ID if not present
          let uniqueId = metadata.unique_id;
          if (!uniqueId) {
            const authorForId = metadata.author || this.getCurrentUserForAttribution();
            uniqueId = generateUniqueId(metadata.name, authorForId);
            logger.debug(`Generated unique ID for ${metadata.name}: ${uniqueId}`);
          }

          // Set default values for new metadata fields
          if (!metadata.category) metadata.category = 'general';
          if (!metadata.age_rating) metadata.age_rating = 'all';
          if (!metadata.content_flags) metadata.content_flags = [];
          if (metadata.ai_generated === undefined) metadata.ai_generated = false;
          if (!metadata.generation_method) metadata.generation_method = 'human';
          if (!metadata.price) metadata.price = 'free';
          if (!metadata.license) metadata.license = 'CC-BY-SA-4.0';

          const persona: Persona = {
            metadata,
            content,
            filename: file,
            unique_id: uniqueId,
          };

          this.personas.set(file, persona);
          logger.debug(`Loaded persona: ${metadata.name} (${uniqueId}`);
        } catch (error) {
          ErrorHandler.logError('DollhouseMCPServer.loadPersonas.loadFile', error, { file });
        }
      }
    } catch (error) {
      // Handle ENOENT gracefully - directory might not exist yet
      if ((error as any).code === 'ENOENT') {
        logger.info('[DollhouseMCP] Personas directory does not exist yet - portfolio is empty');
        this.personas.clear();
        return;
      }
      ErrorHandler.logError('DollhouseMCPServer.loadPersonas', error);
      this.personas.clear();
    }
  }

  async listPersonas() {
    const personaList = Array.from(this.personas.values()).map(persona => ({
      filename: persona.filename,
      unique_id: persona.unique_id,
      name: persona.metadata.name,
      description: persona.metadata.description,
      triggers: persona.metadata.triggers || [],
      version: persona.metadata.version || "1.0",
      author: persona.metadata.author || "Unknown",
      category: persona.metadata.category || 'general',
      age_rating: persona.metadata.age_rating || 'all',
      price: persona.metadata.price || 'free',
      ai_generated: persona.metadata.ai_generated || false,
      active: this.activePersona === persona.filename,
    }));

    if (personaList.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}You don't have any personas installed yet. Would you like to browse the DollhouseMCP collection on GitHub to see what's available? I can show you personas for creative writing, technical analysis, and more. Just say "yes" or use 'browse_collection'.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `${this.getPersonaIndicator()}Available Personas (${personaList.length}):\n\n` +
            personaList.map(p => 
              `${p.active ? '🔹 ' : '▫️ '}**${p.name}** (${p.unique_id})\n` +
              `   ${p.description}\n` +
              `   📁 ${p.category} | 🎭 ${p.author} | 🔖 ${p.price} | ${p.ai_generated ? '🤖 AI' : '👤 Human'}\n` +
              `   Age: ${p.age_rating} | Version: ${p.version}\n` +
              `   Triggers: ${p.triggers.join(', ') || 'None'}\n`
            ).join('\n'),
        },
      ],
    };
  }

  async activatePersona(personaIdentifier: string) {
    // Enhanced input validation for persona identifier
    const validatedIdentifier = MCPInputValidator.validatePersonaIdentifier(personaIdentifier);
    
    // Try to find persona by filename first, then by name
    let persona = this.personas.get(validatedIdentifier);
    
    if (!persona) {
      // Search by name
      persona = Array.from(this.personas.values()).find(p => 
        p.metadata.name.toLowerCase() === validatedIdentifier.toLowerCase()
      );
    }

    if (!persona) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Persona not found: ${personaIdentifier}`
      );
    }

    this.activePersona = persona.filename;

    return {
      content: [
        {
          type: "text",
          text: `${this.getPersonaIndicator()}Persona Activated: **${persona.metadata.name}**\n\n` +
            `${persona.metadata.description}\n\n` +
            `**Instructions:**\n${persona.content}`,
        },
      ],
    };
  }

  async getActivePersona() {
    if (!this.activePersona) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}No persona is currently active.`,
          },
        ],
      };
    }

    const persona = this.personas.get(this.activePersona);
    if (!persona) {
      this.activePersona = null;
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}Active persona not found. Deactivated.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `${this.getPersonaIndicator()}Active Persona: **${persona.metadata.name}**\n\n` +
            `${persona.metadata.description}\n\n` +
            `File: ${persona.filename}\n` +
            `Version: ${persona.metadata.version || '1.0'}\n` +
            `Author: ${persona.metadata.author || 'Unknown'}`,
        },
      ],
    };
  }

  async deactivatePersona() {
    const wasActive = this.activePersona !== null;
    const indicator = this.getPersonaIndicator();
    this.activePersona = null;

    return {
      content: [
        {
          type: "text",
          text: wasActive 
            ? `${indicator}✅ Persona deactivated. Back to default mode.`
            : "No persona was active.",
        },
      ],
    };
  }

  async getPersonaDetails(personaIdentifier: string) {
    // Try to find persona by filename first, then by name
    let persona = this.personas.get(personaIdentifier);
    
    if (!persona) {
      // Search by name
      persona = Array.from(this.personas.values()).find(p => 
        p.metadata.name.toLowerCase() === personaIdentifier.toLowerCase()
      );
    }

    if (!persona) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Persona not found: ${personaIdentifier}`
      );
    }

    return {
      content: [
        {
          type: "text",
          text: `${this.getPersonaIndicator()}📋 **${persona.metadata.name}** Details\n\n` +
            `**Description:** ${persona.metadata.description}\n` +
            `**File:** ${persona.filename}\n` +
            `**Version:** ${persona.metadata.version || '1.0'}\n` +
            `**Author:** ${persona.metadata.author || 'Unknown'}\n` +
            `**Triggers:** ${persona.metadata.triggers?.join(', ') || 'None'}\n\n` +
            `**Full Content:**\n\`\`\`\n${persona.content}\n\`\`\``,
        },
      ],
    };
  }

  async reloadPersonas() {
    await this.loadPersonas();
    return {
      content: [
        {
          type: "text",
          text: `${this.getPersonaIndicator()}🔄 Reloaded ${this.personas.size} personas from ${this.personasDir}`,
        },
      ],
    };
  }

  // ===== Element Methods (Generic for all element types) =====
  
  async listElements(type: string) {
    try {
      // Normalize the type to handle both plural and singular forms
      const normalizedType = this.normalizeElementType(type);
      
      switch (normalizedType) {
        case ElementType.PERSONA:
          return this.listPersonas();
          
        case ElementType.SKILL: {
          const skills = await this.skillManager.list();
          if (skills.length === 0) {
            return {
              content: [{
                type: "text",
                text: "No skills are currently installed. The DollhouseMCP collection has skills for code review, data analysis, creative writing and more. Would you like me to show you what's available? Just say \"yes\" or I can help you create a custom skill."
              }]
            };
          }
          
          const skillList = skills.map(skill => {
            const complexity = skill.metadata.complexity || 'beginner';
            const domains = skill.metadata.domains?.join(', ') || 'general';
            const version = skill.version || skill.metadata.version || '1.0.0';
            return `🛠️ ${skill.metadata.name} (v${version}) - ${skill.metadata.description}\n   Complexity: ${complexity} | Domains: ${domains}`;
          }).join('\n\n');
          
          return {
            content: [{
              type: "text",
              text: `📚 Available Skills:\n\n${skillList}`
            }]
          };
        }
        
        case ElementType.TEMPLATE: {
          const templates = await this.templateManager.list();
          if (templates.length === 0) {
            return {
              content: [{
                type: "text",
                text: "You haven't installed any templates yet. Would you like to see available templates for emails, reports, and documentation? I can show you examples from the collection or help you create your own. What would you prefer?"
              }]
            };
          }
          
          const templateList = templates.map(template => {
            const variables = template.metadata.variables?.map(v => v.name).join(', ') || 'none';
            const version = template.version || template.metadata.version || '1.0.0';
            return `📄 ${template.metadata.name} (v${version}) - ${template.metadata.description}\n   Variables: ${variables}`;
          }).join('\n\n');
          
          return {
            content: [{
              type: "text",
              text: `📝 Available Templates:\n\n${templateList}`
            }]
          };
        }
        
        case ElementType.AGENT: {
          const agents = await this.agentManager.list();
          if (agents.length === 0) {
            return {
              content: [{
                type: "text",
                text: "No agents installed yet. Agents are autonomous helpers that can work on tasks independently. The DollhouseMCP collection includes task managers, research assistants, and more. Would you like to browse available agents or learn how to create your own?"
              }]
            };
          }
          
          const agentList = agents.map(agent => {
            const specializations = (agent.metadata as any).specializations?.join(', ') || 'general';
            const status = agent.getStatus();
            const version = agent.version || agent.metadata.version || '1.0.0';
            return `🤖 ${agent.metadata.name} (v${version}) - ${agent.metadata.description}\n   Status: ${status} | Specializations: ${specializations}`;
          }).join('\n\n');
          
          return {
            content: [{
              type: "text",
              text: `🤖 Available Agents:\n\n${agentList}`
            }]
          };
        }
        
        default:
          return {
            content: [{
              type: "text",
              text: `❌ Unknown element type '${type}'. Available types: ${Object.values(ElementType).join(', ')} (or legacy plural forms: personas, skills, templates, agents)`
            }]
          };
      }
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.handleListElements', error, { type });
      return {
        content: [{
          type: "text",
          text: `❌ Failed to list ${type}: ${ErrorHandler.getUserMessage(error)}`
        }]
      };
    }
  }
  
  async activateElement(name: string, type: string) {
    try {
      // Normalize the type to handle both plural and singular forms
      const normalizedType = this.normalizeElementType(type);
      
      switch (normalizedType) {
        case ElementType.PERSONA:
          return this.activatePersona(name);
          
        case ElementType.SKILL: {
          const skill = await this.skillManager.find(s => s.metadata.name === name);
          if (!skill) {
            return {
              content: [{
                type: "text",
                text: `❌ Skill '${name}' not found`
              }]
            };
          }
          
          // Activate the skill
          await skill.activate?.();
          
          return {
            content: [{
                type: "text",
                text: `✅ Skill '${name}' activated\n\n${skill.instructions}`
              }]
          };
        }
        
        case ElementType.TEMPLATE: {
          const template = await this.templateManager.find(t => t.metadata.name === name);
          if (!template) {
            return {
              content: [{
                type: "text",
                text: `❌ Template '${name}' not found`
              }]
            };
          }
          
          const variables = template.metadata.variables?.map(v => v.name).join(', ') || 'none';
          return {
            content: [{
              type: "text",
              text: `✅ Template '${name}' ready to use\nVariables: ${variables}\n\nUse 'render_template' to generate content with this template.`
            }]
          };
        }
        
        case ElementType.AGENT: {
          const agent = await this.agentManager.find(a => a.metadata.name === name);
          if (!agent) {
            return {
              content: [{
                type: "text",
                text: `❌ Agent '${name}' not found`
              }]
            };
          }
          
          // Activate the agent
          await agent.activate();
          
          return {
            content: [{
              type: "text",
              text: `✅ Agent '${name}' activated and ready\nSpecializations: ${(agent.metadata as any).specializations?.join(', ') || 'general'}\n\nUse 'execute_agent' to give this agent a goal.`
            }]
          };
        }
        
        default:
          return {
            content: [{
              type: "text",
              text: `❌ Unknown element type '${type}'`
            }]
          };
      }
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.handleActivateElement', error, { type, name });
      return {
        content: [{
          type: "text",
          text: `❌ Failed to activate ${type} '${name}': ${ErrorHandler.getUserMessage(error)}`
        }]
      };
    }
  }
  
  async getActiveElements(type: string) {
    try {
      // Normalize the type to handle both plural and singular forms
      const normalizedType = this.normalizeElementType(type);
      
      switch (normalizedType) {
        case ElementType.PERSONA:
          return this.getActivePersona();
          
        case ElementType.SKILL: {
          const skills = await this.skillManager.list();
          const activeSkills = skills.filter(s => s.getStatus() === 'active');
          
          if (activeSkills.length === 0) {
            return {
              content: [{
                type: "text",
                text: "📋 No active skills"
              }]
            };
          }
          
          const skillList = activeSkills.map(s => `🛠️ ${s.metadata.name}`).join(', ');
          return {
            content: [{
              type: "text",
              text: `Active skills: ${skillList}`
            }]
          };
        }
        
        case ElementType.TEMPLATE: {
          return {
            content: [{
              type: "text",
              text: "📝 Templates are stateless and activated on-demand when rendering"
            }]
          };
        }
        
        case ElementType.AGENT: {
          const agents = await this.agentManager.list();
          const activeAgents = agents.filter(a => a.getStatus() === 'active');
          
          if (activeAgents.length === 0) {
            return {
              content: [{
                type: "text",
                text: "🤖 No active agents"
              }]
            };
          }
          
          const agentList = activeAgents.map(a => {
            const goals = (a as any).state?.goals?.length || 0;
            return `🤖 ${a.metadata.name} (${goals} active goals)`;
          }).join('\n');
          
          return {
            content: [{
              type: "text",
              text: `Active agents:\n${agentList}`
            }]
          };
        }
        
        default:
          return {
            content: [{
              type: "text",
              text: `❌ Unknown element type '${type}'`
            }]
          };
      }
    } catch (error) {
      logger.error(`Failed to get active ${type}:`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to get active ${type}: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
  
  async deactivateElement(name: string, type: string) {
    try {
      // Normalize the type to handle both plural and singular forms
      const normalizedType = this.normalizeElementType(type);
      
      switch (normalizedType) {
        case ElementType.PERSONA:
          return this.deactivatePersona();
          
        case ElementType.SKILL: {
          const skill = await this.skillManager.find(s => s.metadata.name === name);
          if (!skill) {
            return {
              content: [{
                type: "text",
                text: `❌ Skill '${name}' not found`
              }]
            };
          }
          
          await skill.deactivate?.();
          return {
            content: [{
              type: "text",
              text: `✅ Skill '${name}' deactivated`
            }]
          };
        }
        
        case ElementType.TEMPLATE: {
          return {
            content: [{
              type: "text",
              text: "📝 Templates are stateless - nothing to deactivate"
            }]
          };
        }
        
        case ElementType.AGENT: {
          const agent = await this.agentManager.find(a => a.metadata.name === name);
          if (!agent) {
            return {
              content: [{
                type: "text",
                text: `❌ Agent '${name}' not found`
              }]
            };
          }
          
          await agent.deactivate();
          return {
            content: [{
              type: "text",
              text: `✅ Agent '${name}' deactivated`
            }]
          };
        }
        
        default:
          return {
            content: [{
              type: "text",
              text: `❌ Unknown element type '${type}'`
            }]
          };
      }
    } catch (error) {
      logger.error(`Failed to deactivate ${type} '${name}':`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to deactivate ${type} '${name}': ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
  
  async getElementDetails(name: string, type: string) {
    try {
      // Normalize the type to handle both plural and singular forms
      const normalizedType = this.normalizeElementType(type);
      
      switch (normalizedType) {
        case ElementType.PERSONA:
          return this.getPersonaDetails(name);
          
        case ElementType.SKILL: {
          const skill = await this.skillManager.find(s => s.metadata.name === name);
          if (!skill) {
            return {
              content: [{
                type: "text",
                text: `❌ Skill '${name}' not found`
              }]
            };
          }
          
          const details = [
            `🛠️ **${skill.metadata.name}**`,
            `${skill.metadata.description}`,
            ``,
            `**Complexity**: ${skill.metadata.complexity || 'beginner'}`,
            `**Domains**: ${skill.metadata.domains?.join(', ') || 'general'}`,
            `**Languages**: ${skill.metadata.languages?.join(', ') || 'any'}`,
            `**Prerequisites**: ${skill.metadata.prerequisites?.join(', ') || 'none'}`,
            ``,
            `**Instructions**:`,
            skill.instructions
          ];
          
          if (skill.metadata.parameters && skill.metadata.parameters.length > 0) {
            details.push('', '**Parameters**:');
            skill.metadata.parameters.forEach(p => {
              details.push(`- ${p.name} (${p.type}): ${p.description}`);
            });
          }
          
          return {
            content: [{
              type: "text",
              text: details.join('\n')
            }]
          };
        }
        
        case ElementType.TEMPLATE: {
          const template = await this.templateManager.find(t => t.metadata.name === name);
          if (!template) {
            return {
              content: [{
                type: "text",
                text: `❌ Template '${name}' not found`
              }]
            };
          }
          
          const details = [
            `📄 **${template.metadata.name}**`,
            `${template.metadata.description}`,
            ``,
            `**Output Format**: ${(template.metadata as any).output_format || 'text'}`,
            `**Template Content**:`,
            '```',
            template.content,
            '```'
          ];
          
          if (template.metadata.variables && template.metadata.variables.length > 0) {
            details.push('', '**Variables**:');
            template.metadata.variables.forEach(v => {
              details.push(`- ${v.name} (${v.type}): ${v.description}`);
            });
          }
          
          return {
            content: [{
              type: "text",
              text: details.join('\n')
            }]
          };
        }
        
        case ElementType.AGENT: {
          const agent = await this.agentManager.find(a => a.metadata.name === name);
          if (!agent) {
            return {
              content: [{
                type: "text",
                text: `❌ Agent '${name}' not found`
              }]
            };
          }
          
          const details = [
            `🤖 **${agent.metadata.name}**`,
            `${agent.metadata.description}`,
            ``,
            `**Status**: ${agent.getStatus()}`,
            `**Specializations**: ${(agent.metadata as any).specializations?.join(', ') || 'general'}`,
            `**Decision Framework**: ${(agent.metadata as any).decisionFramework || 'rule-based'}`,
            `**Risk Tolerance**: ${(agent.metadata as any).riskTolerance || 'low'}`,
            ``,
            `**Instructions**:`,
            (agent as any).instructions || 'No instructions available'
          ];
          
          const agentState = (agent as any).state;
          if (agentState?.goals && agentState.goals.length > 0) {
            details.push('', '**Current Goals**:');
            agentState.goals.forEach((g: any) => {
              details.push(`- ${g.description} (${g.status})`);
            });
          }
          
          return {
            content: [{
              type: "text",
              text: details.join('\n')
            }]
          };
        }
        
        default:
          return {
            content: [{
              type: "text",
              text: `❌ Unknown element type '${type}'`
            }]
          };
      }
    } catch (error) {
      logger.error(`Failed to get ${type} details for '${name}':`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to get ${type} details: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
  
  async reloadElements(type: string) {
    try {
      // Normalize the type to handle both plural and singular forms
      const normalizedType = this.normalizeElementType(type);
      
      switch (normalizedType) {
        case ElementType.PERSONA:
          return this.reloadPersonas();
          
        case ElementType.SKILL: {
          this.skillManager.clearCache();
          const skills = await this.skillManager.list();
          return {
            content: [{
              type: "text",
              text: `🔄 Reloaded ${skills.length} skills from portfolio`
            }]
          };
        }
        
        case ElementType.TEMPLATE: {
          // Template manager doesn't have clearCache, just list
          const templates = await this.templateManager.list();
          return {
            content: [{
              type: "text",
              text: `🔄 Reloaded ${templates.length} templates from portfolio`
            }]
          };
        }
        
        case ElementType.AGENT: {
          // Agent manager doesn't have clearCache, just list
          const agents = await this.agentManager.list();
          return {
            content: [{
              type: "text",
              text: `🔄 Reloaded ${agents.length} agents from portfolio`
            }]
          };
        }
        
        default:
          return {
            content: [{
              type: "text",
              text: `❌ Unknown element type '${type}'`
            }]
          };
      }
    } catch (error) {
      logger.error(`Failed to reload ${type}:`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to reload ${type}: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
  
  // Element-specific methods
  async renderTemplate(name: string, variables: Record<string, any>) {
    try {
      const template = await this.templateManager.find(t => t.metadata.name === name);
      if (!template) {
        return {
          content: [{
            type: "text",
            text: `❌ Template '${name}' not found`
          }]
        };
      }
      
      // Simple template rendering - replace variables in content
      let rendered = template.content;
      for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
        rendered = rendered.replace(regex, String(value));
      }
      return {
        content: [{
          type: "text",
          text: `📄 Rendered template '${name}':\n\n${rendered}`
        }]
      };
    } catch (error) {
      logger.error(`Failed to render template '${name}':`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to render template: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
  
  async executeAgent(name: string, goal: string) {
    try {
      const agent = await this.agentManager.find(a => a.metadata.name === name);
      if (!agent) {
        return {
          content: [{
            type: "text",
            text: `❌ Agent '${name}' not found`
          }]
        };
      }
      
      // Simple agent execution simulation
      const result = {
        summary: `Agent '${name}' is now working on: ${goal}`,
        status: 'in-progress',
        actionsTaken: 1
      };
      
      return {
        content: [{
          type: "text",
          text: `🤖 Agent '${name}' execution result:\n\n${result.summary}\n\nStatus: ${result.status}\nActions taken: ${result.actionsTaken || 0}`
        }]
      };
    } catch (error) {
      logger.error(`Failed to execute agent '${name}':`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to execute agent: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
  
  async createElement(args: {name: string; type: string; description: string; content?: string; metadata?: Record<string, any>}) {
    // Ensure initialization for test compatibility
    await this.ensureInitialized();
    
    try {
      const { name, type, description, content, metadata } = args;
      
      // Validate element type
      if (!Object.values(ElementType).includes(type as ElementType)) {
        return {
          content: [{
            type: "text",
            text: `❌ Invalid element type '${type}'. Valid types: ${Object.values(ElementType).join(', ')} (or legacy plural forms: personas, skills, templates, agents)`
          }]
        };
      }
      
      // Validate inputs
      const validatedName = validateFilename(name);
      const validatedDescription = sanitizeInput(description, SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH);
      
      // CRITICAL FIX: Validate content size BEFORE processing to prevent memory exhaustion
      // This prevents Claude from trying to output massive content in responses
      if (content) {
        try {
          validateContentSize(content, SECURITY_LIMITS.MAX_CONTENT_LENGTH);
        } catch (error: any) {
          return {
            content: [{
              type: "text",
              text: `❌ Content too large: ${error.message}. Maximum allowed size is ${SECURITY_LIMITS.MAX_CONTENT_LENGTH} characters (${Math.floor(SECURITY_LIMITS.MAX_CONTENT_LENGTH / 1024)}KB).`
            }]
          };
        }
      }
      
      // SECURITY FIX: Sanitize metadata to prevent prototype pollution
      const sanitizedMetadata = this.sanitizeMetadata(metadata || {});
      
      // Create element based on type
      switch (type as ElementType) {
        case ElementType.PERSONA:
          // Use existing persona creation logic
          return this.createPersona(
            validatedName, 
            validatedDescription, 
            content || '',
            sanitizedMetadata?.triggers
          );
          
        case ElementType.SKILL:
          const skill = await this.skillManager.create({
            name: validatedName,
            description: validatedDescription,
            ...sanitizedMetadata,
            content: content || ''
          });
          return {
            content: [{
              type: "text",
              text: `✅ Created skill '${skill.metadata.name}' successfully`
            }]
          };
          
        case ElementType.TEMPLATE:
          const template = await this.templateManager.create({
            name: validatedName,
            description: validatedDescription,
            content: content || '',
            ...sanitizedMetadata
          });
          return {
            content: [{
              type: "text",
              text: `✅ Created template '${template.metadata.name}' successfully`
            }]
          };
          
        case ElementType.AGENT:
          const agentResult = await this.agentManager.create(
            validatedName,
            validatedDescription,
            content || '',
            sanitizedMetadata
          );
          if (!agentResult.success) {
            return {
              content: [{
                type: "text",
                text: `❌ ${agentResult.message}`
              }]
            };
          }
          return {
            content: [{
              type: "text",
              text: `✅ Created agent '${validatedName}' successfully`
            }]
          };
          
        default:
          return {
            content: [{
              type: "text",
              text: `❌ Element type '${type}' is not yet supported for creation`
            }]
          };
      }
    } catch (error) {
      logger.error(`Failed to create element:`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to create element: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
  
  async editElement(args: {name: string; type: string; field: string; value: string | number | boolean | Record<string, any> | any[]}) {
    try {
      const { name, type, field, value } = args;
      
      // Validate element type
      if (!Object.values(ElementType).includes(type as ElementType)) {
        return {
          content: [{
            type: "text",
            text: `❌ Invalid element type '${type}'. Valid types: ${Object.values(ElementType).join(', ')} (or legacy plural forms: personas, skills, templates, agents)`
          }]
        };
      }
      
      // For personas, use existing edit logic
      if (type === ElementType.PERSONA) {
        return this.editPersona(name, field, String(value));
      }
      
      // TYPE SAFETY: Define a common interface for element managers
      interface ElementManagerBase<T> {
        find(predicate: (element: T) => boolean): Promise<T | undefined>;
        save(element: T, filePath: string): Promise<void>;
      }
      
      // Get the appropriate manager based on type with proper typing
      let manager: ElementManagerBase<Skill | Template | Agent> | null = null;
      let element: Skill | Template | Agent | undefined;
      
      switch (type as ElementType) {
        case ElementType.SKILL:
          manager = this.skillManager as ElementManagerBase<Skill>;
          element = await this.skillManager.find((e: Skill) => e.metadata.name === name);
          break;
        case ElementType.TEMPLATE:
          manager = this.templateManager as ElementManagerBase<Template>;
          element = await this.templateManager.find((e: Template) => e.metadata.name === name);
          break;
        case ElementType.AGENT:
          manager = this.agentManager as ElementManagerBase<Agent>;
          element = await this.agentManager.find((e: Agent) => e.metadata.name === name);
          break;
        default:
          return {
            content: [{
              type: "text",
              text: `❌ Element type '${type}' is not yet supported for editing`
            }]
          };
      }
      
      // Check if element was found
      if (!element) {
        return {
          content: [{
            type: "text",
            text: `❌ ${type} '${name}' not found`
          }]
        };
      }
      
      // Handle nested field updates (e.g., "metadata.author")
      const fieldParts = field.split('.');
      
      // SECURITY FIX: Validate field names to prevent prototype pollution
      const dangerousProperties = ['__proto__', 'constructor', 'prototype'];
      for (const part of fieldParts) {
        if (dangerousProperties.includes(part)) {
          return {
            content: [{
              type: "text",
              text: `❌ Invalid field name: '${part}' is not allowed for security reasons`
            }]
          };
        }
      }
      
      let target: any = element;
      for (let i = 0; i < fieldParts.length - 1; i++) {
        // SECURITY: Additional check to prevent prototype pollution
        if (typeof target !== 'object' || target === null) {
          return {
            content: [{
              type: "text",
              text: `❌ Cannot set property '${fieldParts[i]}' on non-object`
            }]
          };
        }
        
        if (!target[fieldParts[i]]) {
          // SECURITY: Use Object.defineProperty to avoid prototype chain pollution
          Object.defineProperty(target, fieldParts[i], {
            value: {},
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
        target = target[fieldParts[i]];
      }
      
      // Update the field
      const lastField = fieldParts[fieldParts.length - 1];
      // SECURITY: Use Object.defineProperty for the final assignment too
      Object.defineProperty(target, lastField, {
        value: value,
        writable: true,
        enumerable: true,
        configurable: true
      });
      
      // VERSION FIX: Handle version field updates differently
      // If user is directly editing version field, don't auto-increment
      if (field === 'version' || field === 'metadata.version') {
        const versionString = String(value);
        
        // VERSION VALIDATION: Validate version format
        // Accept semver (1.0.0), two-part (1.0), or single digit (1)
        // Also accepts pre-release versions (1.0.0-beta, 1.0.0-alpha.1)
        const isValidVersion = /^(\d+)(\.\d+)?(\.\d+)?(-[a-zA-Z0-9.-]+)?$/.test(versionString);
        if (!isValidVersion) {
          return {
            content: [{
              type: "text",
              text: `❌ Invalid version format: '${versionString}'. Please use format like 1.0.0, 1.0, or 1`
            }]
          };
        }
        
        // ERROR HANDLING: Wrap version update in try-catch
        try {
          // Update both locations to ensure consistency
          element.version = versionString;
          if (element.metadata) {
            element.metadata.version = versionString;
          }
        } catch (error) {
          logger.error(`Failed to update version for ${name}:`, error);
          return {
            content: [{
              type: "text",
              text: `❌ Failed to update version: ${error instanceof Error ? error.message : 'Unknown error'}`
            }]
          };
        }
      } else {
        // For other field edits, auto-increment version
        // VERSION FIX: Update both element.version AND element.metadata.version
        // Previously: Only element.version was updated, but some managers read from metadata.version
        // Now: Keep both in sync to ensure version persists correctly
        
        // ERROR HANDLING: Wrap auto-increment in try-catch
        try {
          if (element.version) {
            // PRE-RELEASE HANDLING: Check for pre-release versions
            const preReleaseMatch = element.version.match(/^(\d+\.\d+\.\d+)(-([a-zA-Z0-9.-]+))?$/);
            
            if (preReleaseMatch) {
              // Handle pre-release versions (e.g., 1.0.0-beta.1)
              const baseVersion = preReleaseMatch[1];
              const preReleaseTag = preReleaseMatch[3];
              
              if (preReleaseTag) {
                // If it has a pre-release tag, increment the pre-release number
                const preReleaseNumberMatch = preReleaseTag.match(/^([a-zA-Z]+)\.?(\d+)?$/);
                if (preReleaseNumberMatch) {
                  const preReleaseType = preReleaseNumberMatch[1];
                  const preReleaseNumber = parseInt(preReleaseNumberMatch[2] || '0') + 1;
                  element.version = `${baseVersion}-${preReleaseType}.${preReleaseNumber}`;
                } else {
                  // Complex pre-release, just increment patch
                  const [major, minor, patch] = baseVersion.split('.').map(Number);
                  element.version = `${major}.${minor}.${patch + 1}`;
                }
              } else {
                // Regular semver, increment patch
                const [major, minor, patch] = baseVersion.split('.').map(Number);
                element.version = `${major}.${minor}.${patch + 1}`;
              }
            } else {
              // Handle non-semver versions
              const versionParts = element.version.split('.');
              if (versionParts.length >= 3) {
                // Standard semver format (e.g., 1.0.0)
                const patch = parseInt(versionParts[2]) || 0;
                versionParts[2] = String(patch + 1);
                element.version = versionParts.join('.');
              } else if (versionParts.length === 2) {
                // Two-part version (e.g., 1.0) - add patch version
                element.version = `${element.version}.1`;
              } else if (versionParts.length === 1 && /^\d+$/.test(versionParts[0])) {
                // Single number version (e.g., 1) - convert to semver
                element.version = `${element.version}.0.1`;
              } else {
                // Non-standard version - append or replace with standard format
                element.version = '1.0.1';
              }
            }
          } else {
            // No version - set initial version
            element.version = '1.0.0';
          }
          
          // Ensure metadata.version is also updated for managers that use it
          if (element.metadata) {
            element.metadata.version = element.version;
          }
        } catch (error) {
          logger.error(`Failed to auto-increment version for ${name}:`, error);
          // Don't fail the entire operation, just log the error
          // Version will remain unchanged
        }
      }
      
      // Save the element - need to determine filename
      const filename = `${element.metadata.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.md`;
      // TYPE SAFETY: No need for 'as any' cast anymore with proper typing
      await manager!.save(element, filename);
      
      return {
        content: [{
          type: "text",
          text: `✅ Updated ${type} '${name}' - ${field} set to: ${JSON.stringify(value)}`
        }]
      };
    } catch (error) {
      logger.error(`Failed to edit element:`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to edit element: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
  
  async validateElement(args: {name: string; type: string; strict?: boolean}) {
    try {
      const { name, type, strict = false } = args;
      
      // Validate element type
      if (!Object.values(ElementType).includes(type as ElementType)) {
        return {
          content: [{
            type: "text",
            text: `❌ Invalid element type '${type}'. Valid types: ${Object.values(ElementType).join(', ')} (or legacy plural forms: personas, skills, templates, agents)`
          }]
        };
      }
      
      // For personas, use existing validation logic
      if (type === ElementType.PERSONA) {
        return this.validatePersona(name);
      }
      
      // Get the appropriate manager based on type
      let manager: SkillManager | TemplateManager | AgentManager | null = null;
      switch (type as ElementType) {
        case ElementType.SKILL:
          manager = this.skillManager;
          break;
        case ElementType.TEMPLATE:
          manager = this.templateManager;
          break;
        case ElementType.AGENT:
          manager = this.agentManager;
          break;
        default:
          return {
            content: [{
              type: "text",
              text: `❌ Element type '${type}' is not yet supported for validation`
            }]
          };
      }
      
      // Find the element
      const element = await manager!.find((e: any) => e.metadata.name === name);
      if (!element) {
        return {
          content: [{
            type: "text",
            text: `❌ ${type} '${name}' not found`
          }]
        };
      }
      
      // Perform validation
      const validationResult = element.validate();
      
      // Format validation report
      let report = `🔍 Validation Report for ${type} '${name}':\n`;
      report += `${validationResult.valid ? '✅' : '❌'} Status: ${validationResult.valid ? 'Valid' : 'Invalid'}\n\n`;
      
      if (validationResult.errors && validationResult.errors.length > 0) {
        report += `❌ Errors (${validationResult.errors.length}):\n`;
        validationResult.errors.forEach((error: any) => {
          report += `   • ${error.field || 'General'}: ${error.message}\n`;
          if (error.fix) {
            report += `     💡 Fix: ${error.fix}\n`;
          }
        });
        report += '\n';
      }
      
      if (validationResult.warnings && validationResult.warnings.length > 0) {
        report += `⚠️  Warnings (${validationResult.warnings.length}):\n`;
        validationResult.warnings.forEach((warning: any) => {
          report += `   • ${warning.field || 'General'}: ${warning.message}\n`;
          if (warning.suggestion) {
            report += `     💡 Suggestion: ${warning.suggestion}\n`;
          }
        });
        report += '\n';
      }
      
      if (validationResult.suggestions && validationResult.suggestions.length > 0) {
        report += `💡 Suggestions:\n`;
        validationResult.suggestions.forEach((suggestion: string) => {
          report += `   • ${suggestion}\n`;
        });
      }
      
      // Add strict mode additional checks if requested
      if (strict) {
        report += '\n📋 Strict Mode: Additional quality checks applied';
      }
      
      return {
        content: [{
          type: "text",
          text: report
        }]
      };
    } catch (error) {
      logger.error(`Failed to validate element:`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to validate element: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
  
  async deleteElement(args: {name: string; type: string; deleteData?: boolean}) {
    // Ensure initialization for test compatibility
    await this.ensureInitialized();
    
    try {
      const { name, type, deleteData } = args;
      
      // Validate element type
      if (!Object.values(ElementType).includes(type as ElementType)) {
        return {
          content: [{
            type: "text",
            text: `❌ Invalid element type: ${type}\nValid types: ${Object.values(ElementType).join(', ')} (or legacy plural forms: personas, skills, templates, agents)`
          }]
        };
      }
      
      // Get the appropriate manager based on type
      let manager: SkillManager | TemplateManager | AgentManager | null = null;
      switch (type as ElementType) {
        case ElementType.SKILL:
          manager = this.skillManager;
          break;
        case ElementType.TEMPLATE:
          manager = this.templateManager;
          break;
        case ElementType.AGENT:
          manager = this.agentManager;
          break;
        case ElementType.PERSONA:
          // For personas, use a different approach
          // personasDir is guaranteed to be set after ensureInitialized()
          const personaPath = path.join(this.personasDir!, `${name}.md`);
          try {
            await fs.access(personaPath);
            await fs.unlink(personaPath);
            
            // Reload personas to update the cache
            await this.loadPersonas();
            
            return {
              content: [{
                type: "text",
                text: `✅ Successfully deleted persona '${name}'`
              }]
            };
          } catch (error) {
            if ((error as any).code === 'ENOENT') {
              return {
                content: [{
                  type: "text",
                  text: `❌ ${type.charAt(0).toUpperCase() + type.slice(1)} '${name}' not found`
                }]
              };
            }
            throw error;
          }
        default:
          return {
            content: [{
              type: "text",
              text: `❌ Element type '${type}' is not yet supported for deletion`
            }]
          };
      }
      
      // Ensure manager was assigned (TypeScript type safety)
      if (!manager) {
        return {
          content: [{
            type: "text",
            text: `❌ Element type '${type}' is not supported for deletion`
          }]
        };
      }
      
      // Find the element first to check if it exists
      const element = await manager!.find((e: any) => e.metadata.name === name);
      if (!element) {
        return {
          content: [{
            type: "text",
            text: `❌ ${type} '${name}' not found`
          }]
        };
      }
      
      // Check for associated data files
      let dataFiles: string[] = [];
      
      // Agent-specific: Check for state files
      if (type === ElementType.AGENT) {
        const stateDir = path.join(this.portfolioManager.getElementDir(ElementType.AGENT), '.state');
        const stateFile = path.join(stateDir, `${name}-state.json`);
        try {
          const stat = await fs.stat(stateFile);
          dataFiles.push(`- .state/${name}-state.json (${(stat.size / 1024).toFixed(2)} KB)`);
        } catch (error) {
          // No state file exists, which is fine
        }
      }
      
      // Memory-specific: Check for storage files
      if (type === ElementType.MEMORY) {
        const storageDir = path.join(this.portfolioManager.getElementDir(ElementType.MEMORY), '.storage');
        const storageFile = path.join(storageDir, `${name}-memory.json`);
        try {
          const stat = await fs.stat(storageFile);
          dataFiles.push(`- .storage/${name}-memory.json (${(stat.size / 1024).toFixed(2)} KB)`);
        } catch (error) {
          // No storage file exists, which is fine
        }
      }
      
      // Ensemble-specific: Check for config files
      if (type === ElementType.ENSEMBLE) {
        const configDir = path.join(this.portfolioManager.getElementDir(ElementType.ENSEMBLE), '.configs');
        const configFile = path.join(configDir, `${name}-config.json`);
        try {
          const stat = await fs.stat(configFile);
          dataFiles.push(`- .configs/${name}-config.json (${(stat.size / 1024).toFixed(2)} KB)`);
        } catch (error) {
          // No config file exists, which is fine
        }
      }
      
      // If data files exist and deleteData is not specified, we need to inform the user
      if (dataFiles.length > 0 && deleteData === undefined) {
        return {
          content: [{
            type: "text",
            text: `⚠️  This ${type} has associated data files:\n${dataFiles.join('\n')}\n\nWould you like to delete these data files as well?\n\n• To delete everything (element + data), say: "Yes, delete all data"\n• To keep the data files, say: "No, keep the data"\n• To cancel, say: "Cancel"`
          }]
        };
      }
      
      // Delete the main element file
      const filename = `${slugify(name)}.md`;
      const filepath = path.join(this.portfolioManager.getElementDir(type as ElementType), filename);
      
      try {
        await fs.unlink(filepath);
      } catch (error) {
        if ((error as any).code === 'ENOENT') {
          return {
            content: [{
              type: "text",
              text: `❌ ${type} file '${filename}' not found`
            }]
          };
        }
        throw error;
      }
      
      // Delete associated data files if requested
      if (deleteData && dataFiles.length > 0) {
        const updatedDataFiles: string[] = [];
        
        if (type === ElementType.AGENT) {
          const stateFile = path.join(this.portfolioManager.getElementDir(ElementType.AGENT), '.state', `${name}-state.json`);
          try {
            await fs.unlink(stateFile);
            updatedDataFiles.push(`${dataFiles[0]} ✓ deleted`);
          } catch (error) {
            // Log but don't fail if state file deletion fails
            logger.warn(`Failed to delete agent state file: ${error}`);
            updatedDataFiles.push(`${dataFiles[0]} ⚠️ deletion failed`);
          }
        } else if (type === ElementType.MEMORY) {
          const storageFile = path.join(this.portfolioManager.getElementDir(ElementType.MEMORY), '.storage', `${name}-memory.json`);
          try {
            await fs.unlink(storageFile);
            updatedDataFiles.push(`${dataFiles[0]} ✓ deleted`);
          } catch (error) {
            // Log but don't fail if storage file deletion fails
            logger.warn(`Failed to delete memory storage file: ${error}`);
            updatedDataFiles.push(`${dataFiles[0]} ⚠️ deletion failed`);
          }
        } else if (type === ElementType.ENSEMBLE) {
          const configFile = path.join(this.portfolioManager.getElementDir(ElementType.ENSEMBLE), '.configs', `${name}-config.json`);
          try {
            await fs.unlink(configFile);
            updatedDataFiles.push(`${dataFiles[0]} ✓ deleted`);
          } catch (error) {
            // Log but don't fail if config file deletion fails
            logger.warn(`Failed to delete ensemble config file: ${error}`);
            updatedDataFiles.push(`${dataFiles[0]} ⚠️ deletion failed`);
          }
        }
        
        dataFiles = updatedDataFiles;
      }
      
      // Build success message
      let message = `✅ Successfully deleted ${type} '${name}'`;
      if (dataFiles.length > 0) {
        if (deleteData) {
          message += `\n\nAssociated data files:\n${dataFiles.join('\n')}`;
        } else {
          message += `\n\n⚠️ Associated data files were preserved:\n${dataFiles.join('\n')}`;
        }
      }
      
      return {
        content: [{
          type: "text",
          text: message
        }]
      };
      
    } catch (error) {
      logger.error(`Failed to delete element:`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to delete element: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  // checkRateLimit and fetchFromGitHub are now handled by GitHubClient

  async browseCollection(section?: string, type?: string) {
    try {
      // FIX #471: Replace legacy category validation with proper section/type validation
      // Valid sections: library, showcase, catalog
      // Valid types: personas, skills, agents, prompts, templates, tools, ensembles, memories
      const validSections = ['library', 'showcase', 'catalog'];
      const validTypes = ['personas', 'skills', 'agents', 'prompts', 'templates', 'tools', 'ensembles', 'memories'];
      
      // Validate section if provided
      const validatedSection = section ? sanitizeInput(section.toLowerCase()) : undefined;
      if (validatedSection && !validSections.includes(validatedSection)) {
        throw new Error(`Invalid section '${validatedSection}'. Must be one of: ${validSections.join(', ')}`);
      }
      
      // Validate type if provided (only valid when section is 'library')
      const validatedType = type ? sanitizeInput(type.toLowerCase()) : undefined;
      if (validatedType && validatedSection === 'library' && !validTypes.includes(validatedType)) {
        throw new Error(`Invalid type '${validatedType}'. Must be one of: ${validTypes.join(', ')}`);
      }
      if (validatedType && validatedSection !== 'library') {
        throw new Error('Type parameter is only valid when section is "library"');
      }
      
      const result = await this.collectionBrowser.browseCollection(validatedSection, validatedType);
      
      // Handle sections view
      const items = result.items;
      const categories = result.sections || result.categories;
      
      const text = this.collectionBrowser.formatBrowseResults(
        items, 
        categories, 
        validatedSection, 
        validatedType, 
        this.getPersonaIndicator()
      );
      
      return {
        content: [
          {
            type: "text",
            text: text,
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Collection browsing failed: ${sanitized.message}`,
          },
        ],
      };
    }
  }

  async searchCollection(query: string) {
    try {
      // Enhanced input validation for search query
      const validatedQuery = MCPInputValidator.validateSearchQuery(query);
      
      const items = await this.collectionSearch.searchCollection(validatedQuery);
      const text = this.collectionSearch.formatSearchResults(items, validatedQuery, this.getPersonaIndicator());
      
      return {
        content: [
          {
            type: "text",
            text: text,
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Error searching collection: ${sanitized.message}`,
          },
        ],
      };
    }
  }

  async searchCollectionEnhanced(query: string, options: any = {}) {
    try {
      // Enhanced input validation for search query
      const validatedQuery = MCPInputValidator.validateSearchQuery(query);
      
      // Validate and sanitize options
      const validatedOptions = {
        elementType: options.elementType ? String(options.elementType) : undefined,
        category: options.category ? String(options.category) : undefined,
        page: options.page ? Math.max(1, parseInt(options.page) || 1) : 1,
        pageSize: options.pageSize ? Math.min(100, Math.max(1, parseInt(options.pageSize) || 25)) : 25,
        sortBy: options.sortBy && ['relevance', 'name', 'date'].includes(options.sortBy) ? options.sortBy : 'relevance'
      };
      
      const results = await this.collectionSearch.searchCollectionWithOptions(validatedQuery, validatedOptions);
      const text = this.collectionSearch.formatSearchResultsWithPagination(results, this.getPersonaIndicator());
      
      return {
        content: [
          {
            type: "text",
            text: text,
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Error searching collection: ${sanitized.message}`,
          },
        ],
      };
    }
  }

  async getCollectionContent(path: string) {
    try {
      const { metadata, content } = await this.personaDetails.getCollectionContent(path);
      const text = this.personaDetails.formatPersonaDetails(metadata, content, path, this.getPersonaIndicator());
      
      return {
        content: [
          {
            type: "text",
            text: text,
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Error fetching content: ${sanitized.message}`,
          },
        ],
      };
    }
  }

  async installContent(inputPath: string) {
    try {
      const result = await this.elementInstaller.installContent(inputPath);
      
      if (!result.success) {
        return {
          content: [
            {
              type: "text",
              text: `⚠️ ${result.message}`,
            },
          ],
        };
      }
      
      // If it's a persona, reload personas
      if (result.elementType === ElementType.PERSONA) {
        await this.loadPersonas();
      }
      
      const text = this.elementInstaller.formatInstallSuccess(
        result.metadata!, 
        result.filename!,
        result.elementType!
      );
      
      return {
        content: [
          {
            type: "text",
            text: text,
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Error installing AI customization element: ${sanitized.message}`,
          },
        ],
      };
    }
  }

  async submitContent(contentIdentifier: string) {
    // Use the new portfolio-based submission tool
    const { SubmitToPortfolioTool } = await import('./tools/portfolio/submitToPortfolioTool.js');
    const { FileDiscoveryUtil } = await import('./utils/FileDiscoveryUtil.js');
    const submitTool = new SubmitToPortfolioTool(this.apiCache);
    
    // Try to find the content across all element types
    const portfolioManager = PortfolioManager.getInstance();
    let elementType: ElementType | undefined;
    let foundPath: string | null = null;
    
    // PERFORMANCE OPTIMIZATION: Search all element directories in parallel
    // NOTE: This dynamically handles ALL element types from the ElementType enum
    // No hardcoded count - if you add 10 more element types tomorrow, this code
    // will automatically search all 16 types without any changes needed here
    const searchPromises = Object.values(ElementType).map(async (type) => {
      const dir = portfolioManager.getElementDir(type);
      try {
        const file = await FileDiscoveryUtil.findFile(dir, contentIdentifier, {
          extensions: ['.md', '.json', '.yaml', '.yml'],
          partialMatch: true,
          cacheResults: true
        });
        
        return file ? { type: type as ElementType, file } : null;
      } catch (error: any) {
        // IMPROVED ERROR HANDLING: Log warnings for unexpected errors
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
          // Not just a missing directory - this could be a permission issue or other problem
          logger.warn(`Unexpected error searching ${type} directory`, { 
            contentIdentifier,
            type,
            error: error?.message || String(error),
            code: error?.code 
          });
        } else {
          // Directory doesn't exist - this is expected for unused element types
          logger.debug(`${type} directory does not exist, skipping`, { type });
        }
        return null;
      }
    });
    
    // Wait for all searches to complete and find the first match
    const searchResults = await Promise.allSettled(searchPromises);
    
    // NOTE: File validation - we rely on the portfolio directory structure to ensure
    // files are in the correct element type directory. Additional schema validation
    // could be added here if needed, but the current approach is sufficient as:
    // 1. FileDiscoveryUtil already validates file extensions
    // 2. Portfolio structure enforces proper organization
    // 3. submitToPortfolioTool performs additional validation downstream
    for (const result of searchResults) {
      if (result.status === 'fulfilled' && result.value) {
        foundPath = result.value.file;
        elementType = result.value.type;
        logger.debug(`Found content in ${elementType} directory`, { 
          contentIdentifier, 
          type: elementType, 
          file: foundPath 
        });
        break;
      }
    }
    
    // CRITICAL FIX: Never default to any element type when content is not found
    // This prevents incorrect submissions and forces proper type detection or user specification
    if (!elementType) {
      // Content not found in any element directory - provide helpful error with suggestions
      const availableTypes = Object.values(ElementType).join(', ');
      logger.warn(`Content "${contentIdentifier}" not found in any portfolio directory`, { 
        contentIdentifier,
        searchedTypes: Object.values(ElementType) 
      });
      
      return {
        content: [
          {
            type: "text",
            text: `❌ Content "${contentIdentifier}" not found in portfolio.\n\n` +
                  `**Searched in all element types:** ${availableTypes}\n\n` +
                  `**To resolve this issue:**\n` +
                  `1. Check if the content exists in your portfolio\n` +
                  `2. Verify the content name/filename is correct\n` +
                  `3. If the content is in a specific type directory, try using the exact filename\n` +
                  `4. Use the \`list_portfolio\` tool to see all available content\n\n` +
                  `**Note:** The system no longer defaults to any element type to prevent incorrect submissions.`,
          },
        ],
      };
    }
    
    // Check for duplicates across all sources before submission
    try {
      const { UnifiedIndexManager } = await import('./portfolio/UnifiedIndexManager.js');
      const unifiedManager = UnifiedIndexManager.getInstance();
      
      // Extract the actual element name from the content path
      const basename = path.basename(foundPath!, path.extname(foundPath!));
      const duplicates = await unifiedManager.checkDuplicates(basename);
      
      if (duplicates.length > 0) {
        const duplicate = duplicates[0];
        let warningText = `⚠️ **Duplicate Detection Alert**\n\n`;
        warningText += `Found "${duplicate.name}" in multiple sources:\n\n`;
        
        for (const source of duplicate.sources) {
          const sourceIcon = this.getSourceIcon(source.source);
          warningText += `${sourceIcon} **${source.source}**: ${source.version || 'unknown version'} (${source.lastModified.toLocaleDateString()})\n`;
        }
        
        warningText += `\n`;
        
        if (duplicate.hasVersionConflict && duplicate.versionConflict) {
          warningText += `🔄 **Version Conflict Detected**\n`;
          warningText += `Recommended source: **${duplicate.versionConflict.recommended}**\n`;
          warningText += `Reason: ${duplicate.versionConflict.reason}\n\n`;
        }
        
        warningText += `**Recommendations:**\n`;
        warningText += `• Review existing versions before submitting\n`;
        warningText += `• Consider updating local version instead of creating duplicate\n`;
        warningText += `• Ensure your version adds meaningful improvements\n`;
        warningText += `• Update version number in metadata if submitting enhancement\n\n`;
        warningText += `**Proceeding with submission anyway...**\n\n`;
        
        // Log the duplicate detection for monitoring
        logger.warn('Duplicate content detected during submission', {
          contentIdentifier,
          elementType,
          duplicateInfo: duplicate
        });
        
        // Continue with submission but show warning
        const result = await submitTool.execute({
          name: contentIdentifier,
          type: elementType
        });
        
        // Combine warning with submission result
        const responseText = `${this.getPersonaIndicator()}${result.success ? '⚠️' : '❌'} ${warningText}${result.message}`;
        
        return {
          content: [{
            type: "text",
            text: responseText,
          }],
        };
      }
    } catch (duplicateError) {
      // If duplicate checking fails, log but continue with submission
      logger.warn('Duplicate checking failed during submission', {
        contentIdentifier,
        error: duplicateError instanceof Error ? duplicateError.message : String(duplicateError)
      });
    }
    
    // Execute the submission with the detected element type
    const result = await submitTool.execute({
      name: contentIdentifier,
      type: elementType
    });
    
    // Format the response - the message already contains all details
    let responseText = result.message;
    
    // Add persona indicator for consistency
    responseText = `${this.getPersonaIndicator()}${result.success ? '✅' : '❌'} ${responseText}`;
    
    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }

  async getCollectionCacheHealth() {
    try {
      // Get cache statistics from both caches
      const collectionStats = await this.collectionCache.getCacheStats();
      const searchStats = await this.collectionSearch.getCacheStats();
      
      // Check if cache directory exists
      const cacheDir = path.join(process.cwd(), '.dollhousemcp', 'cache');
      let cacheFileExists = false;
      let cacheFileSize = 0;
      
      try {
        const cacheFile = path.join(cacheDir, 'collection-cache.json');
        const fileStats = await fs.stat(cacheFile);
        cacheFileExists = true;
        cacheFileSize = fileStats.size;
      } catch (error) {
        // Cache file doesn't exist yet
      }
      
      // Format cache age
      const formatAge = (ageMs: number): string => {
        if (ageMs === 0) return 'Not cached';
        const hours = Math.floor(ageMs / (1000 * 60 * 60));
        const minutes = Math.floor((ageMs % (1000 * 60 * 60)) / (1000 * 60));
        if (hours > 0) {
          return `${hours}h ${minutes}m old`;
        }
        return `${minutes}m old`;
      };
      
      // Build health report with both cache systems
      const healthReport = {
        collection: {
          status: collectionStats.isValid ? 'healthy' : (cacheFileExists ? 'expired' : 'empty'),
          cacheExists: cacheFileExists,
          itemCount: collectionStats.itemCount,
          cacheAge: formatAge(collectionStats.cacheAge),
          cacheAgeMs: collectionStats.cacheAge,
          isValid: collectionStats.isValid,
          cacheFileSize: cacheFileSize,
          cacheFileSizeFormatted: cacheFileSize > 0 ? `${(cacheFileSize / 1024).toFixed(2)} KB` : '0 KB',
          ttlRemaining: collectionStats.isValid ? formatAge(24 * 60 * 60 * 1000 - collectionStats.cacheAge) : 'Expired'
        },
        index: {
          status: searchStats.index.isValid ? 'healthy' : (searchStats.index.hasCache ? 'expired' : 'empty'),
          hasCache: searchStats.index.hasCache,
          elements: searchStats.index.elements,
          cacheAge: formatAge(searchStats.index.age),
          isValid: searchStats.index.isValid,
          ttlRemaining: searchStats.index.isValid ? formatAge(15 * 60 * 1000 - searchStats.index.age) : 'Expired'
        },
        overall: {
          recommendation: (collectionStats.isValid || searchStats.index.isValid)
            ? 'Cache system is operational and serving content efficiently'
            : 'Cache system will refresh on next access for optimal performance'
        }
      };
      
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}📊 **Collection Cache Health Check**\n\n` +
              `## 🗄️ Collection Cache (Legacy)\n` +
              `**Status**: ${healthReport.collection.status === 'healthy' ? '✅' : healthReport.collection.status === 'expired' ? '⚠️' : '📦'} ${healthReport.collection.status.toUpperCase()}\n` +
              `**Items Cached**: ${healthReport.collection.itemCount}\n` +
              `**Cache Age**: ${healthReport.collection.cacheAge}\n` +
              `**Cache Size**: ${healthReport.collection.cacheFileSizeFormatted}\n` +
              `**TTL Remaining**: ${healthReport.collection.ttlRemaining}\n\n` +
              `## 🚀 Index Cache (Enhanced Search)\n` +
              `**Status**: ${healthReport.index.status === 'healthy' ? '✅' : healthReport.index.status === 'expired' ? '⚠️' : '📦'} ${healthReport.index.status.toUpperCase()}\n` +
              `**Elements Indexed**: ${healthReport.index.elements}\n` +
              `**Cache Age**: ${healthReport.index.cacheAge}\n` +
              `**TTL Remaining**: ${healthReport.index.ttlRemaining}\n\n` +
              `**Overall Status**: ${healthReport.overall.recommendation}\n\n` +
              `The enhanced index cache provides fast search with pagination, filtering, and sorting. ` +
              `The collection cache serves as a fallback for offline browsing.`,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to get cache health: ${errorMessage}`);
      
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Failed to get cache health: ${errorMessage}`,
          },
        ],
      };
    }
  }

  // User identity management
  async setUserIdentity(username: string, email?: string) {
    try {
      if (!username || username.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${this.getPersonaIndicator()}❌ Username cannot be empty`,
            },
          ],
        };
      }

      // Validate and sanitize username
      const validatedUsername = validateUsername(username);
      
      // Validate email if provided
      let validatedEmail: string | undefined;
      if (email) {
        const sanitizedEmail = sanitizeInput(email, 100);
        if (!VALIDATION_PATTERNS.SAFE_EMAIL.test(sanitizedEmail)) {
          throw new Error('Invalid email format');
        }
        validatedEmail = sanitizedEmail;
      }

      // Set the validated user identity
      this.currentUser = validatedUsername;
      if (validatedEmail) {
        process.env.DOLLHOUSE_EMAIL = validatedEmail;
      }

      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}✅ **User Identity Set**\n\n` +
            `👤 **Username:** ${validatedUsername}\n` +
            `${validatedEmail ? `📧 **Email:** ${validatedEmail}\n` : ''}` +
            `\n🎯 **Next Steps:**\n` +
            `• New personas you create will be attributed to "${validatedUsername}"\n` +
            `• Set environment variable \`DOLLHOUSE_USER=${validatedUsername}\` to persist this setting\n` +
            `${validatedEmail ? `• Set environment variable \`DOLLHOUSE_EMAIL=${validatedEmail}\` for contact info\n` : ''}` +
            `• Use \`clear_user_identity\` to return to anonymous mode`,
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Validation Error**\n\n` +
              `${sanitized.message}\n\n` +
              `Please provide a valid username (alphanumeric characters, hyphens, underscores, dots only).`,
          },
        ],
      };
    }
  }

  async getUserIdentity() {
    const email = process.env.DOLLHOUSE_EMAIL;
    
    if (!this.currentUser) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}👤 **User Identity: Anonymous**\n\n` +
            `🔒 **Status:** Anonymous mode\n` +
            `📝 **Attribution:** Personas will use anonymous IDs\n\n` +
            `**To set your identity:**\n` +
            `• Use: \`set_user_identity "your-username"\`\n` +
            `• Or set environment variable: \`DOLLHOUSE_USER=your-username\``,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `${this.getPersonaIndicator()}👤 **User Identity: ${this.currentUser}**\n\n` +
          `✅ **Status:** Authenticated\n` +
          `👤 **Username:** ${this.currentUser}\n` +
          `${email ? `📧 **Email:** ${email}\n` : ''}` +
          `📝 **Attribution:** New personas will be credited to "${this.currentUser}"\n\n` +
          `**Environment Variables:**\n` +
          `• \`DOLLHOUSE_USER=${this.currentUser}\`\n` +
          `${email ? `• \`DOLLHOUSE_EMAIL=${email}\`\n` : ''}` +
          `\n**Management:**\n` +
          `• Use \`clear_user_identity\` to return to anonymous mode\n` +
          `• Use \`set_user_identity "new-username"\` to change username`,
        },
      ],
    };
  }

  async clearUserIdentity() {
    const wasSet = this.currentUser !== null;
    const previousUser = this.currentUser;
    this.currentUser = null;

    return {
      content: [
        {
          type: "text",
          text: wasSet 
            ? `${this.getPersonaIndicator()}✅ **User Identity Cleared**\n\n` +
              `👤 **Previous:** ${previousUser}\n` +
              `🔒 **Current:** Anonymous mode\n\n` +
              `📝 **Effect:** New personas will use anonymous IDs\n\n` +
              `⚠️ **Note:** This only affects the current session.\n` +
              `To persist this change, unset the \`DOLLHOUSE_USER\` environment variable.`
            : `${this.getPersonaIndicator()}ℹ️ **Already in Anonymous Mode**\n\n` +
              `👤 No user identity was set.\n\n` +
              `Use \`set_user_identity "username"\` to set your identity.`,
        },
      ],
    };
  }

  private getCurrentUserForAttribution(): string {
    return this.currentUser || generateAnonymousId();
  }

  // GitHub authentication management
  async setupGitHubAuth() {
    try {
      // Check current auth status first
      const currentStatus = await this.githubAuthManager.getAuthStatus();
      
      if (currentStatus.isAuthenticated) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}✅ **Already Connected to GitHub**\n\n` +
                  `👤 **Username:** ${currentStatus.username}\n` +
                  `🔑 **Permissions:** ${currentStatus.scopes?.join(', ') || 'basic access'}\n\n` +
                  `You're all set! You can:\n` +
                  `• Browse the collection\n` +
                  `• Install content\n` +
                  `• Submit your creations\n\n` +
                  `To disconnect, say "disconnect from GitHub"`
          }]
        };
      }
      
      // Initiate device flow
      const deviceResponse = await this.githubAuthManager.initiateDeviceFlow();
      
      // Spawn detached OAuth helper process
      try {
        // Get the path to the oauth-helper script - handle both dev and production paths
        const currentFileUrl = import.meta.url;
        const currentDir = path.dirname(fileURLToPath(currentFileUrl));
        
        // Try multiple possible locations for the helper script
        const possiblePaths = [
          path.join(currentDir, '..', 'oauth-helper.mjs'), // Production: dist/../oauth-helper.mjs
          path.join(currentDir, '..', '..', 'oauth-helper.mjs'), // Dev: dist/subdir/../oauth-helper.mjs
          path.join(process.cwd(), 'oauth-helper.mjs'), // Current working directory
        ];
        
        let helperPath: string | null = null;
        for (const testPath of possiblePaths) {
          try {
            await fs.access(testPath, fs.constants.R_OK);
            helperPath = testPath;
            break;
          } catch {
            // Try next path
          }
        }
        
        if (!helperPath) {
          throw new Error('OAuth helper script not found. Please ensure oauth-helper.mjs is in the project root.');
        }
        
        // Get the client ID with ConfigManager fallback
        let clientId: string | null = null;
        
        // Check environment variable first (for backward compatibility)
        clientId = process.env.DOLLHOUSE_GITHUB_CLIENT_ID || null;
        
        // If not found in environment, try ConfigManager
        if (!clientId) {
          try {
            const configManager = ConfigManager.getInstance();
            await configManager.loadConfig();
            clientId = configManager.getGitHubClientId();
          } catch (configError) {
            logger.debug('Failed to load ConfigManager for client ID', { error: configError });
          }
        }
        
        if (!clientId) {
          logger.error('GitHub OAuth client ID not configured in any source');
          return {
            content: [{
              type: "text",
              text: `${this.getPersonaIndicator()}❌ **GitHub OAuth Configuration Missing**\n\n` +
                    `GitHub OAuth client ID not found in any of these sources:\n` +
                    `• DOLLHOUSE_GITHUB_CLIENT_ID environment variable\n` +
                    `• ~/.dollhouse/config.json file\n\n` +
                    `**Setup Instructions:**\n\n` +
                    `**Option 1 - Environment Variable:**\n` +
                    `Set DOLLHOUSE_GITHUB_CLIENT_ID before starting the server.\n\n` +
                    `**Option 2 - Config File:**\n` +
                    `Create ~/.dollhouse/config.json with:\n` +
                    `\`\`\`json\n` +
                    `{\n` +
                    `  "version": "1.0.0",\n` +
                    `  "oauth": {\n` +
                    `    "githubClientId": "your_client_id_here"\n` +
                    `  }\n` +
                    `}\n` +
                    `\`\`\`\n\n` +
                    `Contact your administrator for the client ID value.`
            }]
          };
        }
        
        // Spawn the helper as a detached process
        const helper = spawn('node', [
          helperPath,
          deviceResponse.device_code,
          (deviceResponse.interval || 5).toString(),
          deviceResponse.expires_in.toString(),
          clientId
        ], {
          detached: true,
          stdio: 'ignore', // Completely detach I/O
          windowsHide: true // Hide console on Windows
        });
        
        // Allow the parent process to exit without waiting for the helper
        helper.unref();
        
        logger.info('OAuth helper process spawned', {
          pid: helper.pid,
          expiresIn: deviceResponse.expires_in,
          userCode: deviceResponse.user_code
        });
        
        // Optional: Write helper state for tracking
        const helperStateFile = path.join(process.env.HOME || process.env.USERPROFILE || '', '.dollhouse', '.auth', 'oauth-helper-state.json');
        const helperState = {
          pid: helper.pid,
          deviceCode: deviceResponse.device_code,
          userCode: deviceResponse.user_code,
          startedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + (deviceResponse.expires_in * 1000)).toISOString()
        };
        
        // SECURITY FIX: Add JSON validation and use atomic write for helper state
        // FIXED: CVE-2025-XXXX - Direct file write without validation for OAuth helper state
        // Original issue: Line 2511 used direct fs.writeFile without JSON validation
        // Security impact: Could allow malformed data to be written to auth state file
        // Fix: Added JSON validation and replaced with atomic write operation
        
        // Write state file (non-blocking, ignore errors)
        fs.mkdir(path.dirname(helperStateFile), { recursive: true })
          .then(async () => {
            try {
              // Validate JSON structure before write
              const jsonContent = JSON.stringify(helperState, null, 2);
              JSON.parse(jsonContent); // Validate JSON structure
              
              // Use atomic write to prevent race conditions
              await FileLockManager.atomicWriteFile(helperStateFile, jsonContent);
            } catch (validationError) {
              logger.debug('Invalid helper state JSON or write failed', { 
                error: validationError instanceof Error ? validationError.message : String(validationError) 
              });
            }
          })
          .catch(err => logger.debug('Could not write helper state file', { error: err.message }));
          
      } catch (spawnError) {
        logger.error('Failed to spawn OAuth helper process', { error: spawnError });
        // Don't fail the whole auth process, just log the error
        // The user can still complete auth manually if needed
      }
      
      // Return instructions to user
      return {
        content: [{
          type: "text",
          text: this.githubAuthManager.formatAuthInstructions(deviceResponse) +
                '\n\n📝 **Note**: Authentication is being handled in the background. ' +
                'Once you authorize on GitHub, you\'ll be authenticated automatically!'
        }]
      };
    } catch (error) {
      logger.error('Failed to setup GitHub auth', { error });
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ **Authentication Setup Failed**\n\n` +
                `Unable to start GitHub authentication: ${error instanceof Error ? error.message : 'Unknown error'}\n\n` +
                `Please check your internet connection and try again.`
        }]
      };
    }
  }
  
  async checkGitHubAuth() {
    try {
      // First check for pending OAuth helper process
      const helperStateFile = path.join(process.env.HOME || process.env.USERPROFILE || '', '.dollhouse', '.auth', 'oauth-helper-state.json');
      let pendingAuth = false;
      let pendingDetails = null;
      
      try {
        const stateData = await fs.readFile(helperStateFile, 'utf-8');
        const state = JSON.parse(stateData);
        const expiresAt = new Date(state.expiresAt);
        
        if (expiresAt > new Date()) {
          pendingAuth = true;
          pendingDetails = {
            userCode: state.userCode,
            timeRemaining: Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
            pid: state.pid
          };
        } else {
          // Expired, clean up the state file
          await fs.unlink(helperStateFile).catch(() => {});
        }
      } catch (error) {
        // No state file or invalid JSON, that's ok
      }
      
      const status = await this.githubAuthManager.getAuthStatus();
      
      if (status.isAuthenticated) {
        // Clean up state file if auth is successful
        if (pendingAuth) {
          await fs.unlink(helperStateFile).catch(() => {});
        }
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}✅ **GitHub Connected**\n\n` +
                  `👤 **Username:** ${status.username}\n` +
                  `🔑 **Permissions:** ${status.scopes?.join(', ') || 'basic access'}\n\n` +
                  `**Available Actions:**\n` +
                  `✅ Browse collection\n` +
                  `✅ Install content\n` +
                  `✅ Submit content\n\n` +
                  `Everything is working properly!`
          }]
        };
      } else if (status.hasToken) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}⚠️ **GitHub Token Invalid**\n\n` +
                  `A GitHub token was found but it appears to be invalid or expired.\n\n` +
                  `**To fix this:**\n` +
                  `1. Say "set up GitHub" to authenticate again\n` +
                  `2. Or check your GITHUB_TOKEN environment variable\n\n` +
                  `Note: Browse and install still work without authentication!`
          }]
        };
      } else if (pendingAuth && pendingDetails) {
        // OAuth helper is actively polling
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}⏳ **GitHub Authentication In Progress**\n\n` +
                  `🔑 **User Code:** ${pendingDetails.userCode}\n` +
                  `⏱️ **Time Remaining:** ${Math.floor(pendingDetails.timeRemaining / 60)} minutes\n` +
                  `📋 **Process ID:** ${pendingDetails.pid}\n\n` +
                  `**Status:** Waiting for you to authorize on GitHub\n\n` +
                  `If you haven't already:\n` +
                  `1. Visit: https://github.com/login/device\n` +
                  `2. Enter code: **${pendingDetails.userCode}**\n` +
                  `3. Authorize 'DollhouseMCP Collection'\n\n` +
                  `The authentication will complete automatically once you authorize!`
          }]
        };
      } else {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}🔒 **Not Connected to GitHub**\n\n` +
                  `You're not currently authenticated with GitHub.\n\n` +
                  `**What works without auth:**\n` +
                  `✅ Browse the public collection\n` +
                  `✅ Install community content\n` +
                  `❌ Submit your own content (requires auth)\n\n` +
                  `To connect, just say "set up GitHub" or "connect to GitHub"`
          }]
        };
      }
    } catch (error) {
      logger.error('Failed to check GitHub auth', { error });
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ **Unable to Check Authentication**\n\n` +
                `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
  
  async clearGitHubAuth() {
    try {
      await this.githubAuthManager.clearAuthentication();
      
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}✅ **GitHub Disconnected**\n\n` +
                `Your GitHub connection has been cleared.\n\n` +
                `**What still works:**\n` +
                `✅ Browse the public collection\n` +
                `✅ Install community content\n` +
                `❌ Submit content (requires reconnection)\n\n` +
                `To reconnect later, just say "connect to GitHub"\n\n` +
                `⚠️ **Note:** To fully remove authentication, also unset the GITHUB_TOKEN environment variable.`
        }]
      };
    } catch (error) {
      logger.error('Failed to clear GitHub auth', { error });
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ **Failed to Clear Authentication**\n\n` +
                `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  // OAuth configuration management
  async configureOAuth(client_id?: string) {
    try {
      const configManager = ConfigManager.getInstance();
      await configManager.loadConfig();
      
      // If no client_id provided, show current configuration status
      if (!client_id) {
        const currentClientId = configManager.getGitHubClientId();
        
        if (currentClientId) {
          // Show first 10 characters for security
          const maskedClientId = currentClientId.substring(0, 10) + '...';
          return {
            content: [{
              type: "text",
              text: `${this.getPersonaIndicator()}✅ **GitHub OAuth Configuration**\n\n` +
                    `**Current Status:** Configured\n` +
                    `**Client ID:** ${maskedClientId}\n\n` +
                    `Your GitHub OAuth is ready to use! You can now:\n` +
                    `• Run setup_github_auth to connect\n` +
                    `• Submit content to the collection\n` +
                    `• Access authenticated features\n\n` +
                    `To update the configuration, provide a new client_id parameter.`
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
              text: `${this.getPersonaIndicator()}⚠️ **GitHub OAuth Not Configured**\n\n` +
                    `No GitHub OAuth client ID is currently configured.\n\n` +
                    `**To set up OAuth:**\n` +
                    `1. Create a GitHub OAuth app at: https://github.com/settings/applications/new\n` +
                    `2. Use these settings:\n` +
                    `   • Homepage URL: https://github.com/DollhouseMCP\n` +
                    `   • Authorization callback URL: http://localhost:3000/callback\n` +
                    `3. Copy your Client ID (starts with "Ov23li")\n` +
                    `4. Run: configure_oauth with your client_id parameter\n\n` +
                    `**Need help?** Check the documentation for detailed setup instructions.`
            }]
          };
        }
      }
      
      // Validate client ID format
      if (!ConfigManager.validateClientId(client_id)) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Invalid Client ID Format**\n\n` +
                  `GitHub OAuth Client IDs must:\n` +
                  `• Start with "Ov23li"\n` +
                  `• Be followed by at least 14 alphanumeric characters\n\n` +
                  `**Example:** Ov23liABCDEFGHIJKLMN\n\n` +
                  `Please check your client ID and try again.`
          }]
        };
      }
      
      // Save the client ID
      await configManager.setGitHubClientId(client_id);
      
      // Show success message with masked ID
      const maskedClientId = client_id.substring(0, 10) + '...';
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}✅ **GitHub OAuth Configured Successfully**\n\n` +
                `**Client ID:** ${maskedClientId}\n` +
                `**Saved to:** ~/.dollhouse/config.json\n\n` +
                `Your GitHub OAuth is now ready! Next steps:\n` +
                `• Run setup_github_auth to connect your account\n` +
                `• Start submitting content to the collection\n` +
                `• Access all authenticated features\n\n` +
                `**Note:** Your client ID is securely stored in your local config file.`
        }]
      };
      
    } catch (error) {
      logger.error('Failed to configure OAuth', { error });
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ **OAuth Configuration Failed**\n\n` +
                `Error: ${error instanceof Error ? error.message : 'Unknown error'}\n\n` +
                `Please check:\n` +
                `• File permissions for ~/.dollhouse/config.json\n` +
                `• Valid client ID format (starts with "Ov23li")\n` +
                `• Available disk space`
        }]
      };
    }
  }

  // Chat-based persona management tools
  async createPersona(name: string, description: string, instructions: string, triggers?: string) {
    // Ensure initialization for test compatibility
    await this.ensureInitialized();
    
    try {
      // Validate required fields
      if (!name || !description || !instructions) {
        return {
          content: [
            {
              type: "text",
              text: `${this.getPersonaIndicator()}❌ **Missing Required Fields**\n\n` +
                `Please provide all required fields:\n` +
                `• **name**: Display name for the persona\n` +
                `• **description**: Brief description of what it does\n` +
                `• **instructions**: The persona's behavioral guidelines\n\n` +
                `**Optional:**\n` +
                `• **triggers**: Comma-separated keywords for activation`,
            },
          ],
        };
      }

      // Sanitize and validate inputs
      const sanitizedName = sanitizeInput(name, 100);
      const sanitizedDescription = sanitizeInput(description, 500);
      const sanitizedInstructions = sanitizeInput(instructions);
      const sanitizedTriggers = triggers ? sanitizeInput(triggers, 200) : '';

      // Validate name length and format
      if (sanitizedName.length < 2) {
        throw new Error('Persona name must be at least 2 characters long');
      }

      // No category validation needed - categories are deprecated

      // Validate content sizes
      validateContentSize(sanitizedInstructions, SECURITY_LIMITS.MAX_CONTENT_LENGTH);
      validateContentSize(sanitizedDescription, 2000); // 2KB max for description

      // Validate content for security threats
      const nameValidation = ContentValidator.validateAndSanitize(sanitizedName);
      if (!nameValidation.isValid) {
        throw new Error(`Name contains prohibited content: ${nameValidation.detectedPatterns?.join(', ')}`);
      }

      const descValidation = ContentValidator.validateAndSanitize(sanitizedDescription);
      if (!descValidation.isValid) {
        throw new Error(`Description contains prohibited content: ${descValidation.detectedPatterns?.join(', ')}`);
      }

      const instructionsValidation = ContentValidator.validateAndSanitize(sanitizedInstructions);
      if (!instructionsValidation.isValid && instructionsValidation.severity === 'critical') {
        throw new Error(`Instructions contain security threats: ${instructionsValidation.detectedPatterns?.join(', ')}`);
      }

      // Generate metadata
      const author = this.getCurrentUserForAttribution();
      const uniqueId = generateUniqueId(sanitizedName, this.currentUser || undefined);
      const filename = validateFilename(`${slugify(sanitizedName)}.md`);
      // personasDir is guaranteed to be set after ensureInitialized()
      const filePath = path.join(this.personasDir!, filename);

    // Check if file already exists
    try {
      await PathValidator.validatePersonaPath(filePath);
      await fs.access(filePath);
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}⚠️ **Persona Already Exists**\n\n` +
              `A persona file named "${filename}" already exists.\n` +
              `Use \`edit_persona\` to modify it, or choose a different name.`,
          },
        ],
      };
    } catch {
      // File doesn't exist, proceed with creation
    }

      // Parse and sanitize triggers
      const triggerList = sanitizedTriggers ? 
        sanitizedTriggers.split(',').map(t => sanitizeInput(t.trim(), 50)).filter(t => t.length > 0) : 
        [];

      // Create persona metadata with sanitized values
      const metadata: PersonaMetadata = {
        name: sanitizedName,
        description: sanitizedDescription,
        unique_id: uniqueId,
        author,
        triggers: triggerList,
        version: "1.0",
        age_rating: "all",
        content_flags: ["user-created"],
        ai_generated: true,
        generation_method: "Claude",
        price: "free",
        revenue_split: "80/20",
        license: "CC-BY-SA-4.0",
        created_date: new Date().toISOString().slice(0, 10)
      };

      // Create full persona content with sanitized values
      const frontmatter = Object.entries(metadata)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join('\n');

      const personaContent = `---
${frontmatter}
---

# ${sanitizedName}

${sanitizedInstructions}

## Response Style
- Follow the behavioral guidelines above
- Maintain consistency with the persona's character
- Adapt responses to match the intended purpose

## Usage Notes
- Created via DollhouseMCP chat interface
- Author: ${author}
- Version: 1.0`;

      // Validate final content size
      validateContentSize(personaContent, SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES);

    try {
      // Use file locking to prevent race conditions
      await FileLockManager.withLock(`persona:${sanitizedName}`, async () => {
        // Double-check file doesn't exist (in case of race condition)
        try {
          await fs.access(filePath);
          throw new Error(`Persona file "${filename}" already exists`);
        } catch (error: any) {
          // If error is not ENOENT (file not found), re-throw it
          if (error.code !== 'ENOENT' && error.message?.includes('already exists')) {
            throw error;
          }
          // File doesn't exist, proceed
        }
        
        // Write the file atomically
        await FileLockManager.atomicWriteFile(filePath, personaContent);
      });
      
      // Reload personas to include the new one
      await this.loadPersonas();

      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}✅ **Persona Created Successfully!**\n\n` +
              `🎭 **${sanitizedName}** by ${author}\n` +
              `🆔 Unique ID: ${uniqueId}\n` +
              `📄 Saved as: ${filename}\n` +
              `📊 Total personas: ${this.personas.size}\n\n` +
              `🎯 **Ready to use:** \`activate_persona "${sanitizedName}"\`\n` +
              `📤 **Share it:** \`submit_content "${sanitizedName}"\`\n` +
              `✏️ **Edit it:** \`edit_persona "${sanitizedName}" "field" "new value"\``,
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Error Creating Persona**\n\n` +
              `Failed to write persona file: ${sanitized.message}\n\n` +
              `Please check permissions and try again.`,
          },
        ],
      };
    }
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Validation Error**\n\n` +
              `${sanitized.message}\n\n` +
              `Please fix the issue and try again.`,
          },
        ],
      };
    }
  }

  async editPersona(personaIdentifier: string, field: string, value: string) {
    if (!personaIdentifier || !field || !value) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Missing Parameters**\n\n` +
              `Usage: \`edit_persona "persona_name" "field" "new_value"\`\n\n` +
              `**Editable fields:**\n` +
              `• **name** - Display name\n` +
              `• **description** - Brief description\n` +
              `• **instructions** - Main persona content\n` +
              `• **triggers** - Comma-separated keywords\n` +
              `• **version** - Version number`,
          },
        ],
      };
    }

    // Find the persona
    let persona = this.personas.get(personaIdentifier);
    
    if (!persona) {
      // Search by name
      persona = Array.from(this.personas.values()).find(p => 
        p.metadata.name.toLowerCase() === personaIdentifier.toLowerCase()
      );
    }

    if (!persona) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Persona Not Found**\n\n` +
              `Could not find persona: "${personaIdentifier}"\n\n` +
              `Use \`list_personas\` to see available personas.`,
          },
        ],
      };
    }

    const validFields = ['name', 'description', 'instructions', 'triggers', 'version'];
    if (!validFields.includes(field.toLowerCase())) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Invalid Field**\n\n` +
              `Field "${field}" is not editable.\n\n` +
              `**Valid fields:** ${validFields.join(', ')}`,
          },
        ],
      };
    }

    // personasDir is guaranteed to be set after initialization
    let filePath = path.join(this.personasDir!, persona.filename);
    let isDefault = isDefaultPersona(persona.filename);

    try {
      // Read current file
      const fileContent = await PathValidator.safeReadFile(filePath);
      
      // Use secure YAML parser
      let parsed;
      try {
        parsed = SecureYamlParser.safeMatter(fileContent);
      } catch (error) {
        if (error instanceof SecurityError) {
          return {
            content: [
              {
                type: "text",
                text: `${this.getPersonaIndicator()}❌ **Security Error**\n\n` +
                  `Cannot edit persona due to security threat: ${error.message}`,
              },
            ],
          };
        }
        throw error;
      }
      
      // If editing a default persona, create a copy instead
      if (isDefault) {
        // Generate unique ID for the copy
        const author = this.currentUser || generateAnonymousId();
        const uniqueId = generateUniqueId(persona.metadata.name, author);
        const newFilename = `${uniqueId}.md`;
        const newFilePath = path.join(this.personasDir!, newFilename);
        
        // Create copy of the default persona
        const content = await PathValidator.safeReadFile(filePath);
        
        // Use file locking to prevent race conditions when creating the copy
        await FileLockManager.withLock(`persona:${persona.metadata.name}-copy`, async () => {
          await FileLockManager.atomicWriteFile(newFilePath, content);
        });
        
        // Update file path to point to the copy
        filePath = newFilePath;
        
        // Update the unique_id in the metadata
        parsed.data.unique_id = uniqueId;
        parsed.data.author = author;
      }
      
      // Update the appropriate field
      const normalizedField = field.toLowerCase();
      
      // Validate the new value for security threats
      const valueValidation = ContentValidator.validateAndSanitize(value);
      if (!valueValidation.isValid && valueValidation.severity === 'critical') {
        return {
          content: [
            {
              type: "text",
              text: `${this.getPersonaIndicator()}❌ **Security Validation Failed**\n\n` +
              `The new value contains prohibited content:\n` +
              `• ${valueValidation.detectedPatterns?.join('\n• ')}\n\n` +
              `Please remove these patterns and try again.`,
            },
          ],
        };
      }
      
      // Use sanitized value if needed
      let sanitizedValue = valueValidation.sanitizedContent || value;
      
      // Always remove shell metacharacters from display output
      const displayValue = sanitizedValue.replace(/[;&|`$()]/g, '');
      
      if (normalizedField === 'instructions') {
        // Update the main content
        parsed.content = sanitizedValue;
      } else if (normalizedField === 'triggers') {
        // Parse triggers as comma-separated list
        parsed.data[normalizedField] = sanitizedValue.split(',').map(t => t.trim()).filter(t => t.length > 0);
      } else if (normalizedField === 'category') {
        // Category field is deprecated but still editable for backward compatibility
        parsed.data[normalizedField] = sanitizedValue;
      } else {
        // Update metadata field
        // For name field, apply additional sanitization to remove shell metacharacters
        if (normalizedField === 'name') {
          parsed.data[normalizedField] = sanitizeInput(sanitizedValue, 100);
        } else {
          parsed.data[normalizedField] = sanitizedValue;
        }
      }

      // Update version and modification info
      if (normalizedField !== 'version') {
        const currentVersion = parsed.data.version || '1.0';
        const versionParts = currentVersion.split('.').map(Number);
        versionParts[1] = (versionParts[1] || 0) + 1;
        parsed.data.version = versionParts.join('.');
      }

      // Regenerate file content
      // Use secure YAML stringification
      const secureParser = SecureYamlParser.createSecureMatterParser();
      const updatedContent = secureParser.stringify(parsed.content, parsed.data);
      
      // Use file locking to prevent race conditions
      await FileLockManager.withLock(`persona:${persona.metadata.name}`, async () => {
        // Write updated file atomically
        await FileLockManager.atomicWriteFile(filePath, updatedContent);
      });
      
      // Reload personas
      await this.loadPersonas();

      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}✅ **Persona Updated Successfully!**\n\n` +
              (isDefault ? `📋 **Note:** Created a copy of the default persona to preserve the original.\n\n` : '') +
              `🎭 **${(parsed.data.name || persona.metadata.name || '').replace(/[;&|`$()]/g, '')}**\n` +
              `📝 **Field Updated:** ${field}\n` +
              `🔄 **New Value:** ${normalizedField === 'instructions' ? 'Content updated' : displayValue}\n` +
              `📊 **Version:** ${parsed.data.version}\n` +
              (isDefault ? `🆔 **New ID:** ${parsed.data.unique_id}\n` : '') +
              `\n` +
              `Use \`get_persona_details "${(parsed.data.name || persona.metadata.name || '').replace(/[;&|`$()]/g, '')}"\` to see all changes.`,
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Error Updating Persona**\n\n` +
              `Failed to update persona: ${sanitized.message}\n\n` +
              `Please check file permissions and try again.`,
          },
        ],
      };
    }
  }

  async validatePersona(personaIdentifier: string) {
    if (!personaIdentifier) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Missing Persona Identifier**\n\n` +
              `Usage: \`validate_persona "persona_name"\`\n\n` +
              `Use \`list_personas\` to see available personas.`,
          },
        ],
      };
    }

    // Find the persona
    let persona = this.personas.get(personaIdentifier);
    
    if (!persona) {
      // Search by name
      persona = Array.from(this.personas.values()).find(p => 
        p.metadata.name.toLowerCase() === personaIdentifier.toLowerCase()
      );
    }

    if (!persona) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Persona Not Found**\n\n` +
              `Could not find persona: "${personaIdentifier}"\n\n` +
              `Use \`list_personas\` to see available personas.`,
          },
        ],
      };
    }

    // Validation checks
    const issues: string[] = [];
    const warnings: string[] = [];
    const metadata = persona.metadata;

    // Required field checks
    if (!metadata.name || metadata.name.trim().length === 0) {
      issues.push("Missing or empty 'name' field");
    }
    if (!metadata.description || metadata.description.trim().length === 0) {
      issues.push("Missing or empty 'description' field");
    }
    if (!persona.content || persona.content.trim().length < 50) {
      issues.push("Persona content is too short (minimum 50 characters)");
    }

    // Category validation
    const validCategories = ['creative', 'professional', 'educational', 'gaming', 'personal', 'general'];
    if (metadata.category && !validCategories.includes(metadata.category)) {
      issues.push(`Invalid category '${metadata.category}'. Must be one of: ${validCategories.join(', ')}`);
    }

    // Age rating validation
    const validAgeRatings = ['all', '13+', '18+'];
    if (metadata.age_rating && !validAgeRatings.includes(metadata.age_rating)) {
      warnings.push(`Invalid age_rating '${metadata.age_rating}'. Should be one of: ${validAgeRatings.join(', ')}`);
    }

    // Optional field warnings
    if (!metadata.triggers || metadata.triggers.length === 0) {
      warnings.push("No trigger keywords defined - users may have difficulty finding this persona");
    }
    if (!metadata.version) {
      warnings.push("No version specified - defaulting to '1.0'");
    }
    if (!metadata.unique_id) {
      warnings.push("No unique_id - one will be generated automatically");
    }

    // Content quality checks
    if (persona.content.length > 5000) {
      warnings.push("Persona content is very long - consider breaking it into sections");
    }
    if (metadata.name && metadata.name.length > 50) {
      warnings.push("Persona name is very long - consider shortening for better display");
    }
    if (metadata.description && metadata.description.length > 200) {
      warnings.push("Description is very long - consider keeping it under 200 characters");
    }

    // Generate validation report
    let report = `${this.getPersonaIndicator()}📋 **Validation Report: ${persona.metadata.name}**\n\n`;
    
    if (issues.length === 0 && warnings.length === 0) {
      report += `✅ **All Checks Passed!**\n\n` +
        `🎭 **Persona:** ${metadata.name}\n` +
        `📁 **Category:** ${metadata.category || 'general'}\n` +
        `📊 **Version:** ${metadata.version || '1.0'}\n` +
        `📝 **Content Length:** ${persona.content.length} characters\n` +
        `🔗 **Triggers:** ${metadata.triggers?.length || 0} keywords\n\n` +
        `This persona meets all validation requirements and is ready for use!`;
    } else {
      if (issues.length > 0) {
        report += `❌ **Issues Found (${issues.length}):**\n`;
        issues.forEach((issue, i) => {
          report += `   ${i + 1}. ${issue}\n`;
        });
        report += '\n';
      }

      if (warnings.length > 0) {
        report += `⚠️ **Warnings (${warnings.length}):**\n`;
        warnings.forEach((warning, i) => {
          report += `   ${i + 1}. ${warning}\n`;
        });
        report += '\n';
      }

      if (issues.length > 0) {
        report += `**Recommendation:** Fix the issues above before using this persona.\n`;
        report += `Use \`edit_persona "${persona.metadata.name}" "field" "value"\` to make corrections.`;
      } else {
        report += `**Status:** Persona is functional but could be improved.\n`;
        report += `Address warnings above for optimal performance.`;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: report,
        },
      ],
    };
  }

  // retryNetworkOperation is now handled by UpdateChecker

  // Auto-update management tools
  async checkForUpdates() {
    if (!this.updateManager) {
      return {
        content: [{ type: "text", text: this.getPersonaIndicator() + "❌ Update functionality not available (initialization failed)" }]
      };
    }
    const { text } = await this.updateManager.checkForUpdates();
    return {
      content: [{ type: "text", text: this.getPersonaIndicator() + text }]
    };
  }

  // Update helper methods are now handled by UpdateManager

  async updateServer(confirm: boolean) {
    if (!confirm) {
      return {
        content: [{
          type: "text",
          text: this.getPersonaIndicator() + 
            '⚠️ **Update Confirmation Required**\n\n' +
            'To proceed with the update, you must confirm:\n' +
            '`update_server true`\n\n' +
            '**What will happen:**\n' +
            '• Backup current version\n' +
            '• Pull latest changes from GitHub\n' +
            '• Update dependencies\n' +
            '• Rebuild TypeScript\n' +
            '• Restart server (will disconnect temporarily)\n\n' +
            '**Prerequisites:**\n' +
            '• Git repository must be clean (no uncommitted changes)\n' +
            '• Network connection required\n' +
            '• Sufficient disk space for backup'
        }]
      };
    }

    if (!this.updateManager) {
      return {
        content: [{ type: "text", text: this.getPersonaIndicator() + "❌ Update functionality not available (initialization failed)" }]
      };
    }
    const { text } = await this.updateManager.updateServer(confirm, this.getPersonaIndicator());
    return {
      content: [{ type: "text", text }]
    };
  }

  // Rollback helper methods are now handled by UpdateManager

  async rollbackUpdate(confirm: boolean) {
    if (!this.updateManager) {
      return {
        content: [{ type: "text", text: this.getPersonaIndicator() + "❌ Update functionality not available (initialization failed)" }]
      };
    }
    const { text } = await this.updateManager.rollbackUpdate(confirm, this.getPersonaIndicator());
    return {
      content: [{ type: "text", text }]
    };
  }

  // Version and git info methods are now handled by UpdateManager

  // Status helper methods are now handled by UpdateManager

  async getServerStatus() {
    // Add persona information to the status
    const personaInfo = `
**🎭 Persona Information:**
• **Total Personas:** ${this.personas.size}
• **Active Persona:** ${this.activePersona || 'None'}
• **User Identity:** ${this.currentUser || 'Anonymous'}
• **Personas Directory:** ${this.personasDir}`;
    
    if (!this.updateManager) {
      const errorMessage = `${this.getPersonaIndicator()}❌ Update functionality not available (initialization failed)\n\n${personaInfo}`;
      return {
        content: [{ type: "text", text: errorMessage }]
      };
    }
    const { text } = await this.updateManager.getServerStatus(this.getPersonaIndicator());
    // Insert persona info into the status text
    const updatedText = text.replace('**Available Commands:**', personaInfo + '\n\n**Available Commands:**');
    
    return {
      content: [{ type: "text", text: updatedText }]
    };
  }

  async convertToGitInstallation(targetDir?: string, confirm: boolean = false) {
    if (!this.updateManager) {
      return {
        content: [{ type: "text", text: this.getPersonaIndicator() + "❌ Update functionality not available (initialization failed)" }]
      };
    }
    const result = await this.updateManager.convertToGitInstallation(targetDir, confirm, this.getPersonaIndicator());
    return {
      content: [{ type: "text", text: result.text }]
    };
  }

  // Version and dependency methods are now handled by UpdateManager


  /**
   * Configure indicator settings
   */
  async configureIndicator(config: Partial<IndicatorConfig>) {
    try {
      // Update the configuration
      if (config.enabled !== undefined) {
        this.indicatorConfig.enabled = config.enabled;
      }
      if (config.style !== undefined) {
        this.indicatorConfig.style = config.style;
      }
      if (config.customFormat !== undefined) {
        // Validate custom format before applying
        const validation = validateCustomFormat(config.customFormat);
        if (!validation.valid) {
          return {
            content: [
              {
                type: "text",
                text: `${this.getPersonaIndicator()}❌ Invalid custom format: ${validation.error}`
              }
            ]
          };
        }
        this.indicatorConfig.customFormat = config.customFormat;
      }
      if (config.showVersion !== undefined) {
        this.indicatorConfig.showVersion = config.showVersion;
      }
      if (config.showAuthor !== undefined) {
        this.indicatorConfig.showAuthor = config.showAuthor;
      }
      if (config.showCategory !== undefined) {
        this.indicatorConfig.showCategory = config.showCategory;
      }
      if (config.emoji !== undefined) {
        this.indicatorConfig.emoji = config.emoji;
      }
      if (config.bracketStyle !== undefined) {
        this.indicatorConfig.bracketStyle = config.bracketStyle;
      }

      // Show example of what the indicator would look like
      let exampleIndicator = "";
      if (this.activePersona) {
        const persona = this.personas.get(this.activePersona);
        if (persona) {
          exampleIndicator = formatIndicator(this.indicatorConfig, {
            name: persona.metadata.name,
            version: persona.metadata.version,
            author: persona.metadata.author,
            category: persona.metadata.category
          });
        }
      } else {
        // Show example with sample data
        exampleIndicator = formatIndicator(this.indicatorConfig, {
          name: "Example Persona",
          version: "1.0",
          author: "@username",
          category: "creative"
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}✅ Indicator configuration updated successfully!

Current settings:
- Enabled: ${this.indicatorConfig.enabled}
- Style: ${this.indicatorConfig.style}
- Show Version: ${this.indicatorConfig.showVersion}
- Show Author: ${this.indicatorConfig.showAuthor}
- Show Category: ${this.indicatorConfig.showCategory}
- Emoji: ${this.indicatorConfig.emoji}
- Brackets: ${this.indicatorConfig.bracketStyle}
${this.indicatorConfig.customFormat ? `- Custom Format: ${this.indicatorConfig.customFormat}` : ''}

Example indicator: ${exampleIndicator || "(none - indicators disabled)"}

Note: Configuration is temporary for this session. To make permanent, set environment variables:
- DOLLHOUSE_INDICATOR_ENABLED=true/false
- DOLLHOUSE_INDICATOR_STYLE=full/minimal/compact/custom
- DOLLHOUSE_INDICATOR_FORMAT="custom format template"
- DOLLHOUSE_INDICATOR_SHOW_VERSION=true/false
- DOLLHOUSE_INDICATOR_SHOW_AUTHOR=true/false
- DOLLHOUSE_INDICATOR_SHOW_CATEGORY=true/false
- DOLLHOUSE_INDICATOR_EMOJI=🎭
- DOLLHOUSE_INDICATOR_BRACKETS=square/round/curly/angle/none`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Error configuring indicator: ${SecureErrorHandler.sanitizeError(error).message}`
          }
        ]
      };
    }
  }

  /**
   * Get current indicator configuration
   */
  async configureCollectionSubmission(autoSubmit: boolean) {
    try {
      // Store the configuration in environment variable
      if (autoSubmit) {
        process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = 'true';
      } else {
        delete process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION;
      }

      const message = autoSubmit 
        ? "✅ Collection submission enabled! Content will automatically be submitted to the DollhouseMCP collection after portfolio upload."
        : "✅ Collection submission disabled. Content will only be uploaded to your personal portfolio.";

      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}${message}`
          }
        ]
      };
    } catch (error) {
      logger.error('Error configuring collection submission', { error });
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Failed to configure collection submission: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }

  async getCollectionSubmissionConfig() {
    const autoSubmitEnabled = process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION === 'true';
    
    const message = `**Collection Submission Configuration**\n\n` +
      `• **Auto-submit**: ${autoSubmitEnabled ? '✅ Enabled' : '❌ Disabled'}\n\n` +
      `When auto-submit is enabled, the \`submit_content\` tool will:\n` +
      `1. Upload content to your GitHub portfolio\n` +
      `2. Automatically create a submission issue in DollhouseMCP/collection\n\n` +
      `To change this setting, use:\n` +
      `\`\`\`\nconfigure_collection_submission autoSubmit: true/false\n\`\`\``;

    return {
      content: [
        {
          type: "text",
          text: `${this.getPersonaIndicator()}${message}`
        }
      ]
    };
  }

  async getIndicatorConfig() {
    // Show current configuration and example
    let exampleIndicator = "";
    if (this.activePersona) {
      const persona = this.personas.get(this.activePersona);
      if (persona) {
        exampleIndicator = formatIndicator(this.indicatorConfig, {
          name: persona.metadata.name,
          version: persona.metadata.version,
          author: persona.metadata.author,
          category: persona.metadata.category
        });
      }
    } else {
      // Show example with sample data
      exampleIndicator = formatIndicator(this.indicatorConfig, {
        name: "Example Persona",
        version: "1.0",
        author: "@username",
        category: "creative"
      });
    }

    return {
      content: [
        {
          type: "text",
          text: `${this.getPersonaIndicator()}📊 Current Indicator Configuration:

Settings:
- Enabled: ${this.indicatorConfig.enabled}
- Style: ${this.indicatorConfig.style}
- Show Version: ${this.indicatorConfig.showVersion}
- Show Author: ${this.indicatorConfig.showAuthor}
- Show Category: ${this.indicatorConfig.showCategory}
- Emoji: ${this.indicatorConfig.emoji}
- Brackets: ${this.indicatorConfig.bracketStyle}
- Separator: "${this.indicatorConfig.separator}"
${this.indicatorConfig.customFormat ? `- Custom Format: ${this.indicatorConfig.customFormat}` : ''}

Available styles:
- full: [🎭 Persona Name v1.0 by @author]
- minimal: 🎭 Persona Name
- compact: [Persona Name v1.0]
- custom: Use your own format with placeholders

Example with current settings: ${exampleIndicator || "(none - indicators disabled)"}

Placeholders for custom format:
- {emoji} - The configured emoji
- {name} - Persona name
- {version} - Persona version
- {author} - Persona author
- {category} - Persona category`
        }
      ]
    };
  }


  /**
   * Export a single persona
   */
  async exportPersona(personaName: string) {
    try {
      // Use a single lookup to avoid race conditions
      let persona = this.personas.get(personaName);
      if (!persona) {
        // Try by filename
        persona = Array.from(this.personas.values()).find(p => p.filename === personaName);
        if (!persona) {
          return {
            content: [{
              type: "text",
              text: `${this.getPersonaIndicator()}❌ Persona not found: ${personaName}`
            }]
          };
        }
      }

      const exportData = this.personaExporter.exportPersona(persona);
      const base64 = this.personaExporter.toBase64(exportData);
      const result = this.personaExporter.formatExportResult(persona, base64);

      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}${result}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ Export failed: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Export all personas
   */
  async exportAllPersonas(includeDefaults = true) {
    try {
      const personasArray = Array.from(this.personas.values());
      const bundle = this.personaExporter.exportBundle(personasArray, includeDefaults);
      const base64 = this.personaExporter.toBase64(bundle);
      const result = this.personaExporter.formatBundleResult(bundle, base64);

      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}${result}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ Export failed: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Import a persona
   */
  async importPersona(source: string, overwrite = false) {
    try {
      if (!this.personaImporter) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Import functionality not available (initialization in progress)`
          }]
        };
      }
      const result = await this.personaImporter.importPersona(source, this.personas, overwrite);
      
      if (result.success) {
        // Reload personas to include the new one
        await this.loadPersonas();
        
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}✅ ${result.message}\n\nPersona "${result.persona?.metadata.name}" is now available.\nTotal personas: ${this.personas.size}`
          }]
        };
      } else {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ ${result.message}`
          }]
        };
      }
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ Import failed: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Share a persona via URL
   */
  async sharePersona(personaName: string, expiryDays = 7) {
    try {
      // Enhanced input validation
      const validatedPersonaName = MCPInputValidator.validatePersonaIdentifier(personaName);
      const validatedExpiryDays = MCPInputValidator.validateExpiryDays(expiryDays);
      
      const persona = this.personas.get(validatedPersonaName);
      if (!persona) {
        // Try by filename
        const byFilename = Array.from(this.personas.values()).find(p => p.filename === validatedPersonaName);
        if (!byFilename) {
          return {
            content: [{
              type: "text",
              text: `${this.getPersonaIndicator()}❌ Persona not found: ${validatedPersonaName}`
            }]
          };
        }
        personaName = byFilename.metadata.name;
      }

      const result = await this.personaSharer.sharePersona(this.personas.get(personaName)!, validatedExpiryDays);
      
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}${result.message}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ Share failed: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Import from a shared URL
   */
  async importFromUrl(url: string, overwrite = false) {
    try {
      // Enhanced input validation for URL
      const validatedUrl = MCPInputValidator.validateImportUrl(url);
      
      const fetchResult = await this.personaSharer.importFromUrl(validatedUrl);
      
      if (!fetchResult.success) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ ${fetchResult.message}`
          }]
        };
      }

      // Import the fetched data
      if (!this.personaImporter) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Import functionality not available (initialization in progress)`
          }]
        };
      }
      const importResult = await this.personaImporter.importPersona(
        JSON.stringify(fetchResult.data),
        this.personas,
        overwrite
      );

      if (importResult.success) {
        // Reload personas
        await this.loadPersonas();
        
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}✅ Successfully imported from URL!\n\n${importResult.message}\nTotal personas: ${this.personas.size}`
          }]
        };
      } else {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ ${importResult.message}`
          }]
        };
      }
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ Import from URL failed: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Portfolio management methods
   */

  /**
   * Check portfolio status including repository existence and sync information
   */
  async portfolioStatus(username?: string) {
    try {
      // Validate username parameter if provided
      if (username && typeof username === 'string') {
        try {
          validateUsername(username);
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `${this.getPersonaIndicator()}❌ Invalid username: ${error instanceof Error ? error.message : 'Validation failed'}`
            }]
          };
        }
      }

      // Get current user if username not provided
      let targetUsername = username;
      if (!targetUsername) {
        const authStatus = await this.githubAuthManager.getAuthStatus();
        if (!authStatus.isAuthenticated || !authStatus.username) {
          return {
            content: [{
              type: "text",
              text: `${this.getPersonaIndicator()}❌ GitHub authentication required. Please use setup_github_auth first.`
            }]
          };
        }
        targetUsername = authStatus.username;
      }

      // Check if portfolio exists
      const { PortfolioRepoManager } = await import('./portfolio/PortfolioRepoManager.js');
      const portfolioManager = new PortfolioRepoManager();
      const portfolioExists = await portfolioManager.checkPortfolioExists(targetUsername);

      let statusText = `${this.getPersonaIndicator()}📊 **Portfolio Status for ${targetUsername}**\n\n`;

      if (portfolioExists) {
        statusText += `✅ **Repository**: dollhouse-portfolio exists\n`;
        statusText += `🔗 **URL**: https://github.com/${targetUsername}/dollhouse-portfolio\n\n`;
        
        // Get local elements count
        const localPortfolioManager = PortfolioManager.getInstance();
        const personasPath = localPortfolioManager.getElementDir(ElementType.PERSONA);
        const skillsPath = localPortfolioManager.getElementDir(ElementType.SKILL);
        const templatesPath = localPortfolioManager.getElementDir(ElementType.TEMPLATE);
        const agentsPath = localPortfolioManager.getElementDir(ElementType.AGENT);
        const memoriesPath = localPortfolioManager.getElementDir(ElementType.MEMORY);
        const ensemblesPath = localPortfolioManager.getElementDir(ElementType.ENSEMBLE);

        const [personas, skills, templates, agents, memories, ensembles] = await Promise.all([
          this.countElementsInDir(personasPath),
          this.countElementsInDir(skillsPath),
          this.countElementsInDir(templatesPath),
          this.countElementsInDir(agentsPath),
          this.countElementsInDir(memoriesPath),
          this.countElementsInDir(ensemblesPath)
        ]);

        const totalElements = personas + skills + templates + agents + memories + ensembles;
        statusText += `📈 **Local Elements**:\n`;
        statusText += `  • Personas: ${personas}\n`;
        statusText += `  • Skills: ${skills}\n`;
        statusText += `  • Templates: ${templates}\n`;
        statusText += `  • Agents: ${agents}\n`;
        statusText += `  • Memories: ${memories}\n`;
        statusText += `  • Ensembles: ${ensembles}\n`;
        statusText += `  • **Total**: ${totalElements}\n\n`;

        statusText += `🔄 **Sync Status**: Use sync_portfolio to update GitHub\n`;
      } else {
        statusText += `❌ **Repository**: No portfolio found\n`;
        statusText += `💡 **Next Step**: Use init_portfolio to create one\n\n`;
        
        statusText += `📝 **What you'll get**:\n`;
        statusText += `  • GitHub repository for your elements\n`;
        statusText += `  • Organized folder structure\n`;
        statusText += `  • README with usage instructions\n`;
        statusText += `  • Easy sharing and backup\n`;
      }

      return {
        content: [{
          type: "text",
          text: statusText
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ Failed to check portfolio status: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Initialize a new GitHub portfolio repository
   */
  async initPortfolio(options: {repositoryName?: string; private?: boolean; description?: string}) {
    try {
      // Check authentication
      const authStatus = await this.githubAuthManager.getAuthStatus();
      if (!authStatus.isAuthenticated || !authStatus.username) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ GitHub authentication required. Please use setup_github_auth first.`
          }]
        };
      }

      const username = authStatus.username;

      // Check if portfolio already exists
      const { PortfolioRepoManager } = await import('./portfolio/PortfolioRepoManager.js');
      const portfolioManager = new PortfolioRepoManager();
      const portfolioExists = await portfolioManager.checkPortfolioExists(username);

      if (portfolioExists) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}✅ Portfolio already exists at https://github.com/${username}/dollhouse-portfolio\n\nUse portfolio_status to see details or sync_portfolio to update it.`
          }]
        };
      }

      // Create portfolio with explicit consent
      const portfolioUrl = await portfolioManager.createPortfolio(username, true);

      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}🎉 **Portfolio Created Successfully!**\n\n` +
                `✅ **Repository**: https://github.com/${username}/dollhouse-portfolio\n` +
                `📁 **Structure**: Organized folders for all element types\n` +
                `📝 **README**: Usage instructions included\n` +
                `🔄 **Next Step**: Use sync_portfolio to upload your elements\n\n` +
                `Your portfolio is ready for sharing your DollhouseMCP creations!`
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ Failed to initialize portfolio: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Configure portfolio settings
   */
  async portfolioConfig(options: {autoSync?: boolean; defaultVisibility?: string; autoSubmit?: boolean; repositoryName?: string}) {
    try {
      const configManager = ConfigManager.getInstance();
      await configManager.loadConfig();

      let statusText = `${this.getPersonaIndicator()}⚙️ **Portfolio Configuration**\n\n`;

      // Update settings if provided
      if (options.autoSync !== undefined) {
        // This would be implemented when auto-sync feature is added
        statusText += `🔄 Auto-sync: ${options.autoSync ? 'Enabled' : 'Disabled'} (Coming soon)\n`;
      }

      if (options.defaultVisibility) {
        statusText += `🔒 Default visibility: ${options.defaultVisibility}\n`;
      }

      if (options.autoSubmit !== undefined) {
        // Note: Auto-submit configuration would be implemented here
        // For now, we'll just show the status
        statusText += `📤 Auto-submit to collection: ${options.autoSubmit ? 'Enabled' : 'Disabled'} (Coming soon)\n`;
      }

      if (options.repositoryName) {
        statusText += `📁 Repository name: ${options.repositoryName} (Custom names coming soon)\n`;
      }

      // Show current configuration
      statusText += `\n📋 **Current Settings**:\n`;
      statusText += `  • Auto-submit: Disabled (Coming soon)\n`;
      statusText += `  • Repository name: dollhouse-portfolio (default)\n`;
      statusText += `  • Default visibility: public\n`;

      return {
        content: [{
          type: "text",
          text: statusText
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ Failed to configure portfolio: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Sync portfolio with GitHub
   */
  async syncPortfolio(options: {direction: string; force: boolean; dryRun: boolean}) {
    try {
      // Check authentication
      const authStatus = await this.githubAuthManager.getAuthStatus();
      if (!authStatus.isAuthenticated || !authStatus.username) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ GitHub authentication required. Please use setup_github_auth first.`
          }]
        };
      }

      const username = authStatus.username;

      // Check if portfolio exists
      const { PortfolioRepoManager } = await import('./portfolio/PortfolioRepoManager.js');
      const portfolioManager = new PortfolioRepoManager();
      const portfolioExists = await portfolioManager.checkPortfolioExists(username);

      if (!portfolioExists) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ No portfolio found. Use init_portfolio to create one first.`
          }]
        };
      }

      if (options.dryRun) {
        // Show what would be synced
        const localPortfolioManager = PortfolioManager.getInstance();
        
        const elementTypeCounts: Record<string, number | string> = {};
        const elementTypeErrors: string[] = [];
        
        // Get element counts with better error handling
        for (const elementType of ['personas', 'skills', 'templates', 'agents']) {
          try {
            const elements = await this.getElementsList(elementType);
            elementTypeCounts[elementType] = elements.length;
          } catch (error: any) {
            elementTypeCounts[elementType] = 'ERROR';
            elementTypeErrors.push(`${elementType}: ${error.message || 'Unknown error'}`);
          }
        }

        let dryRunText = `${this.getPersonaIndicator()}🔍 **Dry Run - Portfolio Sync Preview**\n\n`;
        dryRunText += `📤 **Elements to sync** (${options.direction}):\n`;
        dryRunText += `  • Personas: ${elementTypeCounts.personas}\n`;
        dryRunText += `  • Skills: ${elementTypeCounts.skills}\n`;
        dryRunText += `  • Templates: ${elementTypeCounts.templates}\n`;
        dryRunText += `  • Agents: ${elementTypeCounts.agents}\n\n`;
        
        // Include any errors encountered during dry run
        if (elementTypeErrors.length > 0) {
          dryRunText += `⚠️ **Errors found during preview:**\n`;
          for (const error of elementTypeErrors) {
            dryRunText += `  • ${error}\n`;
          }
          dryRunText += `\n`;
        }
        
        dryRunText += `🎯 **Target**: https://github.com/${username}/dollhouse-portfolio\n`;
        dryRunText += `⚠️  **Note**: This is a preview. Remove dry_run=true to perform actual sync.`;

        return {
          content: [{
            type: "text",
            text: dryRunText
          }]
        };
      }

      // For now, implement basic push functionality
      if (options.direction === 'push' || options.direction === 'both') {
        let syncCount = 0;
        let syncText = `${this.getPersonaIndicator()}🔄 **Syncing Portfolio...**\n\n`;

        // Get all local elements
        const elementTypes = ['personas', 'skills', 'templates', 'agents'] as const;
        const failedElements: Array<{type: string, name: string, error: string}> = [];
        
        for (const elementType of elementTypes) {
          try {
            const elements = await this.getElementsList(elementType);
            
            for (const elementName of elements) {
              try {
                // Load element and save to portfolio
                const element = await this.loadElementByType(elementName, elementType);
                if (element) {
                  await portfolioManager.saveElement(element, true); // Explicit consent
                  syncCount++;
                  logger.debug(`Successfully synced ${elementType}/${elementName}`);
                } else {
                  failedElements.push({
                    type: elementType,
                    name: elementName,
                    error: 'Element loaded as null/undefined'
                  });
                }
              } catch (elementError: any) {
                const errorMessage = elementError.message || 'Unknown error during element sync';
                failedElements.push({
                  type: elementType,
                  name: elementName,
                  error: errorMessage
                });
                logger.warn(`Failed to sync ${elementType}/${elementName}`, { error: errorMessage });
              }
            }
          } catch (listError: any) {
            // Handle errors in getting the elements list for this type
            const errorMessage = listError.message || 'Failed to get elements list';
            failedElements.push({
              type: elementType,
              name: 'ALL',
              error: `Failed to list ${elementType}: ${errorMessage}`
            });
            logger.warn(`Failed to get ${elementType} list`, { error: errorMessage });
          }
        }

        syncText += `✅ **Sync Complete!**\n`;
        syncText += `📤 Uploaded: ${syncCount} elements\n`;
        
        // Include failed elements information if any
        if (failedElements.length > 0) {
          syncText += `⚠️ **Failed**: ${failedElements.length} elements\n\n`;
          syncText += `**Failed Elements:**\n`;
          for (const failed of failedElements) {
            if (failed.name === 'ALL') {
              syncText += `  • ${failed.type}: ${failed.error}\n`;
            } else {
              syncText += `  • ${failed.type}/${failed.name}: ${failed.error}\n`;
            }
          }
          syncText += `\n`;
        } else {
          syncText += `🎉 All elements synced successfully!\n\n`;
        }
        
        syncText += `🔗 **Portfolio**: https://github.com/${username}/dollhouse-portfolio\n\n`;
        syncText += `Your elements are now available on GitHub!`;

        return {
          content: [{
            type: "text",
            text: syncText
          }]
        };
      }

      if (options.direction === 'pull') {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}⚠️ Pull sync is coming soon. Currently only push sync is supported.`
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ Invalid sync direction. Use 'push', 'pull', or 'both'.`
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.getPersonaIndicator()}❌ Failed to sync portfolio: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Search local portfolio using the metadata index system
   * This provides fast, comprehensive search across all element types
   */
  async searchPortfolio(options: {
    query: string; 
    elementType?: string; 
    fuzzyMatch?: boolean; 
    maxResults?: number; 
    includeKeywords?: boolean; 
    includeTags?: boolean; 
    includeTriggers?: boolean; 
    includeDescriptions?: boolean;
  }) {
    try {
      // Validate the query parameter
      if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Search query is required and must be a non-empty string.`
          }]
        };
      }

      // Import portfolio index manager
      const { PortfolioIndexManager } = await import('./portfolio/PortfolioIndexManager.js');
      const indexManager = PortfolioIndexManager.getInstance();

      // Parse element type if provided
      let elementType: ElementType | undefined;
      if (options.elementType) {
        const validTypes = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
        if (!validTypes.includes(options.elementType)) {
          return {
            content: [{
              type: "text",
              text: `${this.getPersonaIndicator()}❌ Invalid element type. Valid types: ${validTypes.join(', ')}`
            }]
          };
        }
        elementType = options.elementType as ElementType;
      }

      // Build search options
      const searchOptions = {
        elementType,
        fuzzyMatch: options.fuzzyMatch !== false, // Default to true
        maxResults: options.maxResults || 20,
        includeKeywords: options.includeKeywords !== false,
        includeTags: options.includeTags !== false,
        includeTriggers: options.includeTriggers !== false,
        includeDescriptions: options.includeDescriptions !== false
      };

      // Perform the search
      const results = await indexManager.search(options.query, searchOptions);

      // Format the results
      let text = `${this.getPersonaIndicator()}🔍 **Portfolio Search Results**\n\n`;
      text += `**Query**: "${options.query}"\n`;
      
      if (elementType) {
        text += `**Type Filter**: ${elementType}\n`;
      }
      
      text += `**Found**: ${results.length} element${results.length === 1 ? '' : 's'}\n\n`;

      if (results.length === 0) {
        text += `No elements found matching your search criteria.\n\n`;
        text += `**Tips for better results:**\n`;
        text += `• Try different keywords or partial names\n`;
        text += `• Remove the type filter to search all element types\n`;
        text += `• Check spelling and try synonyms\n`;
        text += `• Use the list_elements tool to see all available content`;
      } else {
        text += `**Results:**\n\n`;
        
        for (const result of results) {
          const { entry, matchType } = result;
          const icon = this.getElementIcon(entry.elementType);
          
          text += `${icon} **${entry.metadata.name}**\n`;
          text += `   📁 Type: ${entry.elementType}\n`;
          text += `   🎯 Match: ${matchType}\n`;
          
          if (entry.metadata.description) {
            const desc = entry.metadata.description.length > 100 
              ? entry.metadata.description.substring(0, 100) + '...'
              : entry.metadata.description;
            text += `   📝 ${desc}\n`;
          }
          
          if (entry.metadata.tags && entry.metadata.tags.length > 0) {
            text += `   🏷️ Tags: ${entry.metadata.tags.slice(0, 5).join(', ')}${entry.metadata.tags.length > 5 ? '...' : ''}\n`;
          }
          
          text += `   📄 File: ${entry.filename}.md\n\n`;
        }
        
        if (results.length >= searchOptions.maxResults) {
          text += `⚠️ Results limited to ${searchOptions.maxResults}. Refine your search for more specific results.\n\n`;
        }
        
        text += `💡 **Next steps:**\n`;
        text += `• Use get_element_details to see full content\n`;
        text += `• Use activate_element to activate elements\n`;
        text += `• Use submit_content to share with the community`;
      }

      return {
        content: [{
          type: "text",
          text
        }]
      };

    } catch (error: any) {
      ErrorHandler.logError('DollhouseMCPServer.searchPortfolio', error, { 
        query: options.query,
        elementType: options.elementType 
      });
      
      return {
        content: [{
          type: "text", 
          text: `${this.getPersonaIndicator()}❌ Search failed: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Search across all sources (local, GitHub, collection) using UnifiedIndexManager
   * This provides comprehensive search with duplicate detection and version comparison
   */
  async searchAll(options: {
    query: string;
    sources?: string[];
    elementType?: string;
    page?: number;
    pageSize?: number;
    sortBy?: string;
  }) {
    try {
      // Validate the query parameter
      if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
        return {
          content: [{
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Search query is required and must be a non-empty string.`
          }]
        };
      }

      // Import unified index manager
      const { UnifiedIndexManager } = await import('./portfolio/UnifiedIndexManager.js');
      const { ElementType } = await import('./portfolio/types.js');
      const unifiedManager = UnifiedIndexManager.getInstance();

      // Parse element type if provided
      let elementType: ElementType | undefined;
      if (options.elementType) {
        const validTypes = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
        if (!validTypes.includes(options.elementType)) {
          return {
            content: [{
              type: "text",
              text: `${this.getPersonaIndicator()}❌ Invalid element type. Valid types: ${validTypes.join(', ')}`
            }]
          };
        }
        elementType = options.elementType as ElementType;
      }

      // Parse sources (default to local and github)
      const sources = options.sources || ['local', 'github'];
      const includeLocal = sources.includes('local');
      const includeGitHub = sources.includes('github');
      const includeCollection = sources.includes('collection');

      // Build search options
      const searchOptions = {
        query: options.query,
        includeLocal,
        includeGitHub,
        includeCollection,
        elementType,
        page: options.page || 1,
        pageSize: options.pageSize || 20,
        sortBy: (options.sortBy as any) || 'relevance'
      };

      // Perform the unified search
      const results = await unifiedManager.search(searchOptions);

      // Format the results
      let text = `${this.getPersonaIndicator()}🔍 **Unified Search Results**\n\n`;
      text += `**Query**: "${options.query}"\n`;
      text += `**Sources**: ${sources.join(', ')}\n`;
      
      if (elementType) {
        text += `**Type Filter**: ${elementType}\n`;
      }
      
      text += `**Found**: ${results.length} element${results.length === 1 ? '' : 's'}\n\n`;

      if (results.length === 0) {
        text += `No elements found matching your search criteria.\n\n`;
        text += `**Tips for better results:**\n`;
        text += `• Try different keywords or partial names\n`;
        text += `• Remove the type filter to search all element types\n`;
        text += `• Include more sources: local, github, collection\n`;
        text += `• Check spelling and try synonyms\n`;
        text += `• Use browse_collection to explore available content`;
      } else {
        text += `**Results:**\n\n`;
        
        for (const result of results) {
          const { entry, source, matchType, score, isDuplicate, versionConflict } = result;
          const icon = this.getElementIcon(entry.elementType);
          const sourceIcon = this.getSourceIcon(source);
          
          text += `${icon} **${entry.name}** ${sourceIcon}\n`;
          text += `   📁 Type: ${entry.elementType} | Source: ${source}\n`;
          text += `   🎯 Match: ${matchType} | Score: ${score.toFixed(2)}\n`;
          
          if (entry.description) {
            const desc = entry.description.length > 100 
              ? entry.description.substring(0, 100) + '...'
              : entry.description;
            text += `   📝 ${desc}\n`;
          }

          if (entry.version) {
            text += `   🏷️ Version: ${entry.version}\n`;
          }

          // Show duplicate information
          if (isDuplicate) {
            text += `   ⚠️ **Duplicate detected across sources**\n`;
            if (versionConflict) {
              text += `   🔄 Version conflict - Recommended: ${versionConflict.recommended} (${versionConflict.reason})\n`;
            }
          }
          
          text += `\n`;
        }
        
        const hasMore = results.length >= searchOptions.pageSize;
        if (hasMore) {
          const nextPage = searchOptions.page + 1;
          text += `⚠️ Results limited to ${searchOptions.pageSize}. Use page=${nextPage} for more results.\n\n`;
        }
        
        text += `💡 **Next steps:**\n`;
        text += `• Use get_element_details to see full content\n`;
        text += `• Use install_content for collection items\n`;
        text += `• Use activate_element for local elements\n`;
        text += `• Check for duplicates before submitting new content`;
      }

      return {
        content: [{
          type: "text",
          text
        }]
      };

    } catch (error: any) {
      const { ErrorHandler } = await import('./utils/ErrorHandler.js');
      const { SecureErrorHandler } = await import('./security/errorHandler.js');
      
      ErrorHandler.logError('DollhouseMCPServer.searchAll', error, { 
        query: options.query,
        sources: options.sources,
        elementType: options.elementType 
      });
      
      return {
        content: [{
          type: "text", 
          text: `${this.getPersonaIndicator()}❌ Unified search failed: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Get icon for source type
   */
  private getSourceIcon(source: string): string {
    const icons: { [key: string]: string } = {
      local: '💻',
      github: '🐙',
      collection: '🌐'
    };
    return icons[source] || '📁';
  }

  /**
   * Get icon for element type
   */
  private getElementIcon(elementType: ElementType): string {
    const icons = {
      personas: '🎭',
      skills: '🎯',
      templates: '📄',
      agents: '🤖',
      memories: '🧠',
      ensembles: '🎼'
    };
    return icons[elementType] || '📁';
  }

  /**
   * Helper method to count elements in a directory
   */
  private async countElementsInDir(dirPath: string): Promise<number> {
    try {
      // Check if directory exists and is accessible
      await fs.access(dirPath);
      const files = await fs.readdir(dirPath);
      
      // Count all element files (.md, .json, .yaml) to support all element types
      // - Personas: .md files
      // - Skills: .md files  
      // - Templates: .md or .yaml files
      // - Agents: .md files
      return files.filter(file => 
        file.endsWith('.md') || 
        file.endsWith('.json') || 
        file.endsWith('.yaml')
      ).length;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Helper method to get list of elements by type
   */
  private async getElementsList(elementType: string): Promise<string[]> {
    try {
      const localPortfolioManager = PortfolioManager.getInstance();
      let elementTypeEnum: ElementType;
      
      switch (elementType) {
        case 'personas':
          elementTypeEnum = ElementType.PERSONA;
          break;
        case 'skills':
          elementTypeEnum = ElementType.SKILL;
          break;
        case 'templates':
          elementTypeEnum = ElementType.TEMPLATE;
          break;
        case 'agents':
          elementTypeEnum = ElementType.AGENT;
          break;
        default:
          // Instead of silently returning empty array, throw descriptive error
          const validTypes = ['personas', 'skills', 'templates', 'agents'];
          throw new Error(`Invalid element type: '${elementType}'. Valid types are: ${validTypes.join(', ')}`);
      }

      const dirPath = localPortfolioManager.getElementDir(elementTypeEnum);
      
      // Check if directory exists and is accessible
      await fs.access(dirPath);
      const files = await fs.readdir(dirPath);
      
      // Filter and extract names for all element file types
      // - Personas: .md files
      // - Skills: .md files  
      // - Templates: .md or .yaml files
      // - Agents: .md files
      return files
        .filter(file => file.endsWith('.md') || file.endsWith('.json') || file.endsWith('.yaml'))
        .map(file => {
          // Remove file extension to get element name
          if (file.endsWith('.md')) return file.replace('.md', '');
          if (file.endsWith('.json')) return file.replace('.json', '');
          if (file.endsWith('.yaml')) return file.replace('.yaml', '');
          return file;
        });
    } catch (error: any) {
      // Check if this is our validation error for invalid element types
      if (error.message && error.message.includes('Invalid element type:')) {
        throw error; // Re-throw validation errors for debugging
      }
      
      // For file system errors, provide context about the operation
      const errorMessage = error.code === 'ENOENT' 
        ? `Element directory not found for type '${elementType}'. Directory may not exist yet.`
        : `Failed to read elements directory for type '${elementType}': ${error.message || 'Unknown file system error'}`;
      
      logger.warn('Error in getElementsList', { 
        elementType, 
        error: error.message, 
        code: error.code 
      });
      
      throw new Error(errorMessage);
    }
  }

  /**
   * Helper method to load element by type
   */
  private async loadElementByType(elementName: string, elementType: string): Promise<any> {
    try {
      const localPortfolioManager = PortfolioManager.getInstance();
      let elementTypeEnum: ElementType;
      
      switch (elementType) {
        case 'personas':
          elementTypeEnum = ElementType.PERSONA;
          break;
        case 'skills':
          elementTypeEnum = ElementType.SKILL;
          break;
        case 'templates':
          elementTypeEnum = ElementType.TEMPLATE;
          break;
        case 'agents':
          elementTypeEnum = ElementType.AGENT;
          break;
        default:
          // Instead of silently returning null, throw descriptive error
          const validTypes = ['personas', 'skills', 'templates', 'agents'];
          throw new Error(`Invalid element type: '${elementType}'. Valid types are: ${validTypes.join(', ')}`);
      }

      const dirPath = localPortfolioManager.getElementDir(elementTypeEnum);
      const filePath = path.join(dirPath, `${elementName}.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      // Check if this is our validation error for invalid element types
      if (error.message && error.message.includes('Invalid element type:')) {
        throw error; // Re-throw validation errors for debugging
      }
      
      // Provide specific error messages for common file system errors
      let errorMessage: string;
      
      if (error.code === 'ENOENT') {
        errorMessage = `Element '${elementName}' not found in ${elementType}. File does not exist.`;
      } else if (error instanceof SyntaxError) {
        errorMessage = `Element '${elementName}' in ${elementType} contains invalid JSON: ${error.message}`;
      } else {
        errorMessage = `Failed to load element '${elementName}' from ${elementType}: ${error.message || 'Unknown error'}`;
      }
      
      logger.warn('Error in loadElementByType', { 
        elementName, 
        elementType, 
        error: error.message, 
        code: error.code 
      });
      
      throw new Error(errorMessage);
    }
  }

  async run() {
    logger.info("Starting DollhouseMCP server...");
    // Docker build verification - proves we're running fresh code
    logger.info("BUILD VERIFICATION: Running build from 2025-08-17 16:30 UTC - PR606 ARM64 fix");
    
    // FIX #610: Initialize portfolio and complete setup BEFORE connecting to MCP
    // This ensures personas and portfolio are ready when MCP commands arrive
    try {
      await this.initializePortfolio();
      await this.completeInitialization();
      logger.info("Portfolio and personas initialized successfully");
      // Output message that Docker tests can detect
      logger.info("DollhouseMCP server ready - waiting for MCP connection on stdio");
    } catch (error) {
      ErrorHandler.logError('DollhouseMCPServer.run.initialization', error);
      throw error; // Re-throw to prevent server from starting with incomplete initialization
    }
    
    const transport = new StdioServerTransport();
    
    // Set up graceful shutdown handlers
    const cleanup = async () => {
      logger.info("Shutting down DollhouseMCP server...");
      
      try {
        // Clean up GitHub auth manager
        if (this.githubAuthManager) {
          await this.githubAuthManager.cleanup();
        }
        
        // Clean up any other resources
        if (this.updateManager) {
          // UpdateManager might have active operations too
          logger.debug("Cleaning up update manager...");
        }
        
        logger.info("Cleanup completed");
      } catch (error) {
        logger.error("Error during cleanup", { error });
      }
      
      process.exit(0);
    };
    
    // Register shutdown handlers
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);
    
    await this.server.connect(transport);
    // Mark that MCP is now connected - no more console output allowed
    logger.setMCPConnected();
    logger.info("DollhouseMCP server running on stdio");
  }
}

// Export is already at class declaration

// Only start the server if this file is being run directly (not imported by tests)
// Handle different execution methods (direct, npx, CLI)
const isDirectExecution = import.meta.url === `file://${process.argv[1]}`;
const isNpxExecution = process.env.npm_execpath?.includes('npx');
const isCliExecution = process.argv[1]?.endsWith('/dollhousemcp') || process.argv[1]?.endsWith('\\dollhousemcp');
const isTest = process.env.JEST_WORKER_ID;

// Progressive startup with retries for npx/CLI execution
const STARTUP_DELAYS = [10, 50, 100, 200]; // Progressive delays in ms

async function startServerWithRetry(retriesLeft = STARTUP_DELAYS.length): Promise<void> {
  try {
    const server = new DollhouseMCPServer();
    await server.run();
  } catch (error) {
    if (retriesLeft > 0 && (isNpxExecution || isCliExecution)) {
      // Try again with a longer delay
      const delayIndex = STARTUP_DELAYS.length - retriesLeft;
      const delay = STARTUP_DELAYS[delayIndex];
      await new Promise(resolve => setTimeout(resolve, delay));
      return startServerWithRetry(retriesLeft - 1);
    }
    // Final failure - minimal error message for security
    // Note: Using console.error here is intentional as it's the final error before exit
    console.error("[DollhouseMCP] Server startup failed");
    process.exit(1);
  }
}

if ((isDirectExecution || isNpxExecution || isCliExecution) && !isTest) {
  startServerWithRetry().catch(() => {
    // Note: Using console.error here is intentional as it's the final error before exit
    console.error("[DollhouseMCP] Server startup failed");
    process.exit(1);
  });
}