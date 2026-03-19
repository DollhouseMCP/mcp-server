# GitHub Portfolio Sync Guide

Set up your GitHub portfolio repository to back up your Dollhouse elements, sync between machines, and submit content to the community collection.

> **Note**: Your local portfolio (`~/.dollhouse/portfolio/`) works immediately with no setup. This guide is for connecting it to GitHub for backup, sync, and community sharing. If you just want to create and use Dollhouse elements locally, you don't need any of this.

---

## 1. Prerequisites

- DollhouseMCP server installed and running (see [Quick Start](quick-start.md))
- GitHub account (OAuth setup is guided by the server)
- At least one local Dollhouse element, or access to the community collection

All portfolio operations use MCP-AQL. Ask your AI in natural language or use the operations directly:

| Operation | Endpoint | Purpose |
|-----------|----------|---------|
| `check_github_auth` | Read | Verify you are authenticated with GitHub |
| `setup_github_auth` | Create | Start the OAuth authentication flow |
| `init_portfolio` | Create | Create the GitHub portfolio repository |
| `portfolio_status` | Read | Inspect repository existence, element counts, and sync status |
| `portfolio_element_manager` | Create | Upload, download, list, or compare individual elements |
| `submit_collection_content` | Create | Share an element with the DollhouseMCP community |
| `sync_portfolio` | Create | Bulk sync between local portfolio and GitHub |

---

## 2. Quick Start (10 Minutes)

### Step 1 — Confirm Authentication

Ask your AI: "Check my GitHub authentication status"

Or directly:
```json
mcp_aql_read { "operation": "check_github_auth" }
```

If not authenticated:
```json
mcp_aql_create { "operation": "setup_github_auth" }
```

> **Expected result:** You'll see your GitHub username and authentication status. If authentication is needed, the server guides you through OAuth device flow.

### Step 2 — Create the Portfolio Repository

Ask your AI: "Initialize my portfolio repository"

```json
mcp_aql_create { "operation": "init_portfolio" }
mcp_aql_read { "operation": "portfolio_status" }
```

> **Expected result:** A new repository named `dollhouse-portfolio` is created in your GitHub account. `portfolio_status` shows the repository URL and element counts (initially 0).

### Step 3 — Install a Community Element

Ask your AI: "Install the creative writer persona from the collection"

```json
mcp_aql_create { "operation": "install_collection_content", "params": { "element_type": "persona", "element_name": "Creative-Writer" } }
```

> **Expected result:** The Creative Writer persona is installed to `~/.dollhouse/portfolio/personas/creative-writer.md`.

### Step 4 — Upload to GitHub

Ask your AI: "Upload the creative writer persona to my GitHub portfolio"

```json
mcp_aql_create { "operation": "portfolio_element_manager", "params": { "action": "push", "element_type": "persona", "element_name": "creative-writer" } }
```

> **Expected result:** The persona is uploaded to your GitHub portfolio repository.

### Step 5 — Optional Community Submission

Ask your AI: "Submit the creative writer persona to the community collection"

```json
mcp_aql_create { "operation": "submit_collection_content", "params": { "element_type": "persona", "element_name": "creative-writer" } }
```

> **Expected result:** A GitHub issue is created in the DollhouseMCP collection repository for review. You'll receive a link to the submission issue.

---

## 3. Repository Layout

`init_portfolio` seeds the following directories:

```
personas/
skills/
templates/
agents/
memories/
ensembles/
README.md
```

Each directory contains a `.gitkeep` so GitHub tracks the folder even while empty.

| Directory | Typical Content |
|-----------|-----------------|
| `personas/` | `creative-writer.md`, `technical-analyst.md` |
| `skills/` | `code-review.md`, `data-analysis.md` |
| `templates/` | `meeting-notes.md`, `project-update.md` |
| `agents/` | `code-reviewer.md`, `session-monitor.md` |
| `memories/` | `.yaml` structured context files |
| `ensembles/` | Bundled element combinations, team configurations |

---

## 4. Managing Elements

### List Remote Elements

```json
mcp_aql_create { "operation": "portfolio_element_manager", "params": { "action": "list" } }
```

### Download from GitHub

```json
mcp_aql_create { "operation": "portfolio_element_manager", "params": { "action": "pull", "element_type": "persona", "element_name": "creative-writer" } }
```

### Upload Updates

Increment your element's version, then:

```json
mcp_aql_create { "operation": "portfolio_element_manager", "params": { "action": "push", "element_type": "persona", "element_name": "creative-writer" } }
```

---

## 5. Syncing in Bulk

Use `sync_portfolio` when you need to reconcile many changes at once:

```json
// Preview what would be pushed (dry run)
mcp_aql_create { "operation": "sync_portfolio", "params": { "direction": "push", "dry_run": true } }

// Push local changes to GitHub (additive — never deletes)
mcp_aql_create { "operation": "sync_portfolio", "params": { "direction": "push", "mode": "additive" } }

// Pull GitHub changes to local (with confirmation)
mcp_aql_create { "operation": "sync_portfolio", "params": { "direction": "pull", "mode": "mirror" } }
```

Bulk operations are conservative by default — confirmation prompts and dry runs help you avoid accidental overwrites.

---

## 6. Browsing the Community Collection

Browse available elements before installing:

- **Web browser**: Visit [dollhousemcp.github.io/collection](https://dollhousemcp.github.io/collection/) or ask your AI to "open the portfolio browser"
- **From your AI**: "Browse the community collection for personas" or "Search the collection for code review"

```json
mcp_aql_read { "operation": "browse_collection", "params": { "section": "personas" } }
mcp_aql_read { "operation": "search_collection", "params": { "query": "code review" } }
```

---

## 7. Troubleshooting

### "Authentication required"
Ask your AI to "set up GitHub authentication" — it will guide you through the OAuth flow.

### "Element not found"
- Verify the element exists locally: "List all my personas"
- Confirm the element name matches the file's frontmatter `name`
- Element names are case-sensitive

### "Upload succeeded, but the file is missing on GitHub"
- Wait a few seconds and refresh the GitHub UI (there can be slight propagation delay)
- Check `portfolio_status` to confirm the upload was recorded

---

## 8. Related Guides

- [Quick Start](quick-start.md) — Install DollhouseMCP on your platform
- [Public Beta Onboarding](public-beta-onboarding.md) — Full walkthrough from install to first custom element
- [Troubleshooting](troubleshooting.md) — Common issues and diagnostics
