# Migration Guide: DollhouseMCP v1.4.x to v1.6.0

This comprehensive guide helps users upgrade from DollhouseMCP v1.4.x to v1.6.0, including breaking changes, new features, and step-by-step migration instructions.

## Overview

Version 1.6.0 introduces significant enhancements including GitHub OAuth authentication, portfolio management, enhanced collection access, and improved serialization. Most features are backward-compatible, but there are some breaking changes to be aware of.

### What's New in v1.6.0?
- 🔐 **GitHub OAuth Integration**: Secure device flow authentication
- 📁 **Portfolio Management System**: 6 new tools for GitHub portfolio integration  
- 🔍 **Enhanced Collection Search**: Pagination, filtering, and anonymous access
- 📊 **Build Information Service**: Runtime and build info access
- 🚫 **Deprecated Tool Removal**: Marketplace aliases removed for performance
- 🔒 **Enhanced Security**: YAML bomb protection, Unicode normalization, audit logging

### What's Preserved?
- ✅ All existing personas and elements
- ✅ Existing file formats and structure
- ✅ Core MCP tools and workflows
- ✅ Configuration and environment variables
- ✅ Backward compatibility for most features

---

## Breaking Changes

### 1. Serialization Format Change

**Impact**: Elements now serialize to markdown/YAML format instead of JSON by default.

#### Before (v1.4.x)
```javascript
// serialize() returned JSON
const element = new PersonaElement(data);
const json = element.serialize(); // Returns JSON string
```

#### After (v1.6.0)
```javascript
// serialize() returns markdown with YAML frontmatter
const element = new PersonaElement(data);
const markdown = element.serialize(); // Returns markdown with YAML frontmatter
const json = element.serializeToJSON(); // For backward compatibility
```

#### How to Migrate
**For Code Using Serialization**:
- Replace `element.serialize()` calls with `element.serializeToJSON()` if you need JSON
- Update any parsing logic to handle the new markdown format
- The new format is GitHub-compatible and human-readable

**Migration Example**:
```javascript
// OLD CODE
const serialized = element.serialize();
const parsed = JSON.parse(serialized);

// NEW CODE (Option 1: Use backward compatibility)
const serialized = element.serializeToJSON();
const parsed = JSON.parse(serialized);

// NEW CODE (Option 2: Use new format)
const markdownContent = element.serialize();
// Parse YAML frontmatter if needed
```

### 2. Server Initialization Change

**Impact**: Portfolio initialization now happens in `run()` method instead of constructor.

#### Before (v1.4.x)
```javascript
// Portfolio was initialized in constructor
const server = new DollhouseMCPServer();
// Portfolio ready immediately
```

#### After (v1.6.0)
```javascript
// Portfolio initialization moved to run()
const server = new DollhouseMCPServer();
await server.run(); // Portfolio initialized here

// For tests: Use ensureInitialized()
await server.ensureInitialized();
```

#### How to Migrate
**For Test Code**:
- Add `await server.ensureInitialized()` before using portfolio features
- This ensures proper initialization without calling `run()`

**Migration Example**:
```javascript
// OLD TEST CODE
const server = new DollhouseMCPServer();
await server.createPersona(...); // Might fail

// NEW TEST CODE
const server = new DollhouseMCPServer();
await server.ensureInitialized(); // Add this line
await server.createPersona(...); // Now works
```

### 3. Deprecated Marketplace Tools Removed

**Impact**: 5 marketplace tool aliases have been removed for performance.

#### Removed Tools and Replacements
| Removed Tool | Replacement Tool |
|--------------|------------------|
| `browse_marketplace` | `browse_collection` |
| `search_marketplace` | `search_collection` |
| `get_marketplace_persona` | `get_collection_content` |
| `install_persona` | `install_content` |
| `submit_persona` | `submit_content` |

#### How to Migrate
**Update Scripts and Documentation**:
- Replace all marketplace tool references with collection equivalents
- Update any automation or documentation
- Functionality is identical, only names changed

### 4. PersonaTools Streamlined (Breaking Change)

**Impact**: 9 redundant PersonaTools have been removed, reducing total tools from 51 to 42.

#### Removed Tools and ElementTools Equivalents
| Removed Tool | Replacement |
|--------------|-------------|
| `list_personas` | `list_elements type="personas"` |
| `activate_persona` | `activate_element name="name" type="personas"` |
| `get_active_persona` | `get_active_elements type="personas"` |
| `deactivate_persona` | `deactivate_element type="personas"` |
| `get_persona_details` | `get_element_details name="name" type="personas"` |
| `reload_personas` | `reload_elements type="personas"` |
| `create_persona` | Use ElementTools or server methods |
| `edit_persona` | Use ElementTools or server methods |
| `validate_persona` | Use ElementTools or server methods |

#### How to Migrate
**Update All PersonaTools Usage**:
```bash
# OLD: Removed tools
list_personas
activate_persona persona="creative-writer"

# NEW: ElementTools equivalents
list_elements type="personas"
activate_element name="creative-writer" type="personas"
```

**Preserved PersonaTools** (5 tools remain for export/import functionality):
- `export_persona` - Export single persona to JSON
- `export_all_personas` - Export all personas to JSON bundle  
- `import_persona` - Import from file or JSON
- `share_persona` - Generate shareable URL
- `import_from_url` - Import from shared URL

> **📖 Complete Migration Guide**: See [PersonaTools Migration Guide](PERSONATOOLS_MIGRATION_GUIDE.md) for detailed step-by-step instructions.

### 5. Update Tools Removed

**Impact**: 5 update/maintenance tools have been completely removed from v1.6.0.

#### Removed Tools (No Replacement)
| Removed Tool | Purpose |
|--------------|---------|
| `check_for_updates` | Check for newer versions |
| `update_server` | Update to latest version |
| `rollback_update` | Rollback to previous version |
| `get_server_status` | Get server status and version info |
| `convert_to_git_installation` | Convert to git installation |

#### How to Migrate
**For Update Management**:
- Use standard npm/package manager commands for updates:
  ```bash
  npm install -g @dollhousemcp/mcp-server@latest
  ```
- Use `dollhousemcp --version` for version information
- Use process monitoring tools for server status
- Manual backup/restore procedures replace rollback functionality

**Note**: These tools were removed to simplify the server and reduce security surface area. Standard package management is now the recommended approach.

---

## New Features

### 1. Portfolio Management System

Six new tools for GitHub portfolio integration:

#### Core Tools
- **`portfolio_status`**: Check portfolio repository status
- **`init_portfolio`**: Create new GitHub portfolio repository
- **`portfolio_config`**: Configure portfolio settings
- **`sync_portfolio`**: Sync local changes to GitHub
- **`search_portfolio`**: Search your local portfolio
- **`search_all`**: Unified search across local, GitHub, and collection

#### Getting Started with Portfolio
```bash
# Check if you have a portfolio
portfolio_status

# Create a new portfolio (requires GitHub auth)
init_portfolio --repository_name "my-dollhouse-portfolio" --private false

# Configure automatic syncing
portfolio_config --auto_sync true --auto_submit false

# Sync your elements to GitHub
sync_portfolio --direction push
```

### 2. GitHub OAuth Integration

Secure device flow authentication without manual token management.

#### OAuth Tools
- **`setup_github_auth`**: Authenticate with GitHub via device flow
- **`check_github_auth`**: Verify authentication status
- **`clear_github_auth`**: Remove stored authentication

#### Setting Up GitHub Authentication
```bash
# Start OAuth flow
setup_github_auth

# Follow the displayed instructions:
# 1. Visit the provided URL
# 2. Enter the user code
# 3. Authorize DollhouseMCP

# Check authentication status
check_github_auth

# If needed, clear and re-authenticate
clear_github_auth
```

#### Security Features
- **AES-256-GCM encryption**: Tokens encrypted at rest
- **Machine-specific keys**: Encryption tied to your machine
- **Secure permissions**: Files use restrictive permissions (0o600)
- **Rate limiting**: Built-in protection against attacks

### 3. Enhanced Collection Search

Improved collection browsing with anonymous access and advanced features.

#### New Capabilities
- **Anonymous access**: Browse without authentication
- **Offline caching**: 24-hour TTL for offline browsing
- **Pagination**: Large result sets handled efficiently
- **Advanced filtering**: Multiple search criteria
- **Cache health monitoring**: Visibility into cache status

#### Using Enhanced Search
```bash
# Search with pagination
search_collection --query "creative writing" --page 1 --page_size 10

# Anonymous browsing (no auth required)
browse_collection

# Search with specific filters
search_collection --query "debug" --type "personas" --sort_by "relevance"
```

### 4. Build Information Service

Access runtime and build information for debugging and monitoring.

#### Build Info Tool
- **`get_build_info`**: Get comprehensive build and runtime information

#### Information Provided
- **Package info**: Name, version
- **Build details**: Git commit, branch, build type
- **Runtime info**: Node.js version, platform, memory usage
- **Environment**: Production/development mode, Docker status
- **Server stats**: Uptime, connection status

#### Using Build Info
```bash
# Get build information
get_build_info

# Returns formatted markdown with:
# - Package version and build details
# - Runtime environment information
# - Memory usage and uptime
# - Docker container status (if applicable)
```

---

## Tool Changes

### New Tools Added
- `portfolio_status` - Check portfolio repository status
- `init_portfolio` - Initialize GitHub portfolio
- `portfolio_config` - Configure portfolio settings
- `sync_portfolio` - Sync with GitHub
- `search_portfolio` - Search local portfolio
- `search_all` - Unified search across sources
- `setup_github_auth` - GitHub OAuth authentication
- `check_github_auth` - Check auth status
- `clear_github_auth` - Clear authentication
- `get_build_info` - Build and runtime information

### Deprecated Tools Removed
- `browse_marketplace` → `browse_collection`
- `search_marketplace` → `search_collection`
- `get_marketplace_persona` → `get_collection_content`
- `install_persona` → `install_content`
- `submit_persona` → `submit_content`

### Enhanced Tools
- **Collection tools**: Now work without authentication
- **Search tools**: Enhanced with pagination and filtering
- **Submission tools**: Improved rate limiting and security

---

## Configuration Changes

### New Environment Variables

#### OAuth Configuration
```bash
# GitHub OAuth Client ID (if using custom OAuth app)
export GITHUB_CLIENT_ID="your_client_id"
```

#### Portfolio Configuration
```bash
# Portfolio repository settings
export PORTFOLIO_AUTO_SYNC=true
export PORTFOLIO_DEFAULT_VISIBILITY=public
export PORTFOLIO_AUTO_SUBMIT=false
```

#### Collection Configuration
```bash
# Collection submission settings
export COLLECTION_SUBMISSION_ENABLED=true
export COLLECTION_AUTO_SUBMIT=false
```

### OAuth Setup Requirements

#### Prerequisites
1. **Node.js 20+**: Required for OAuth implementation
2. **Network access**: For GitHub API communication
3. **Web browser**: For OAuth device flow completion

#### Configuration Steps
1. **Use Default OAuth App** (Recommended):
   ```bash
   setup_github_auth
   # Uses DollhouseMCP's registered OAuth app
   ```

2. **Use Custom OAuth App** (Advanced):
   ```bash
   export GITHUB_CLIENT_ID="your_custom_client_id"
   setup_github_auth
   ```

---

## Step-by-Step Migration

### 1. Backup Existing Installation

```bash
# Backup your entire DollhouseMCP directory
cp -r ~/.dollhouse ~/.dollhouse.backup.$(date +%Y%m%d)

# Backup package.json if using local installation
cp package.json package.json.backup

# Backup any custom configurations
cp claude_desktop_config.json claude_desktop_config.json.backup
```

### 2. Update to v1.6.0

#### Global Installation
```bash
npm install -g @dollhousemcp/mcp-server@1.6.0
```

#### Local Installation
```bash
npm install @dollhousemcp/mcp-server@1.6.0
npm run build
```

#### Docker Installation
```bash
docker pull dollhousemcp/mcp-server:1.6.0
```

### 3. Run Migration Scripts

The server automatically handles migration:

```bash
# Start the server (triggers automatic migration)
dollhousemcp
# or
npm run start

# Check logs for migration status
# Migration happens automatically on first run
```

### 4. Update Configuration

#### Verify OAuth Setup
```bash
# Check if GitHub authentication is needed
check_github_auth

# If needed, set up authentication
setup_github_auth
```

#### Configure Portfolio (Optional)
```bash
# Check portfolio status
portfolio_status

# Initialize if desired
init_portfolio --repository_name "my-portfolio"

# Configure settings
portfolio_config --auto_sync false --default_visibility public
```

### 5. Test Critical Workflows

#### Test Basic Functionality
```bash
# List your personas using new ElementTools syntax
list_elements type="personas"

# Create a test element
create_element --type personas --name "Test Migration" --description "Testing v1.6.0"

# Test serialization (should work transparently)
get_element_details name="Test Migration" type="personas"
```

#### Test New Features
```bash
# Test collection access (should work without auth)
browse_collection

# Test build info
get_build_info

# Test portfolio if configured
search_portfolio --query "test"
```

#### Test Tool Replacements
```bash
# Use new collection tools instead of marketplace
search_collection --query "creative"  # instead of search_marketplace
browse_collection                     # instead of browse_marketplace
```

---

## Common Issues and Solutions

### 1. Serialization Errors

**Symptom**: Code that depends on JSON serialization fails
**Cause**: `serialize()` now returns markdown instead of JSON

**Solution**:
```javascript
// Change this:
const data = element.serialize();
const parsed = JSON.parse(data); // Fails

// To this:
const data = element.serializeToJSON();
const parsed = JSON.parse(data); // Works
```

### 2. Authentication Setup Problems

**Symptom**: Portfolio features fail with auth errors
**Cause**: GitHub authentication not configured

**Solutions**:
```bash
# Check current auth status
check_github_auth

# Set up authentication
setup_github_auth

# If OAuth flow fails, try clearing and retry
clear_github_auth
setup_github_auth
```

**Troubleshooting OAuth**:
- Ensure stable internet connection
- Use a modern web browser
- Check firewall isn't blocking GitHub access
- Try incognito/private browsing mode

### 3. Portfolio Initialization Issues

**Symptom**: Tests fail with "portfolio not initialized" errors
**Cause**: Portfolio initialization moved to `run()` method

**Solution**:
```javascript
// In test code, add:
beforeEach(async () => {
  await server.ensureInitialized();
});

// Or before specific tests:
await server.ensureInitialized();
```

### 4. Tool Not Found Errors

**Symptom**: "Tool not found" errors for marketplace tools
**Cause**: Marketplace aliases removed in v1.6.0

**Solution**:
Update tool names:
```bash
# Change this:
browse_marketplace

# To this:
browse_collection
```

### 5. Collection Access Failures

**Symptom**: Collection browsing fails
**Cause**: Network issues or cache problems

**Solutions**:
```bash
# Collection tools now work without auth
browse_collection

# If issues persist, check network connectivity
# Collection uses cached data when offline
```

---

## Testing Your Migration

### 1. Verify Successful Migration

#### Basic Functionality Check
```bash
# Verify server starts
dollhousemcp --version
# Should show 1.6.0

# Test basic operations using ElementTools syntax
list_elements type="personas"
create_element --type personas --name "Migration Test" --description "Test persona"
```

#### Feature Verification
```bash
# Test new build info
get_build_info
# Should show version 1.6.0

# Test collection access (works without auth)
browse_collection

# Test enhanced search
search_collection --query "creative" --page 1 --page_size 5
```

### 2. Verify Tool Updates

#### Check Deprecated Tools
```bash
# These should NOT work:
browse_marketplace    # Should fail
search_marketplace    # Should fail

# These should work:
browse_collection     # Should succeed
search_collection     # Should succeed
```

### 3. Test OAuth Flow (Optional)

```bash
# Only if you want portfolio features
setup_github_auth
check_github_auth
portfolio_status
```

### 4. Performance Verification

```bash
# Server should start faster (marketplace aliases removed)
time dollhousemcp --help

# Collection browsing should work offline
# Disconnect internet, then:
browse_collection  # Should work with cached data
```

---

## How to Rollback if Needed

### 1. Stop Current Server
```bash
# Stop DollhouseMCP server
killall dollhousemcp
# or use Ctrl+C if running in foreground
```

### 2. Restore Previous Version

#### Global Installation Rollback
```bash
npm install -g @dollhousemcp/mcp-server@1.4.5
```

#### Local Installation Rollback
```bash
npm install @dollhousemcp/mcp-server@1.4.5
npm run build
```

### 3. Restore Configuration
```bash
# Restore backed up configurations
cp claude_desktop_config.json.backup claude_desktop_config.json
cp package.json.backup package.json
```

### 4. Clean OAuth Data (if needed)
```bash
# Remove OAuth tokens if causing issues
rm -rf ~/.dollhouse/.oauth/
```

### 5. Verify Rollback
```bash
dollhousemcp --version
# Should show 1.4.5

# Test basic functionality
# Note: list_personas was removed - use ElementTools
list_elements type="personas"  # Use new syntax
```

**Note**: Your data is safe during rollback - only the server version changes.

---

## Post-Migration Optimization

### 1. Configure Portfolio Management

If you plan to use portfolio features:

```bash
# Set up GitHub authentication
setup_github_auth

# Initialize portfolio
init_portfolio --repository_name "my-dollhouse-portfolio"

# Configure auto-sync
portfolio_config --auto_sync true --auto_submit false
```

### 2. Update Scripts and Automation

Replace deprecated marketplace tools:

```bash
# Update any scripts using:
sed -i 's/browse_marketplace/browse_collection/g' your-script.sh
sed -i 's/search_marketplace/search_collection/g' your-script.sh
sed -i 's/get_marketplace_persona/get_collection_content/g' your-script.sh
sed -i 's/install_persona/install_content/g' your-script.sh
sed -i 's/submit_persona/submit_content/g' your-script.sh
```

### 3. Take Advantage of New Features

#### Anonymous Collection Access
- Browse without authentication
- Faster startup (no auth required)
- Offline capability with caching

#### Enhanced Search
- Use pagination for large result sets
- Filter by element type
- Sort by relevance or other criteria

#### Build Information
- Monitor server health
- Debug deployment issues
- Track runtime metrics

### 4. Security Best Practices

#### OAuth Tokens
- Tokens are automatically encrypted at rest
- Use `clear_github_auth` if changing machines
- Regularly verify auth status with `check_github_auth`

#### Rate Limiting
- Anonymous submissions limited to 5/hour
- 10-second minimum delay between submissions
- Authenticated users have higher limits

---

## Performance Improvements

### 1. Faster Server Startup
- **5 fewer tools**: Marketplace aliases removed
- **Reduced memory usage**: Less tool registration overhead
- **Faster MCP initialization**: Streamlined tool registry

### 2. Enhanced Collection Performance
- **Caching**: 24-hour TTL reduces API calls
- **Offline capability**: Works without network
- **Pagination**: Large result sets handled efficiently

### 3. OAuth Efficiency
- **Token persistence**: No repeated authentication
- **Machine-specific encryption**: Secure and fast
- **Rate limit awareness**: Prevents API throttling

---

## Migration Checklist

### Pre-Migration
- [ ] Backup ~/.dollhouse directory
- [ ] Backup package.json and configs
- [ ] Note current version: `dollhousemcp --version`
- [ ] Document current tool usage
- [ ] Test basic functionality

### Migration
- [ ] Update to v1.6.0
- [ ] Start server to trigger auto-migration
- [ ] Verify no error messages in logs
- [ ] Test basic persona/element operations
- [ ] Update any custom scripts

### Post-Migration
- [ ] Verify version: `dollhousemcp --version` shows 1.6.0
- [ ] Test deprecated tool replacements
- [ ] Set up GitHub OAuth (optional)
- [ ] Initialize portfolio (optional)
- [ ] Test new collection features
- [ ] Update documentation/scripts
- [ ] Remove backup files (after verification)

### Optional Advanced Features
- [ ] Configure portfolio auto-sync
- [ ] Set up collection submission workflow
- [ ] Test unified search capabilities
- [ ] Monitor build info for debugging

---

## Frequently Asked Questions

### Q: Will my existing personas stop working?
**A**: No, all personas continue to work exactly as before. The migration is designed to be seamless.

### Q: Do I need to set up GitHub OAuth?
**A**: Only if you want portfolio features. Collection browsing now works without authentication.

### Q: What happened to marketplace tools?
**A**: They were renamed to "collection" tools for clarity. Functionality is identical:
- `browse_marketplace` → `browse_collection`
- `search_marketplace` → `search_collection`
- etc.

### Q: Is the new serialization format compatible with v1.4.x?
**A**: The new format is markdown-based for GitHub compatibility. Use `serializeToJSON()` for backward compatibility.

### Q: Can I use both old and new tools?
**A**: Most old tools still work, but marketplace aliases were removed. Use collection tools instead.

### Q: How do I access the collection without GitHub?
**A**: Collection tools now work anonymously! Use `browse_collection` or `search_collection` without authentication.

### Q: What if OAuth setup fails?
**A**: Try `clear_github_auth` then `setup_github_auth` again. Ensure stable internet and modern browser.

### Q: Can I rollback if something goes wrong?
**A**: Yes, install the previous version: `npm install -g @dollhousemcp/mcp-server@1.4.5`

### Q: Do I need to reconfigure Claude Desktop?
**A**: No, existing Claude Desktop configurations continue to work unchanged.

### Q: What's the performance impact?
**A**: v1.6.0 is faster due to removed marketplace aliases (5 fewer tools) and optimized collection caching.

---

## Support and Resources

### Documentation
- **API Reference**: `/docs/API_REFERENCE.md`
- **Architecture Guide**: `/docs/ARCHITECTURE.md`
- **Security Guide**: `/docs/SECURITY.md`
- **Portfolio Setup**: `/docs/guides/PORTFOLIO_SETUP_GUIDE.md`
- **OAuth Setup**: `/docs/setup/OAUTH_SETUP.md`

### Getting Help
1. **Check logs**: Look for error messages during migration
2. **Verify setup**: Use `get_build_info` to check installation
3. **Test basics**: Ensure core functionality works
4. **GitHub Issues**: Report problems with detailed logs
5. **Community**: Share experiences and solutions

### Useful Commands
```bash
# Comprehensive system check
get_build_info

# Check all authentication
check_github_auth

# Verify portfolio setup
portfolio_status

# Test collection access
browse_collection

# Performance check
time dollhousemcp --help
```

---

## Summary

DollhouseMCP v1.6.0 introduces powerful new features while maintaining backward compatibility for core functionality. The migration includes:

### Major Enhancements
- **GitHub OAuth Integration**: Secure, user-friendly authentication
- **Portfolio Management**: Full GitHub repository integration
- **Enhanced Collection Access**: Anonymous browsing with caching
- **Improved Security**: YAML bomb protection, Unicode normalization
- **Better Performance**: Faster startup, optimized tool registry

### Breaking Changes (Minimal)
- Serialization format change (backward compatibility via `serializeToJSON()`)
- Server initialization timing (tests need `ensureInitialized()`)
- Marketplace tool removal (replaced with collection tools)

### Migration Benefits
- **Faster performance**: Reduced tool count, better caching
- **Enhanced security**: Multiple security improvements
- **Better UX**: Anonymous access, improved OAuth flow
- **GitHub integration**: Full portfolio sync capabilities
- **Future-ready**: Foundation for advanced features

The migration process is designed to be smooth and non-disruptive. Most users can update and continue working immediately, with new features available when needed.

Welcome to DollhouseMCP v1.6.0! 🎉