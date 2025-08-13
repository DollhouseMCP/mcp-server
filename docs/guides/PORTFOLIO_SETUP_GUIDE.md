# Portfolio Setup Guide

**Complete guide to setting up your GitHub portfolio for DollhouseMCP elements**

## What is a Portfolio?

Your DollhouseMCP portfolio is your personal GitHub repository where you store, version, and share your AI customization elements. Think of it as:

- **Your AI Toolbox**: A organized collection of personas, skills, templates, and agents
- **Version Control**: Full Git history of your element modifications and improvements  
- **Public Showcase**: Share your best elements with the community
- **Collaboration Hub**: Work with others on shared element development

## Prerequisites

Before setting up your portfolio, ensure you have:

### Required
- [x] **DollhouseMCP Server**: Installed and running (`npm install -g @dollhousemcp/mcp-server`)
- [x] **GitHub Account**: Free account at [github.com](https://github.com)
- [x] **Internet Connection**: For GitHub API access

### Recommended  
- [x] **Git Knowledge**: Basic understanding of Git and GitHub workflows
- [x] **GitHub CLI** (optional): For advanced repository management (`gh` command)
- [x] **Code Editor**: For editing elements outside of the chat interface

---

## Quick Setup (5 Minutes)

For users who want to get started immediately:

### Step 1: Check Authentication Status
```
check_github_auth
```

If not authenticated, proceed to authenticate:
```
setup_github_auth
```

### Step 2: Initialize Portfolio
```
init_portfolio
```

### Step 3: Configure Settings
```
portfolio_config auto_sync=true auto_submit=false
```

### Step 4: Verify Setup
```
portfolio_status
```

**Done!** Your portfolio is ready. Skip to [First Portfolio Submission](#first-portfolio-submission) to start using it.

---

## Detailed Setup Process

For users who want to understand each step and customize their setup:

### Phase 1: GitHub Authentication

#### Option A: OAuth Setup (Recommended)

The easiest way to authenticate with GitHub:

```
setup_github_auth
```

This will:
1. Display a user code (like `AB12-CD34`)
2. Open your browser to https://github.com/login/device
3. Prompt you to enter the code and authorize DollhouseMCP
4. Store your authentication securely

#### Option B: Manual Token Setup (Advanced Users)

For users who prefer manual token management:

1. **Create a Personal Access Token**:
   - Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Click "Generate new token (classic)"
   - Select scopes: `repo`, `user`, `workflow`
   - Generate and copy the token

2. **Configure the token**:
   ```bash
   export GITHUB_TOKEN="your_token_here"
   ```

#### Verify Authentication

Regardless of which method you used:
```
check_github_auth
```

You should see: `✅ Authenticated as: yourusername`

### Phase 2: Portfolio Initialization

#### Basic Portfolio Setup

Create a standard portfolio with default settings:

```
init_portfolio
```

This creates a repository named `dollhouse-portfolio` with:
- Public visibility
- Standard directory structure
- Comprehensive README
- Element type directories (personas/, skills/, etc.)

#### Custom Portfolio Setup

For users who want specific configurations:

```
init_portfolio repository_name="my-ai-toolkit" private=false description="My custom AI element collection"
```

Parameters:
- **repository_name**: Name for your portfolio repository
- **private**: `true` for private, `false` for public repository
- **description**: Repository description shown on GitHub

#### Verify Repository Creation

Check that your portfolio was created successfully:

```
portfolio_status
```

You should see:
- Repository URL (like `https://github.com/yourusername/dollhouse-portfolio`)
- Element counts (initially 0)
- Sync status
- Configuration details

### Phase 3: Configuration

#### Essential Configuration

Set up your portfolio behavior:

```
portfolio_config auto_sync=true auto_submit=false default_visibility="public"
```

**Configuration Options:**

| Setting | Description | Recommended |
|---------|-------------|-------------|
| `auto_sync` | Automatically push changes to GitHub | `true` - keeps everything in sync |
| `auto_submit` | Auto-create collection issues | `false` - gives you control over submissions |  
| `default_visibility` | Default for new repositories | `"public"` - enables community sharing |

#### Advanced Configuration

Customize additional settings based on your workflow:

```
portfolio_config repository_name="ai-elements" auto_sync=true auto_submit=true
```

For users who want automated submission workflow:
- **auto_submit=true**: Automatically creates collection issues when you submit elements
- **auto_submit=false**: Gives you manual control and review before submission

### Phase 4: First Portfolio Test

#### Add Some Default Elements

If you have existing elements in your local portfolio, sync them:

```
list_elements
sync_portfolio direction="push"
```

#### Create a Test Element  

Create your first portfolio element to test the workflow:

```
create_element type="skill" name="portfolio-test" description="Testing my portfolio setup"
```

#### Submit to Portfolio

Upload your test element:

```
submit_content "portfolio-test"
```

#### Verify on GitHub

1. Visit your portfolio repository URL (shown in `portfolio_status`)
2. Navigate to the `skills/` directory
3. Find your `portfolio-test.md` file
4. Check the commit history shows your submission

---

## Repository Structure

Your initialized portfolio will have this structure:

```
dollhouse-portfolio/
├── README.md                 # Portfolio overview and index
├── .github/
│   └── workflows/           # GitHub Actions for automation
│       └── validate-elements.yml
├── personas/                # AI personality profiles
├── skills/                  # Discrete capabilities  
├── templates/              # Reusable content structures
├── agents/                 # Autonomous assistants
│   └── .state/            # Agent state storage
├── memory/                # Persistent context storage
│   └── .storage/         # Memory data files
├── ensembles/             # Element combinations
└── .dollhouse/           # Metadata and configuration
    ├── config.json       # Portfolio settings
    └── index.json        # Element index
```

### Directory Purposes

| Directory | Contains | Example Elements |
|-----------|----------|------------------|
| `personas/` | AI personality and behavior profiles | creative-writer.md, technical-analyst.md |
| `skills/` | Specific capabilities and expertise | code-reviewer.md, data-analyst.md |  
| `templates/` | Reusable content structures | email-template.md, report-format.md |
| `agents/` | Goal-oriented autonomous assistants | project-manager.md, research-assistant.md |
| `memory/` | Persistent context and knowledge | conversation-history.md, learning-notes.md |
| `ensembles/` | Coordinated element combinations | full-stack-dev.md, content-team.md |

---

## First Portfolio Submission

Now that your portfolio is set up, let's walk through your first element submission:

### Step 1: Find or Create an Element

Option A - Install from collection:
```
browse_collection type="skills"
install_element "library/skills/creative-writing.md"
```

Option B - Create your own:
```  
create_element type="skill" name="my-expertise" description="My specialized skill"
```

### Step 2: Customize (Optional)

Edit the element to make it your own:
```
get_element_details "my-expertise" type="skills"
edit_element "my-expertise" type="skills" version="1.1.0"
validate_element "my-expertise" type="skills"
```

### Step 3: Submit to Portfolio

Upload to your GitHub repository:
```
submit_content "my-expertise"
```

### Step 4: Verify Submission

Check it worked:
```
portfolio_status
```

Visit your GitHub repository to see the element was uploaded with:
- Proper file structure
- Metadata preservation
- Commit message with details
- Updated README index

### Step 5: Optional - Submit to Collection

If you want to share with the community:
```
# Manual submission (gives you control)
portfolio_config auto_submit=false
submit_content "my-expertise"
# Follow the provided link to create collection issue

# Or automatic submission  
portfolio_config auto_submit=true
submit_content "my-expertise"
# Issue created automatically
```

---

## Authentication Troubleshooting

### Common Authentication Issues

#### "GitHub OAuth client ID is not configured"

**Cause**: DollhouseMCP needs a GitHub OAuth app configured.

**Solution**: 
1. For most users, this happens automatically with the public DollhouseMCP OAuth app
2. If self-hosting, follow the [OAuth Setup Guide](../setup/OAUTH_SETUP.md)

#### "Authentication failed"

**Cause**: Network issues or expired credentials.

**Solution**:
```
# Clear existing auth and try again
clear_github_auth
setup_github_auth
```

#### "Permission denied" errors

**Cause**: Token doesn't have sufficient permissions.

**Solution**:
```  
# Check what permissions you have
check_github_auth

# If using manual tokens, ensure scopes include:
# - repo (full repository access)
# - user (user profile access)  
# - workflow (GitHub Actions access)
```

### Verification Commands

Test your authentication setup:

```
# Check auth status
check_github_auth

# Test API access
portfolio_status

# Test repository creation (safe - won't create if exists)
init_portfolio repository_name="test-portfolio" 
```

---

## Repository Troubleshooting

### "Repository already exists"

If you see this error when running `init_portfolio`:

**Option 1 - Use existing repository**:
```
portfolio_status  # Should show your existing repository
```

**Option 2 - Create with different name**:
```
init_portfolio repository_name="dollhouse-portfolio-v2"
```

**Option 3 - Delete and recreate** (⚠️ DATA LOSS WARNING):
```bash
# Only do this if you're sure!
gh repo delete yourusername/dollhouse-portfolio --confirm
init_portfolio
```

### "Permission denied" on repository operations

**Cause**: Usually authentication or repository access issues.

**Diagnosis**:
```
check_github_auth
portfolio_status
```

**Solutions**:
1. **Re-authenticate**: `clear_github_auth` then `setup_github_auth`
2. **Check repository exists**: Visit the GitHub URL shown in `portfolio_status`
3. **Verify ownership**: Ensure you own the repository or have collaborator access

### Elements not syncing

**Diagnosis commands**:
```
portfolio_status
sync_portfolio dry_run=true
```

**Common causes and fixes**:
- **Local changes not committed**: Sync will show pending changes
- **Network issues**: Check internet connection
- **Authentication expired**: Re-run `setup_github_auth`
- **Repository conflicts**: Use `sync_portfolio direction="pull"` to get remote changes first

---

## Portfolio Maintenance

### Regular Maintenance Tasks

#### Weekly
- **Sync portfolio**: `sync_portfolio direction="both"`
- **Review submissions**: Check collection issues for your submitted elements
- **Update elements**: Keep your elements current with improvements

#### Monthly  
- **Audit configuration**: Review `portfolio_config` settings
- **Clean up branches**: Remove feature branches from major element changes
- **Review stats**: Check `portfolio_status` for growth and activity

#### As Needed
- **Backup**: Your portfolio is backed up on GitHub automatically
- **Security review**: Regenerate tokens if compromised
- **Repository cleanup**: Archive old or unused elements

### Portfolio Best Practices

#### Organization
- **Use clear names**: Make element names descriptive and discoverable
- **Write good descriptions**: Help others understand what your elements do
- **Version semantically**: Use semantic versioning for element updates (1.0.0 → 1.1.0 → 2.0.0)
- **Document changes**: Use meaningful commit messages

#### Collaboration  
- **Make elements public**: Enable others to discover and build on your work
- **Respond to issues**: Engage with community feedback on your submitted elements
- **Contribute regularly**: Small, frequent contributions are better than large, rare ones
- **Follow conventions**: Match the style and format of successful elements

#### Security
- **Review permissions**: Regularly check what access tokens have
- **Monitor repository**: Watch for unexpected changes or access
- **Use branch protection**: For important repositories, consider branch protection rules
- **Keep tokens secure**: Never share or commit authentication tokens

---

## Advanced Portfolio Features

### GitHub Actions Integration

Your portfolio repository includes GitHub Actions workflows for:

- **Element validation**: Automatically validate elements when pushed
- **Duplicate detection**: Check for similar elements in collection  
- **Quality scoring**: Assess element quality and completeness
- **Security scanning**: Scan for common security issues

### Branch-based Development

For major element changes, consider using Git branches:

```bash
# In your portfolio directory
cd ~/.dollhouse/portfolio
git checkout -b feature/improved-code-reviewer
# Make your changes
git add skills/code-reviewer.md  
git commit -m "Enhanced code reviewer with security focus"
git push origin feature/improved-code-reviewer
# Create PR on GitHub
```

### Collaborative Portfolios

Share portfolio development with team members:

1. **Add collaborators** to your GitHub repository
2. **Set up shared configuration**:
   ```
   portfolio_config auto_sync=true auto_submit=false
   ```
3. **Coordinate changes** through pull requests
4. **Sync regularly** to stay current with team updates

---

## Integration with Development Workflow

### IDE Integration

Edit elements directly in your favorite editor:

```bash
# Open portfolio in VS Code
code ~/.dollhouse/portfolio

# Edit specific element types
code ~/.dollhouse/portfolio/skills/
code ~/.dollhouse/portfolio/personas/
```

### Command Line Integration

Use the portfolio system in scripts and automation:

```bash
# Check portfolio status in scripts
npx @dollhousemcp/mcp-server portfolio_status --json

# Batch operations
for element in skill1 skill2 skill3; do
  npx @dollhousemcp/mcp-server submit_content "$element"
done
```

### CI/CD Integration

Integrate portfolio management with your development pipeline:

```yaml
# .github/workflows/sync-portfolio.yml
name: Sync Portfolio
on:
  schedule:
    - cron: '0 9 * * *'  # Daily at 9 AM
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sync Portfolio
        run: npx @dollhousemcp/mcp-server sync_portfolio
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Migration from Existing Systems

### From Local-Only Usage

If you've been using DollhouseMCP locally without a portfolio:

1. **Initialize portfolio**: `init_portfolio`
2. **Bulk upload existing elements**:
   ```
   list_elements
   # For each element, run:
   submit_content "element-name"
   ```
3. **Configure for ongoing sync**: `portfolio_config auto_sync=true`

### From Other AI Tools

Import elements from other systems:

1. **Convert formats**: Convert existing prompts/configurations to DollhouseMCP element format
2. **Create elements**: Use `create_element` for each converted item
3. **Submit to portfolio**: Use `submit_content` to upload
4. **Tag appropriately**: Use metadata to mark origins and versions

### From Team Repositories  

If your team has existing AI resources:

1. **Audit existing content**: Review what elements would be valuable
2. **Convert systematically**: Focus on most-used elements first  
3. **Set up shared portfolio**: Use organization repositories for team elements
4. **Migrate incrementally**: Don't try to convert everything at once

---

## Next Steps

After setting up your portfolio:

1. **Master the Workflow**: Follow the [Roundtrip Workflow Guide](ROUNDTRIP_WORKFLOW_USER_GUIDE.md)
2. **Explore Element Types**: Read the [Element Types Reference](../ELEMENT_TYPES.md)
3. **Join the Community**: Participate in [collection discussions](https://github.com/DollhouseMCP/collection/issues)
4. **Contribute**: Submit your best elements to help grow the ecosystem
5. **Learn Advanced Features**: Explore agents, ensembles, and memory elements

## Support Resources

- **[Troubleshooting Guide](TROUBLESHOOTING_ROUNDTRIP.md)**: Solutions for common issues
- **[OAuth Setup Guide](../setup/OAUTH_SETUP.md)**: Detailed authentication setup
- **[API Reference](../API_REFERENCE.md)**: Complete tool documentation
- **[GitHub Issues](https://github.com/DollhouseMCP/mcp-server/issues)**: Report problems or get help

---

**🚀 Ready to create your portfolio?** Run `portfolio_status` to check your current setup, then follow this guide to get your GitHub portfolio configured and ready for element sharing!