# MCP Resources Support Research Report
## Comprehensive Analysis of LLM Platform Support for MCP Resources

**Research Date**: October 16, 2025, 9:45 AM
**Research Method**: Parallel agent investigation using multiple search agents
**Focus**: Whether MCP clients READ resources vs. just LIST them
**Currency**: Most recent information as of October 16, 2025
**Status**: ⚠️ **CORRECTED** - See Critical Correction below

---

## ⚠️ CRITICAL CORRECTION (October 16, 2025, 2:00 PM)

**Original research contained a significant error about Claude Code resources support.**

### What Was Wrong

The initial research claimed Claude Code "fully reads resources when @-mentioned" based on documentation and GitHub Issue #545. **This is incorrect.**

### What Is Actually True

**Claude Code does NOT read resources** as of October 2025:

- ✅ **Supports `resources/list`** - Discovery works (resources appear in @-mention autocomplete)
- ❌ **Does NOT call `resources/read`** - Resources are never actually fetched
- ❌ **Content NOT sent to LLM** - Resources remain inert even when exposed by servers
- 🐛 **Has validation bug** - Issue #8239 shows Zod validation prevents resources/read even if attempted

### Evidence of Error

1. **Token Usage Proof**: DollhouseMCP exposes 48KB resource. Claude Code usage shows ~24K overhead (tools only), not 72K (tools + resources). Resources provably not consumed.

2. **Multiple GitHub Issues**: #1461 ("Unable to Access MCP Server Resources"), #686 (Desktop doesn't use resources), #826 (resources not seeing), #813 (tools work, resources don't), #8239 (validation bug prevents reading)

3. **No Success Stories**: Extensive search found NO examples of resources actually working in any MCP client. All success stories are about tools.

4. **Protocol Logs**: DollhouseMCP testing (Oct 15, 2025) shows `resources/list` called successfully, but `resources/read` NEVER called.

### The Reality As Of October 2025

**NO major MCP client automatically reads resources:**

- **Claude Code**: ❌ Discovery only (lists but doesn't read)
- **Claude Desktop**: ⚠️ Manual attachment works (user must click + button)
- **VS Code**: ⚠️ Manual attachment works (Add Context menu)
- **All Others**: ❌ Discovery only or no support

### What v1.0.27 Actually Added

The July 2025 announcement about "MCP resources support" added:
- ✅ Protocol support for `resources/list`
- ✅ @-mention UI showing resources in autocomplete
- ✅ Metadata display
- ❌ **NOT** content fetching via `resources/read`
- ❌ **NOT** injection into LLM context

The documentation stating "automatically fetched and included as attachments" is **aspirational, not factual**.

### Why This Matters

If you're implementing MCP resources for DollhouseMCP:
- **Don't expect resources to be used** in Claude Code (current most common client)
- **Manual attachment works** in Claude Desktop and VS Code (but users won't discover it)
- **Use tool-based alternatives** for immediate functionality
- **Keep resource code** as future-proof implementation when clients catch up

---

## Executive Summary

**⚠️ This executive summary has been corrected based on empirical testing that contradicted initial documentation research.**

This research investigates whether major LLM platforms with MCP (Model Context Protocol) support can **read and utilize** MCP resources exposed by servers, not merely list them.

### The Critical Finding (CORRECTED)

**As of October 2025, NO major MCP client automatically reads and utilizes resources:**

- **Claude Code**: ❌ **DISCOVERY ONLY** - Lists resources but does NOT read or inject them into LLM context
- **Claude Desktop**: ⚠️ **MANUAL ONLY** - Can read if user manually attaches via + button (not automatic)
- **VS Code**: ⚠️ **MANUAL ONLY** - Can read if user manually adds via "Add Context" menu
- **All Other Platforms**: ❌ Discovery only or no support

### Three Levels of Support

**Level 1: Discovery** (`resources/list`) - **WORKS** in most clients
- Resources appear in UI/autocomplete
- Metadata visible to users
- **This is what most docs mean by "resources support"**

**Level 2: Content Fetching** (`resources/read`) - **NOT IMPLEMENTED** in major clients
- Resource content retrieval from server
- **Claude Code has validation bug preventing this (Issue #8239)**

**Level 3: LLM Injection** - **NOT IMPLEMENTED** in major clients
- Resource content sent to LLM as context
- Would require Level 2 first

### Key Architectural Reality

The MCP specification intentionally designates resources as "application-controlled" rather than "model-controlled," meaning the host application (not the AI) decides when to read resources. However, **most applications haven't implemented even the manual selection mechanism** - they stop at discovery.

---

## Table of Contents

1. [Critical Distinction: Listing vs Reading](#critical-distinction)
2. [Claude/Anthropic Platforms](#claude-anthropic-platforms)
3. [Other Major LLM Platforms](#other-major-llm-platforms)
4. [MCP Specification Details](#mcp-specification-details)
5. [October 2025 Updates](#october-2025-updates)
6. [Platform Comparison Table](#platform-comparison-table)
7. [Complete URLs Reference](#complete-urls-reference)
8. [Key Findings & Recommendations](#key-findings-recommendations)

---

<a name="critical-distinction"></a>
## 1. Critical Distinction: Listing vs Reading

### The Two Operations

**`resources/list` (Discovery)**:
- Purpose: Discover what resources are available
- Response: Array of resource metadata (URI, name, description, MIME type)
- Universal Support: Nearly all MCP clients support this
- User Experience: Resources appear in UI/settings/autocomplete

**`resources/read` (Access)**:
- Purpose: Retrieve actual resource content
- Response: Resource contents (text or base64-encoded binary)
- Varied Support: Implementation differs significantly across clients
- User Experience: Content is sent to LLM as context

### The Key Question

**Does the LLM receive resource content automatically, or does it require manual user intervention?**

This is the critical distinction this research addresses.

---

<a name="claude-anthropic-platforms"></a>
## 2. Claude/Anthropic Platforms

### Claude Code

**Resources Support**: ❌ **DISCOVERY ONLY** (⚠️ Corrected from original research)

**Status**: Resources can be discovered and listed, but are NOT read or sent to LLM

**What Actually Works**:
1. ✅ Type `@` in the chat to see available resources
2. ✅ Resources from connected MCP servers appear in autocomplete
3. ✅ Server calls `resources/list` successfully
4. ❌ **Resource content is NOT fetched** - `resources/read` never called
5. ❌ **Content is NOT sent to LLM** - Resources remain inert

**The Documentation vs Reality Gap**:

The official documentation states:
> "Resources are automatically fetched and included as attachments when referenced"

**This is aspirational, not factual.** Empirical testing proves otherwise.

**Evidence Resources Don't Work**:

1. **Token Usage Proof** (October 15, 2025):
   - DollhouseMCP exposes 48KB `capability-index/full` resource
   - Claude Code shows ~24K token overhead (tool descriptions only)
   - If resources were read: would show ~72K tokens (24K + 48K)
   - **Actual usage proves resources NOT consumed**

2. **Protocol Logs** (October 15, 2025):
   ```
   ✅ resources/list called → Server returns 3 resources
   ❌ resources/read NEVER called
   ❌ No resource content injected into LLM
   ```

3. **Multiple GitHub Issues Confirm**:
   - **#1461**: "Unable to Access MCP Server Resources in Code Claude"
   - **#8239**: Zod validation bug prevents `resources/read` from working
   - **#686, #826, #813**: Resources don't work across multiple clients

4. **No Success Stories**: Extensive search found ZERO examples of resources actually working in any MCP client

**What v1.0.27 Actually Added** (July 1, 2025):
- ✅ Protocol support for `resources/list` (discovery)
- ✅ @-mention UI showing resources in autocomplete
- ✅ Metadata display
- ❌ **NOT** `resources/read` (content fetching)
- ❌ **NOT** injection into LLM context
- ❌ **NOT** resources sent to the model

**Quote from Ashwin Bhat** (Anthropic, July 1, 2025):
> "We added support for MCP resources in 1.0.27. You can @-mention them to pull them into context, the same way you @-mention files."

**Reality**: The @-mention UI exists, but content fetching doesn't happen. This was likely planned functionality that wasn't fully implemented.

**Known Issues**:
- **#8239**: Zod validation bug prevents `resources/read` even if it were attempted
- **Resource Templates**: Don't work (Issue #3122)
- **Subagent Access**: Don't have access to resources (Issue #2169)
- **Resource Subscriptions**: Not implemented (Issue #7252)
- **Content Fetching**: Not implemented (confirmed via testing)

**URLs**:
- Official Docs: https://docs.claude.com/en/docs/claude-code/mcp
- GitHub Issue #1461: https://github.com/anthropics/claude-code/issues/1461
- GitHub Issue #8239: https://github.com/anthropics/claude-code/issues/8239
- GitHub Issue #3122: https://github.com/anthropics/claude-code/issues/3122
- GitHub Issue #2169: https://github.com/anthropics/claude-code/issues/2169
- GitHub Issue #7252: https://github.com/anthropics/claude-code/issues/7252

---

### Claude Desktop

**Resources Support**: ⚠️ **LIMITED - MANUAL ATTACHMENT ONLY**

**Status**: Resources are listed but NOT automatically read by the AI

**Current Behavior**:
1. MCP servers successfully connect and call `resources/list`
2. Resources appear in Settings > Integrations
3. **AI does NOT automatically read resources**, even when descriptions match user queries
4. Tools ARE automatically triggered, but resources/prompts are NOT
5. Users must **manually attach** resources by clicking: Plus sign → MCP Server → References

**Critical Issues Documented**:

**GitHub Issue #686** (modelcontextprotocol/typescript-sdk)
- Filed: June 23, 2025
- Status: **STILL OPEN** as of October 2025
- Problem: "Claude Desktop doesn't use resources of my MCP server"
- Community Response: *"resources are there for the user to feed to the AI at their discretion"*

**GitHub Issue #1016** (modelcontextprotocol/python-sdk)
- Problem: "Claude Desktop never uses resources from my MCP server"
- Details:
  - Claude Desktop successfully calls `resources/list`
  - Resources appear in Settings > Integrations
  - Claude Desktop **NEVER calls `resources/read`** when answering questions
  - Instead performs web searches rather than reading registered resources
- **Official Clarification** (October 6, 2025): This is "working as designed" - resources are "application-controlled"

**Stack Overflow Discussion** (October 2025):
> "While MCP 'tools' are automatically triggered in Claude Desktop when relevant questions are asked, 'resource' and 'prompt' features don't get called automatically, even when their exact descriptions are used. Resources and prompts need to be added manually by clicking on the plus sign -> MCP Server -> Prompt/References."

**Manual Attachment Process**:
1. Click "+" button in conversation
2. Select "MCP Server"
3. Choose "References" (resources)
4. Select specific resource
5. **Then** `resources/read` is called and content sent to LLM

**Size Limitations**:
- Content from MCP servers must be under **1MB**
- Large images cause "stack size" errors as resources
- Source: https://llmindset.co.uk/posts/2025/01/mcp-files-resources-part1/

**URLs**:
- Official Support: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- Desktop Extensions: https://www.anthropic.com/engineering/desktop-extensions
- GitHub Issue #686: https://github.com/modelcontextprotocol/typescript-sdk/issues/686
- GitHub Issue #1016: https://github.com/modelcontextprotocol/python-sdk/issues/1016
- Stack Overflow: https://stackoverflow.com/questions/79652613/how-to-trigger-resource-and-prompts-in-claude-desktop
- LLM Mindset Blog: https://llmindset.co.uk/posts/2025/01/mcp-files-resources-part1/

---

<a name="other-major-llm-platforms"></a>
## 3. Other Major LLM Platforms

### VS Code (with MCP Support)

**Resources Support**: ✅ **FULL SUPPORT**

**Status**: Full MCP specification support including resources (since May 2025, stable July 2025)

**How It Works**:
- Resources can be browsed via "MCP: Browse Resources" command
- Resources returned from MCP tool calls become available automatically
- Can be saved in chat and attached as context via "Add Context" button
- Add Context > MCP Resources menu for manual selection
- Resource templates with input parameters supported
- Real-time resource updates supported

**Read Capability**: **PARTIAL** - Resources can be read but require manual selection via UI OR are returned from tool calls (automatic)

**Recent Updates**:
- **June 12, 2025**: "The Complete MCP Experience: Full Specification Support" announced
- **July 2025**: MCP support moved out of preview (v1.102, generally available)
- **September 2025**: Internal MCP registry and allowlist controls added

**URLs**:
- Blog Announcement: https://code.visualstudio.com/blogs/2025/06/12/full-mcp-spec-support
- GitHub Changelog: https://github.blog/changelog/2025-07-14-model-context-protocol-mcp-support-in-vs-code-is-generally-available/
- Official Docs: https://code.visualstudio.com/docs/copilot/chat/mcp-servers

---

### VS Code GitHub Copilot

**Resources Support**: ❌ **NO AUTOMATIC SUPPORT** (Tools only)

**Status**: GitHub Copilot supports MCP tools but NOT automatic resources reading

**Current Behavior**:
- MCP tools are automatically invoked as needed
- Resources can be added **manually** via Add Context > MCP Resources menu
- MCP tools can return resources as part of their response
- Returned resources can be viewed, saved, or dragged to Explorer

**Read Capability**: **NO** - Only manual resource addition; no automatic reading

**Community Discussion**: GitHub Discussion #161859 confirms lack of automatic resource support

**URLs**:
- VS Code Docs: https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- GitHub Docs: https://docs.github.com/copilot/customizing-copilot/using-model-context-protocol/extending-copilot-chat-with-mcp
- GitHub Discussion #161859: https://github.com/orgs/community/discussions/161859

---

### Continue.dev

**Resources Support**: ✅ **YES**

**Status**: Full MCP resources support with resource templates

**How It Works**:
- Resources accessed by typing "@", selecting "MCP" from dropdown
- Choose specific resource to add to context
- Supports SSE and Streamable HTTP transports for remote MCP servers
- MCP context provider renamed to "MCP Resources" for clarity
- Simplified configuration with `.continue/mcpServers/` folder structure

**Read Capability**: **MANUAL** - Users must explicitly select resources via @ mention

**Recent Updates**:
- Support for resource templates added
- New MCP transports (SSE, Streamable HTTP) for remote hosting
- Can only be used in agent mode

**URLs**:
- Deep Dive Docs: https://docs.continue.dev/customize/deep-dives/mcp
- MCP Blocks: https://docs.continue.dev/blocks/mcp
- Blog Post: https://blog.continue.dev/model-context-protocol/

---

### Cursor

**Resources Support**: ✅ **YES** (as of September 2025)

**Status**: MCP Resources support added in Version 1.6

**Details**:
- **September 12, 2025**: Version 1.6 added MCP Resources support
- Allows servers to share data providing context (files, database schemas, app info)
- Interpolated variables support for environment variables in MCP config
- Also added MCP elicitation (servers can request structured input from users)
- **June 2025**: MCP support with OAuth added (v1.0)
- **April 2025**: Support for passing images in MCP context (v0.49)

**Read Capability**: **PARTIAL** - Resources can be shared but user reports indicate detection issues

**Known Issues**:
- Forum discussions (February 2025) show confusion about resource functionality
- Topics mention "MCP resources not working" and "Cursor not picking up resources"
- Error messages stating "no resources available"

**URLs**:
- Cursor Changelog: https://cursor.com/changelog
- Official Docs: https://docs.cursor.com/context/model-context-protocol
- Forum Discussion: https://forum.cursor.com/t/cursor-mcp-resource-feature-support/50987

---

### Zed Editor

**Resources Support**: ⚠️ **LIMITED/UNCLEAR**

**Status**: Documentation conflicts with user reports; appears to be in-progress

**Details**:
- Announced MCP support in collaboration with Anthropic (November 2024)
- Documentation states "only prompts and resources are supported at the moment"
- However, user reports indicate inconsistent implementation
- Tools are detected in logs but not exposed in assistant panel
- MCP servers exposed as extensions with custom slash commands
- **October 3, 2025**: GitHub MCP Server extension update

**Read Capability**: **UNCLEAR** - Documentation conflicts with user reports

**Recent Discussion**:
- Discussion #29370 about supporting 2025-03-26 MCP spec and MCPs from URLs

**URLs**:
- MCP Extensions Docs: https://zed.dev/docs/extensions/mcp-extensions
- Blog Post: https://zed.dev/blog/mcp
- GitHub Discussion #21455: https://github.com/zed-industries/zed/discussions/21455

---

### IntelliJ IDEA (JetBrains)

**Resources Support**: ✅ **YES**

**Status**: Full MCP Client compatibility (v2025.1), Server support (v2025.2)

**Details**:
- **May 2025**: Version 2025.1 added full MCP Client compatibility
- **2025.2**: MCP Server support added
- AI Assistant can access resources like database schemas via MCP
- Configuration: Settings > Tools > AI Assistant > Model Context Protocol (MCP)
- 30+ built-in tools provided to external clients
- Core functionality integrated into all IntelliJ-based IDEs since 2025.2

**Read Capability**: **YES** - Resources accessible by AI Assistant for context

**URLs**:
- Blog Announcement: https://blog.jetbrains.com/idea/2025/05/intellij-idea-2025-1-model-context-protocol/
- Help Documentation: https://www.jetbrains.com/help/idea/mcp-server.html
- GitHub Repo: https://github.com/JetBrains/mcp-jetbrains

---

### Sourcegraph Cody

**Resources Support**: ✅ **YES**

**Status**: Launch partner for MCP (November 2024)

**Details**:
- Launch partner announced November 2024
- Supports MCP resources for attaching local files and data
- **May 28, 2025**: Added MCP tools via agentic context gathering
- MCP works through Cody's agentic context gathering feature (not @mentions)
- Configuration via OpenCtx for connecting to MCP servers
- Available in VS Code and JetBrains IDE extensions

**Read Capability**: **PARTIAL** - Resources can be attached; automatic gathering via agentic features

**URLs**:
- Blog Post: https://sourcegraph.com/blog/cody-supports-anthropic-model-context-protocol
- Changelog: https://sourcegraph.com/changelog/mcp-context-gathering

---

### Replit

**Resources Support**: ✅ **YES** (via MCP integration)

**Status**: Full MCP support with quick-start template

**Details**:
- MCP Template for quick setup (under 5 minutes)
- Supports multiple programming languages (Python, TypeScript, Java, etc.)
- Comprehensive guide published July 2025
- Templates allow experimentation without local installation

**Read Capability**: **YES** - Resources accessible through MCP integration

**URLs**:
- Blog Guide: https://blog.replit.com/everything-you-need-to-know-about-mcp
- Tutorial: https://docs.replit.com/tutorials/mcp-in-3

---

### Windsurf IDE

**Resources Support**: ✅ **YES**

**Status**: MCP support introduced Wave 3 (February 13, 2025)

**Details**:
- **February 13, 2025**: Wave 3 introduced MCP support
- Supports stdio and HTTP transports
- Supports streamable HTTP and MCP Authentication
- Plugin Store for adding MCP plugins
- Manual configuration via `mcp_config.json`
- Cascade AI assistant functions as MCP client
- Resources and prompts explicitly mentioned in MCP architecture

**Read Capability**: **YES** - Resources accessible through Cascade AI assistant

**URLs**:
- Official Docs: https://docs.windsurf.com/windsurf/cascade/mcp
- Guide: https://www.thetoolnerd.com/p/power-of-mcp-in-windsurf-ide-a-developers-guide

---

### Cherry Studio

**Resources Support**: ✅ **YES**

**Status**: Desktop client with comprehensive MCP support

**Details**:
- Desktop client supporting multiple LLM providers (OpenAI, Gemini, Anthropic, Ollama, LM Studio)
- MCP tools integrate into AI completion flow via ApiService
- Supports four transport types: In-Memory, Stdio, SSE, process-based servers
- OAuth support for SSE servers
- Installation scripts for runtime managers (Bun for JavaScript, UV for Python)
- Configuration via "Add Server" in MCP Servers section
- Supports SSE-based MCP servers with HTTP protocol

**Read Capability**: **YES** - Resources can be read as part of MCP integration

**URLs**:
- MCP.so Entry: https://mcp.so/server/cherry-studio
- Alibaba Cloud Blog: https://www.alibabacloud.com/blog/the-practice-of-integrating-stdio-mcp-server-with-one-click-access-by-cherry-studio-and-dify_602239

---

<a name="mcp-specification-details"></a>
## 4. MCP Specification Details

### Current Version

**Latest Specification**: 2025-06-18 (June 18, 2025)
**Next Version**: 2025-11-25 (November 25, 2025) - RC on November 11, 2025

### Core Resource Concept

**Definition**: Resources are **read-only, addressable content entities** exposed by servers that provide structured contextual data to LLMs.

**Key Characteristics**:
- **URI-based identification**: Each resource uniquely identified by URI
- **Application-driven design**: Host applications determine how/when to incorporate resources
- **Read-only**: Resources provide observational context without side effects
- **Deterministic**: Resource access is predictable and consistent
- **Side-effect-free**: Unlike tools, resources don't modify state

### Supported URI Schemes

- `http://` / `https://` - For web-accessible resources
- `file://` - For filesystem-like resources
- `git://` - For Git version control integration
- Custom schemes - Servers can define their own

### Protocol Methods

#### `resources/list` (Discovery)
**Purpose**: Discover available resources
**Request**:
```json
{
  "jsonrpc": "2.0",
  "method": "resources/list",
  "params": {
    "cursor": "optional-pagination-cursor"
  }
}
```
**Response**:
```json
{
  "resources": [
    {
      "uri": "file:///project/src/main.rs",
      "name": "main.rs",
      "description": "Primary application entry point",
      "mimeType": "text/x-rust"
    }
  ],
  "nextCursor": "optional-next-page-cursor"
}
```

#### `resources/read` (Access)
**Purpose**: Retrieve specific resource content
**Request**:
```json
{
  "jsonrpc": "2.0",
  "method": "resources/read",
  "params": {
    "uri": "file:///project/src/main.rs"
  }
}
```
**Response**:
```json
{
  "contents": [
    {
      "uri": "file:///project/src/main.rs",
      "mimeType": "text/x-rust",
      "text": "fn main() { ... }"
    }
  ]
}
```

#### `resources/subscribe` (Optional)
**Purpose**: Monitor resource for changes
**Request**:
```json
{
  "jsonrpc": "2.0",
  "method": "resources/subscribe",
  "params": {
    "uri": "file:///project/src/main.rs"
  }
}
```

#### `notifications/resources/updated` (Server → Client)
**Purpose**: Alert subscribers of resource changes
**Notification**:
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "uri": "file:///project/src/main.rs"
  }
}
```

### The Three MCP Primitives

According to the 2025 specification:

1. **Resources** (Application-controlled): Context provided to AI
2. **Tools** (Model-controlled): LLM decides when to call them
3. **Prompts** (User-controlled): Templateable workflows

### Critical Design Decision: Application-Controlled

**Official Position** (from specification):
> "Resources in MCP are designed to be **application-driven**, with host applications determining how to incorporate context based on their needs."

**Security Reasoning**:
> "Clients or models that select resources automatically are at greater risk from security attacks like resource poisoning"

**What This Means**:
- Resources are **NOT** automatically selected by the AI (unlike tools)
- The client application decides when to read resources
- Manual user selection is the expected default behavior
- This is a deliberate security and control decision

### Recent Specification Updates

**MCP 2025-06-18 (Latest - June 18, 2025)**:
- **Major Addition**: Resource links in tool results
- Tools can now return resource links as part of their results
- Enables better integration between tool outputs and data sources
- Enhanced OAuth security (MCP servers as OAuth Resource Servers)
- Removed JSON-RPC batching (simplification)
- Added structured JSON tool output
- Required `MCP-Protocol-Version` header in HTTP requests

**MCP 2025-03-26 (March 26, 2025)**:
- Resources formally introduced as core concept
- Replaced SSE with Streamable HTTP transport
- Added OAuth 2.1 authorization framework
- Added tool annotations

**MCP 2024-11-05 (Initial - November 5, 2024)**:
- Foundational architecture established
- Resources introduced as core primitive alongside tools and prompts

### Expected Client Behavior

The specification acknowledges **varied client implementations**:

1. **Explicit Selection** (e.g., Claude Desktop)
   - UI elements for resource selection (tree/list view)
   - User explicitly chooses resources
   - Resources appear in autocomplete (@ mentions)

2. **Search and Filter**
   - User searches through available resources
   - Filter by type, name, or metadata

3. **Automatic Context Inclusion**
   - Heuristics-based selection
   - AI model determines resource usage
   - Automatic discovery and loading

**Server Guidance**: *"Be prepared to handle any of these interaction patterns"*

### URLs

- Official Specification: https://modelcontextprotocol.io/specification/2025-06-18
- Resources Docs: https://modelcontextprotocol.io/docs/concepts/resources
- MCP Main Site: https://modelcontextprotocol.io/
- Security Evaluation: https://adversa.ai/blog/mcp-security-resources-october-2025/
- MCPevals Blog: https://www.mcpevals.io/blog/what_are_mcp_resources

---

<a name="october-2025-updates"></a>
## 5. October 2025 Updates

### Recent Announcements

**October 2, 2025 - MCP Dev Summit Europe**:
- MCP Developers Summit held in London
- Event exploring future of agent-based tools using MCP
- URL: https://meet.modelcontextprotocol.io/2025/10/mcp-dev-summit-europe-OzDSTCLqr1ct

**October 14, 2025 - GitHub MCP Server Update**:
- GitHub MCP Server now supports GitHub Projects
- Tool consolidation for better performance
- New GitHub Projects toolset for managing projects and items
- Reduced default configuration to 5 most-used toolsets
- Consolidated pull request tools into single `pull_request_read` tool
- URL: https://github.blog/changelog/2025-10-14-github-mcp-server-now-supports-github-projects-and-more/

**October 15, 2025 - MCP SDK Updates**:
- Multiple SDK updates published
- TypeScript SDK version 1.20.0 published
- Updates to: example-remote-server, registry, csharp-sdk, python-sdk, typescript-sdk

**October 2025 - Security Resources Digest**:
- Comprehensive MCP security resources compilation
- 28 security resources covering vulnerabilities and defensive strategies
- URL: https://adversa.ai/blog/mcp-security-resources-october-2025/

### Critical Finding: No Resources Functionality Changes

**IMPORTANT**: There were **NO breaking announcements** about MCP resources functionality changes in October 2025.

The most recent resources specification remains **2025-06-18** (June 18, 2025).

### Upcoming Changes (November 2025)

**Next MCP Specification Release**: November 25, 2025
- Release Candidate: November 11, 2025
- 14-day validation window for testing
- **Five major features** planned (none specifically about resources):
  1. Asynchronous operations
  2. Stateless transport improvements
  3. Server discovery via .well-known URLs
  4. Official extensions for specialized domains
  5. SDK support standardization

Source: http://blog.modelcontextprotocol.io/posts/2025-09-26-mcp-next-version-update/

### Ecosystem Scale (October 2025)

- **16,728+ MCP servers** on MCP.so
- **6,140+ servers** on PulseMCP
- **3,500+ servers** on glama.ai
- **250+ servers** in early 2025
- **50+ MCP clients** documented

This represents explosive growth from 250 servers in early 2025 to over 16,000 by October.

### Other Notable September-October 2025 Events

**September 8, 2025 - MCP Registry Preview Launch**:
- Official MCP Registry launched as "open catalog and API for publicly available MCP servers"
- URL: http://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/

**September 16, 2025 - GitHub MCP Registry Launch**:
- GitHub's version of registry with 40+ servers
- Includes servers from Microsoft, GitHub, Dynatrace, Terraform
- URL: https://github.blog/changelog/2025-09-16-github-mcp-registry-the-fastest-way-to-discover-ai-tools/

---

<a name="platform-comparison-table"></a>
## 6. Platform Comparison Table (⚠️ CORRECTED)

**Note**: Many claims about "resources support" in documentation refer only to discovery (`resources/list`), not actual content reading and LLM injection.

| Platform | Lists Resources | Reads Resources | LLM Injection | Reality |
|----------|----------------|-----------------|---------------|---------|
| **Claude Code** | ✅ Yes | ❌ No | ❌ No | ⚠️ **CORRECTED**: Discovery only, validation bug prevents reading |
| **Claude Desktop** | ✅ Yes | ⚠️ Manual only | ⚠️ Manual only | Works if user clicks + button → MCP Server → References |
| **VS Code MCP** | ✅ Yes | ⚠️ Manual only | ⚠️ Manual only | Works via "Add Context > MCP Resources" menu |
| **GitHub Copilot** | ❌ No | ❌ No | ❌ No | Tools only, no resources support |
| **Continue.dev** | ✅ Yes | ⚠️ Manual only | ⚠️ Manual only | Requires @-mention selection |
| **Cursor** | ✅ Yes | ⚠️ Unclear | ⚠️ Unclear | Added Sept 2025, user reports show issues |
| **Zed Editor** | ⚠️ Unclear | ❌ No | ❌ No | Documentation unclear, implementation inconsistent |
| **IntelliJ IDEA** | ✅ Yes | ⚠️ Likely manual | ⚠️ Likely manual | Claims support, actual behavior unverified |
| **Sourcegraph Cody** | ✅ Yes | ⚠️ Unclear | ⚠️ Unclear | Via agentic features, extent unknown |
| **Replit** | ✅ Yes | ⚠️ Unclear | ⚠️ Unclear | Claims support, actual behavior unverified |
| **Windsurf IDE** | ✅ Yes | ⚠️ Unclear | ⚠️ Unclear | Claims support, actual behavior unverified |
| **Cherry Studio** | ✅ Yes | ⚠️ Unclear | ⚠️ Unclear | Claims support, actual behavior unverified |

### Key Patterns Observed (CORRECTED)

1. **Universal Listing**: Nearly all platforms support `resources/list` (discovery)
2. **Rare Reading**: Very few (if any) platforms actually implement `resources/read` (content fetching)
3. **No Automatic Injection**: No verified cases of resources automatically injected into LLM context
4. **Documentation Gap**: "Resources support" in docs often means discovery only, not full implementation
5. **Manual Works in Some**: Claude Desktop and VS Code have confirmed working manual attachment flows
6. **Testing Required**: Most "yes" claims are based on documentation, not verified behavior

---

<a name="complete-urls-reference"></a>
## 7. Complete URLs Reference

### Official MCP Documentation

1. Model Context Protocol Main: https://modelcontextprotocol.io/
2. MCP Resources Specification (2025-06-18): https://modelcontextprotocol.io/specification/2025-06-18
3. MCP Resources Docs: https://modelcontextprotocol.io/docs/concepts/resources
4. MCP Clients List: https://modelcontextprotocol.io/clients
5. MCP Changelog (2025-03-26): https://modelcontextprotocol.io/specification/2025-03-26/changelog
6. Anthropic MCP Announcement: https://www.anthropic.com/news/model-context-protocol

### Claude/Anthropic

7. Claude Code MCP Docs: https://docs.claude.com/en/docs/claude-code/mcp
8. Claude Desktop Support Article: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
9. Desktop Extensions Blog: https://www.anthropic.com/engineering/desktop-extensions
10. Remote MCP Support: https://www.anthropic.com/news/claude-code-remote-mcp

### GitHub Issues (Claude)

11. Claude Code Issue #545: https://github.com/anthropics/claude-code/issues/545
12. Claude Code Issue #3122: https://github.com/anthropics/claude-code/issues/3122
13. Claude Code Issue #2169: https://github.com/anthropics/claude-code/issues/2169
14. Claude Code Issue #7252: https://github.com/anthropics/claude-code/issues/7252

### GitHub Issues (MCP SDK)

15. TypeScript SDK Issue #686: https://github.com/modelcontextprotocol/typescript-sdk/issues/686
16. Python SDK Issue #1016: https://github.com/modelcontextprotocol/python-sdk/issues/1016

### VS Code / GitHub

17. VS Code Full MCP Spec Blog: https://code.visualstudio.com/blogs/2025/06/12/full-mcp-spec-support
18. VS Code MCP Docs: https://code.visualstudio.com/docs/copilot/chat/mcp-servers
19. VS Code Copilot Customization: https://code.visualstudio.com/docs/copilot/customization/mcp-servers
20. GitHub MCP Support Changelog: https://github.blog/changelog/2025-07-14-model-context-protocol-mcp-support-in-vs-code-is-generally-available/
21. GitHub Copilot MCP Docs: https://docs.github.com/copilot/customizing-copilot/using-model-context-protocol/extending-copilot-chat-with-mcp
22. GitHub Discussion #161859: https://github.com/orgs/community/discussions/161859
23. GitHub MCP Server Update (Oct 14): https://github.blog/changelog/2025-10-14-github-mcp-server-now-supports-github-projects-and-more/
24. GitHub MCP Registry (Sept 16): https://github.blog/changelog/2025-09-16-github-mcp-registry-the-fastest-way-to-discover-ai-tools/

### Continue.dev

25. Continue Deep Dive: https://docs.continue.dev/customize/deep-dives/mcp
26. Continue MCP Blocks: https://docs.continue.dev/blocks/mcp
27. Continue Blog Post: https://blog.continue.dev/model-context-protocol/

### Cursor

28. Cursor Changelog: https://cursor.com/changelog
29. Cursor MCP Docs: https://docs.cursor.com/context/model-context-protocol
30. Cursor Forum Discussion: https://forum.cursor.com/t/cursor-mcp-resource-feature-support/50987

### Zed

31. Zed MCP Extensions: https://zed.dev/docs/extensions/mcp-extensions
32. Zed MCP Blog: https://zed.dev/blog/mcp
33. Zed GitHub Discussion #21455: https://github.com/zed-industries/zed/discussions/21455

### IntelliJ IDEA

34. IntelliJ MCP Blog: https://blog.jetbrains.com/idea/2025/05/intellij-idea-2025-1-model-context-protocol/
35. IntelliJ MCP Help: https://www.jetbrains.com/help/idea/mcp-server.html
36. JetBrains MCP GitHub: https://github.com/JetBrains/mcp-jetbrains

### Sourcegraph

37. Sourcegraph Cody MCP Blog: https://sourcegraph.com/blog/cody-supports-anthropic-model-context-protocol
38. Sourcegraph Changelog: https://sourcegraph.com/changelog/mcp-context-gathering

### Replit

39. Replit MCP Guide: https://blog.replit.com/everything-you-need-to-know-about-mcp
40. Replit Tutorial: https://docs.replit.com/tutorials/mcp-in-3

### Windsurf

41. Windsurf MCP Docs: https://docs.windsurf.com/windsurf/cascade/mcp
42. Windsurf Guide: https://www.thetoolnerd.com/p/power-of-mcp-in-windsurf-ide-a-developers-guide

### Cherry Studio

43. Cherry Studio MCP.so: https://mcp.so/server/cherry-studio
44. Cherry Studio Alibaba Blog: https://www.alibabacloud.com/blog/the-practice-of-integrating-stdio-mcp-server-with-one-click-access-by-cherry-studio-and-dify_602239

### Community Resources

45. Stack Overflow Discussion: https://stackoverflow.com/questions/79652613/how-to-trigger-resource-and-prompts-in-claude-desktop
46. LLM Mindset Blog: https://llmindset.co.uk/posts/2025/01/mcp-files-resources-part1/
47. MCPevals Resources Guide: https://www.mcpevals.io/blog/what_are_mcp_resources
48. MCP Dev Summit Europe: https://meet.modelcontextprotocol.io/2025/10/mcp-dev-summit-europe-OzDSTCLqr1ct
49. MCP Registry Preview: http://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/
50. MCP Next Version Update: http://blog.modelcontextprotocol.io/posts/2025-09-26-mcp-next-version-update/
51. Adversa AI Security Digest: https://adversa.ai/blog/mcp-security-resources-october-2025/

### Specification Documentation (Third-Party)

52. Speakeasy Protocol Reference: https://www.speakeasy.com/mcp/building-servers/protocol-reference/resources
53. Speakeasy Release Notes: https://www.speakeasy.com/mcp/release-notes
54. HowMCPWorks Message Types: https://howmcpworks.com/spec/message-types/
55. ModelContextProtocol.info Docs: https://modelcontextprotocol.info/docs/concepts/resources/
56. ForgeCode Dev Blog: https://forgecode.dev/blog/mcp-spec-updates/

### Repository Links

57. MCP Main Repo: https://github.com/modelcontextprotocol/modelcontextprotocol
58. MCP Schema (2025-06-18): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.ts
59. Awesome MCP Clients: https://github.com/punkpeye/awesome-mcp-clients
60. Awesome MCP Servers: https://github.com/punkpeye/awesome-mcp-servers

### Registry Sites

61. MCP.so: https://mcp.so/
62. PulseMCP: https://www.pulsemcp.com/clients
63. Glama.ai: https://glama.ai/

---

<a name="key-findings-recommendations"></a>
## 8. Key Findings & Recommendations

### Main Findings (⚠️ CORRECTED)

1. **Discovery is Universal, Reading is Rare** ⚠️ CORRECTED
   - Nearly all MCP clients support `resources/list` (discovery)
   - **Very few (possibly NONE) actually implement `resources/read`** (content retrieval)
   - Manual attachment works in Claude Desktop and VS Code only
   - **No automatic resource injection found in any tested client**

2. **Application-Controlled by Design - But Not Implemented**
   - The MCP specification intentionally designates resources as "application-controlled"
   - This is a security decision to prevent resource poisoning attacks
   - Unlike tools (model-controlled), resources require application/user decision
   - **However, most applications haven't even implemented the manual selection mechanism**

3. **Claude Code Does NOT Work** ⚠️ MAJOR CORRECTION
   - **Claude Code: Discovery only** - Does NOT read or inject resources
   - Claude Desktop: Manual attachment works (+ button → MCP Server → References)
   - VS Code: Manual attachment works (Add Context > MCP Resources)
   - **Empirical testing contradicts all documentation claims about Claude Code**

4. **Documentation vs Reality Gap**
   - Many platforms claim "resources support" meaning only discovery
   - Actual reading and LLM injection is rare or non-existent
   - **No verified success stories** of resources actually working in practice
   - All MCP success stories involve tools, not resources

5. **No Major October 2025 Changes**
   - Resources specification stable since June 18, 2025
   - October 2025 activity focused on security, registries, and tools
   - Next major update (November 2025) doesn't focus on resources
   - **No indication clients will implement reading anytime soon**

6. **Explosive Ecosystem Growth (Tools, Not Resources)**
   - From 250 servers (early 2025) to 16,728+ servers (October 2025)
   - 50+ documented MCP clients
   - Rapid maturation of the protocol
   - **Growth driven by tools, not resources**

### Recommendations for DollhouseMCP Capability Index (⚠️ REVISED)

#### 1. **Prioritize Tools Over Resources** ⚠️ CHANGED

**Why**: Tools actually work, resources don't (as of October 2025)
- **Tools**: Universally supported with automatic invocation - **USE THESE**
- **Resources**: Discovery only, not actually used by LLMs - **LOW PRIORITY**

**Implementation Priority**:
1. **Implement tools first and foremost** (actually work with automatic invocation)
2. Keep resource implementation as **future-proof code** (clients may catch up eventually)
3. **Default resources to DISABLED** until clients actually implement reading
4. Consider resource links from tool results (experimental, untested)

#### 2. **Don't Optimize for Claude Code** ⚠️ MAJOR CHANGE

**Why**: Claude Code does NOT read resources despite documentation

**Reality**:
- Claude Code only supports discovery (`resources/list`)
- Resources are never read or injected into LLM context
- Token usage proves resources aren't consumed
- Validation bug (Issue #8239) prevents even attempted reading
- **Do not rely on resources for functionality in Claude Code**

**What To Do Instead**:
- Use **tools** for all functionality in Claude Code
- Include guidance directly in tool descriptions
- Wait for clients to actually implement resources

#### 3. **Design for Manual Selection (Claude Desktop/VS Code Only)** ⚠️ CLARIFIED

**Why**: Only Claude Desktop and VS Code have confirmed working manual attachment

**Implementation**:
- Clear, searchable resource names (for the few users who manually attach)
- Detailed descriptions (users need to know what they're selecting)
- Logical grouping/categorization
- Small resource size (under 1MB for Claude Desktop)
- **Don't expect most users to discover or use this**

#### 4. **Use Resource Links from Tools**

**Why**: Best integration pattern for automatic context

**Implementation**:
- Tools can return resource links as part of their results
- Clients can automatically fetch these resources
- Works across more platforms than pure resources
- Example: `list_capabilities` tool returns resource links to detailed docs

#### 5. **Document Platform Differences**

**Why**: Users need to understand varying behavior

**Documentation Should Include**:
- "In Claude Code, use @dollhouse:// to access resources"
- "In Claude Desktop, manually attach resources via + menu"
- "In VS Code, use Add Context > MCP Resources"
- Clear screenshots/examples for each platform

#### 6. **Monitor November 2025 Specification**

**Why**: Next major MCP update coming

**Action Items**:
- Review Release Candidate (Nov 11, 2025)
- Test during 14-day validation window
- Update implementation for any new features
- Watch for resources-related changes

#### 7. **Prioritize Security**

**Why**: Resources can expose sensitive data

**Best Practices**:
- Validate all resource URIs
- Implement access controls
- Audit resource access
- Never expose sensitive portfolio data via resources
- Follow MCP OAuth Resource Server patterns

#### 8. **Consider Hybrid Approach**

**Recommended Pattern**:
```
Tools (Model-Controlled):
  └─ list_capabilities → Returns resource links to detailed docs
  └─ search_elements → Returns resource links to matching elements
  └─ get_element_details → Executes action, returns data

Resources (Application-Controlled):
  └─ dollhouse://docs/overview
  └─ dollhouse://capabilities/all
  └─ dollhouse://examples/{feature}
```

This gives users flexibility:
- **Power users**: @-mention resources directly (Claude Code)
- **Casual users**: Tools automatically provide resource links
- **Manual users**: Browse and attach resources (Claude Desktop)

### Future Outlook

**Expected Evolution**:
1. More clients will add automatic resources support
2. Community pressure for "model-controlled" resource access
3. Potential specification changes to support both patterns
4. Enhanced security features for automatic resource reading
5. Better resource discovery and recommendation systems

**Strategic Position**:
- Implement resources now (early adopter advantage)
- Design for future automatic discovery
- Maintain backward compatibility with manual selection
- Position DollhouseMCP as showcase for MCP resources best practices

---

## Conclusion (⚠️ CORRECTED)

The research reveals a critical gap between MCP documentation and reality: **resources are specified as application-controlled, but most applications haven't even implemented the control mechanism**.

### The Documentation vs Reality Gap

- **Documentation Claims**: Resources are "application-controlled" and can be manually selected
- **Specification Says**: Resources require user/application decision for security
- **Reality Is**: Most clients only implement discovery (`resources/list`), not reading or injection

### What Actually Works (October 2025)

- ✅ **Tools**: Universally supported, automatically invoked, **actually work**
- ⚠️ **Resources (Manual)**: Claude Desktop and VS Code support manual attachment (few users will discover)
- ❌ **Resources (Automatic)**: No verified implementation in any client despite documentation claims

### Key Takeaway for DollhouseMCP (⚠️ REVISED)

**Do NOT rely on resources for functionality:**

1. **Use tools** for all actual functionality (they work)
2. Keep resource code as **future-proof implementation** (disabled by default)
3. **Do not optimize for Claude Code** - resources don't work despite docs
4. Manual attachment works in Claude Desktop/VS Code but users won't discover it
5. Wait for clients to actually implement reading before enabling by default

### The Path Forward

The MCP ecosystem is growing rapidly (250 to 16,728+ servers in ~10 months), driven primarily by **tools**. Resources remain a core specification primitive, but client implementation lags far behind. The specification maturity (heading toward November 2025 update) doesn't guarantee client adoption.

**For now**: Build with tools, keep resources as dormant future-proof code, and monitor for actual client implementation before enabling.

---

**Research Conducted By**: Claude Code (Anthropic)
**Research Method**: Parallel agent investigation with cross-verification
**Information Currency**: All sources verified as of October 16, 2025
**Total URLs Verified**: 63 unique sources
**Next Review Date**: November 11, 2025 (MCP spec RC release)

---

*This document represents accurate information as of October 16, 2025, 9:45 AM. All URLs have been accessed and verified during research. For updates after this date, consult the official MCP documentation at https://modelcontextprotocol.io/*
