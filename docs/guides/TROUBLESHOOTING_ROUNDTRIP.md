# Troubleshooting Roundtrip Workflow

**Solutions for common issues in the DollhouseMCP roundtrip workflow**

## Quick Diagnostic Commands

Before diving into specific issues, run these commands to gather diagnostic information:

```
# Check overall system status
get_server_status

# Check authentication
check_github_auth

# Check portfolio status  
portfolio_status

# List local elements
list_elements

# Check configuration
portfolio_config
```

---

## Phase 1: Collection Browsing Issues

### "Cannot connect to collection"

**Symptoms**: `browse_collection` fails with connection errors

**Diagnosis**:
```
# Test basic connectivity
browse_collection

# Check internet connection
ping github.com
```

**Solutions**:
1. **Check internet connection**: Ensure stable internet access
2. **Check GitHub status**: Visit [githubstatus.com](https://githubstatus.com) 
3. **Wait and retry**: GitHub API has rate limits - wait a few minutes
4. **Check authentication**: Run `check_github_auth` - some API calls require auth

### "No results found" when browsing

**Symptoms**: `browse_collection` returns empty results

**Diagnosis**:
```
# Try different queries
browse_collection type="personas"
browse_collection type="skills"
search_collection "test"
```

**Solutions**:
1. **Check collection repository**: Visit [DollhouseMCP/collection](https://github.com/DollhouseMCP/collection)
2. **Try different element types**: The collection might not have content in all categories yet
3. **Use search instead**: `search_collection` may find results when browsing doesn't
4. **Check for typos**: Ensure correct spelling in type filters

### Search returns unexpected results

**Symptoms**: `search_collection "term"` returns irrelevant results

**Diagnosis**:
```
# Try more specific terms
search_collection "creative writing"
search_collection "code review"
```

**Solutions**:
1. **Use more specific terms**: Instead of "code", try "code review" or "programming"
2. **Try different keywords**: Search descriptions and metadata, not just names
3. **Browse by category**: Use `browse_collection type="skills"` for focused results
4. **Check collection content**: Results depend on what's actually in the collection

---

## Phase 2: Installation Issues

### "Element not found" during installation

**Symptoms**: `install_element` fails with "not found" error

**Diagnosis**:
```
# Verify the element exists
browse_collection 
search_collection "element-name"
get_collection_content "library/skills/element-name.md"
```

**Solutions**:
1. **Check exact path**: Ensure the path matches exactly what's shown in `browse_collection`
2. **Include file extension**: Path should end with `.md`
3. **Check collection structure**: Use `browse_collection` to find the correct path
4. **Try alternative paths**: Element might be in different directory than expected

### "Permission denied" during installation

**Symptoms**: Cannot write to local portfolio directory

**Diagnosis**:
```
# Check portfolio directory permissions
ls -la ~/.dollhouse/portfolio/
```

**Solutions**:
```bash
# Fix directory permissions
chmod -R u+w ~/.dollhouse/portfolio/

# Create directory if missing
mkdir -p ~/.dollhouse/portfolio/skills/
mkdir -p ~/.dollhouse/portfolio/personas/
```

### Elements install but don't appear

**Symptoms**: `install_element` succeeds but `list_elements` doesn't show the element

**Diagnosis**:
```
# Check if files exist
ls -la ~/.dollhouse/portfolio/skills/
ls -la ~/.dollhouse/portfolio/personas/

# Force reload elements
reload_elements
```

**Solutions**:
1. **Reload elements**: Run `reload_elements` to refresh the cache
2. **Check file contents**: Ensure installed files have proper YAML frontmatter
3. **Validate format**: Run `validate_element` on the installed element
4. **Check directory**: Ensure element was installed to correct directory for its type

---

## Phase 3: Local Customization Issues

### Cannot edit elements

**Symptoms**: `edit_element` fails or doesn't open editor

**Diagnosis**:
```
# Check element exists
get_element_details "element-name" type="skills"

# Check permissions
ls -la ~/.dollhouse/portfolio/skills/element-name.md
```

**Solutions**:
1. **Check file permissions**: Ensure file is writable
2. **Use correct element name**: Match exact name from `list_elements`
3. **Specify type**: Include `type="skills"` parameter
4. **Check file format**: Ensure file has valid YAML frontmatter

### Validation fails after editing

**Symptoms**: `validate_element` reports errors after customization

**Common Validation Errors**:

#### Invalid YAML frontmatter
```yaml
# ❌ Wrong - missing quotes
name: My Skill Name
version: 1.0.0

# ✅ Correct - properly quoted
name: "My Skill Name"
version: "1.0.0"
```

#### Missing required fields
```yaml
# ❌ Wrong - missing description
---
name: "My Skill"
---

# ✅ Correct - includes description
---
name: "My Skill"
description: "What this skill does"
---
```

#### Invalid version format
```yaml
# ❌ Wrong - not semantic versioning
version: 1.0

# ✅ Correct - semantic versioning
version: "1.0.0"
```

**Solutions**:
1. **Check YAML syntax**: Use a YAML validator
2. **Include required fields**: Ensure name, description are present
3. **Use semantic versioning**: Format as "major.minor.patch"
4. **Quote string values**: Put strings in quotes to avoid parsing issues

### Version conflicts

**Symptoms**: Version numbers don't update correctly

**Diagnosis**:
```
# Check current version
get_element_details "element-name" type="skills"
```

**Solutions**:
1. **Manual version update**: Specify version explicitly: `edit_element "name" type="skills" version="1.1.0"`
2. **Check version format**: Use semantic versioning (1.0.0, 1.1.0, 2.0.0)
3. **Avoid version conflicts**: Don't reuse version numbers
4. **Clear cache**: Run `reload_elements` if versions seem cached

---

## Phase 4: Portfolio Management Issues

### GitHub Authentication Problems

#### "Authentication failed"
**Symptoms**: `check_github_auth` shows not authenticated

**Diagnosis**:
```
check_github_auth
```

**Solutions**:
```
# Clear and re-authenticate
clear_github_auth
setup_github_auth

# Follow the device flow:
# 1. Copy the user code shown
# 2. Visit https://github.com/login/device  
# 3. Enter the code and authorize
```

#### "Invalid token" errors
**Symptoms**: Authentication appears successful but API calls fail

**Solutions**:
1. **Regenerate OAuth**: Run `clear_github_auth` then `setup_github_auth`
2. **Check token expiration**: Tokens may have expired
3. **Verify scopes**: Token needs `repo`, `user`, and `workflow` scopes
4. **Wait and retry**: May be temporary API issues

### Portfolio Initialization Issues

#### "Repository already exists"
**Symptoms**: `init_portfolio` fails because repository name is taken

**Solutions**:
```
# Option 1: Use existing repository  
portfolio_status

# Option 2: Use different name
init_portfolio repository_name="my-dollhouse-portfolio-v2"

# Option 3: Delete existing (⚠️ DATA LOSS)
# Only if you're sure you want to start over!
```

#### "Permission denied creating repository"
**Symptoms**: Cannot create repository on GitHub

**Diagnosis**:
```
check_github_auth
```

**Solutions**:
1. **Check authentication**: Ensure you're authenticated with proper scopes
2. **Check rate limits**: GitHub API has rate limits - wait before retrying
3. **Check account status**: Ensure GitHub account is in good standing
4. **Try different repository name**: Current name might violate GitHub policies

### Sync Issues

#### "Nothing to sync"
**Symptoms**: `sync_portfolio` reports no changes when you expect changes

**Diagnosis**:
```
# Check what's different
sync_portfolio dry_run=true direction="push"

# Check local status
list_elements

# Check portfolio status
portfolio_status
```

**Solutions**:
1. **Check for uncommitted changes**: Elements might not be staged for sync
2. **Force reload**: Run `reload_elements` then try sync again
3. **Verify element modifications**: Check that elements were actually changed
4. **Check configuration**: Ensure `auto_sync` isn't interfering

#### "Sync conflicts"
**Symptoms**: Local and remote changes conflict

**Solutions**:
```
# Pull remote changes first
sync_portfolio direction="pull"

# Review conflicts and resolve manually
# Then push resolved changes
sync_portfolio direction="push"

# Or force push (⚠️ overwrites remote)
sync_portfolio direction="push" force=true
```

#### "Push rejected"
**Symptoms**: Cannot push changes to GitHub

**Common causes and solutions**:
1. **Authentication expired**: Re-run `setup_github_auth`
2. **No push permissions**: Check repository permissions
3. **Branch protection**: Repository may have branch protection rules
4. **Large files**: GitHub has file size limits (100MB per file)

---

## Phase 5: Collection Submission Issues

### Submission to Portfolio Fails

#### "Element not found for submission"
**Symptoms**: `submit_content` can't find the element

**Diagnosis**:
```
# Verify element exists locally
list_elements
get_element_details "element-name" type="skills"
```

**Solutions**:
1. **Check element name**: Use exact name from `list_elements`
2. **Specify element type**: Include type parameter if needed
3. **Reload elements**: Run `reload_elements` if element was recently created
4. **Check validation**: Ensure element passes `validate_element`

#### "Upload failed"  
**Symptoms**: Element validation passes but upload to GitHub fails

**Diagnosis**:
```
portfolio_status
check_github_auth
```

**Solutions**:
1. **Check authentication**: Re-run `setup_github_auth` if needed
2. **Check portfolio exists**: Run `init_portfolio` if needed
3. **Check internet connection**: Ensure stable connection to GitHub
4. **Try manual sync**: Use `sync_portfolio direction="push"` to debug

### Collection Issue Creation Problems  

#### "Auto-submit failed"
**Symptoms**: Element uploads to portfolio but collection issue isn't created

**Diagnosis**:
```
portfolio_config
```

**Solutions**:
1. **Check auto_submit setting**: Should be `true` for automatic submission
2. **Check authentication**: Collection issues require GitHub authentication
3. **Check rate limits**: GitHub API may be rate-limited
4. **Use manual submission**: Set `auto_submit=false` and use provided link

#### "Issue creation permission denied"
**Symptoms**: Can't create issues in collection repository

**Solutions**:
1. **This is expected**: Users cannot create issues directly in collection repository
2. **Use proper workflow**: The system creates issues via automation, not direct user access
3. **Check auto_submit**: Must be enabled for automatic issue creation
4. **Wait for processing**: Automated issue creation may have delays

---

## Authentication Deep Dive

### OAuth Device Flow Issues

#### "Device authorization pending" never completes

**Symptoms**: `setup_github_auth` gets stuck at "waiting for authorization"

**Diagnosis**:
```
# Check if helper process is running
ps aux | grep oauth-helper

# Check log files
cat ~/.dollhouse/oauth-helper.log 2>/dev/null || echo "No log file found"
```

**Solutions**:
1. **Complete authorization**: Ensure you completed the browser authorization
2. **Check browser**: Visit https://github.com/login/device and enter the code
3. **Wait longer**: Authorization can take up to 5 minutes
4. **Restart process**: Cancel and re-run `setup_github_auth`
5. **Check network**: Ensure stable internet connection

#### "Invalid client_id" 

**Symptoms**: GitHub rejects the OAuth client ID

**Solutions**:
1. **This shouldn't happen**: DollhouseMCP uses a pre-configured OAuth app
2. **Check for configuration**: Ensure `DOLLHOUSE_GITHUB_CLIENT_ID` isn't set incorrectly
3. **Clear environment**: Unset custom OAuth environment variables
4. **Update server**: Ensure you're using the latest version

### Token Storage Issues

#### "Cannot save authentication"

**Symptoms**: Authentication succeeds but doesn't persist

**Diagnosis**:
```
# Check dollhouse directory permissions
ls -la ~/.dollhouse/
```

**Solutions**:
```bash
# Create directory if missing
mkdir -p ~/.dollhouse/

# Fix permissions
chmod 700 ~/.dollhouse/

# Clear any corrupted auth files
rm -f ~/.dollhouse/github-auth.json
```

#### "Corrupted token storage"

**Symptoms**: `check_github_auth` shows errors about token decryption

**Solutions**:
```
# Clear corrupted auth and re-authenticate
clear_github_auth
setup_github_auth
```

---

## File System Issues

### Permission Problems

#### "Cannot create portfolio directory"

**Solutions**:
```bash
# Create directory with correct permissions
mkdir -p ~/.dollhouse/portfolio/
chmod 755 ~/.dollhouse/portfolio/

# Create element type directories
mkdir -p ~/.dollhouse/portfolio/{personas,skills,templates,agents,memory,ensembles}
```

#### "Cannot write elements"

**Solutions**:
```bash
# Fix portfolio permissions
chmod -R u+w ~/.dollhouse/portfolio/

# Fix ownership (if needed)
sudo chown -R $USER ~/.dollhouse/
```

### Disk Space Issues

#### "No space left on device"

**Diagnosis**:
```bash
df -h ~/.dollhouse/
```

**Solutions**:
1. **Clean up old backups**: Remove unnecessary backup files
2. **Archive old elements**: Move unused elements to external storage
3. **Free disk space**: Clean up other large files on your system

---

## Network and API Issues

### GitHub API Rate Limiting

#### "Rate limit exceeded"

**Symptoms**: API calls fail with 429 status

**Solutions**:
1. **Wait**: GitHub rate limits reset hourly
2. **Authenticate**: Authenticated requests have higher rate limits
3. **Batch operations**: Avoid rapid sequential API calls
4. **Check usage**: Visit https://api.github.com/rate_limit (while authenticated)

### Connection Problems

#### "Network unreachable" 

**Diagnosis**:
```bash
# Test basic connectivity
ping github.com
curl -I https://api.github.com/
```

**Solutions**:
1. **Check internet connection**: Ensure stable connectivity
2. **Check firewall**: Ensure GitHub API access isn't blocked
3. **Try different network**: Test on different internet connection
4. **Check proxy settings**: Corporate networks may require proxy configuration

---

## Element Format Issues

### YAML Parsing Errors

Common YAML frontmatter issues and fixes:

#### Unquoted strings with special characters
```yaml
# ❌ Problem
name: My Skill: Advanced Edition

# ✅ Solution
name: "My Skill: Advanced Edition"
```

#### Invalid multiline strings
```yaml
# ❌ Problem  
description: This is a long
description that spans
multiple lines

# ✅ Solution
description: |
  This is a long
  description that spans
  multiple lines
```

#### Missing required fields
```yaml
# ❌ Problem - missing fields
---
name: "My Element"
---

# ✅ Solution - includes required fields
---
name: "My Element"
description: "What this element does"
version: "1.0.0"
author: "username"
---
```

### Content Validation Errors

#### Unicode/special character issues
**Symptoms**: Elements with emoji or special characters fail validation

**Solutions**:
1. **Use standard quotes**: Replace smart quotes with regular quotes
2. **Escape special characters**: Use backslashes where needed
3. **Check encoding**: Ensure files are UTF-8 encoded
4. **Test validation**: Use `validate_element` to catch issues early

#### Large content issues
**Symptoms**: Very large elements fail to process

**Solutions**:
1. **Split large elements**: Break into smaller, focused pieces
2. **Use references**: Link to external resources instead of embedding
3. **Optimize content**: Remove unnecessary content or formatting
4. **Check limits**: GitHub has file size limits (100MB per file)

---

## Advanced Troubleshooting

### Debug Mode

Enable detailed logging for troubleshooting:

```bash
# Enable debug logging
export DEBUG=dollhouse:*
export LOG_LEVEL=debug

# Run commands with verbose output
npx @dollhousemcp/mcp-server --debug
```

### Log File Analysis

Check log files for detailed error information:

```bash
# System logs (location varies by OS)
# macOS:
tail -f ~/Library/Logs/Claude/mcp-server.log

# Linux:
tail -f ~/.local/share/Claude/logs/mcp-server.log  

# Windows:
tail -f %APPDATA%\Claude\Logs\mcp-server.log
```

### Manual Portfolio Inspection

Directly inspect portfolio files:

```bash
# Navigate to portfolio
cd ~/.dollhouse/portfolio/

# Check Git status
git status
git log --oneline -5

# Inspect element files
ls -la skills/
head skills/my-element.md
```

### API Testing

Test GitHub API access directly:

```bash
# Test authentication (requires valid token)
curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/user

# Test repository access
curl -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/yourusername/dollhouse-portfolio
```

---

## Getting Help

If you've tried the solutions in this guide and still have issues:

### Before Asking for Help

Gather this diagnostic information:

1. **System info**: Run `get_server_status`
2. **Authentication status**: Run `check_github_auth`  
3. **Portfolio status**: Run `portfolio_status`
4. **Error messages**: Copy exact error messages
5. **Steps to reproduce**: Document what you were doing when the error occurred

### Where to Get Help

1. **GitHub Issues**: [DollhouseMCP/mcp-server/issues](https://github.com/DollhouseMCP/mcp-server/issues)
2. **Documentation**: Check other docs in this directory
3. **Community**: Engage with other users in issue discussions

### Creating Good Bug Reports

When reporting issues, include:

- **DollhouseMCP version**: From `get_server_status`
- **Operating system**: macOS, Windows, Linux version
- **Node.js version**: Output of `node --version`
- **Exact error message**: Copy/paste the full error
- **Steps to reproduce**: Numbered list of actions that cause the error
- **Expected behavior**: What should have happened
- **Diagnostic output**: Results from the commands above

---

## Prevention Tips

### Regular Maintenance

1. **Keep updated**: Regularly update DollhouseMCP server
2. **Monitor status**: Periodically run `portfolio_status` and `check_github_auth`
3. **Backup important elements**: Keep copies of critical customizations
4. **Test after changes**: Validate elements after significant modifications

### Best Practices

1. **Start simple**: Begin with small changes and test frequently
2. **Use validation**: Always run `validate_element` before submitting
3. **Keep good commit messages**: Help track what changes were made
4. **Monitor rate limits**: Don't make rapid API calls
5. **Stay authenticated**: Re-authenticate before long sessions

---

**🔧 Still having issues?** The troubleshooting process is iterative. Start with the diagnostic commands, work through the relevant sections, and don't hesitate to ask for help with specific error messages and system details.