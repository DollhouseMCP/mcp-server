# DollhouseMCP User Guide

## Table of Contents
- [Understanding Element Sources and Priority](#understanding-element-sources-and-priority)
  - [What are Element Sources?](#what-are-element-sources)
  - [How Source Priority Works](#how-source-priority-works)
  - [When to Customize Source Priority](#when-to-customize-source-priority)
  - [Viewing Current Configuration](#viewing-current-configuration)
  - [Modifying Source Priority](#modifying-source-priority)
  - [Common Use Cases](#common-use-cases)
  - [Troubleshooting](#troubleshooting)

---

## Understanding Element Sources and Priority

### What are Element Sources?

DollhouseMCP can access elements from three different locations, called "sources":

1. **Local Portfolio** - Elements stored on your computer in `~/.dollhouse/portfolio/`
   - Your personal workspace
   - Fastest access (no network required)
   - Full control and privacy
   - Automatically created when you install DollhouseMCP

2. **GitHub Portfolio** - Elements in your personal GitHub repository
   - Your synced elements in a `dollhouse-portfolio` repository
   - Accessible from any device
   - Version controlled with git
   - Optional backup and sharing

3. **Community Collection** - Elements in the public DollhouseMCP collection
   - Shared by the community
   - Curated and tested
   - Read-only (you can install but not modify directly)
   - Available at `github.com/DollhouseMCP/collection`

### How Source Priority Works

When you search for an element or install an element, DollhouseMCP checks sources in a specific order called "source priority". The default priority is:

**Local Portfolio → GitHub Portfolio → Community Collection**

Here's how it works step-by-step:

1. **Local Portfolio is checked first**
   - If found → element is used immediately
   - Your local customizations always take priority
   - Fastest because no network access needed

2. **GitHub Portfolio is checked second**
   - Only checked if not found locally
   - Your personal synced elements
   - Requires GitHub authentication

3. **Community Collection is checked last**
   - Only checked if not found in local or GitHub
   - Public shared elements
   - Fallback to community contributions

**Why this order?**
- Your local customizations should never be overridden by remote versions
- Searching stops at first match for better performance
- You maintain full control over which version is used
- Duplicates are automatically detected

### When to Customize Source Priority

**The default priority works for 99% of users**, but you may want to customize if:

- **You primarily work with community elements**: Prioritize collection to discover new elements first
- **You want to always use latest GitHub versions**: Prioritize GitHub over local to prefer synced versions
- **You're developing elements**: Test collection versions without installing locally
- **You have specific workflow needs**: Match your mental model of where elements should come from

### Viewing Current Configuration

To see your current source priority configuration, use the `dollhouse_config` tool:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action get \
  --setting source_priority
```

**Example output:**
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

**What these settings mean:**
- **priority**: The order sources are checked (first = highest priority)
- **stopOnFirst**: Stop searching after finding element in first source
- **checkAllForUpdates**: Check all sources to find latest version
- **fallbackOnError**: Try next source if current source fails

### Modifying Source Priority

#### Change Priority Order

To change which source is checked first:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.priority \
  --value '["github", "local", "collection"]'
```

This would prioritize GitHub Portfolio over Local Portfolio.

#### Disable Early Termination

To search all sources even after finding a match:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.stopOnFirst \
  --value false
```

This is useful when you want to see all versions across all sources.

#### Enable Update Checking

To always check all sources for the latest version:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.checkAllForUpdates \
  --value true
```

This overrides `stopOnFirst` to ensure you see if newer versions exist elsewhere.

#### Reset to Defaults

To restore the default configuration:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action reset \
  --section source_priority
```

### Common Use Cases

#### Use Case 1: Always Use Latest GitHub Versions

**Scenario**: You want elements from your GitHub portfolio to override local customizations.

**Why**: You work across multiple machines and want GitHub to be the source of truth.

**Solution**: Prioritize GitHub over local:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.priority \
  --value '["github", "local", "collection"]'
```

**Result**: When searching, GitHub versions are returned first, even if you have local versions.

---

#### Use Case 2: Compare Versions Across Sources

**Scenario**: You want to see all versions of an element to compare them.

**Why**: You modified an element locally but want to see if the community version has improvements.

**Solution**: Search with `includeAll` option:

When searching through MCP tools, use search options that include all sources:

```javascript
// When calling search functions through MCP
{
  "query": "creative-writer",
  "includeLocal": true,
  "includeGitHub": true,
  "includeCollection": true,
  "includeAll": true  // Don't stop at first match
}
```

**Result**: You'll see results from all three sources with version information.

---

#### Use Case 3: Install from Specific Source

**Scenario**: You want to install a community element even though you have a local version.

**Why**: You want to test the community version without deleting your local customizations.

**Solution**: Use `preferredSource` in search options:

```javascript
// When installing through MCP tools
{
  "query": "creative-writer",
  "preferredSource": "collection"  // Force collection to be checked first
}
```

**Result**: The collection version is found and installed, your local version remains untouched.

---

#### Use Case 4: Discover Community Elements

**Scenario**: You want to browse community elements without interference from your local portfolio.

**Why**: You want to see what's available in the collection.

**Solution**: Search with only collection enabled:

```javascript
// When browsing collection
{
  "query": "*",  // or specific search term
  "includeLocal": false,
  "includeGitHub": false,
  "includeCollection": true
}
```

**Result**: Only collection elements are returned.

---

#### Use Case 5: Offline Development

**Scenario**: You're working without internet and want faster searches.

**Why**: No need to wait for network timeouts.

**Solution**: Configure priority to only check local:

```bash
mcp__DollhouseMCP__dollhouse_config \
  --action set \
  --setting source_priority.priority \
  --value '["local"]'
```

Or search with only local enabled:

```javascript
{
  "query": "code-reviewer",
  "includeLocal": true,
  "includeGitHub": false,
  "includeCollection": false
}
```

**Result**: Searches only check local portfolio, no network access required.

### Troubleshooting

#### Q: I modified an element locally but search still returns the old version

**Possible causes:**
1. Source priority is misconfigured (local is not first)
2. Local index is stale
3. Element filename doesn't match

**Solutions:**
1. Verify source priority order:
   ```bash
   mcp__DollhouseMCP__dollhouse_config --action get --setting source_priority
   ```
   Ensure local is first in the priority array.

2. Reload elements to rebuild index:
   ```bash
   mcp__DollhouseMCP__reload_elements --type personas
   ```

3. Check element filename matches expected name:
   ```bash
   ls ~/.dollhouse/portfolio/personas/
   ```

---

#### Q: Installation says "already exists" but I don't see the element

**Possible causes:**
1. Element exists in local portfolio
2. Element is in a different type directory
3. Filename doesn't match display name

**Solutions:**
1. List all local elements:
   ```bash
   mcp__DollhouseMCP__list_elements --type personas
   ```

2. Use force installation to overwrite:
   - When installing, specify force option to replace existing element

3. Delete local element first if you want fresh installation:
   ```bash
   mcp__DollhouseMCP__delete_element --name "element-name" --type personas
   ```

---

#### Q: Search is slower after upgrading

**Possible causes:**
1. Checking multiple sources sequentially
2. Network latency to GitHub or collection
3. Cache not enabled

**Solutions:**
1. Verify `stopOnFirst` is enabled for faster searches:
   ```bash
   mcp__DollhouseMCP__dollhouse_config --action get --setting source_priority.stopOnFirst
   ```
   Should be `true` for best performance.

2. Check network connectivity:
   - Searches to GitHub and collection require internet
   - Consider local-only searches for offline work

3. Rebuild indexes to ensure cache is fresh:
   ```bash
   mcp__DollhouseMCP__reload_elements --type personas
   ```

---

#### Q: Element not found but I know it exists

**Possible causes:**
1. Source is not included in search
2. Source priority excludes the source
3. Element type mismatch
4. Authentication issue (for GitHub)

**Solutions:**
1. Try searching all sources:
   ```javascript
   {
     "query": "element-name",
     "includeLocal": true,
     "includeGitHub": true,
     "includeCollection": true,
     "includeAll": true
   }
   ```

2. Check element type is correct:
   - Personas, skills, templates, agents, memories, ensembles
   - Element might be in a different type directory

3. Verify GitHub authentication (if searching GitHub portfolio):
   ```bash
   mcp__DollhouseMCP__check_github_auth
   ```

4. Check collection cache is up to date:
   ```bash
   mcp__DollhouseMCP__get_collection_cache_health
   ```

---

#### Q: Duplicate elements appearing in search results

**Possible causes:**
1. `stopOnFirst` is disabled
2. `includeAll` is enabled
3. Same element exists in multiple sources

**Solutions:**
1. Enable early termination:
   ```bash
   mcp__DollhouseMCP__dollhouse_config \
     --action set \
     --setting source_priority.stopOnFirst \
     --value true
   ```

2. This is expected behavior when `includeAll: true`:
   - Use version information to distinguish between sources
   - Choose the version you want to use

3. To see which sources have the element:
   - Search with `includeAll: true` to see all versions
   - Check version numbers and last modified dates
   - Delete duplicates you don't want

---

## Advanced Configuration

### Configuration File Location

Source priority configuration is stored in:
- **macOS/Linux**: `~/.dollhouse/config.yml`
- **Windows**: `%USERPROFILE%\.dollhouse\config.yml`

### Environment Variables

For testing or CI/CD, you can override configuration with environment variables:

```bash
export SOURCE_PRIORITY='{"priority":["local","github","collection"],"stopOnFirst":true,"checkAllForUpdates":false,"fallbackOnError":true}'
```

### Configuration Priority

Configuration is loaded in this order (highest priority first):
1. Runtime override (search options)
2. Config file (`~/.dollhouse/config.yml`)
3. Environment variables
4. Default configuration

---

## Related Documentation

- [API Reference](API_REFERENCE.md) - Detailed API documentation for source priority
- [Developer Guide](DEVELOPER_GUIDE.md) - Extending source priority system
- [Migration Guide](MIGRATION_GUIDE.md) - Upgrading from older versions
- [Troubleshooting](guides/TROUBLESHOOTING_ROUNDTRIP.md) - General troubleshooting guide

---

## Glossary

- **Source**: A location where elements can be stored (local, GitHub, collection)
- **Priority**: The order in which sources are checked
- **Early termination**: Stopping search after first match (stopOnFirst)
- **Preferred source**: Temporary override to check a specific source first
- **Custom priority**: User-defined source order
- **Fallback**: Trying next source when current source fails

---

*Last updated: 2025-11-06*
*Version: 1.10.0*
