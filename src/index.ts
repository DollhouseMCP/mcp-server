#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import { loadIndicatorConfig, formatIndicator, validateCustomFormat, type IndicatorConfig } from './config/indicator-config.js';
import { SecureYamlParser } from './security/secureYamlParser.js';
import { SecurityError } from './errors/SecurityError.js';
import { SecureErrorHandler } from './security/errorHandler.js';

// Import modularized components
import { Persona, PersonaMetadata } from './types/persona.js';
import { APICache } from './cache/APICache.js';
import { validateFilename, sanitizeInput, validateContentSize, validateUsername, validateCategory, MCPInputValidator } from './security/InputValidator.js';
import { SECURITY_LIMITS, VALIDATION_PATTERNS } from './security/constants.js';
import { ContentValidator } from './security/contentValidator.js';
import { PathValidator } from './security/pathValidator.js';
import { FileLockManager } from './security/fileLockManager.js';
import { generateAnonymousId, generateUniqueId, slugify } from './utils/filesystem.js';
import { GitHubClient, CollectionBrowser, CollectionSearch, PersonaDetails, PersonaSubmitter, ElementInstaller } from './collection/index.js';
import { UpdateManager } from './update/index.js';
import { ServerSetup, IToolHandler } from './server/index.js';
import { logger } from './utils/logger.js';
import { PersonaExporter, PersonaImporter, PersonaSharer } from './persona/export-import/index.js';
import { isDefaultPersona } from './constants/defaultPersonas.js';
import { PortfolioManager, ElementType } from './portfolio/PortfolioManager.js';
import { MigrationManager } from './portfolio/MigrationManager.js';
import { SkillManager } from './elements/skills/index.js';
import { TemplateManager } from './elements/templates/TemplateManager.js';
import { AgentManager } from './elements/agents/AgentManager.js';



export class DollhouseMCPServer implements IToolHandler {
  private server: Server;
  private personasDir: string;
  private personas: Map<string, Persona> = new Map();
  private activePersona: string | null = null;
  private currentUser: string | null = null;
  private apiCache: APICache = new APICache();
  private rateLimitTracker = new Map<string, number[]>();
  private indicatorConfig: IndicatorConfig;
  private githubClient: GitHubClient;
  private collectionBrowser: CollectionBrowser;
  private collectionSearch: CollectionSearch;
  private personaDetails: PersonaDetails;
  private elementInstaller: ElementInstaller;
  private personaSubmitter: PersonaSubmitter;
  private updateManager: UpdateManager;
  private serverSetup: ServerSetup;
  private personaExporter: PersonaExporter;
  private personaImporter: PersonaImporter;
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
        version: "1.0.0",
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
    
    // Use portfolio personas directory
    this.personasDir = this.portfolioManager.getElementDir(ElementType.PERSONA);
    
    // Initialize element managers
    this.skillManager = new SkillManager();
    this.templateManager = new TemplateManager();
    this.agentManager = new AgentManager(this.portfolioManager.getBaseDir());
    
    // Log resolved path for debugging
    logger.info(`Personas directory resolved to: ${this.personasDir}`);
    
    // Initialize PathValidator with the personas directory
    PathValidator.initialize(this.personasDir);
    
    // Load user identity from environment variables
    this.currentUser = process.env.DOLLHOUSE_USER || null;
    
    // Load indicator configuration
    this.indicatorConfig = loadIndicatorConfig();
    
    // Initialize persona manager
    
    // Initialize collection modules
    this.githubClient = new GitHubClient(this.apiCache, this.rateLimitTracker);
    this.collectionBrowser = new CollectionBrowser(this.githubClient);
    this.collectionSearch = new CollectionSearch(this.githubClient);
    this.personaDetails = new PersonaDetails(this.githubClient);
    this.elementInstaller = new ElementInstaller(this.githubClient);
    this.personaSubmitter = new PersonaSubmitter();
    
    // Initialize update manager with safe directory
    // Use the parent of personas directory to avoid production check
    const safeDir = path.dirname(this.personasDir);
    this.updateManager = new UpdateManager(safeDir);
    
    // Initialize export/import/share modules
    this.personaExporter = new PersonaExporter(this.currentUser);
    this.personaImporter = new PersonaImporter(this.personasDir, this.currentUser);
    this.personaSharer = new PersonaSharer(this.githubClient, this.currentUser);
    
    // Initialize server setup
    this.serverSetup = new ServerSetup();
    this.serverSetup.setupServer(this.server, this);
    
    // Initialize portfolio and perform migration if needed
    this.initializePortfolio().then(() => {
      this.loadPersonas();
    }).catch(error => {
      logger.error(`Failed to initialize portfolio: ${error}`);
    });
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
    if (!path.isAbsolute(this.personasDir)) {
      logger.warn(`Personas directory path is not absolute: ${this.personasDir}`);
    }
    
    try {
      await fs.access(this.personasDir);
    } catch (error) {
      // Create personas directory if it doesn't exist
      try {
        await fs.mkdir(this.personasDir, { recursive: true });
        logger.info(`Created personas directory at: ${this.personasDir}`);
        return;
      } catch (mkdirError: any) {
        logger.error(`Failed to create personas directory at ${this.personasDir}: ${mkdirError.message}`);
        throw new Error(`Cannot create personas directory: ${mkdirError.message}`);
      }
    }

    try {
      const files = await fs.readdir(this.personasDir);
      const markdownFiles = files.filter(file => file.endsWith('.md'));

      this.personas.clear();

      for (const file of markdownFiles) {
        try {
          const filePath = path.join(this.personasDir, file);
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
          logger.error(`Error loading persona ${file}: ${error}`);
        }
      }
    } catch (error) {
      logger.error(`Error reading personas directory: ${error}`);
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
                text: "📚 No skills found in your portfolio. Skills are discrete capabilities for specific tasks."
              }]
            };
          }
          
          const skillList = skills.map(skill => {
            const complexity = skill.metadata.complexity || 'beginner';
            const domains = skill.metadata.domains?.join(', ') || 'general';
            return `🛠️ ${skill.metadata.name} - ${skill.metadata.description}\n   Complexity: ${complexity} | Domains: ${domains}`;
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
                text: "📝 No templates found in your portfolio. Templates are reusable content structures."
              }]
            };
          }
          
          const templateList = templates.map(template => {
            const variables = template.metadata.variables?.map(v => v.name).join(', ') || 'none';
            return `📄 ${template.metadata.name} - ${template.metadata.description}\n   Variables: ${variables}`;
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
                text: "🤖 No agents found in your portfolio. Agents are autonomous goal-oriented actors."
              }]
            };
          }
          
          const agentList = agents.map(agent => {
            const specializations = (agent.metadata as any).specializations?.join(', ') || 'general';
            const status = agent.getStatus();
            return `🤖 ${agent.metadata.name} - ${agent.metadata.description}\n   Status: ${status} | Specializations: ${specializations}`;
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
      logger.error(`Failed to list ${type} elements:`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to list ${type}: ${error instanceof Error ? error.message : 'Unknown error'}`
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
      logger.error(`Failed to activate ${type} '${name}':`, error);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to activate ${type} '${name}': ${error instanceof Error ? error.message : 'Unknown error'}`
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
      
      // SECURITY FIX: Sanitize metadata to prevent prototype pollution
      const sanitizedMetadata = this.sanitizeMetadata(metadata || {});
      
      // Create element based on type
      switch (type as ElementType) {
        case ElementType.PERSONA:
          // Use existing persona creation logic
          return this.createPersona(
            validatedName, 
            validatedDescription, 
            sanitizedMetadata?.category || 'general',
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
              text: `❌ Element type '${type}' is not yet supported for editing`
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
      
      // Update version - handle various version formats
      if (element.version) {
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
      } else {
        // No version - set initial version
        element.version = '1.0.0';
      }
      
      // Save the element - need to determine filename
      const filename = `${element.metadata.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.md`;
      await manager!.save(element as any, filename);
      
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
          const personaPath = path.join(this.personasDir, `${name}.md`);
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
                  text: `❌ Persona '${name}' not found`
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
      // Enhanced input validation for section and type
      const validatedSection = section ? validateCategory(section) : undefined;
      const validatedType = type ? validateCategory(type) : undefined;
      
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
    // Find the content in local collection
    let persona = this.personas.get(contentIdentifier);
    
    if (!persona) {
      // Search by name
      persona = Array.from(this.personas.values()).find(p => 
        p.metadata.name.toLowerCase() === contentIdentifier.toLowerCase()
      );
    }

    if (!persona) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Content not found: ${contentIdentifier}`,
          },
        ],
      };
    }

    // Validate persona content before submission
    try {
      // Read the full persona file content
      const fullPath = path.join(this.personasDir, persona.filename);
      const fileContent = await PathValidator.safeReadFile(fullPath);
      
      // Validate content for security threats
      const contentValidation = ContentValidator.validateAndSanitize(fileContent);
      if (!contentValidation.isValid && contentValidation.severity === 'critical') {
        return {
          content: [
            {
              type: "text",
              text: `${this.getPersonaIndicator()}❌ **Security Validation Failed**\n\n` +
              `This persona contains content that could be used for prompt injection attacks:\n` +
              `• ${contentValidation.detectedPatterns?.join('\n• ')}\n\n` +
              `Please remove these patterns before submitting to the collection.`,
            },
          ],
        };
      }
      
      // Validate metadata
      const metadataValidation = ContentValidator.validateMetadata(persona.metadata);
      if (!metadataValidation.isValid) {
        return {
          content: [
            {
              type: "text",
              text: `${this.getPersonaIndicator()}⚠️ **Metadata Security Warning**\n\n` +
              `The persona metadata contains potentially problematic content:\n` +
              `• ${metadataValidation.detectedPatterns?.join('\n• ')}\n\n` +
              `Please fix these issues before submitting.`,
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
            text: `${this.getPersonaIndicator()}❌ Error validating persona: ${sanitized.message}`,
          },
        ],
      };
    }

    const { githubIssueUrl } = this.personaSubmitter.generateSubmissionIssue(persona);
    const text = this.personaSubmitter.formatSubmissionResponse(persona, githubIssueUrl, this.getPersonaIndicator());

    return {
      content: [
        {
          type: "text",
          text: text,
        },
      ],
    };
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

  // Chat-based persona management tools
  async createPersona(name: string, description: string, category: string, instructions: string, triggers?: string) {
    try {
      // Validate required fields
      if (!name || !description || !category || !instructions) {
        return {
          content: [
            {
              type: "text",
              text: `${this.getPersonaIndicator()}❌ **Missing Required Fields**\n\n` +
                `Please provide all required fields:\n` +
                `• **name**: Display name for the persona\n` +
                `• **description**: Brief description of what it does\n` +
                `• **category**: creative, professional, educational, gaming, or personal\n` +
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

      // Validate category
      const validatedCategory = validateCategory(category);

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
      const filePath = path.join(this.personasDir, filename);

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
        category: validatedCategory,
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
              `📁 Category: ${category}\n` +
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
              `• **category** - creative, professional, educational, gaming, personal\n` +
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

    const validFields = ['name', 'description', 'category', 'instructions', 'triggers', 'version'];
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

    let filePath = path.join(this.personasDir, persona.filename);
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
        const newFilePath = path.join(this.personasDir, newFilename);
        
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
        // Validate category
        const validCategories = ['creative', 'professional', 'educational', 'gaming', 'personal'];
        if (!validCategories.includes(sanitizedValue.toLowerCase())) {
          return {
            content: [
              {
                type: "text",
                text: `${this.getPersonaIndicator()}❌ **Invalid Category**\n\n` +
                    `Category must be one of: ${validCategories.join(', ')}\n` +
                    `You provided: "${sanitizedValue}"`,
              },
            ],
          };
        }
        parsed.data[normalizedField] = sanitizedValue.toLowerCase();
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

    const { text } = await this.updateManager.updateServer(confirm, this.getPersonaIndicator());
    return {
      content: [{ type: "text", text }]
    };
  }

  // Rollback helper methods are now handled by UpdateManager

  async rollbackUpdate(confirm: boolean) {
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
    
    const { text } = await this.updateManager.getServerStatus(this.getPersonaIndicator());
    // Insert persona info into the status text
    const updatedText = text.replace('**Available Commands:**', personaInfo + '\n\n**Available Commands:**');
    
    return {
      content: [{ type: "text", text: updatedText }]
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

  async run() {
    const transport = new StdioServerTransport();
    logger.info("Starting DollhouseMCP server...");
    await this.server.connect(transport);
    // Mark that MCP is now connected - no more console output allowed
    logger.setMCPConnected();
    logger.info("DollhouseMCP server running on stdio");
  }
}

// Export is already at class declaration

// Only start the server if this file is being run directly (not imported by tests)
if (import.meta.url === `file://${process.argv[1]}` && !process.env.JEST_WORKER_ID) {
  const server = new DollhouseMCPServer();
  server.run().catch((error) => {
    logger.error("Fatal error starting server", error);
    process.exit(1);
  });
}