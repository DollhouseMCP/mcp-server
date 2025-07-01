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
import matter from "gray-matter";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

    // Use environment variable if set, otherwise default to personas subdirectory
    this.personasDir = process.env.PERSONAS_DIR || path.join(process.cwd(), "personas");
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
            uniqueId = generateUniqueId(metadata.name, metadata.author);
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

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("DollhouseMCP server running on stdio");
  }
}

const server = new DollhouseMCPServer();
server.run().catch(console.error);