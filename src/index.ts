#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import matter from "gray-matter";
import { loadIndicatorConfig, formatIndicator, validateCustomFormat, type IndicatorConfig } from './config/indicator-config.js';

// Import modularized components
import { Persona, PersonaMetadata } from './types/persona.js';
import { APICache } from './cache/APICache.js';
import { validateFilename, validatePath, sanitizeInput, validateContentSize, validateUsername, validateCategory } from './security/InputValidator.js';
import { SECURITY_LIMITS, VALIDATION_PATTERNS } from './security/constants.js';
import { generateAnonymousId, generateUniqueId, slugify } from './utils/filesystem.js';
import { PersonaManager } from './persona/PersonaManager.js';
import { GitHubClient, MarketplaceBrowser, MarketplaceSearch, PersonaDetails, PersonaInstaller, PersonaSubmitter } from './marketplace/index.js';
import { UpdateManager } from './update/index.js';
import { ServerSetup, IToolHandler } from './server/index.js';

// Default personas that should not be modified in place
const DEFAULT_PERSONAS = [
  'business-consultant.md',
  'creative-writer.md',
  'debug-detective.md',
  'eli5-explainer.md',
  'technical-analyst.md'
];


export class DollhouseMCPServer implements IToolHandler {
  private server: Server;
  private personasDir: string;
  private personas: Map<string, Persona> = new Map();
  private activePersona: string | null = null;
  private currentUser: string | null = null;
  private apiCache: APICache = new APICache();
  private rateLimitTracker = new Map<string, number[]>();
  private indicatorConfig: IndicatorConfig;
  private personaManager: PersonaManager;
  private githubClient: GitHubClient;
  private marketplaceBrowser: MarketplaceBrowser;
  private marketplaceSearch: MarketplaceSearch;
  private personaDetails: PersonaDetails;
  private personaInstaller: PersonaInstaller;
  private personaSubmitter: PersonaSubmitter;
  private updateManager: UpdateManager;
  private serverSetup: ServerSetup;

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

    // Use environment variable if set, otherwise default to personas subdirectory relative to current working directory
    this.personasDir = process.env.PERSONAS_DIR || path.join(process.cwd(), "personas");
    
    // Load user identity from environment variables
    this.currentUser = process.env.DOLLHOUSE_USER || null;
    
    // Load indicator configuration
    this.indicatorConfig = loadIndicatorConfig();
    
    // Initialize persona manager
    this.personaManager = new PersonaManager(this.personasDir, this.indicatorConfig);
    
    // Initialize marketplace modules
    this.githubClient = new GitHubClient(this.apiCache, this.rateLimitTracker);
    this.marketplaceBrowser = new MarketplaceBrowser(this.githubClient);
    this.marketplaceSearch = new MarketplaceSearch(this.githubClient);
    this.personaDetails = new PersonaDetails(this.githubClient);
    this.personaInstaller = new PersonaInstaller(this.githubClient, this.personasDir);
    this.personaSubmitter = new PersonaSubmitter();
    
    // Initialize update manager
    this.updateManager = new UpdateManager();
    
    // Initialize server setup
    this.serverSetup = new ServerSetup();
    this.serverSetup.setupServer(this.server, this);
    
    this.loadPersonas();
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

  private async loadPersonas() {
    try {
      await fs.access(this.personasDir);
    } catch {
      // Create personas directory if it doesn't exist
      await fs.mkdir(this.personasDir, { recursive: true });
      console.error(`Created personas directory at: ${this.personasDir}`);
      return;
    }

    try {
      const files = await fs.readdir(this.personasDir);
      const markdownFiles = files.filter(file => file.endsWith('.md'));

      this.personas.clear();

      for (const file of markdownFiles) {
        try {
          const filePath = path.join(this.personasDir, file);
          const fileContent = await fs.readFile(filePath, 'utf-8');
          const parsed = matter(fileContent);
          
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
            console.error(`Generated unique ID for ${metadata.name}: ${uniqueId}`);
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
          console.error(`Loaded persona: ${metadata.name} (${uniqueId})`);
        } catch (error) {
          console.error(`Error loading persona ${file}: ${error}`);
        }
      }
    } catch (error) {
      console.error(`Error reading personas directory: ${error}`);
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

  // checkRateLimit and fetchFromGitHub are now handled by GitHubClient

  async browseMarketplace(category?: string) {
    try {
      const { items, categories } = await this.marketplaceBrowser.browseMarketplace(category);
      const text = this.marketplaceBrowser.formatBrowseResults(items, categories, category, this.getPersonaIndicator());
      
      return {
        content: [
          {
            type: "text",
            text: text,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Error browsing marketplace: ${error}`,
          },
        ],
      };
    }
  }

  async searchMarketplace(query: string) {
    try {
      const items = await this.marketplaceSearch.searchMarketplace(query);
      const text = this.marketplaceSearch.formatSearchResults(items, query, this.getPersonaIndicator());
      
      return {
        content: [
          {
            type: "text",
            text: text,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Error searching marketplace: ${error}`,
          },
        ],
      };
    }
  }

  async getMarketplacePersona(path: string) {
    try {
      const { metadata, content } = await this.personaDetails.getMarketplacePersona(path);
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
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Error fetching persona: ${error}`,
          },
        ],
      };
    }
  }

  async installPersona(inputPath: string) {
    try {
      const result = await this.personaInstaller.installPersona(inputPath);
      
      if (!result.success) {
        return {
          content: [
            {
              type: "text",
              text: `${this.getPersonaIndicator()}⚠️ ${result.message}`,
            },
          ],
        };
      }
      
      // Reload personas to include the new one
      await this.loadPersonas();
      
      const text = this.personaInstaller.formatInstallSuccess(
        result.metadata!, 
        result.filename!, 
        this.personas.size, 
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
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Error installing persona: ${error}`,
          },
        ],
      };
    }
  }

  async submitPersona(personaIdentifier: string) {
    // Find the persona in local collection
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
            text: `${this.getPersonaIndicator()}❌ Persona not found: ${personaIdentifier}`,
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
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Validation Error**\n\n` +
              `${error}\n\n` +
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

      // Generate metadata
      const author = this.getCurrentUserForAttribution();
      const uniqueId = generateUniqueId(sanitizedName, this.currentUser || undefined);
      const filename = validateFilename(`${slugify(sanitizedName)}.md`);
      const filePath = path.join(this.personasDir, filename);

    // Check if file already exists
    try {
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
      // Write the file
      await fs.writeFile(filePath, personaContent, 'utf-8');
      
      // Reload personas to include the new one
      await this.loadPersonas();

      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}✅ **Persona Created Successfully!**\n\n` +
              `🎭 **${name}** by ${author}\n` +
              `📁 Category: ${category}\n` +
              `🆔 Unique ID: ${uniqueId}\n` +
              `📄 Saved as: ${filename}\n` +
              `📊 Total personas: ${this.personas.size}\n\n` +
              `🎯 **Ready to use:** \`activate_persona "${name}"\`\n` +
              `📤 **Share it:** \`submit_persona "${name}"\`\n` +
              `✏️ **Edit it:** \`edit_persona "${name}" "field" "new value"\``,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Error Creating Persona**\n\n` +
              `Failed to write persona file: ${error}\n\n` +
              `Please check permissions and try again.`,
          },
        ],
      };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Validation Error**\n\n` +
              `${error}\n\n` +
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
    let isDefaultPersona = DEFAULT_PERSONAS.includes(persona.filename);

    try {
      // Read current file
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const parsed = matter(fileContent);
      
      // If editing a default persona, create a copy instead
      if (isDefaultPersona) {
        // Generate unique ID for the copy
        const author = this.currentUser || generateAnonymousId();
        const uniqueId = generateUniqueId(persona.metadata.name, author);
        const newFilename = `${uniqueId}.md`;
        const newFilePath = path.join(this.personasDir, newFilename);
        
        // Create copy of the default persona
        await fs.copyFile(filePath, newFilePath);
        
        // Update file path to point to the copy
        filePath = newFilePath;
        
        // Update the unique_id in the metadata
        parsed.data.unique_id = uniqueId;
        parsed.data.author = author;
      }
      
      // Update the appropriate field
      const normalizedField = field.toLowerCase();
      
      if (normalizedField === 'instructions') {
        // Update the main content
        parsed.content = value;
      } else if (normalizedField === 'triggers') {
        // Parse triggers as comma-separated list
        parsed.data[normalizedField] = value.split(',').map(t => t.trim()).filter(t => t.length > 0);
      } else if (normalizedField === 'category') {
        // Validate category
        const validCategories = ['creative', 'professional', 'educational', 'gaming', 'personal'];
        if (!validCategories.includes(value.toLowerCase())) {
          return {
            content: [
              {
                type: "text",
                text: `${this.getPersonaIndicator()}❌ **Invalid Category**\n\n` +
                    `Category must be one of: ${validCategories.join(', ')}\n` +
                    `You provided: "${value}"`,
              },
            ],
          };
        }
        parsed.data[normalizedField] = value.toLowerCase();
      } else {
        // Update metadata field
        parsed.data[normalizedField] = value;
      }

      // Update version and modification info
      if (normalizedField !== 'version') {
        const currentVersion = parsed.data.version || '1.0';
        const versionParts = currentVersion.split('.').map(Number);
        versionParts[1] = (versionParts[1] || 0) + 1;
        parsed.data.version = versionParts.join('.');
      }

      // Regenerate file content
      const updatedContent = matter.stringify(parsed.content, parsed.data);
      
      // Write updated file
      await fs.writeFile(filePath, updatedContent, 'utf-8');
      
      // Reload personas
      await this.loadPersonas();

      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}✅ **Persona Updated Successfully!**\n\n` +
              (isDefaultPersona ? `📋 **Note:** Created a copy of the default persona to preserve the original.\n\n` : '') +
              `🎭 **${parsed.data.name || persona.metadata.name}**\n` +
              `📝 **Field Updated:** ${field}\n` +
              `🔄 **New Value:** ${normalizedField === 'instructions' ? 'Content updated' : value}\n` +
              `📊 **Version:** ${parsed.data.version}\n` +
              (isDefaultPersona ? `🆔 **New ID:** ${parsed.data.unique_id}\n` : '') +
              `\n` +
              `Use \`get_persona_details "${parsed.data.name || persona.metadata.name}"\` to see all changes.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Error Updating Persona**\n\n` +
              `Failed to update persona: ${error}\n\n` +
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
            text: `${this.getPersonaIndicator()}❌ Error configuring indicator: ${error instanceof Error ? error.message : String(error)}`
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


  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("DollhouseMCP server running on stdio");
  }
}

// Export is already at class declaration

const server = new DollhouseMCPServer();
server.run().catch(console.error);