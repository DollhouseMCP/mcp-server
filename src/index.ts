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

    // Use environment variable if set, otherwise default to personas subdirectory
    this.personasDir = process.env.PERSONAS_DIR || path.join(process.cwd(), "personas");
    
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

      let text = `${this.getPersonaIndicator()}🏪 **DollhouseMCP Marketplace**\n\n`;
      
      if (!category) {
        text += `**📁 Categories (${categories.length}):**\n`;
        categories.forEach((cat: any) => {
          text += `   📂 **${cat.name}** - Browse with: \`browse_marketplace "${cat.name}"\`\n`;
        });
        text += '\n';
      }

      if (items.length > 0) {
        text += `**🎭 Personas in ${category || 'root'} (${items.length}):**\n`;
        items.forEach((item: any) => {
          const path = category ? `${category}/${item.name}` : item.name;
          text += `   ▫️ **${item.name}**\n`;
          text += `      📥 Install: \`install_persona "${path}"\`\n`;
          text += `      👁️ Details: \`get_marketplace_persona "${path}"\`\n\n`;
        });
      }

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

      let text = `${this.getPersonaIndicator()}🔍 **Search Results for "${query}"** (${data.items.length} found)\n\n`;
      
      data.items.forEach((item: any) => {
        const path = item.path.replace('personas/', '');
        text += `   🎭 **${item.name}**\n`;
        text += `      📂 Path: ${path}\n`;
        text += `      📥 Install: \`install_persona "${path}"\`\n`;
        text += `      👁️ Details: \`get_marketplace_persona "${path}"\`\n\n`;
      });

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

      let text = `${this.getPersonaIndicator()}🎭 **Marketplace Persona: ${metadata.name}**\n\n`;
      text += `**📋 Details:**\n`;
      text += `   🆔 ID: ${metadata.unique_id || 'Not specified'}\n`;
      text += `   👤 Author: ${metadata.author || 'Unknown'}\n`;
      text += `   📁 Category: ${metadata.category || 'General'}\n`;
      text += `   🔖 Price: ${metadata.price || 'Free'}\n`;
      text += `   📊 Version: ${metadata.version || '1.0'}\n`;
      text += `   🔞 Age Rating: ${metadata.age_rating || 'All'}\n`;
      text += `   ${metadata.ai_generated ? '🤖 AI Generated' : '👤 Human Created'}\n\n`;
      
      text += `**📝 Description:**\n${metadata.description}\n\n`;
      
      if (metadata.triggers && metadata.triggers.length > 0) {
        text += `**🔗 Triggers:** ${metadata.triggers.join(', ')}\n\n`;
      }

      text += `**📥 Installation:**\n`;
      text += `Use: \`install_persona "${path}"\`\n\n`;
      
      text += `**📄 Full Content:**\n\`\`\`\n${parsed.content}\n\`\`\``;

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

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("DollhouseMCP server running on stdio");
  }
}

const server = new DollhouseMCPServer();
server.run().catch(console.error);