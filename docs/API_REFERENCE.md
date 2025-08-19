# DollhouseMCP API Reference

Complete reference for all MCP tools available in DollhouseMCP v1.6.0

## Overview

DollhouseMCP provides 56 MCP tools organized into these categories:
- **Element Tools**: Work with all element types (personas, skills, templates, agents, memories, ensembles)
- **Persona Tools**: Legacy tools for backward compatibility (being phased out)
- **Collection Tools**: GitHub marketplace integration and community content
- **Portfolio Tools**: Personal and GitHub portfolio management  
- **Auth Tools**: GitHub OAuth authentication
- **Config Tools**: System configuration and settings
- **User Tools**: User identity management
- **Build Info Tools**: System information and diagnostics

## Breaking Changes in v1.6.0

- **Tool Count**: Expanded from 40+ to 56 total tools
- **Portfolio System**: New portfolio management tools for local and GitHub synchronization
- **Enhanced Search**: Unified search across local, GitHub, and collection sources
- **Collection Enhancements**: Enhanced search with pagination and filtering
- **Build Information**: New build info tools for better system diagnostics

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

## Persona Tools (14 tools) - Legacy

**⚠️ These tools are maintained for backward compatibility but should be replaced with generic element tools.**

### list_personas
List all available personas. **Use `list_elements --type personas` instead.**

**Example:**
```bash
list_personas
```

### activate_persona  
Activate a specific persona by name. **Use `activate_element [name] --type personas` instead.**

**Parameters:**
- `persona` (required): The persona name or filename to activate

**Example:**
```bash
activate_persona "Professional Writer"
```

### get_active_persona
Get information about the currently active persona. **Use `get_active_elements --type personas` instead.**

**Example:**
```bash
get_active_persona
```

### deactivate_persona
Deactivate the current persona. **Use `deactivate_element [name] --type personas` instead.**

**Example:**
```bash
deactivate_persona
```

### get_persona_details
Get detailed information about a specific persona. **Use `get_element_details [name] --type personas` instead.**

**Parameters:**
- `persona` (required): The persona name or filename to get details for

**Example:**
```bash
get_persona_details "Creative Writer"
```

### reload_personas
Reload all personas from the personas directory. **Use `reload_elements --type personas` instead.**

**Example:**
```bash
reload_personas
```

### create_persona
Create a new persona with guided assistance. **Use `create_element --type personas` instead.**

**Parameters:**
- `name` (required): The display name for the persona
- `description` (required): A brief description of the persona
- `instructions` (required): The main instructions/prompt for the persona
- `triggers` (optional): Comma-separated list of trigger words

**Example:**
```bash
create_persona "Data Scientist" "Expert in data analysis" "You are an expert data scientist..."
```

### edit_persona
Edit an existing persona's properties. **Use `edit_element --type personas` instead.**

**Parameters:**
- `persona` (required): The persona name or filename to edit
- `field` (required): Field to edit (name, description, instructions, triggers, etc.)
- `value` (required): The new value for the field

**Example:**
```bash
edit_persona "Data Scientist" description "Advanced data analysis expert"
```

### validate_persona
Validate a persona's format. **Use `validate_element --type personas` instead.**

**Parameters:**
- `persona` (required): The persona name or filename to validate

**Example:**
```bash
validate_persona "Creative Writer"
```

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
| Persona Tools | 14 | Legacy compatibility (being phased out) |
| Collection Tools | 7 | Community marketplace integration |
| Portfolio Tools | 6 | Personal and GitHub portfolio management |
| Auth Tools | 4 | GitHub OAuth authentication |
| Config Tools | 4 | System configuration |
| User Tools | 3 | User identity management |
| Build Info Tools | 1 | System diagnostics |
| **Total** | **56** | Complete MCP tool suite |

## Best Practices

1. **Use Modern Tools**: Prefer Element Tools over legacy Persona Tools
2. **Validate Content**: Use `validate_element` before important operations
3. **Set User Identity**: Configure identity for proper attribution with `set_user_identity`
4. **Manage Portfolios**: Use portfolio tools for organized element management
5. **Stay Updated**: Regularly check for updates with `check_for_updates`
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

- **v1.6.0**: 56 total tools, portfolio management, enhanced search, build diagnostics
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

