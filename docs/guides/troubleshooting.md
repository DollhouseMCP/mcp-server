# Day-2 Troubleshooting Guide

Use this guide when DollhouseMCP is already installed but something stops working—portfolio sync stalls, the Enhanced Capability Index feels stale, or automation fails. It focuses on post-install (“Day 2”) operations so you can stabilize the system without guesswork.

---

## 1. Triage First

Run these commands to capture the current state before making changes:

Ask your AI to run these, or call them via MCP-AQL:

```
"Show me the DollhouseMCP build info"
"Check my GitHub authentication status"
"Show my portfolio status"
"List all my personas"
"Show the DollhouseMCP logs"
```

Or directly via MCP-AQL:
```json
mcp_aql_read { "operation": "get_build_info" }
mcp_aql_read { "operation": "check_github_auth" }
mcp_aql_read { "operation": "portfolio_status" }
mcp_aql_read { "operation": "list_elements", "element_type": "persona" }
mcp_aql_read { "operation": "query_logs", "params": { "level": "error", "limit": 20 } }
```

Keep the output—support requests and bug reports should include it.

---

## 2. Keep the Portfolio Healthy

### 2.1 Verify Repository State
- `portfolio_status` — confirms the GitHub repository exists, is reachable, and reports element counts.  
- `sync_portfolio dry_run=true` — shows what would change without touching GitHub. Use this before every push/pull.

### 2.2 Back Up Before Risky Changes
Create a snapshot of the local portfolio (5–10 MB typically):
```bash
cd ~/.dollhouse
tar czf portfolio-backup-$(date +%Y%m%d-%H%M).tgz portfolio/
```
Store the archive somewhere safe. To restore, unpack it into `~/.dollhouse/`.

### 2.3 Recover From Corrupt Files
Symptoms: `portfolio_element_manager` fails to read an element or GitHub rejects uploads.
1. Run `validate_element` on the file.  
2. If YAML or encoding is broken, fix in your editor and run `reload_elements type="..."`.  
3. If the file is beyond repair, restore it from your GitHub repo:  
   ```bash
   portfolio_element_manager \
     operation="download" \
     element_name="element-slug" \
     element_type="personas" \
     options.force=true
   ```

### 2.4 Resolve Sync Conflicts
1. Pull remote changes first: `sync_portfolio direction="pull"`.  
2. Review the diff under `~/.dollhouse/portfolio` (Git is initialized automatically).  
3. Fix conflicts manually, then push: `sync_portfolio direction="push"`.  
4. As a last resort, overwrite with force: `sync_portfolio direction="push" force=true` (document why in your notes).

---

## 3. Enhanced Capability Index Maintenance

The capability index lives at `~/.dollhouse/portfolio/capability-index.yaml`. See [Enhanced Capability Index](../architecture/enhanced-index-architecture.md) for architecture details.

### 3.1 Quick Health Checks
- `get_relationship_stats` — verifies counts by relationship type; a sudden zero means the index needs rebuilding.  
- `find_similar_elements` / `search_by_verb` — if they return empty or irrelevant results, the index is stale.

### 3.2 Force a Rebuild
```bash
# Delete the file and let the server rebuild it automatically
rm ~/.dollhouse/portfolio/capability-index.yaml

# Then trigger a tool that reads the index
get_relationship_stats
```
The manager recreates the file on the next access. Watch the logs for “Enhanced Index operation completed”.

### 3.3 Adjust Performance & Limits
Configuration lives in `~/.dollhouse/portfolio/.config/index-config.json`. Common tweaks:
- `performance.maxSimilarityComparisons` — raise if you have hundreds of elements and want richer matches.
- `verbs.maxElementsPerVerb` — tune verb trigger output size.
After editing, restart the server or run any tool so the manager reloads the config. Keep a backup of the JSON file before editing.

### 3.4 Telemetry & Troubleshooting
- The manager logs messages tagged `EnhancedIndexManager`; search your runtime logs for that string to identify build failures or slow operations.  
- Developers extending the system can call `EnhancedIndexManager.exportMetrics('json')` from a Node REPL or test harness to inspect trigger metrics offline.

---

## 4. Authentication & OAuth

### 4.1 Common Fixes
- Re-authenticate cleanly:  
  ```bash
  clear_github_auth
  setup_github_auth
  ```  
- Ensure the token includes `public_repo` (or `repo` for private portfolios).  
- `oauth_helper_status verbose=true` shows whether the device flow is still running or blocked.

### 4.2 Device Flow Tips
- If the browser never opens, copy the verification URL from terminal output.  
- On shared machines, multiple logins can collide; run `clear_github_auth` before switching accounts.

---

## 5. Configuration Drift

### 5.1 Inspect and Compare
- `dollhouse_config action="get"` — capture the live configuration.  
- Save a snapshot before major changes: `dollhouse_config action="export" format="yaml" > config-$(date +%Y%m%d).yaml`.

### 5.2 Reset a Section
If sync settings get messy:
```bash
dollhouse_config action="reset" section="sync"
```
Then rerun `dollhouse_config action="wizard"` to reapply defaults interactively.

### 5.3 Detect Local Overrides
- Global config: `~/.dollhouse/config.yml`  
- Enhanced index config: `~/.dollhouse/portfolio/.config/index-config.json`  
Rename these files with a `.bak` suffix and rerun the wizard if you suspect corrupted YAML or experimental edits.

---

## 6. Filesystem & Permissions

### 6.1 Portfolio Directory Missing or Read-Only
```bash
mkdir -p ~/.dollhouse/portfolio
chmod -R u+rw ~/.dollhouse
```
Avoid running the server with `sudo`; mismatched ownership is a common cause of write failures.

### 6.2 Clearing Temp or Stale Locks
- Index lock file: `~/.dollhouse/portfolio/capability-index.yaml.lock`  
- Git lock: `~/.dollhouse/portfolio/.git/index.lock`  
Delete stale locks only when you are certain no process is rebuilding or syncing.

---

## 7. Network & API Reliability

### 7.1 Rate Limits
- Visit `https://api.github.com/rate_limit` while authenticated.  
- Switch to authenticated commands (`setup_github_auth`) to raise limits.  
- When the 429 window hits, wait; retrying aggressively prolongs the lockout.

### 7.2 Connectivity Checklist
```bash
ping github.com
curl -I https://api.github.com
```
If corporate proxies are involved, set `HTTPS_PROXY`/`HTTP_PROXY` before running DollhouseMCP.

---

## 8. Element Validation & Content Issues

### 8.1 YAML Frontmatter Errors
- Use `validate_element` to surface specific line numbers.  
- Ensure required fields (`name`, `description`, `version`, `author`) exist.  
- Quote strings containing colon (`:`), hash (`#`), or leading numbers.

### 8.2 Unicode & Encoding
- Elements must be UTF-8; convert mis-encoded files with your editor or `iconv`.  
- Replace smart quotes and unusual dash characters—these frequently trigger validation errors and render badly in terminals.

### 8.3 Large Files
- Keep elements under GitHub’s 100 MB hard cap; the sync tooling warns well before that.  
- For long-form content, split into multiple templates or move large assets to external storage and reference them from `references`.

---

## 9. Logging & Escalation

### 9.1 Query Logs via MCP-AQL

DollhouseMCP has built-in log querying. Ask your AI to check the logs:

```
"Show me recent DollhouseMCP errors"
"Query DollhouseMCP logs for the last 10 minutes"
```

Or directly:
```json
mcp_aql_read { "operation": "query_logs", "params": { "level": "error", "limit": 20 } }
mcp_aql_read { "operation": "query_logs", "params": { "level": "warn", "limit": 50 } }
```

### 9.2 Verbose Server Logs
For deeper debugging, run the server with verbose logging:
```bash
LOG_LEVEL=debug npx @dollhousemcp/mcp-server
```

Search for `ERROR`, `Gatekeeper`, `EnhancedIndex`, or `GitHub` to focus on the failing subsystem.

### 9.3 Prepare a Support Bundle
Gather:
1. Output from the triage commands in Section 1.  
2. Relevant log excerpts (10–20 lines around the error).  
3. Steps to reproduce and which elements or commands were involved.

### 9.4 Where to Ask
- GitHub Issues: [DollhouseMCP/mcp-server](https://github.com/DollhouseMCP/mcp-server/issues)  
- Documentation cross-reference:  
  - [Configuration Basics](configuration-basics.md)  
  - [Enhanced Capability Index](../architecture/enhanced-index-architecture.md)  
  - [Portfolio Setup Guide](portfolio-setup-guide.md)

Clear, complete reports help maintainers reproduce the problem quickly.

---

Keep this guide handy during regular operations. Updating it whenever you discover a new troubleshooting pattern prevents Day-2 surprises from recurring.
