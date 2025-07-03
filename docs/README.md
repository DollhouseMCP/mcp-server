# DollhouseMCP Documentation

This directory contains all project documentation organized by purpose and audience.

## 📁 Directory Structure

### `/development/` - Development Team Resources
Technical documentation for developers working on DollhouseMCP.

#### `/development/sessions/` - Development Session Records
- **SESSION_SUMMARY_2025-07-03.md** - Complete overview of July 3rd development session
- **SESSION_PROGRESS.md** - Historical session progress tracking  
- **CONVERSATION_SUMMARY.md** - Conversation summaries and context

#### `/development/workflows/` - CI/CD & Workflow Documentation  
- **WORKFLOW_STATUS_REFERENCE.md** - Current workflow status and performance metrics
- **BRANCH_PROTECTION_READINESS.md** - Assessment for enabling branch protection
- **PR_RESOLUTION_LOG.md** - Detailed log of all PR activities and resolutions

#### `/development/strategies/` - Development Strategy Documents
- **PR_13_STRATEGY.md** - Strategy for handling PR #13 conflicts post-compaction
- **TESTING_AND_DEPLOYMENT.md** - Testing strategies and deployment procedures

### `/project/` - Project Management
High-level project documentation for stakeholders and project management.

- **PROJECT_SUMMARY.md** - Complete project overview, roadmap, and business model

### `/examples/` - Configuration Examples
Sample configurations and setup examples.

- **claude_config_example.json** - Example Claude Desktop configuration

## 🗂️ Root-Level Documentation
Key documents that remain in the project root for easy discovery:

- **README.md** - Main project documentation and setup instructions
- **claude.md** - Claude context file with complete project understanding
- **LICENSE** - AGPL-3.0 license with platform stability commitments

## 📋 Documentation Guidelines

### When to Create New Documentation
- **Development sessions**: Add to `/development/sessions/`
- **Workflow changes**: Update `/development/workflows/`
- **Strategic decisions**: Document in `/development/strategies/`
- **Project milestones**: Update `/project/PROJECT_SUMMARY.md`
- **Configuration examples**: Add to `/examples/`

### Documentation Standards
- Use descriptive filenames with dates when relevant
- Include clear headings and table of contents for longer documents
- Cross-reference related documents when helpful
- Keep technical details in `/development/`, high-level overview in `/project/`

## 🔄 Maintenance
This documentation structure was implemented following Claude Code review feedback to separate project management documents from technical documentation for better maintainability and organization.

Last updated: July 3, 2025