# DollhouseMCP: Getting Started

Welcome to DollhouseMCP — an MCP server that lets you customize your AI with modular elements: personas, skills, templates, agents, memories, and ensembles.

This guide takes you from installation to your first activated persona in under 10 minutes.

---

## What You're Installing

DollhouseMCP is a Model Context Protocol (MCP) server. It runs alongside your AI client (Claude Code, Claude Desktop, Gemini, Bolt AI) and gives it new capabilities:

- **Personas** change how the AI behaves — its tone, priorities, and expertise
- **Skills** add discrete capabilities the AI can activate on demand
- **Templates** standardize outputs with variable substitution
- **Agents** execute multi-step goals autonomously
- **Memories** persist context across sessions
- **Ensembles** bundle elements together into coordinated configurations

When you activate a persona, you're not just changing a prompt — you're changing what tools the AI can access, what commands it can run, and what operations require your approval. Elements are security principals, not just behavioral profiles.

---

## Step 1: Install

> **Note:** DollhouseMCP v2 is now the default release. Install via `@dollhousemcp/mcp-server` — no special tag required.

### Claude Code (Recommended)

```bash
claude mcp add dollhousemcp -- npx -y @dollhousemcp/mcp-server
```

That's it. Claude Code handles the rest.

### Claude Desktop

**One-click**: Download the [Desktop Extension (.mcpb)](https://github.com/DollhouseMCP/mcp-server/releases/tag/v2.0.0) and open it.

**Manual config** — add this to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["-y", "@dollhousemcp/mcp-server"]
    }
  }
}
```

Restart Claude Desktop after saving.

### Other Clients

See [MCP Client Setup Guide](mcp-client-setup.md) for Gemini, Bolt AI, and other configurations.

---

## Step 2: Verify It's Working

After installation, start a new conversation and ask:

> "What DollhouseMCP tools do you have available?"

You should see the AI report MCP-AQL endpoints (`mcp_aql_create`, `mcp_aql_read`, etc.) or DollhouseMCP tools. If it doesn't mention DollhouseMCP at all, see [Troubleshooting](#troubleshooting) below.

Next, try:

> "List all available personas"

The AI will call `list_elements` and show you the bundled starter personas. You should see names like Creative Writer, Debug Detective, Technical Analyst, and others.

**If you see a list of personas, you're ready.**

---

## Step 3: Activate Your First Persona

Ask the AI:

> "Activate the creative writer persona"

Two things happen:

1. **Behavior changes**: The AI now follows the Creative Writer persona's instructions — it becomes more narrative-focused, imaginative, and descriptive
2. **Permissions may change**: Some personas restrict which tools the AI can use or which operations require your approval

You can check what's active at any time:

> "What elements are currently active?"

To switch back:

> "Deactivate the creative writer persona"

### Key Things to Know About Activation

- **Session-scoped**: Activations persist for the current session. If you restart your client, you're back to defaults (unless you have activation persistence configured).
- **Multiple at once**: You can activate multiple personas, skills, and other elements simultaneously.
- **Instant permission changes**: When you activate or deactivate elements, the permission surface updates immediately — no restart needed.

---

## Step 4: Explore What's Available

DollhouseMCP ships with 38 starter elements across all 6 types:

### Personas (7)
| Name | What It Does |
|------|-------------|
| Creative Writer | Narrative-focused, imaginative storytelling |
| Business Consultant | Business strategy and advisory |
| Technical Analyst | Architecture and technical evaluation |
| Debug Detective | Deep debugging with systematic analysis |
| DollhouseMCP Expert | Guided help with the DollhouseMCP system |
| ELI5 Explainer | Simplifies complex topics for anyone |
| Security Analyst | Security-focused expert perspective |

### Skills (7)
| Name | What It Does |
|------|-------------|
| Code Review | Systematic code analysis for quality and security |
| Creative Writing | Creative content production |
| Data Analysis | Statistical and data insights |
| Penetration Testing | Security testing methodologies |
| Research | Research and investigation methodology |
| Threat Modeling | Security threat assessment |
| Translation | Language translation |

### Templates (8)
| Name | What It Does |
|------|-------------|
| Meeting Notes | Structured meeting documentation |
| Code Documentation | Technical documentation generation |
| Executive Report | Executive-level summaries |
| Professional Email | Business email formatting |
| Project Brief | Project overview and planning |
| Penetration Test Report | Security testing reports |
| Security Vulnerability Report | Vulnerability disclosure format |
| Threat Assessment Report | Threat analysis format |

### Agents (7)
| Name | What It Does |
|------|-------------|
| Hello World Agent | Introductory example agent |
| Code Reviewer | Automated multi-step code review with goal tracking |
| Research Assistant | Autonomous research and investigation |
| Documentation Writer | Automated documentation generation |
| Session Monitor | Watches for external state changes and keeps LLM synchronized |
| Test Generator | Automated test creation |
| Task Manager | Task orchestration |

### Memories (4)
| Name | What It Does |
|------|-------------|
| Conversation History | Session conversation tracking |
| GitHub Label Correction | Repository labeling patterns |
| Learning Progress | Learning state tracking |
| Project Context | Project-specific context storage |

Memories use YAML format and are created as you work. The bundled memories provide starter examples of the format.

### Ensembles (5)
| Name | What It Does |
|------|-------------|
| Business Advisor | Combined business analysis ensemble |
| Creative Studio | Creative content production ensemble |
| Development Team | Coordinates developer persona + code review skill |
| dollhouse-expert-suite | DollhouseMCP expert persona + knowledge base memory |
| Security Analysis Team | Combined security expert workflow |

To see everything available:

> "List all available skills"

> "Search for elements related to security"

> "Show me available ensembles"

---

## Step 5: Try an Ensemble

Ensembles are where DollhouseMCP really shines. They bundle multiple elements into a coordinated configuration:

> "Activate the development team ensemble"

This activates a persona and supporting skills together, with combined permission policies. When you deactivate the ensemble, all its elements deactivate together.

---

## What's Happening Under the Hood

When you interact with DollhouseMCP, you're using **MCP-AQL** — a query language that routes operations through 5 endpoints:

| Endpoint | Purpose | Example Operations |
|----------|---------|-------------------|
| **Create** | Add new things | `create_element`, `addEntry`, `install_collection_content` |
| **Read** | Look at things (safe, no side effects) | `list_elements`, `search_elements`, `get_active_elements` |
| **Update** | Modify existing things | `edit_element` |
| **Delete** | Remove things | `delete_element` |
| **Execute** | Run agents and workflows | `execute_agent`, `confirm_operation` |

You don't need to memorize these — the AI discovers available operations automatically via introspection. But understanding the model helps when things don't work as expected: operations that create or delete require confirmation, while read operations work immediately.

### The Gatekeeper

Some operations require your approval before they execute. This is the **Gatekeeper** — a three-layer permission system:

1. **Route policies**: Each operation has a default permission level (auto-approve for reads, confirm for creates/deletes)
2. **Element policies**: Active personas and skills can add restrictions (e.g., "deny `rm -rf *`")
3. **Session confirmation**: Once you confirm an operation type, it stays confirmed for the session

When an operation needs approval, the AI will ask. You confirm, and it proceeds. This is deliberate — it means the AI can't accidentally delete your elements or run dangerous commands without you knowing.

---

## Create Your First Custom Element

Ready to make something your own? Ask the AI:

> "Create a new persona called 'project-lead' that focuses on project management, task prioritization, and team coordination. It should be direct and action-oriented."

The AI will use `create_element` to create a persona file in your portfolio (`~/.dollhouse/portfolio/personas/`). You can then activate it, edit it, or share it.

To edit an element you've created:

> "Edit the project-lead persona to also include risk assessment as a priority"

To see the raw content:

> "Show me the full details of the project-lead persona"

---

## Browse the Community Collection

DollhouseMCP has a community library of elements you can browse and install:

> "Browse the community collection for personas"

> "Search the collection for 'code review'"

> "Install the creative writer persona from the collection"

You can also browse directly at [dollhousemcp.github.io/collection](https://dollhousemcp.github.io/collection/).

**No GitHub account required to browse or install.** GitHub OAuth is only needed if you want to back up your own portfolio or submit elements to the community.

---

## Optional: Set Up GitHub Portfolio Sync

If you want to back up your custom elements and optionally share them:

1. Set up GitHub authentication:
   > "Set up GitHub authentication for my portfolio"

2. Initialize your portfolio repository:
   > "Initialize my portfolio repository"

3. Sync your local elements to GitHub:
   > "Sync my portfolio"

See the [Portfolio Setup Guide](portfolio-setup-guide.md) for detailed instructions.

**This is entirely optional.** Your elements are stored locally at `~/.dollhouse/portfolio/` and work fine without GitHub.

---

## If You're Migrating from v1.x

If you used an earlier version of DollhouseMCP, the main changes in v2.0 are:

- **Parameters are now snake_case**: `elementName` → `element_name`, `elementType` → `element_type`
- **MCP-AQL replaces discrete tools**: Instead of individual tools like `create_persona`, use `mcp_aql_create` with `operation: "create_element"`
- **Agents use V2 schema**: Goals have structured templates with parameters, agents can define activation lists and resilience policies
- **Gatekeeper is active by default**: Some operations now require confirmation

Your existing portfolio elements (personas, skills, etc.) are compatible — the server handles V1-to-V2 normalization automatically on load.

For a full migration reference, see the [v2.0 Migration Guide](v2-migration-guide.md).

---

## Next Steps

| Want to... | Do this |
|-----------|---------|
| Learn about element types | Ask: "Explain all the element types in DollhouseMCP" |
| See what the server can do | Ask: "Show me all your available operations" |
| Create a custom skill | Ask: "Create a skill for [your use case]" |
| Build and run an agent | Ask: "Investigate how to make the best agent to [your goal], then create it and run it" |
| Understand permissions | Read: [Why DollhouseMCP](why-dollhousemcp.md) |
| Learn about the project | Visit: [dollhousemcp.com](https://dollhousemcp.com) |
| Contribute to the project | Read: [Contributing Guide](../../CONTRIBUTING.md) |

---

## Troubleshooting

### "I don't see any DollhouseMCP tools"

1. **Claude Code**: Run `claude mcp list` and verify `dollhousemcp` appears. If not, re-run the install command.
2. **Claude Desktop**: Check your config file path and JSON syntax. Restart Claude Desktop completely (quit and reopen, not just close the window).
3. **Common issue**: If using `npx`, ensure Node.js >= 20 is installed: `node --version`

### "The AI says it can't find an element"

- Element names are case-sensitive. Try: "List all personas" to see exact names.
- If you just created an element, it should be immediately available (no restart needed).

### "An operation was denied"

This is the Gatekeeper working as intended. The AI will explain what needs confirmation. Approve the operation and it will proceed. Some operations (like `delete_element`) require confirmation every time — this is a safety feature, not a bug.

### "I want to start fresh"

Your portfolio lives at `~/.dollhouse/portfolio/`. You can:
- Delete individual element files to remove them
- Delete the entire portfolio directory to reset to bundled defaults (they'll be re-populated on next server start)

For more troubleshooting, see the [Troubleshooting Guide](troubleshooting.md).

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────┐
│  Your AI Client (Claude Code / Desktop)     │
│                                             │
│  "Activate the security analyst persona"    │
└──────────────────┬──────────────────────────┘
                   │ MCP Protocol
┌──────────────────▼──────────────────────────┐
│  DollhouseMCP MCP Server                    │
│                                             │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │MCP-AQL  │  │Gatekeeper│  │ Element   │  │
│  │Router   │→ │(3 layers)│→ │ Managers  │  │
│  └─────────┘  └──────────┘  └───────────┘  │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ Portfolio (~/.dollhouse/portfolio/) │    │
│  │ personas/ skills/ templates/        │    │
│  │ agents/   memories/ ensembles/      │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

Every operation flows through the MCP-AQL router, gets checked by the Gatekeeper, and is handled by the appropriate element manager. Your elements live in your portfolio as readable markdown/YAML files that you own and control.

For a detailed operation reference written for the AI itself, see the [LLM Quick Reference](llm-quick-reference.md).

---

## Glossary

| Term | Definition |
|------|-----------|
| **Element** | A modular unit of AI customization — a markdown/YAML file that configures behavior, capabilities, or context. DollhouseMCP has 6 element types. |
| **Persona** | An element that defines how the AI behaves — its tone, expertise, priorities, and methodology. Also acts as a security principal with associated permissions. |
| **Skill** | An element that adds a discrete capability the AI can activate on demand (e.g., code review, data analysis, translation). |
| **Template** | An element with variable placeholders (`{{variable}}`) that standardizes outputs like reports, emails, or documentation. |
| **Agent** | An element that executes multi-step goals autonomously, with state tracking, resilience policies, and an execution lifecycle. |
| **Memory** | An element that persists structured context across sessions — facts, preferences, project information. Can auto-load on startup. |
| **Ensemble** | An element that bundles multiple other elements into a coordinated configuration with activation strategies and conflict resolution. |
| **Portfolio** | Your local collection of elements at `~/.dollhouse/portfolio/`. Optionally synced to GitHub for backup. |
| **Collection** | The community-contributed library of shared elements, browsable and installable via MCP-AQL or at [dollhousemcp.github.io/collection](https://dollhousemcp.github.io/collection/). |
| **MCP** | Model Context Protocol — the standard that lets AI clients communicate with tool servers. DollhouseMCP is an MCP server. |
| **MCP-AQL** | DollhouseMCP's query language, routing operations through 5 CRUDE endpoints (Create, Read, Update, Delete, Execute). |
| **CRUDE** | The 5 endpoint categories: **C**reate, **R**ead, **U**pdate, **D**elete, **E**xecute. Each has a default permission level. |
| **Gatekeeper** | The three-layer permission system that checks every operation server-side. Enforces route policies, element policies, and session confirmations. |
| **Activation** | Turning on an element for the current session. Changes the AI's behavior and may change the permission surface. |
| **Introspection** | The server's self-describing API — lets the AI discover available operations, parameters, formats, and categories at runtime. |
