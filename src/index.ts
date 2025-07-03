#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as child_process from "child_process";
import { promisify } from "util";
import matter from "gray-matter";
import { fileURLToPath } from "url";

const exec = promisify(child_process.exec);

// Helper function for safe command execution
function safeExec(command: string, args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
      }
    });
    
    proc.on('error', (error) => {
      reject(error);
    });
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repository configuration constants
const REPO_OWNER = 'mickdarling';
const REPO_NAME = 'DollhouseMCP';
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
const RELEASES_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

interface PersonaMetadata {
  name: string;
  description: string;
  unique_id?: string;
  author?: string;
  triggers?: string[];
  version?: string;
  category?: string;
  age_rating?: 'all' | '13+' | '18+';
  content_flags?: string[];
  ai_generated?: boolean;
  generation_method?: 'human' | 'ChatGPT' | 'Claude' | 'hybrid';
  price?: string;
  revenue_split?: string;
  license?: string;
  created_date?: string;
}

interface Persona {
  metadata: PersonaMetadata;
  content: string;
  filename: string;
  unique_id: string;
}

// Anonymous ID generation
const ADJECTIVES = ['clever', 'swift', 'bright', 'bold', 'wise', 'calm', 'keen', 'witty', 'sharp', 'cool'];
const ANIMALS = ['fox', 'owl', 'cat', 'wolf', 'bear', 'hawk', 'deer', 'lion', 'eagle', 'tiger'];

function generateAnonymousId(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const random = Math.random().toString(36).substring(2, 6);
  return `anon-${adjective}-${animal}-${random}`;
}

function generateUniqueId(personaName: string, author?: string): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const whatItIs = personaName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const whoMadeIt = author || generateAnonymousId();
  
  return `${whatItIs}_${dateStr}-${timeStr}_${whoMadeIt}`;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

class DollhouseMCPServer {
  private server: Server;
  private personasDir: string;
  private personas: Map<string, Persona> = new Map();
  private activePersona: string | null = null;
  private currentUser: string | null = null;

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

    // Use environment variable if set, otherwise default to personas subdirectory relative to this script
    this.personasDir = process.env.PERSONAS_DIR || path.join(__dirname, "..", "personas");
    
    // Load user identity from environment variables
    this.currentUser = process.env.DOLLHOUSE_USER || null;
    
    this.setupHandlers();
    this.loadPersonas();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "list_personas",
            description: "List all available personas",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "activate_persona",
            description: "Activate a specific persona by name or filename",
            inputSchema: {
              type: "object",
              properties: {
                persona: {
                  type: "string",
                  description: "The persona name or filename to activate",
                },
              },
              required: ["persona"],
            },
          },
          {
            name: "get_active_persona",
            description: "Get information about the currently active persona",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "deactivate_persona",
            description: "Deactivate the current persona",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "get_persona_details",
            description: "Get detailed information about a specific persona",
            inputSchema: {
              type: "object",
              properties: {
                persona: {
                  type: "string",
                  description: "The persona name or filename to get details for",
                },
              },
              required: ["persona"],
            },
          },
          {
            name: "reload_personas",
            description: "Reload all personas from the personas directory",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "browse_marketplace",
            description: "Browse personas from the DollhouseMCP marketplace by category",
            inputSchema: {
              type: "object",
              properties: {
                category: {
                  type: "string",
                  description: "Category to browse (creative, professional, educational, gaming, personal)",
                },
              },
            },
          },
          {
            name: "search_marketplace",
            description: "Search for personas in the marketplace by keywords",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Search query for finding personas",
                },
              },
              required: ["query"],
            },
          },
          {
            name: "get_marketplace_persona",
            description: "Get detailed information about a persona from the marketplace",
            inputSchema: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "The marketplace path to the persona (e.g., 'creative/storyteller_20250701_alice.md')",
                },
              },
              required: ["path"],
            },
          },
          {
            name: "install_persona",
            description: "Install a persona from the marketplace to your local collection",
            inputSchema: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "The marketplace path to the persona to install",
                },
              },
              required: ["path"],
            },
          },
          {
            name: "submit_persona",
            description: "Submit a persona to the marketplace for community review",
            inputSchema: {
              type: "object",
              properties: {
                persona: {
                  type: "string",
                  description: "The persona name or filename to submit",
                },
              },
              required: ["persona"],
            },
          },
          {
            name: "set_user_identity",
            description: "Set your user identity for persona creation and attribution",
            inputSchema: {
              type: "object",
              properties: {
                username: {
                  type: "string",
                  description: "Your username for persona attribution",
                },
                email: {
                  type: "string",
                  description: "Your email (optional, for contact)",
                },
              },
              required: ["username"],
            },
          },
          {
            name: "get_user_identity",
            description: "Get your current user identity",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "clear_user_identity",
            description: "Clear your user identity (return to anonymous mode)",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "create_persona",
            description: "Create a new persona through guided chat interface",
            inputSchema: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The name for the new persona",
                },
                description: {
                  type: "string",
                  description: "Brief description of what this persona does",
                },
                category: {
                  type: "string",
                  description: "Category (creative, professional, educational, gaming, personal)",
                },
                instructions: {
                  type: "string",
                  description: "The persona's behavioral instructions and guidelines",
                },
                triggers: {
                  type: "string",
                  description: "Comma-separated list of trigger keywords (optional)",
                },
              },
              required: ["name", "description", "category", "instructions"],
            },
          },
          {
            name: "edit_persona",
            description: "Edit an existing persona's metadata or content",
            inputSchema: {
              type: "object",
              properties: {
                persona: {
                  type: "string",
                  description: "The persona name or filename to edit",
                },
                field: {
                  type: "string",
                  description: "Field to edit: name, description, category, instructions, triggers, version",
                },
                value: {
                  type: "string",
                  description: "New value for the field",
                },
              },
              required: ["persona", "field", "value"],
            },
          },
          {
            name: "validate_persona",
            description: "Validate a persona's format and metadata",
            inputSchema: {
              type: "object",
              properties: {
                persona: {
                  type: "string",
                  description: "The persona name or filename to validate",
                },
              },
              required: ["persona"],
            },
          },
          {
            name: "check_for_updates",
            description: "Check GitHub releases for available DollhouseMCP updates",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "update_server",
            description: "Update DollhouseMCP server to the latest version",
            inputSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "boolean",
                  description: "Confirm you want to proceed with the update",
                },
              },
              required: ["confirm"],
            },
          },
          {
            name: "rollback_update",
            description: "Rollback to the previous version of DollhouseMCP",
            inputSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "boolean",
                  description: "Confirm you want to rollback to the previous version",
                },
              },
              required: ["confirm"],
            },
          },
          {
            name: "get_server_status",
            description: "Get current DollhouseMCP server version and status information",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "list_personas":
            return await this.listPersonas();
          case "activate_persona":
            return await this.activatePersona((args as any)?.persona as string);
          case "get_active_persona":
            return await this.getActivePersona();
          case "deactivate_persona":
            return await this.deactivatePersona();
          case "get_persona_details":
            return await this.getPersonaDetails((args as any)?.persona as string);
          case "reload_personas":
            return await this.reloadPersonas();
          case "browse_marketplace":
            return await this.browseMarketplace((args as any)?.category as string);
          case "search_marketplace":
            return await this.searchMarketplace((args as any)?.query as string);
          case "get_marketplace_persona":
            return await this.getMarketplacePersona((args as any)?.path as string);
          case "install_persona":
            return await this.installPersona((args as any)?.path as string);
          case "submit_persona":
            return await this.submitPersona((args as any)?.persona as string);
          case "set_user_identity":
            return await this.setUserIdentity((args as any)?.username as string, (args as any)?.email as string);
          case "get_user_identity":
            return await this.getUserIdentity();
          case "clear_user_identity":
            return await this.clearUserIdentity();
          case "create_persona":
            return await this.createPersona(
              (args as any)?.name as string,
              (args as any)?.description as string,
              (args as any)?.category as string,
              (args as any)?.instructions as string,
              (args as any)?.triggers as string
            );
          case "edit_persona":
            return await this.editPersona(
              (args as any)?.persona as string,
              (args as any)?.field as string,
              (args as any)?.value as string
            );
          case "validate_persona":
            return await this.validatePersona((args as any)?.persona as string);
          case "check_for_updates":
            return await this.checkForUpdates();
          case "update_server":
            return await this.updateServer((args as any)?.confirm as boolean);
          case "rollback_update":
            return await this.rollbackUpdate((args as any)?.confirm as boolean);
          case "get_server_status":
            return await this.getServerStatus();
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing tool ${name}: ${error}`
        );
      }
    });
  }

  private getPersonaIndicator(): string {
    if (!this.activePersona) {
      return "";
    }

    const persona = this.personas.get(this.activePersona);
    if (!persona) {
      return "";
    }

    return `🎭 ${persona.metadata.name} | `;
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

  private async listPersonas() {
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

  private async activatePersona(personaIdentifier: string) {
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

  private async getActivePersona() {
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

  private async deactivatePersona() {
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

  private async getPersonaDetails(personaIdentifier: string) {
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

  private async reloadPersonas() {
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

  // GitHub API marketplace integration
  private async fetchFromGitHub(url: string): Promise<any> {
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'DollhouseMCP/1.0'
        }
      });
      
      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch from GitHub: ${error}`
      );
    }
  }

  private async browseMarketplace(category?: string) {
    const baseUrl = 'https://api.github.com/repos/mickdarling/DollhouseMCP-Personas/contents/personas';
    const url = category ? `${baseUrl}/${category}` : baseUrl;
    
    try {
      const data = await this.fetchFromGitHub(url);
      
      if (!Array.isArray(data)) {
        return {
          content: [
            {
              type: "text",
              text: `${this.getPersonaIndicator()}❌ Invalid marketplace response. Expected directory listing.`,
            },
          ],
        };
      }

      const items = data.filter((item: any) => item.type === 'file' && item.name.endsWith('.md'));
      const categories = data.filter((item: any) => item.type === 'dir');

      const textParts = [`${this.getPersonaIndicator()}🏪 **DollhouseMCP Marketplace**\n\n`];
      
      if (!category) {
        textParts.push(`**📁 Categories (${categories.length}):**\n`);
        categories.forEach((cat: any) => {
          textParts.push(`   📂 **${cat.name}** - Browse with: \`browse_marketplace "${cat.name}"\`\n`);
        });
        textParts.push('\n');
      }

      if (items.length > 0) {
        textParts.push(`**🎭 Personas in ${category || 'root'} (${items.length}):**\n`);
        items.forEach((item: any) => {
          const path = category ? `${category}/${item.name}` : item.name;
          textParts.push(
            `   ▫️ **${item.name}**\n`,
            `      📥 Install: \`install_persona "${path}"\`\n`,
            `      👁️ Details: \`get_marketplace_persona "${path}"\`\n\n`
          );
        });
      }

      const text = textParts.join('');

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

  private async searchMarketplace(query: string) {
    const searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:mickdarling/DollhouseMCP-Personas+extension:md`;
    
    try {
      const data = await this.fetchFromGitHub(searchUrl);
      
      if (!data.items || data.items.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${this.getPersonaIndicator()}🔍 No personas found for query: "${query}"`,
            },
          ],
        };
      }

      const textParts = [`${this.getPersonaIndicator()}🔍 **Search Results for "${query}"** (${data.items.length} found)\n\n`];
      
      data.items.forEach((item: any) => {
        const path = item.path.replace('personas/', '');
        textParts.push(
          `   🎭 **${item.name}**\n`,
          `      📂 Path: ${path}\n`,
          `      📥 Install: \`install_persona "${path}"\`\n`,
          `      👁️ Details: \`get_marketplace_persona "${path}"\`\n\n`
        );
      });

      const text = textParts.join('');

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

  private async getMarketplacePersona(path: string) {
    const url = `https://api.github.com/repos/mickdarling/DollhouseMCP-Personas/contents/personas/${path}`;
    
    try {
      const data = await this.fetchFromGitHub(url);
      
      if (data.type !== 'file') {
        throw new Error('Path does not point to a file');
      }

      // Decode Base64 content
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const parsed = matter(content);
      const metadata = parsed.data as PersonaMetadata;

      const textParts = [
        `${this.getPersonaIndicator()}🎭 **Marketplace Persona: ${metadata.name}**\n\n`,
        `**📋 Details:**\n`,
        `   🆔 ID: ${metadata.unique_id || 'Not specified'}\n`,
        `   👤 Author: ${metadata.author || 'Unknown'}\n`,
        `   📁 Category: ${metadata.category || 'General'}\n`,
        `   🔖 Price: ${metadata.price || 'Free'}\n`,
        `   📊 Version: ${metadata.version || '1.0'}\n`,
        `   🔞 Age Rating: ${metadata.age_rating || 'All'}\n`,
        `   ${metadata.ai_generated ? '🤖 AI Generated' : '👤 Human Created'}\n\n`,
        `**📝 Description:**\n${metadata.description}\n\n`
      ];
      
      if (metadata.triggers && metadata.triggers.length > 0) {
        textParts.push(`**🔗 Triggers:** ${metadata.triggers.join(', ')}\n\n`);
      }

      textParts.push(
        `**📥 Installation:**\n`,
        `Use: \`install_persona "${path}"\`\n\n`,
        `**📄 Full Content:**\n\`\`\`\n${parsed.content}\n\`\`\``
      );

      const text = textParts.join('');

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

  private async installPersona(path: string) {
    const url = `https://api.github.com/repos/mickdarling/DollhouseMCP-Personas/contents/personas/${path}`;
    
    try {
      const data = await this.fetchFromGitHub(url);
      
      if (data.type !== 'file') {
        throw new Error('Path does not point to a file');
      }

      // Decode Base64 content
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const parsed = matter(content);
      const metadata = parsed.data as PersonaMetadata;

      // Generate local filename (remove path directories)
      const filename = path.split('/').pop() || 'downloaded-persona.md';
      const localPath = `${this.personasDir}/${filename}`;

      // Check if file already exists
      try {
        await fs.access(localPath);
        return {
          content: [
            {
              type: "text",
              text: `${this.getPersonaIndicator()}⚠️ Persona already exists: ${filename}\n\nUse \`reload_personas\` to refresh if you've updated it manually.`,
            },
          ],
        };
      } catch {
        // File doesn't exist, proceed with installation
      }

      // Write the file
      await fs.writeFile(localPath, content, 'utf-8');
      
      // Reload personas to include the new one
      await this.loadPersonas();

      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}✅ **Persona Installed Successfully!**\n\n` +
            `🎭 **${metadata.name}** by ${metadata.author}\n` +
            `📁 Saved as: ${filename}\n` +
            `📊 Total personas: ${this.personas.size}\n\n` +
            `🎯 **Ready to use:** \`activate_persona "${metadata.name}"\``,
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

  private async submitPersona(personaIdentifier: string) {
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

    // Generate GitHub issue body
    const issueTitle = `New Persona Submission: ${persona.metadata.name}`;
    const issueBody = `## Persona Submission

**Name:** ${persona.metadata.name}
**Author:** ${persona.metadata.author || 'Unknown'}
**Category:** ${persona.metadata.category || 'General'}
**Description:** ${persona.metadata.description}

### Persona Content:
\`\`\`markdown
---
${Object.entries(persona.metadata)
  .map(([key, value]) => `${key}: ${Array.isArray(value) ? JSON.stringify(value) : JSON.stringify(value)}`)
  .join('\n')}
---

${persona.content}
\`\`\`

### Submission Details:
- Submitted via DollhouseMCP client
- Filename: ${persona.filename}
- Unique ID: ${persona.unique_id}

---
*Please review this persona for inclusion in the marketplace.*`;

    const githubIssueUrl = `https://github.com/mickdarling/DollhouseMCP-Personas/issues/new?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(issueBody)}`;

    return {
      content: [
        {
          type: "text",
          text: `${this.getPersonaIndicator()}📤 **Persona Submission Prepared**\n\n` +
          `🎭 **${persona.metadata.name}** is ready for marketplace submission!\n\n` +
          `**Next Steps:**\n` +
          `1. Click this link to create a GitHub issue: \n` +
          `   ${githubIssueUrl}\n\n` +
          `2. Review the pre-filled content\n` +
          `3. Click "Submit new issue"\n` +
          `4. The maintainers will review your submission\n\n` +
          `⭐ **Tip:** You can also submit via pull request if you're familiar with Git!`,
        },
      ],
    };
  }

  // User identity management
  private async setUserIdentity(username: string, email?: string) {
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

    // Validate username format (alphanumeric, dashes, underscores)
    const validUsername = /^[a-zA-Z0-9_-]+$/.test(username);
    if (!validUsername) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ Username can only contain letters, numbers, dashes, and underscores`,
          },
        ],
      };
    }

    this.currentUser = username;

    return {
      content: [
        {
          type: "text",
          text: `${this.getPersonaIndicator()}✅ **User Identity Set**\n\n` +
          `👤 **Username:** ${username}\n` +
          `${email ? `📧 **Email:** ${email}\n` : ''}` +
          `\n🎯 **Next Steps:**\n` +
          `• New personas you create will be attributed to "${username}"\n` +
          `• Set environment variable \`DOLLHOUSE_USER=${username}\` to persist this setting\n` +
          `${email ? `• Set environment variable \`DOLLHOUSE_EMAIL=${email}\` for contact info\n` : ''}` +
          `• Use \`clear_user_identity\` to return to anonymous mode`,
        },
      ],
    };
  }

  private async getUserIdentity() {
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

  private async clearUserIdentity() {
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
  private async createPersona(name: string, description: string, category: string, instructions: string, triggers?: string) {
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

    // Validate category
    const validCategories = ['creative', 'professional', 'educational', 'gaming', 'personal'];
    if (!validCategories.includes(category.toLowerCase())) {
      return {
        content: [
          {
            type: "text",
            text: `${this.getPersonaIndicator()}❌ **Invalid Category**\n\n` +
              `Category must be one of: ${validCategories.join(', ')}\n` +
              `You provided: "${category}"`,
          },
        ],
      };
    }

    // Generate metadata
    const author = this.getCurrentUserForAttribution();
    const uniqueId = generateUniqueId(name, this.currentUser || undefined);
    const filename = `${slugify(name)}.md`;
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

    // Parse triggers
    const triggerList = triggers ? 
      triggers.split(',').map(t => t.trim()).filter(t => t.length > 0) : 
      [];

    // Create persona metadata
    const metadata: PersonaMetadata = {
      name,
      description,
      unique_id: uniqueId,
      author,
      triggers: triggerList,
      version: "1.0",
      category: category.toLowerCase(),
      age_rating: "all",
      content_flags: ["user-created"],
      ai_generated: true,
      generation_method: "Claude",
      price: "free",
      revenue_split: "80/20",
      license: "CC-BY-SA-4.0",
      created_date: new Date().toISOString().slice(0, 10)
    };

    // Create full persona content
    const frontmatter = Object.entries(metadata)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');

    const personaContent = `---
${frontmatter}
---

# ${name}

${instructions}

## Response Style
- Follow the behavioral guidelines above
- Maintain consistency with the persona's character
- Adapt responses to match the intended purpose

## Usage Notes
- Created via DollhouseMCP chat interface
- Author: ${author}
- Version: 1.0`;

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
  }

  private async editPersona(personaIdentifier: string, field: string, value: string) {
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

    const filePath = path.join(this.personasDir, persona.filename);

    try {
      // Read current file
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const parsed = matter(fileContent);
      
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
              `🎭 **${persona.metadata.name}**\n` +
              `📝 **Field Updated:** ${field}\n` +
              `🔄 **New Value:** ${normalizedField === 'instructions' ? 'Content updated' : value}\n` +
              `📊 **Version:** ${parsed.data.version}\n\n` +
              `Use \`get_persona_details "${persona.metadata.name}"\` to see all changes.`,
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

  private async validatePersona(personaIdentifier: string) {
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

  /**
   * Executes a network operation with retry logic and exponential backoff
   */
  private async retryNetworkOperation<T>(
    operation: () => Promise<T>, 
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on the last attempt
        if (attempt === maxRetries) {
          break;
        }
        
        // Don't retry certain errors (like 404, 401)
        if (error instanceof Error && error.message.includes('404')) {
          break;
        }
        
        // Calculate delay with exponential backoff
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError!;
  }

  // Auto-update management tools
  private async checkForUpdates() {
    try {
      // Get current version from package.json
      const packageJsonPath = path.join(__dirname, "..", "package.json");
      const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
      const packageData = JSON.parse(packageContent);
      const currentVersion = packageData.version;

      // Check GitHub releases API for latest version with retry logic
      const releasesUrl = RELEASES_API_URL;
      
      const response = await this.retryNetworkOperation(async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
        
        try {
          const response = await fetch(releasesUrl, {
            headers: {
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'DollhouseMCP/1.0'
            },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          return response;
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      });

      if (!response.ok) {
        if (response.status === 404) {
          return {
            content: [{
              type: "text",
              text: this.getPersonaIndicator() + 
                '📦 **Update Check Complete**\n\n' +
                '🔄 **Current Version:** ' + currentVersion + '\n' +
                '📡 **Remote Status:** No releases found on GitHub\n' +
                'ℹ️ **Note:** This may be a development version or releases haven\'t been published yet.\n\n' +
                '**Manual Update:**\n' +
                'Use `update_server true` to pull latest changes from main branch.'
            }]
          };
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const releaseData = await response.json();
      const latestVersion = releaseData.tag_name?.replace(/^v/, '') || releaseData.name;
      const publishedAt = new Date(releaseData.published_at).toLocaleDateString();

      // Simple version comparison (assumes semantic versioning)
      const isUpdateAvailable = this.compareVersions(currentVersion, latestVersion) < 0;

      const releaseNotes = releaseData.body 
        ? releaseData.body.substring(0, 500) + (releaseData.body.length > 500 ? '...' : '')
        : 'See release notes on GitHub';

      const statusParts = [
        this.getPersonaIndicator() + '📦 **Update Check Complete**\n\n',
        '🔄 **Current Version:** ' + currentVersion + '\n',
        '📡 **Latest Version:** ' + latestVersion + '\n',
        '📅 **Released:** ' + publishedAt + '\n\n'
      ];

      if (isUpdateAvailable) {
        statusParts.push(
          '✨ **Update Available!**\n\n',
          '**What\'s New:**\n' + releaseNotes + '\n\n',
          '**To Update:**\n',
          '• Use: `update_server true`\n',
          '• Or visit: ' + releaseData.html_url + '\n\n',
          '⚠️ **Note:** Update will restart the server and reload all personas.'
        );
      } else {
        statusParts.push(
          '✅ **You\'re Up to Date!**\n\n',
          'Your DollhouseMCP installation is current.\n',
          'Check back later for new features and improvements.'
        );
      }

      const statusText = statusParts.join('');

      return {
        content: [{ type: "text", text: statusText }]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbortError = error instanceof Error && error.name === 'AbortError';
      
      return {
        content: [{
          type: "text",
          text: this.getPersonaIndicator() + 
            '❌ **Update Check Failed**\n\n' +
            'Error: ' + errorMessage + '\n\n' +
            '**Possible causes:**\n' +
            (isAbortError ? '• Request timed out (>10 seconds)\n' : '') +
            '• Network connectivity issues\n' +
            '• GitHub API rate limiting\n' +
            '• Repository access problems\n\n' +
            'Try again later or check manually at:\n' +
            REPO_URL + '/releases'
        }]
      };
    }
  }

  /**
   * Validates prerequisites for server update (git repo + clean working tree)
   */
  private async validateUpdatePrerequisites(rootDir: string): Promise<{ valid: boolean; message?: string }> {
    // Check if we're in a git repository
    try {
      await safeExec('git', ['status'], { cwd: rootDir });
    } catch {
      return {
        valid: false,
        message: this.getPersonaIndicator() + 
          '❌ **Update Failed**\n\n' +
          'This directory is not a Git repository.\n' +
          'DollhouseMCP can only be updated if installed via Git clone.\n\n' +
          '**Manual Update Steps:**\n' +
          '1. Download latest code from GitHub\n' +
          '2. Replace installation files\n' +
          '3. Run `npm install && npm run build`'
      };
    }

    // Check for uncommitted changes
    const { stdout: statusOutput } = await safeExec('git', ['status', '--porcelain'], { cwd: rootDir });
    if (statusOutput.trim()) {
      return {
        valid: false,
        message: this.getPersonaIndicator() + 
          '❌ **Update Blocked**\n\n' +
          'Uncommitted changes detected:\n```\n' + statusOutput + '```\n\n' +
          '**Resolution:**\n' +
          '• Commit your changes: `git add . && git commit -m "Save local changes"`\n' +
          '• Or stash them: `git stash`\n' +
          '• Then retry the update'
      };
    }

    return { valid: true };
  }

  /**
   * Creates a timestamped backup of the current installation
   */
  private async createUpdateBackup(rootDir: string): Promise<string> {
    const backupDir = path.join(path.dirname(rootDir), '.backup-' + Date.now());
    await safeExec('cp', ['-r', rootDir, backupDir]);
    
    // Clean up old backups (keep only last 5)
    await this.cleanupOldBackups(path.dirname(rootDir));
    
    return backupDir;
  }

  /**
   * Removes old backup directories, keeping only the 5 most recent
   */
  private async cleanupOldBackups(parentDir: string): Promise<void> {
    try {
      const { stdout: lsOutput } = await safeExec('ls', ['-1t'], { cwd: parentDir });
      const backupDirs = lsOutput.split('\n')
        .filter(dir => dir.startsWith('.backup-') && dir.match(/\.backup-\d+$/))
        .slice(5); // Keep first 5, remove the rest

      for (const oldBackup of backupDirs) {
        const backupPath = path.join(parentDir, oldBackup);
        await safeExec('rm', ['-rf', backupPath]);
      }
    } catch (error) {
      // Don't fail the backup creation if cleanup fails
      console.error('Warning: Failed to cleanup old backups:', error);
    }
  }

  /**
   * Pulls latest changes from git and checks if updates are available
   */
  private async pullLatestChanges(rootDir: string): Promise<{ hasUpdates: boolean; output: string }> {
    const { stdout: pullOutput } = await safeExec('git', ['pull', 'origin', 'main'], { cwd: rootDir });
    const hasUpdates = !pullOutput.includes('Already up to date');
    return { hasUpdates, output: pullOutput };
  }

  /**
   * Updates npm dependencies and rebuilds the project
   */
  private async updateDependenciesAndBuild(rootDir: string): Promise<void> {
    await safeExec('npm', ['install'], { cwd: rootDir });
    await safeExec('npm', ['run', 'build'], { cwd: rootDir });
  }

  /**
   * Formats the success message for completed updates with progress indicators
   */
  private formatUpdateSuccessMessage(pullOutput: string, backupDir: string): string {
    const parts = [
      this.getPersonaIndicator() + '🔄 **DollhouseMCP Update Complete**\n\n',
      '**Progress Summary:**\n',
      '✅ [1/6] Dependencies verified (git, npm)\n',
      '✅ [2/6] Repository status validated\n',
      '✅ [3/6] Backup created: ' + path.basename(backupDir) + '\n',
      '✅ [4/6] Git pull completed\n',
      '✅ [5/6] Dependencies updated (npm install)\n',
      '✅ [6/6] TypeScript build completed\n',
      '\n🎉 **Update Successful!**\n\n',
      '**Changes Applied:**\n' + pullOutput + '\n\n',
      '**Next Steps:**\n',
      '• Server will restart automatically\n',
      '• All personas will be reloaded\n',
      '• Use `get_server_status` to verify update\n\n',
      '**Backup Location:** ' + backupDir + '\n',
      'Use `rollback_update true` if issues occur.'
    ];
    return parts.join('');
  }

  private async updateServer(confirm: boolean) {
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

    try {
      // Check that required dependencies are available
      const depCheck = await this.verifyDependencies();
      if (!depCheck.valid) {
        return { content: [{ type: "text", text: depCheck.message! }] };
      }

      const rootDir = path.join(__dirname, "..");

      // Validate prerequisites (git repo + clean working tree)
      const validation = await this.validateUpdatePrerequisites(rootDir);
      if (!validation.valid) {
        return {
          content: [{ type: "text", text: validation.message! }]
        };
      }

      // Create backup before making changes
      const backupDir = await this.createUpdateBackup(rootDir);

      // Pull latest changes and check if updates exist
      const { hasUpdates, output: pullOutput } = await this.pullLatestChanges(rootDir);
      
      // If no updates, clean up backup and return
      if (!hasUpdates) {
        await safeExec('rm', ['-rf', backupDir]);
        return {
          content: [{
            type: "text",
            text: this.getPersonaIndicator() + 
              'ℹ️ **Already Up to Date**\n\n' +
              'No updates were available.\n' +
              'Your DollhouseMCP installation is current.\n\n' +
              'Use `check_for_updates` to see version information.'
          }]
        };
      }

      // Update dependencies and rebuild
      await this.updateDependenciesAndBuild(rootDir);

      // Format and return success message
      const successMessage = this.formatUpdateSuccessMessage(pullOutput, backupDir);
      return {
        content: [{ type: "text", text: successMessage }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        content: [{
          type: "text",
          text: this.getPersonaIndicator() + 
            '❌ **Update Failed**\n\n' +
            'Error during auto-update: ' + errorMessage + '\n\n' +
            '**Recovery:**\n' +
            'If the server is in an unstable state:\n' +
            '1. Use `rollback_update true` to restore previous version\n' +
            '2. Or manually restore from backup directory\n' +
            '3. Report the issue on GitHub if it persists'
        }]
      };
    }
  }

  /**
   * Finds available backup directories for rollback
   */
  private async findAvailableBackups(parentDir: string): Promise<{ success: boolean; backups?: string[]; message?: string }> {
    const { stdout: lsOutput } = await safeExec('ls', ['-1t'], { cwd: parentDir });
    const backupDirs = lsOutput.split('\n')
      .filter(dir => dir.startsWith('.backup-'))
      .map(dir => path.join(parentDir, dir));

    if (backupDirs.length === 0) {
      return {
        success: false,
        message: this.getPersonaIndicator() + 
          '❌ **No Backups Found**\n\n' +
          'No backup directories found for rollback.\n' +
          'Backups are created automatically during updates.\n\n' +
          '**Manual Recovery:**\n' +
          'You may need to manually restore from:\n' +
          '• Git history: `git reset --hard HEAD~1`\n' +
          '• External backup\n' +
          '• Fresh installation'
      };
    }

    return { success: true, backups: backupDirs };
  }

  /**
   * Performs safe rollback with safety backup creation
   */
  private async performSafeRollback(rootDir: string, parentDir: string, latestBackup: string): Promise<string> {
    // Create safety backup of current state
    const safetyBackup = path.join(parentDir, '.rollback-safety-' + Date.now());
    await safeExec('cp', ['-r', rootDir, safetyBackup]);

    // Remove current installation
    await safeExec('rm', ['-rf', rootDir]);

    // Restore from backup
    await safeExec('cp', ['-r', latestBackup, rootDir]);

    return safetyBackup;
  }

  /**
   * Attempts to rebuild after rollback (non-critical)
   */
  private async attemptPostRollbackBuild(rootDir: string): Promise<boolean> {
    try {
      await safeExec('npm', ['run', 'build'], { cwd: rootDir });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Formats the success message for completed rollbacks
   */
  private formatRollbackSuccessMessage(latestBackup: string, safetyBackup: string, buildSuccess: boolean): string {
    const parts = [
      this.getPersonaIndicator() + '🔄 **DollhouseMCP Rollback Complete**\n\n',
      '**Progress Summary:**\n',
      '✅ [1/5] Dependencies verified (git, npm)\n',
      '✅ [2/5] Safety backup created\n',
      '✅ [3/5] Current version removed\n',
      '✅ [4/5] Previous version restored from: ' + path.basename(latestBackup) + '\n',
      buildSuccess ? '✅ [5/5] TypeScript rebuild completed\n' : '⚠️ [5/5] Rebuild skipped (may not be needed)\n',
      '\n🎉 **Rollback Successful!**\n\n',
      '**Status:**\n',
      '• Previous version restored successfully\n',
      '• Server will restart automatically\n',
      '• Use `get_server_status` to verify rollback\n\n',
      '**Backup Information:**\n',
      '• Safety backup: ' + path.basename(safetyBackup) + '\n',
      '• Original backup: ' + path.basename(latestBackup) + '\n',
      '• Remove manually when satisfied with rollback result'
    ];
    return parts.join('');
  }

  private async rollbackUpdate(confirm: boolean) {
    if (!confirm) {
      return {
        content: [{
          type: "text",
          text: this.getPersonaIndicator() + 
            '⚠️ **Rollback Confirmation Required**\n\n' +
            'To proceed with rollback, you must confirm:\n' +
            '`rollback_update true`\n\n' +
            '**What will happen:**\n' +
            '• Find most recent backup\n' +
            '• Restore previous version\n' +
            '• Rebuild if necessary\n' +
            '• Restart server\n\n' +
            '⚠️ **Warning:** This will undo recent updates and changes.'
        }]
      };
    }

    try {
      // Check that required dependencies are available
      const depCheck = await this.verifyDependencies();
      if (!depCheck.valid) {
        return { content: [{ type: "text", text: depCheck.message! }] };
      }

      const rootDir = path.join(__dirname, "..");
      const parentDir = path.dirname(rootDir);

      // Find available backups
      const backupResult = await this.findAvailableBackups(parentDir);
      if (!backupResult.success) {
        return {
          content: [{ type: "text", text: backupResult.message! }]
        };
      }

      // Use the most recent backup
      const latestBackup = backupResult.backups![0];

      // Perform the rollback with safety backup
      const safetyBackup = await this.performSafeRollback(rootDir, parentDir, latestBackup);

      // Attempt to rebuild (non-critical)
      const buildSuccess = await this.attemptPostRollbackBuild(rootDir);

      // Format and return success message
      const successMessage = this.formatRollbackSuccessMessage(latestBackup, safetyBackup, buildSuccess);
      return {
        content: [{ type: "text", text: successMessage }]
      };

    } catch (error) {
      return {
        content: [{
          type: "text",
          text: this.getPersonaIndicator() + 
            '❌ **Rollback Failed**\n\n' +
            'Error during rollback: ' + error + '\n\n' +
            '**Emergency Recovery:**\n' +
            '1. Check for safety backup directories\n' +
            '2. Manually restore from backup\n' +
            '3. Or reinstall DollhouseMCP from GitHub\n' +
            '4. Report this issue if it persists'
        }]
      };
    }
  }

  /**
   * Reads version information from package.json
   */
  private async getVersionInfo(rootDir: string): Promise<{ version: string; name: string }> {
    const packageJsonPath = path.join(rootDir, "package.json");
    const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageData = JSON.parse(packageContent);
    return { version: packageData.version, name: packageData.name };
  }

  /**
   * Gathers git repository information
   */
  private async getGitInfo(rootDir: string): Promise<{ gitInfo: string; lastCommit: string }> {
    try {
      const { stdout: branchOutput } = await safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootDir });
      const { stdout: commitOutput } = await safeExec('git', ['rev-parse', '--short', 'HEAD'], { cwd: rootDir });
      const { stdout: dateOutput } = await safeExec('git', ['log', '-1', '--format=%cd', '--date=short'], { cwd: rootDir });
      
      const gitInfo = branchOutput.trim() + ' (' + commitOutput.trim() + ')';
      const lastCommit = dateOutput.trim();
      
      return { gitInfo, lastCommit };
    } catch {
      return { gitInfo: "Not available", lastCommit: "Unknown" };
    }
  }

  /**
   * Checks for backup directories
   */
  private async getBackupInfo(rootDir: string): Promise<string> {
    try {
      const parentDir = path.dirname(rootDir);
      const { stdout: lsOutput } = await safeExec('ls', ['-1'], { cwd: parentDir });
      const backupCount = lsOutput.split('\n').filter(dir => dir.startsWith('.backup-')).length;
      
      if (backupCount > 0) {
        return backupCount + ' backup(s) available';
      }
      return "None found";
    } catch {
      return "Check failed";
    }
  }

  /**
   * Collects system information
   */
  private getSystemInfo(): { nodeVersion: string; platform: string; arch: string; uptimeString: string } {
    const nodeVersion = process.version;
    const platform = process.platform;
    const arch = process.arch;
    const uptime = process.uptime();
    const uptimeString = Math.floor(uptime / 3600) + 'h ' + Math.floor((uptime % 3600) / 60) + 'm ' + Math.floor(uptime % 60) + 's';
    
    return { nodeVersion, platform, arch, uptimeString };
  }

  /**
   * Formats the complete server status message
   */
  private formatServerStatusMessage(
    versionInfo: { version: string; name: string },
    gitInfo: { gitInfo: string; lastCommit: string },
    backupInfo: string,
    systemInfo: { nodeVersion: string; platform: string; arch: string; uptimeString: string },
    rootDir: string
  ): string {
    const parts = [
      this.getPersonaIndicator() + '📊 **DollhouseMCP Server Status**\n\n',
      '**📦 Version Information:**\n',
      '• **Version:** ' + versionInfo.version + '\n',
      '• **Git Branch:** ' + gitInfo.gitInfo + '\n',
      '• **Last Update:** ' + gitInfo.lastCommit + '\n\n',
      '**⚙️ System Information:**\n',
      '• **Node.js:** ' + systemInfo.nodeVersion + '\n',
      '• **Platform:** ' + systemInfo.platform + ' (' + systemInfo.arch + ')\n',
      '• **Uptime:** ' + systemInfo.uptimeString + '\n',
      '• **Installation:** ' + rootDir + '\n\n',
      '**🎭 Persona Information:**\n',
      '• **Total Personas:** ' + this.personas.size + '\n',
      '• **Active Persona:** ' + (this.activePersona || 'None') + '\n',
      '• **User Identity:** ' + (this.currentUser || 'Anonymous') + '\n',
      '• **Personas Directory:** ' + this.personasDir + '\n\n',
      '**🔄 Update Information:**\n',
      '• **Backups:** ' + backupInfo + '\n',
      '• **Check Updates:** `check_for_updates`\n',
      '• **Update Server:** `update_server true`\n',
      '• **Rollback:** `rollback_update true`\n\n',
      '**🛠️ Tools Available:** 21 MCP tools registered'
    ];
    return parts.join('');
  }

  private async getServerStatus() {
    try {
      const rootDir = path.join(__dirname, "..");

      // Gather all status information using helper functions
      const versionInfo = await this.getVersionInfo(rootDir);
      const gitInfo = await this.getGitInfo(rootDir);
      const backupInfo = await this.getBackupInfo(rootDir);
      const systemInfo = this.getSystemInfo();

      // Format and return the complete status message
      const statusMessage = this.formatServerStatusMessage(versionInfo, gitInfo, backupInfo, systemInfo, rootDir);
      return {
        content: [{ type: "text", text: statusMessage }]
      };

    } catch (error) {
      return {
        content: [{
          type: "text",
          text: this.getPersonaIndicator() + 
            '❌ **Status Check Failed**\n\n' +
            'Error gathering system information: ' + error + '\n\n' +
            'Basic information:\n' +
            '• Server is running (you received this message)\n' +
            '• Personas loaded: ' + this.personas.size + '\n' +
            '• Active persona: ' + (this.activePersona || 'None')
        }]
      };
    }
  }

  /**
   * Verifies that required dependencies (git, npm) are available
   */
  private async verifyDependencies(): Promise<{ valid: boolean; message?: string }> {
    try {
      // Check git availability
      await safeExec('git', ['--version']);
    } catch (error) {
      return {
        valid: false,
        message: this.getPersonaIndicator() + 
          '❌ **Dependency Check Failed**\n\n' +
          'Git is not available or not installed.\n' +
          'Git is required for auto-update functionality.\n\n' +
          '**Installation:**\n' +
          '• macOS: `brew install git` or download from git-scm.com\n' +
          '• Ubuntu/Debian: `sudo apt install git`\n' +
          '• Windows: Download from git-scm.com\n\n' +
          'Please install Git and try again.'
      };
    }

    try {
      // Check npm availability
      await safeExec('npm', ['--version']);
    } catch (error) {
      return {
        valid: false,
        message: this.getPersonaIndicator() + 
          '❌ **Dependency Check Failed**\n\n' +
          'npm is not available or not installed.\n' +
          'npm is required for dependency management and building.\n\n' +
          '**Installation:**\n' +
          '• Install Node.js from nodejs.org (includes npm)\n' +
          '• Or use a package manager like brew, apt, or chocolatey\n\n' +
          'Please install Node.js/npm and try again.'
      };
    }

    return { valid: true };
  }

  /**
   * Enhanced semantic version comparison supporting pre-release versions
   * Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
   */
  private compareVersions(version1: string, version2: string): number {
    // Normalize versions by removing 'v' prefix
    const v1 = version1.replace(/^v/, '');
    const v2 = version2.replace(/^v/, '');
    
    // Split version and pre-release parts
    const [v1main, v1pre] = v1.split('-');
    const [v2main, v2pre] = v2.split('-');
    
    // Compare main version parts (x.y.z)
    const v1parts = v1main.split('.').map(part => parseInt(part) || 0);
    const v2parts = v2main.split('.').map(part => parseInt(part) || 0);
    
    const maxLength = Math.max(v1parts.length, v2parts.length);
    for (let i = 0; i < maxLength; i++) {
      const v1part = v1parts[i] || 0;
      const v2part = v2parts[i] || 0;
      
      if (v1part < v2part) return -1;
      if (v1part > v2part) return 1;
    }
    
    // If main versions are equal, compare pre-release versions
    // Version without pre-release is greater than version with pre-release
    if (!v1pre && v2pre) return 1;   // 1.0.0 > 1.0.0-beta
    if (v1pre && !v2pre) return -1;  // 1.0.0-beta < 1.0.0
    if (!v1pre && !v2pre) return 0;  // 1.0.0 == 1.0.0
    
    // Both have pre-release, compare lexicographically
    return v1pre.localeCompare(v2pre);
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("DollhouseMCP server running on stdio");
  }
}

// Export for testing
export { DollhouseMCPServer };

const server = new DollhouseMCPServer();
server.run().catch(console.error);