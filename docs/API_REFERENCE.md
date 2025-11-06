# DollhouseMCP API Reference

Complete reference for all MCP tools available in DollhouseMCP v1.6.10

## Overview

DollhouseMCP provides 42 MCP tools organized into these categories:
- **Element Tools**: Work with all element types (personas, skills, templates, agents, memories, ensembles)
- **Persona Export/Import Tools**: Specialized tools for persona sharing and backup (5 tools)
- **Collection Tools**: GitHub marketplace integration and community content
- **Portfolio Tools**: Personal and GitHub portfolio management  
- **Auth Tools**: GitHub OAuth authentication
- **Config Tools**: System configuration and settings
- **User Tools**: User identity management
- **Build Info Tools**: System information and diagnostics

## Breaking Changes in v1.6.0 (Now in v1.6.10)

- **⚠️ PersonaTools Removal**: 9 redundant PersonaTools removed, reducing total from 51 to 42 tools
- **Tool Count**: Reduced from 51 to 42 total tools for a cleaner API
- **Migration Required**: Legacy PersonaTools replaced with ElementTools equivalents
- **Portfolio System**: New portfolio management tools for local and GitHub synchronization
- **Enhanced Search**: Unified search across local, GitHub, and collection sources
- **Collection Enhancements**: Enhanced search with pagination and filtering
- **Build Information**: New build info tools for better system diagnostics

> **📖 Migration Required**: See [PersonaTools Migration Guide](PERSONATOOLS_MIGRATION_GUIDE.md) for step-by-step migration instructions.

## New Features Highlights

- **Unified Search**: Search across all sources (local, GitHub portfolio, collection) with the `search_all` tool
- **Portfolio Management**: Complete portfolio lifecycle management with GitHub integration
- **Enhanced Collection Search**: Paginated and filtered collection browsing
- **Build Diagnostics**: Comprehensive build and runtime information access
- **Improved OAuth**: Enhanced GitHub authentication with better error handling

## Element Tools (12 tools)

These tools work with all element types: `personas`, `skills`, `templates`, `agents`, `memories`, `ensembles`.

### list_elements
Lists all available elements of a specific type.

**Parameters:**
- `type` (required): Element type - one of: `personas`, `skills`, `templates`, `agents`, `memories`, `ensembles`

**Example:**
```bash
list_elements --type skills
```

**Response:**
```
🎯 Code Reviewer (skill)
   Reviews code for quality, security, and best practices
   📁 software-development | ⭐ 4.8 | 👤 dollhousemcp
   
🎯 Language Translator (skill)
   Translates between multiple languages
   📁 communication | ⭐ 4.5 | 👤 mickdarling
```

### create_element
Creates a new element of any type.

**Parameters:**
- `name` (required): Element name
- `type` (required): Element type - one of: `personas`, `skills`, `templates`, `agents`, `memories`, `ensembles`
- `description` (required): Brief description
- `content` (optional): Element content/instructions
- `metadata` (optional): Additional metadata as JSON object

**Examples:**
```bash
# Create a persona
create_element --type personas --name "Data Scientist" --description "Expert in data analysis and ML"

# Create a skill with parameters
create_element --type skills --name "API Helper" --description "Helps integrate APIs" \
  --metadata '{"parameters": [{"name": "apiType", "type": "string", "default": "REST"}]}'

# Create a template
create_element --type templates --name "Sprint Report" --description "Weekly sprint template" \
  --content "# Sprint {{number}}\n\n## Completed\n{{#each tasks}}..."
```

### edit_element
Edits an existing element's properties.

**Parameters:**
- `name` (required): Element name to edit
- `type` (required): Element type
- `field` (required): Field path to edit (supports nested: `metadata.author`)
- `value` (required): New value for the field

**Examples:**
```bash
# Update description
edit_element "Code Reviewer" --type skills --field description --value "Advanced code analysis"

# Update nested metadata
edit_element "Sprint Report" --type templates --field "metadata.version" --value "2.0.0"

# Update skill parameter
edit_element "API Helper" --type skills --field "parameters.apiType.default" --value "GraphQL"
```

### delete_element
Deletes an element and optionally its associated data files.

**Parameters:**
- `name` (required): Element name to delete
- `type` (required): Element type
- `deleteData` (optional): Whether to delete associated data files

**Examples:**
```bash
# Delete element only (preserves data)
delete_element "Old Template" --type templates --deleteData false

# Delete element and all data
delete_element "Test Agent" --type agents --deleteData true

# Interactive mode (prompts about data files)
delete_element "Project Manager" --type agents
```

### validate_element
Validates an element for correctness and best practices.

**Parameters:**
- `name` (required): Element name to validate
- `type` (required): Element type
- `strict` (optional): Apply strict validation rules (default: false)

**Example:**
```bash
validate_element "Code Reviewer" --type skills --strict true
```

**Response:**
```
✅ Validation passed

Warnings:
- Missing 'proficiency.level' field
- No examples provided in content

Suggestions:
- Add usage examples
- Define parameter constraints
- Include error handling instructions
```

### activate_element
Activates a specific element.

**Parameters:**
- `name` (required): Element name to activate
- `type` (required): Element type

**Example:**
```bash
activate_element "Professional Writer" --type personas
activate_element "Code Reviewer" --type skills
```

### deactivate_element
Deactivates a specific element.

**Parameters:**
- `name` (required): Element name to deactivate
- `type` (required): Element type

**Example:**
```bash
deactivate_element "Code Reviewer" --type skills
```

### get_active_elements
Shows currently active elements of a specific type.

**Parameters:**
- `type` (required): Element type to check

**Example:**
```bash
get_active_elements --type personas
```

**Response:**
```
Active personas (1):
🔹 Professional Writer
   A skilled writer focused on clear communication
   Activated at: 2025-08-02T10:30:00Z
```

### get_element_details
Retrieves detailed information about a specific element.

**Parameters:**
- `name` (required): Element name
- `type` (required): Element type

**Example:**
```bash
get_element_details "Code Reviewer" --type skills
```

### reload_elements
Reloads elements from the filesystem.

**Parameters:**
- `type` (required): Element type to reload

**Example:**
```bash
reload_elements --type templates
```

### render_template
Renders a template with provided variables.

**Parameters:**
- `name` (required): Template name to render
- `variables` (required): JSON object with variable values

**Example:**
```bash
render_template "Sprint Report" --variables '{
  "sprintNumber": 23,
  "teamName": "Phoenix",
  "completedTasks": [
    {"title": "Implement auth", "points": 5},
    {"title": "Fix bugs", "points": 3}
  ]
}'
```

### execute_agent
Executes an agent with a specific goal.

**Parameters:**
- `name` (required): Agent name to execute
- `goal` (required): Goal for the agent to achieve

**Example:**
```bash
execute_agent "Project Manager" --goal "Plan the next sprint based on velocity"
```

**Expected Output:**
```
🤖 Agent: Project Manager
🎯 Goal: Plan the next sprint based on velocity

📊 Analyzing current velocity...
📋 Planning next sprint based on capacity...

✅ Sprint plan generated:
- Sprint capacity: 40 points
- Recommended stories: 8 items
- Estimated completion: 2025-08-30
```

## Portfolio Tools (6 tools)

These tools manage your personal and GitHub portfolio integration.

### portfolio_status
Check the status of your GitHub portfolio repository.

**Parameters:**
- `username` (optional): GitHub username to check portfolio for

**Example:**
```bash
portfolio_status
```

### init_portfolio
Initialize a new GitHub portfolio repository.

**Parameters:**
- `repository_name` (optional): Name for the portfolio repository
- `private` (optional): Whether to create a private repository
- `description` (optional): Repository description

**Example:**
```bash
init_portfolio --repository_name "my-ai-elements" --private true
```

### portfolio_config
Configure portfolio settings.

**Parameters:**
- `auto_sync` (optional): Enable automatic sync to GitHub
- `default_visibility` (optional): Default visibility ('public' or 'private')
- `auto_submit` (optional): Auto-submit elements to collection
- `repository_name` (optional): Default repository name

**Example:**
```bash
portfolio_config --auto_sync true --default_visibility private
```

### sync_portfolio
Sync your local portfolio with GitHub repository.

**Parameters:**
- `direction` (optional): Sync direction ('push', 'pull', or 'both')
- `force` (optional): Force sync even with conflicts
- `dry_run` (optional): Preview sync without executing

**Example:**
```bash
sync_portfolio --direction both --dry_run true
```

### search_portfolio
Search your local portfolio.

**Parameters:**
- `query` (required): Search query
- `type` (optional): Element type filter
- `fuzzy_match` (optional): Enable fuzzy matching
- `max_results` (optional): Maximum results to return
- `include_keywords` (optional): Include keyword matching
- `include_tags` (optional): Include tag matching
- `include_triggers` (optional): Include trigger matching
- `include_descriptions` (optional): Include description matching

**Example:**
```bash
search_portfolio "creative writing" --type personas --max_results 5
```

### search_all
Search across all sources (local, GitHub portfolio, collection).

**Parameters:**
- `query` (required): Search query
- `sources` (optional): Array of sources to search
- `type` (optional): Element type filter
- `page` (optional): Page number for pagination
- `page_size` (optional): Results per page
- `sort_by` (optional): Sort criteria

**Example:**
```bash
search_all "code review" --sources '["local", "github", "collection"]'
```

## Collection Tools (7 tools)

These tools integrate with the DollhouseMCP community collection and GitHub marketplace.

### browse_collection
Browse content from the DollhouseMCP collection by section and content type.

**Parameters:**
- `section` (optional): Collection section to browse ('library', 'showcase', 'catalog'). Leave empty to see all sections.
- `type` (optional): Content type within the library section: 'personas', 'skills', 'agents', or 'templates'. Only used when section is 'library'.

**Example:**
```bash
browse_collection --type skills
browse_collection --section library
```

**Expected Output:**
```
📚 DollhouseMCP Collection - Library/Skills

🎯 Code Reviewer (skill)
   Comprehensive code analysis and review
   📁 software-development | ⭐ 4.8 | 👤 dollhousemcp
   
🎯 Language Translator (skill)
   Multi-language translation assistance
   📁 communication | ⭐ 4.5 | 👤 community
   
🎯 Data Analyzer (skill)
   Statistical analysis and insights
   📁 data-science | ⭐ 4.7 | 👤 expert-user
```

### search_collection
Search for content in the collection by keywords.

**Parameters:**
- `query` (required): Search query for finding content. Examples: 'creative writer', 'explain like I'm five', 'coding assistant'.

**Example:**
```bash
search_collection "python programming"
search_collection "creative writing"
```

**Expected Output:**
```
🔍 Collection Search Results for "python programming"

🎯 Python Expert (skill)
   Advanced Python programming assistance
   📁 programming | ⭐ 4.9 | 👤 dollhousemcp
   
🎭 Python Developer (persona)
   Expert Python developer with best practices
   📁 development | ⭐ 4.7 | 👤 community
```

### search_collection_enhanced
Enhanced search for collection content with pagination, filtering, and sorting.

**Parameters:**
- `query` (required): Search query
- `elementType` (optional): Filter by content type ('personas', 'skills', 'agents', 'templates', 'tools', 'ensembles', 'memories', 'prompts')
- `category` (optional): Filter by category ('creative', 'professional', 'educational', 'personal', 'gaming')
- `page` (optional): Page number (default: 1)
- `pageSize` (optional): Results per page (default: 25, max: 100)
- `sortBy` (optional): Sort by 'relevance', 'name', or 'date'

**Example:**
```bash
search_collection_enhanced "creative writing" --elementType personas --category creative --page 1 --pageSize 10
```

### get_collection_content
View detailed information about collection content.

**Parameters:**
- `path` (required): Collection path to the element. Format: 'library/[type]/[element].md'

**Example:**
```bash
get_collection_content "library/skills/python-expert.md"
```

**Expected Output:**
```
📄 Python Expert (skill)
📍 Path: library/skills/python-expert.md
👤 Author: dollhousemcp
📅 Version: 2.1.0
⭐ Rating: 4.9/5.0

📝 Description:
Advanced Python programming assistance with best practices, debugging, and optimization techniques.

🏷️ Tags: python, programming, debugging, optimization
📁 Category: software-development

💾 Install this skill:
   install_content "library/skills/python-expert.md"
```

### install_content
Install AI customization elements from the collection to your local portfolio.

**Parameters:**
- `path` (required): Collection path to the element. Format: 'library/[type]/[element].md'

**Example:**
```bash
install_content "library/skills/code-reviewer.md"
install_content "library/personas/creative-writer.md"
```

**Expected Output:**
```
📥 Installing: Code Reviewer (skill)
📍 Source: library/skills/code-reviewer.md

✅ Successfully installed to local portfolio
📂 Location: ~/.dollhouse/portfolio/skills/code-reviewer.md
🎯 Ready to activate: activate_element "Code Reviewer" --type skills
```

### submit_content
Submit local content to the collection for community review.

**Parameters:**
- `content` (required): The content name or filename to submit

**Example:**
```bash
submit_content "Creative Writer"
submit_content "Code Review Helper"
```

**Expected Output:**
```
📤 Submitting: Creative Writer (persona)
🔍 Validating content...
📋 Creating submission...

✅ Submission created successfully!
🔗 Submission ID: #1234
📝 Review status: Pending community review
🕒 Estimated review time: 3-5 business days

You'll be notified when your submission is reviewed.
```

### get_collection_cache_health
Get health status and statistics for the collection cache system.

**Example:**
```bash
get_collection_cache_health
```

**Expected Output:**
```
🏥 Collection Cache Health Status

✅ Status: Healthy
📊 Cache size: 1,234 entries
💾 Memory usage: 45.2 MB / 100 MB
🔄 Last refresh: 2025-08-19 10:15:00 UTC
📈 Hit rate: 94.2%
🕒 Refresh interval: 30 minutes

📁 Content breakdown:
   • Personas: 456 cached
   • Skills: 789 cached
   • Templates: 234 cached
   • Agents: 123 cached
```

## Persona Export/Import Tools (5 tools)

**⚠️ Breaking Change**: 9 redundant PersonaTools were removed in v1.6.0. Only these 5 specialized tools remain:

> **Removed Tools** (use ElementTools instead):
> - `list_personas` → `list_elements type="personas"`
> - `activate_persona` → `activate_element name="name" type="personas"`
> - `get_active_persona` → `get_active_elements type="personas"`
> - `deactivate_persona` → `deactivate_element type="personas"`
> - `get_persona_details` → `get_element_details name="name" type="personas"`
> - `reload_personas` → `reload_elements type="personas"`
> - `create_persona` → Use ElementTools or server methods
> - `edit_persona` → Use ElementTools or server methods
> - `validate_persona` → Use ElementTools or server methods

The following tools provide unique functionality not available in ElementTools:


### export_persona
Export a single persona to JSON format.

**Parameters:**
- `persona` (required): The persona name or filename to export

**Example:**
```bash
export_persona "Creative Writer"
```

### export_all_personas
Export all personas to a JSON bundle.

**Parameters:**
- `includeDefaults` (optional): Include default personas in export (default: true)

**Example:**
```bash
export_all_personas --includeDefaults false
```

### import_persona
Import a persona from a file path or JSON string.

**Parameters:**
- `source` (required): File path to a .md or .json file, or a JSON string of the persona
- `overwrite` (optional): Overwrite if persona already exists (default: false)

**Example:**
```bash
import_persona "/path/to/persona.md" --overwrite true
```

### share_persona
Generate a shareable URL for a persona.

**Parameters:**
- `persona` (required): The persona name or filename to share
- `expiryDays` (optional): Number of days the share link is valid (default: 7)

**Example:**
```bash
share_persona "Creative Writer" --expiryDays 14
```

### import_from_url
Import a persona from a shared URL.

**Parameters:**
- `url` (required): The shared URL to import from
- `overwrite` (optional): Overwrite if persona already exists (default: false)

**Example:**
```bash
import_from_url "https://share.dollhousemcp.com/p/abc123" --overwrite false
```

## Auth Tools (4 tools)

These tools handle GitHub OAuth authentication for accessing advanced features.

### setup_github_auth
Set up GitHub authentication using OAuth device flow.

**Example:**
```bash
setup_github_auth
```

**Expected Output:**
```
🔐 GitHub Device Flow Authentication

To authenticate with GitHub:
1. Visit: https://github.com/login/device
2. Enter code: XXXX-XXXX
3. Authorize 'DollhouseMCP OAuth'

⏳ Waiting for authorization... (expires in 15 minutes)
```

### check_github_auth
Check current GitHub authentication status.

**Example:**
```bash
check_github_auth
```

**Expected Output (Authenticated):**
```
✅ Authenticated as: johndoe
📧 Email: john@example.com
🔑 Token: Stored securely (encrypted)
📅 Authenticated at: 2025-08-19T14:30:00Z
```

### clear_github_auth
Remove stored GitHub authentication credentials.

**Example:**
```bash
clear_github_auth
```

**Expected Output:**
```
✅ GitHub authentication cleared successfully

Your stored credentials have been removed. You'll need to authenticate again to use GitHub features.
```

### configure_oauth
Configure GitHub OAuth client ID for authentication.

**Parameters:**
- `client_id` (optional): GitHub OAuth client ID (starts with 'Ov23li')

**Example:**
```bash
configure_oauth "Ov23liABCDEF1234567890"
configure_oauth  # Show current configuration
```


## Config Tools (4 tools)

These tools configure system behavior and display settings.

### configure_indicator
Configure how active persona indicators are displayed.

**Parameters:**
- `enabled` (optional): Enable or disable persona indicators
- `style` (optional): Display style ('full', 'minimal', 'compact', or 'custom')
- `customFormat` (optional): Custom format string for style=custom
- `includeEmoji` (optional): Include emoji in indicator
- `includeBrackets` (optional): Wrap indicator in brackets
- `includeVersion` (optional): Include version in indicator
- `includeAuthor` (optional): Include author in indicator
- `includeCategory` (optional): Include category in indicator

**Example:**
```bash
configure_indicator --style minimal --includeEmoji true
configure_indicator --style custom --customFormat "{name} v{version}"
```

### get_indicator_config
Get current persona indicator configuration.

**Example:**
```bash
get_indicator_config
```

**Expected Output:**
```
🎨 Persona Indicator Configuration

✅ Enabled: true
🎯 Style: minimal
🎭 Include emoji: true
📦 Include brackets: false
🏷️ Include version: false
👤 Include author: false
📁 Include category: false

Example output: 🎭 Creative Writer
```

### configure_collection_submission
Configure automatic collection submission settings.

**Parameters:**
- `autoSubmit` (required): Enable automatic submission to DollhouseMCP collection after portfolio upload

**Example:**
```bash
configure_collection_submission --autoSubmit true
configure_collection_submission --autoSubmit false
```

### get_collection_submission_config
Get current collection submission configuration settings.

**Example:**
```bash
get_collection_submission_config
```

**Expected Output:**
```
📤 Collection Submission Configuration

🔄 Auto-submit: Enabled

When enabled, content uploaded to your portfolio will automatically
create a submission to the DollhouseMCP collection for community review.
```

## User Tools (3 tools)

These tools manage user identity for content attribution and collection participation.

### set_user_identity
Set your username for persona attribution and collection participation.

**Parameters:**
- `username` (required): Your username (alphanumeric, hyphens, underscores, dots)
- `email` (optional): Your email address

**Example:**
```bash
set_user_identity "johndoe" --email "john@example.com"
```

**Expected Output:**
```
✅ User identity set successfully

👤 Username: johndoe
📧 Email: john@example.com

Your identity will be used for element attribution and collection participation.
```

### get_user_identity
Get current user identity information.

**Example:**
```bash
get_user_identity
```

**Expected Output:**
```
👤 Current User Identity

Username: johndoe
📧 Email: john@example.com
📅 Set on: 2025-08-19T10:00:00Z

This identity is used for element attribution and collection participation.
```

### clear_user_identity
Clear user identity and return to anonymous mode.

**Example:**
```bash
clear_user_identity
```

**Expected Output:**
```
✅ User identity cleared successfully

You are now in anonymous mode. Elements you create will not be attributed to you.
```

## Build Info Tools (1 tool)

This tool provides system diagnostics and build information.

### get_build_info
Get comprehensive build and runtime information about the server.

**Example:**
```bash
get_build_info
```

**Expected Output:**
```
🔧 DollhouseMCP Build Information

📦 Version: 1.5.2
🏗️ Build: 2025.08.19.1430
🔄 Git Commit: abc1234 (main)
📅 Build Date: 2025-08-19T14:30:00Z

🖥️ Runtime Environment:
- Node.js: v20.11.0
- Platform: darwin x64
- Architecture: arm64
- Memory: 145MB used / 8GB total

📁 Installation:
- Type: npm package
- Location: /Users/johndoe/.dollhouse/mcp-server
- Portfolio: /Users/johndoe/.dollhouse/portfolio

🔧 Features:
✅ Element System
✅ Portfolio Management  
✅ GitHub Integration
✅ Collection Access
✅ OAuth Authentication

📊 Statistics:
- Elements loaded: 23
- Active elements: 3
- Cache entries: 1,234
- Uptime: 6h 45m
```

## Migration Guide References

For users upgrading from earlier versions, see these migration guides:

- **v1.5.x to v1.6.0**: [Portfolio System Migration](./MIGRATION_GUIDE_v1.6.0.md)
- **v1.4.x to v1.5.x**: [Element System Migration](./ELEMENT_MIGRATION_GUIDE.md) 
- **v1.3.x to v1.4.x**: [Collection Integration](./COLLECTION_MIGRATION.md)

## Tool Organization Summary

| Category | Count | Purpose |
|----------|-------|---------|
| Element Tools | 12 | Work with all element types |
| Persona Export/Import Tools | 5 | Specialized persona sharing and backup |
| Collection Tools | 7 | Community marketplace integration |
| Portfolio Tools | 6 | Personal and GitHub portfolio management |
| Auth Tools | 4 | GitHub OAuth authentication |
| Config Tools | 4 | System configuration |
| User Tools | 3 | User identity management |
| Build Info Tools | 1 | System diagnostics |
| **Total** | **42** | Complete MCP tool suite |

## Best Practices

1. **Use Modern Tools**: Prefer Element Tools over legacy Persona Tools
2. **Validate Content**: Use `validate_element` before important operations
3. **Set User Identity**: Configure identity for proper attribution with `set_user_identity`
4. **Manage Portfolios**: Use portfolio tools for organized element management
5. **Keep Elements Updated**: Regularly sync your portfolio and collection content
6. **Use Type Plurals**: Element types are plural (`personas`, `skills`, not `persona`, `skill`)

## Common Workflows

### Setting Up DollhouseMCP
```bash
# 1. Set your identity
set_user_identity "yourusername" --email "your@email.com"

# 2. Set up GitHub authentication (optional but recommended)
setup_github_auth

# 3. Initialize a portfolio (if using GitHub features)
init_portfolio --repository_name "my-ai-elements"

# 4. Browse available content
browse_collection --type personas
```

### Creating and Managing Elements
```bash
# Create a new persona
create_element --type personas --name "Research Assistant" \
  --description "Expert in academic research and analysis"

# Validate the element
validate_element "Research Assistant" --type personas --strict true

# Activate the persona
activate_element "Research Assistant" --type personas

# Check what's active
get_active_elements --type personas
```

### Working with Collections
```bash
# Search for content
search_collection "creative writing"

# View details about an element
get_collection_content "library/personas/creative-writer.md"

# Install to your portfolio
install_content "library/personas/creative-writer.md"

# Submit your own content
submit_content "My Custom Helper"
```

## Version History

- **v1.6.10**: Fixed version update script and improved release workflow reliability
- **v1.6.0**: 42 total tools (PersonaTools streamlined), portfolio management, enhanced search, build diagnostics
- **v1.5.0**: GitHub OAuth authentication with secure token storage  
- **v1.4.5**: Fixed Claude Desktop integration issues
- **v1.4.0**: NPM package distribution support
- **v1.3.3**: Full element system with generic tools
- **v1.3.0**: Portfolio structure introduced
- **v1.2.0**: Security enhancements
- **v1.1.0**: GitHub marketplace integration
- **v1.0.0**: Initial personas-only release

## Error Handling

### Common Error Scenarios

#### Element Not Found
```
❌ Error: Element 'MySkill' not found
```
**Solution**: Check spelling and use `list_elements --type skills` to see available elements.

#### Invalid Element Type
```
❌ Invalid element type 'skill'. Valid types: personas, skills, templates, agents, memories, ensembles
```
**Solution**: Use plural form (`skills`, not `skill`).

#### Authentication Required
```
❌ GitHub authentication required for this action
```
**Solution**: Run `setup_github_auth` to authenticate with GitHub.

#### Validation Errors
```
❌ Invalid element: Name cannot be empty
```
**Solution**: Provide all required fields when creating or editing elements.

#### Portfolio Not Initialized
```
❌ Portfolio not found. Initialize with 'init_portfolio'
```
**Solution**: Run `init_portfolio` to set up your GitHub portfolio.

### Response Formats

#### Success Response
```json
{
  "content": [{
    "type": "text", 
    "text": "✅ Operation completed successfully"
  }]
}
```

#### Error Response
```json
{
  "content": [{
    "type": "text",
    "text": "❌ Error: Element 'NonExistent' not found"
  }]
}
```

#### List Response
```json
{
  "content": [{
    "type": "text",
    "text": "🎯 Element Name (type)\n   Description\n   📁 category | ⭐ rating | 👤 author"
  }]
}
```

## See Also

- [Element Architecture](./ELEMENT_ARCHITECTURE.md)
- [Element Types](./ELEMENT_TYPES.md)
- [Developer Guide](./ELEMENT_DEVELOPER_GUIDE.md)
- [Portfolio Migration Guide](./MIGRATION_TO_PORTFOLIO.md)
- [Collection Integration Guide](./COLLECTION_INTEGRATION.md)
- [GitHub Authentication Setup](./GITHUB_AUTH_SETUP.md)

---

## Element Source Priority API (v1.10.0)

### Overview

The Element Source Priority API provides deterministic control over the order in which element sources are checked during search and installation operations. This ensures predictable behavior and allows users to customize which sources take precedence.

### ElementSource Enum

Defines the available element sources.

**TypeScript Definition:**
```typescript
enum ElementSource {
  /** Local portfolio (~/.dollhouse/portfolio/) */
  LOCAL = 'local',

  /** User's GitHub portfolio repository */
  GITHUB = 'github',

  /** DollhouseMCP community collection */
  COLLECTION = 'collection'
}
```

**Values:**
- `local` - Local portfolio on the filesystem
- `github` - User's GitHub dollhouse-portfolio repository
- `collection` - DollhouseMCP community collection

**Example:**
```typescript
import { ElementSource } from '@dollhousemcp/mcp-server';

const priority = [
  ElementSource.LOCAL,
  ElementSource.GITHUB,
  ElementSource.COLLECTION
];
```

### SourcePriorityConfig Interface

Configuration schema for source priority behavior.

**TypeScript Definition:**
```typescript
interface SourcePriorityConfig {
  /**
   * Ordered list of sources to check (first = highest priority)
   */
  priority: ElementSource[];

  /**
   * Stop searching after finding element in first source
   * @default true
   */
  stopOnFirst: boolean;

  /**
   * Check all sources for version comparison
   * @default false
   */
  checkAllForUpdates: boolean;

  /**
   * Try next source when current source fails
   * @default true
   */
  fallbackOnError: boolean;
}
```

**Fields:**
- `priority` - Array of ElementSource values in priority order
- `stopOnFirst` - Early termination optimization
- `checkAllForUpdates` - Always check all sources for latest version
- `fallbackOnError` - Resilience against source failures

**Example:**
```typescript
const config: SourcePriorityConfig = {
  priority: [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION],
  stopOnFirst: true,
  checkAllForUpdates: false,
  fallbackOnError: true
};
```

### UnifiedSearchOptions Interface

Extended search options with source priority controls.

**TypeScript Definition:**
```typescript
interface UnifiedSearchOptions {
  /** Search query string */
  query: string;

  /** Include local portfolio in search (default: true) */
  includeLocal?: boolean;

  /** Include GitHub portfolio in search (default: true) */
  includeGitHub?: boolean;

  /** Include collection in search (default: false) */
  includeCollection?: boolean;

  /** Filter by specific element type */
  elementType?: ElementType;

  /** Page number for pagination (default: 1) */
  page?: number;

  /** Number of results per page (default: 20) */
  pageSize?: number;

  /** Sort order for results (default: 'relevance') */
  sortBy?: 'relevance' | 'source' | 'name' | 'version';

  // Source priority options

  /**
   * Force search all enabled sources, ignoring stopOnFirst (default: false)
   *
   * When true, searches all enabled sources even if earlier sources return results.
   */
  includeAll?: boolean;

  /**
   * Prefer a specific source to search first
   *
   * Overrides the default priority order to search the specified source first.
   * Other sources are searched in default priority order after the preferred source.
   */
  preferredSource?: ElementSource;

  /**
   * Custom source priority order
   *
   * Completely overrides the default source priority order.
   * Sources are searched in the order specified.
   */
  sourcePriority?: ElementSource[];
}
```

**Example - Basic search:**
```typescript
const results = await unifiedIndex.search({
  query: 'creative-writer',
  includeLocal: true,
  includeGitHub: true,
  includeCollection: false
});
```

**Example - Search all sources:**
```typescript
const results = await unifiedIndex.search({
  query: 'code-reviewer',
  includeAll: true  // Don't stop at first match
});
```

**Example - Preferred source:**
```typescript
const results = await unifiedIndex.search({
  query: 'data-analyst',
  preferredSource: ElementSource.COLLECTION  // Check collection first
});
```

**Example - Custom priority:**
```typescript
const results = await unifiedIndex.search({
  query: 'api-helper',
  sourcePriority: [ElementSource.GITHUB, ElementSource.LOCAL, ElementSource.COLLECTION]
});
```

### Configuration Functions

#### getSourcePriorityConfig()

Retrieves the current source priority configuration.

**Signature:**
```typescript
function getSourcePriorityConfig(): SourcePriorityConfig
```

**Returns:** Current configuration (defaults, env vars, or config file)

**Configuration priority:**
1. Environment variable `SOURCE_PRIORITY` (for testing)
2. Config file `~/.dollhouse/config.yml`
3. Default configuration

**Example:**
```typescript
import { getSourcePriorityConfig } from '@dollhousemcp/mcp-server';

const config = getSourcePriorityConfig();
console.log(config.priority);  // [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION]
console.log(config.stopOnFirst);  // true
```

#### saveSourcePriorityConfig()

Saves source priority configuration to the config file.

**Signature:**
```typescript
async function saveSourcePriorityConfig(config: SourcePriorityConfig): Promise<void>
```

**Parameters:**
- `config` - Configuration to save

**Throws:**
- `Error` if configuration is invalid
- `Error` if save operation fails

**Example:**
```typescript
import { saveSourcePriorityConfig, ElementSource } from '@dollhousemcp/mcp-server';

await saveSourcePriorityConfig({
  priority: [ElementSource.GITHUB, ElementSource.LOCAL, ElementSource.COLLECTION],
  stopOnFirst: false,
  checkAllForUpdates: true,
  fallbackOnError: true
});
```

#### validateSourcePriority()

Validates a source priority configuration.

**Signature:**
```typescript
function validateSourcePriority(config: SourcePriorityConfig): ValidationResult
```

**Parameters:**
- `config` - Configuration to validate

**Returns:**
```typescript
interface ValidationResult {
  isValid: boolean;
  errors: string[];
}
```

**Validation checks:**
- Priority list is not empty
- No duplicate sources in priority list
- All sources are valid ElementSource values

**Example:**
```typescript
import { validateSourcePriority, ElementSource } from '@dollhousemcp/mcp-server';

const config = {
  priority: [ElementSource.LOCAL, ElementSource.GITHUB],
  stopOnFirst: true,
  checkAllForUpdates: false,
  fallbackOnError: true
};

const result = validateSourcePriority(config);
if (!result.isValid) {
  console.error('Validation errors:', result.errors);
}
```

#### getSourceDisplayName()

Gets user-friendly display name for an element source.

**Signature:**
```typescript
function getSourceDisplayName(source: ElementSource): string
```

**Parameters:**
- `source` - ElementSource to get display name for

**Returns:** Human-readable source name

**Throws:**
- `Error` if source is invalid

**Example:**
```typescript
import { getSourceDisplayName, ElementSource } from '@dollhousemcp/mcp-server';

console.log(getSourceDisplayName(ElementSource.LOCAL));       // "Local Portfolio"
console.log(getSourceDisplayName(ElementSource.GITHUB));      // "GitHub Portfolio"
console.log(getSourceDisplayName(ElementSource.COLLECTION));  // "Community Collection"
```

#### parseSourcePriorityOrder()

Parses source priority order from various input formats.

**Signature:**
```typescript
function parseSourcePriorityOrder(value: unknown): ElementSource[]
```

**Parameters:**
- `value` - Value to parse (array of sources or JSON string)

**Returns:** Array of ElementSource values

**Throws:**
- `Error` if value cannot be parsed
- `Error` if sources are invalid

**Example:**
```typescript
import { parseSourcePriorityOrder } from '@dollhousemcp/mcp-server';

// From array of strings
const order1 = parseSourcePriorityOrder(['local', 'github', 'collection']);

// From JSON string
const order2 = parseSourcePriorityOrder('["github", "local"]');

// From ElementSource values
const order3 = parseSourcePriorityOrder([ElementSource.LOCAL, ElementSource.GITHUB]);
```

### Configuration Tool Methods

#### dollhouse_config Tool

The `dollhouse_config` tool provides access to source priority configuration through the MCP interface.

**Get source priority configuration:**
```bash
mcp__DollhouseMCP__dollhouse_config \
  --action get \
  --setting source_priority
```

**Set source priority order:**
```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.priority \
  --value '["github", "local", "collection"]'
```

**Set stopOnFirst:**
```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.stopOnFirst \
  --value false
```

**Reset to defaults:**
```bash
mcp__DollhouseMCP__dollhouse_config \
  --action reset \
  --section source_priority
```

**Export configuration:**
```bash
mcp__DollhouseMCP__dollhouse_config \
  --action export \
  --format yaml
```

### Default Configuration

**Default source priority:**
```typescript
const DEFAULT_SOURCE_PRIORITY: SourcePriorityConfig = {
  priority: [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION],
  stopOnFirst: true,
  checkAllForUpdates: false,
  fallbackOnError: true
};
```

**Rationale:**
- **Local first**: User's local customizations take precedence
- **GitHub second**: User's synced elements from personal repository
- **Collection last**: Community elements as fallback
- **Early termination**: Faster searches by stopping at first match
- **No update checking**: Reduces network traffic and API calls
- **Fallback enabled**: Resilience against individual source failures

### Environment Variables

Override configuration for testing or CI/CD:

```bash
export SOURCE_PRIORITY='{"priority":["local","github","collection"],"stopOnFirst":true,"checkAllForUpdates":false,"fallbackOnError":true}'
```

### Configuration File

Source priority is stored in `~/.dollhouse/config.yml`:

```yaml
source_priority:
  priority:
    - local
    - github
    - collection
  stopOnFirst: true
  checkAllForUpdates: false
  fallbackOnError: true
```

### Search Behavior Examples

#### Example 1: Default behavior

```typescript
// Default: Check local → github → collection, stop at first match
const results = await unifiedIndex.search({
  query: 'creative-writer'
});

// Results from first source that has the element
```

#### Example 2: Search all sources

```typescript
// Check all sources to see all versions
const results = await unifiedIndex.search({
  query: 'creative-writer',
  includeAll: true
});

// Results from all sources (local, github, collection)
```

#### Example 3: Preferred source

```typescript
// Check collection first, then default order
const results = await unifiedIndex.search({
  query: 'creative-writer',
  preferredSource: ElementSource.COLLECTION
});

// Collection checked first, then local, then github
```

#### Example 4: Custom priority

```typescript
// Check github first, then local, skip collection
const results = await unifiedIndex.search({
  query: 'creative-writer',
  sourcePriority: [ElementSource.GITHUB, ElementSource.LOCAL]
});

// Only github and local checked, in that order
```

### Error Handling

**Invalid configuration:**
```typescript
try {
  await saveSourcePriorityConfig({
    priority: [],  // Invalid: empty array
    stopOnFirst: true,
    checkAllForUpdates: false,
    fallbackOnError: true
  });
} catch (error) {
  console.error('Configuration error:', error.message);
  // "Invalid source priority configuration: Priority list cannot be empty"
}
```

**Source failure with fallback:**
```typescript
const results = await unifiedIndex.search({
  query: 'creative-writer',
  includeLocal: true,
  includeGitHub: true,  // Fails (network error)
  includeCollection: true
});

// With fallbackOnError: true (default)
// GitHub fails → continues to collection → returns collection results

// With fallbackOnError: false
// GitHub fails → search fails with error
```

### Performance Characteristics

**Early termination (stopOnFirst: true):**
- Best case: O(1) - Element found in first source
- Average case: O(n/2) - Element in middle source
- Worst case: O(n) - Element in last source or not found

**Full search (stopOnFirst: false, includeAll: true):**
- Always O(n) - All sources searched
- Higher latency but complete results

**Recommendations:**
- Use `stopOnFirst: true` for typical searches
- Use `includeAll: true` when comparing versions
- Use `preferredSource` for known source locations
- Use custom `sourcePriority` for workflow-specific optimization

### Type Definitions

Complete TypeScript type definitions:

```typescript
export enum ElementSource {
  LOCAL = 'local',
  GITHUB = 'github',
  COLLECTION = 'collection'
}

export interface SourcePriorityConfig {
  priority: ElementSource[];
  stopOnFirst: boolean;
  checkAllForUpdates: boolean;
  fallbackOnError: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface UnifiedSearchOptions {
  query: string;
  includeLocal?: boolean;
  includeGitHub?: boolean;
  includeCollection?: boolean;
  elementType?: ElementType;
  page?: number;
  pageSize?: number;
  sortBy?: 'relevance' | 'source' | 'name' | 'version';
  includeAll?: boolean;
  preferredSource?: ElementSource;
  sourcePriority?: ElementSource[];
}

export function getSourcePriorityConfig(): SourcePriorityConfig;
export function saveSourcePriorityConfig(config: SourcePriorityConfig): Promise<void>;
export function validateSourcePriority(config: SourcePriorityConfig): ValidationResult;
export function getSourceDisplayName(source: ElementSource): string;
export function parseSourcePriorityOrder(value: unknown): ElementSource[];
```

### Migration Notes

See [Migration Guide](MIGRATION_GUIDE.md#migrating-to-source-priority-v1100) for upgrading from older versions.

---

