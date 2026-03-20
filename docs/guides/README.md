# Guides

Task-oriented guides for DollhouseMCP. Each guide walks through common workflows — onboarding, portfolio setup, configuration, troubleshooting. Start here when you want step-by-step instructions.

---

## Getting Started

| Guide | Description |
|-------|-------------|
| [Quick Start](quick-start.md) | Platform-specific install for Claude Code, Desktop, Cursor, Windsurf, VS Code, Gemini, Codex, Docker, and more |
| [Public Beta Onboarding](public-beta-onboarding.md) | Install to first activated persona in 10 minutes — the primary getting-started guide |
| [Getting Started (Developer)](getting-started.md) | Local development setup for contributing to DollhouseMCP |
| [Why DollhouseMCP](why-dollhousemcp.md) | Overview of what DollhouseMCP provides and why it exists |

## Using DollhouseMCP

| Guide | Description |
|-------|-------------|
| [LLM Quick Reference](llm-quick-reference.md) | Operation cheat sheet written for AI assistants — MCP-AQL operations, examples, tips |
| [MCP Client Setup](mcp-client-setup.md) | Advanced configuration for MCP clients beyond the Quick Start |
| [Ensembles](ensembles.md) | Create and activate element collections (personas, skills, templates, agents, memories) |
| [Memory System](memory-system.md) | Memory element types, auto-loading, retention, and project-level context |
| [Skills Converter](skills-converter.md) | Bidirectional conversion between Dollhouse Skills and agent skills via MCP-AQL |
| [Agent Execution](agent-execution.md) | The agentic loop, security enforcement, human-in-the-loop, composition, resilience |

## Configuration

| Guide | Description |
|-------|-------------|
| [Environment Variables](environment-variables.md) | Complete reference for all DollhouseMCP environment variables |
| [Configuration Basics](configuration-basics.md) | Manage `config.yml` and configuration tools |
| [GitHub Portfolio Sync](portfolio-setup-guide.md) | Back up your portfolio to GitHub, sync between machines, submit to the community |
| [OAuth Setup](oauth-setup.md) | Custom GitHub OAuth app configuration |
| [Retention Policy](retention-policy.md) | Automatic cleanup of expired memory entries |
| [Logging](logging.md) | Configure, query, and read DollhouseMCP server logs |
| [Telemetry](telemetry.md) | Privacy policy and opt-in controls for operational telemetry |

## Migration & Compatibility

| Guide | Description |
|-------|-------------|
| [V2 Migration Guide](v2-migration-guide.md) | Upgrading from v1.x — parameter changes, MCP-AQL, Gatekeeper, agent schema |
| [Migration from Legacy Tools](migration-from-legacy-tools.md) | Mapping old discrete tool names to MCP-AQL operations |
| [Element Detection](element-detection-guide.md) | How `submit_collection_content` resolves element types |
| [Roundtrip Workflow](roundtrip-workflow-user-guide.md) | Discover → customize → share loop end-to-end |

## Troubleshooting

| Guide | Description |
|-------|-------------|
| [Troubleshooting](troubleshooting.md) | Diagnostic commands, common issues, log querying, and escalation |

## Internal / Reference

| Guide | Description |
|-------|-------------|
| [AI Assistant Onboarding](ai-assistant-onboarding.md) | Brief for AI helpers before they start working on the codebase |
| [Remote Agent Approval Pattern](remote-agent-approval-pattern.md) | Permission architecture for remote agent sessions (bridge) |

---

For deeper context, see [Architecture](../architecture/) or the [Reference](../reference/) section.
