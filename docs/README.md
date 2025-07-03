# DollhouseMCP Documentation

This directory contains all project documentation organized by purpose and audience.

## 1. 📁 Directory Structure

### 1.1 `/development/` - Development Team Resources
Technical documentation for developers working on DollhouseMCP.

#### 1.1.1 `/development/sessions/` - Development Session Records
- **SESSION_SUMMARY_2025-07-03.md** - Complete overview of July 3rd development session  
  → *See also: [Branch Protection Readiness](workflows/BRANCH_PROTECTION_READINESS.md) for implementation outcomes*
- **SESSION_PROGRESS.md** - Historical session progress tracking  
- **CONVERSATION_SUMMARY.md** - Conversation summaries and context

#### 1.1.2 `/development/workflows/` - CI/CD & Workflow Documentation  
- **WORKFLOW_STATUS_REFERENCE.md** - Current workflow status and performance metrics  
  → *Related: [PR Resolution Log](workflows/PR_RESOLUTION_LOG.md) for workflow improvement history*
- **BRANCH_PROTECTION_READINESS.md** - Assessment for enabling branch protection  
  → *Implements strategies from: [PR #13 Strategy](strategies/PR_13_STRATEGY.md)*
- **PR_RESOLUTION_LOG.md** - Detailed log of all PR activities and resolutions  
  → *Background context: [Session Summary](sessions/SESSION_SUMMARY_2025-07-03.md)*

#### 1.1.3 `/development/strategies/` - Development Strategy Documents
- **PR_13_STRATEGY.md** - Strategy for handling PR #13 conflicts post-compaction  
  → *Implementation details: [Branch Protection Readiness](workflows/BRANCH_PROTECTION_READINESS.md)*
- **TESTING_AND_DEPLOYMENT.md** - Testing strategies and deployment procedures  
  → *Current status: [Workflow Status Reference](workflows/WORKFLOW_STATUS_REFERENCE.md)*

### 1.2 `/project/` - Project Management
High-level project documentation for stakeholders and project management.

- **PROJECT_SUMMARY.md** - Complete project overview, roadmap, and business model  
  → *Technical implementation details: [Session Progress](development/sessions/SESSION_PROGRESS.md)*

### 1.3 `/examples/` - Configuration Examples
Sample configurations and setup examples.

- **claude_config_example.json** - Example Claude Desktop configuration  
  → *Setup context: [Project Summary](project/PROJECT_SUMMARY.md)*

## 2. 🗂️ Root-Level Documentation
Key documents that remain in the project root for easy discovery:

- **README.md** - Main project documentation and setup instructions
- **claude.md** - Claude context file with complete project understanding
- **LICENSE** - AGPL-3.0 license with platform stability commitments

## 3. 📋 Documentation Guidelines

### 3.1 When to Create New Documentation
- **Development sessions**: Add to `/development/sessions/`
- **Workflow changes**: Update `/development/workflows/`
- **Strategic decisions**: Document in `/development/strategies/`
- **Project milestones**: Update `/project/PROJECT_SUMMARY.md`
- **Configuration examples**: Add to `/examples/`

### 3.2 Documentation Standards
- Use descriptive filenames with dates when relevant
- Include clear headings and table of contents for longer documents
- Cross-reference related documents when helpful (see examples above)
- Keep technical details in `/development/`, high-level overview in `/project/`
- Update changelog below when making significant documentation changes

## 4. 📜 Documentation Changelog

### 2025-07-03 - Major Reorganization
- **Created organized documentation structure** following Claude Code review feedback
- **Moved 10 files** from root directory to categorized subdirectories
- **Added comprehensive navigation** with section numbers and cross-references
- **Established documentation guidelines** for future maintenance

### Previous
- Documentation scattered in project root with no clear organization
- Mixed technical and project management documents

## 5. 🔄 Maintenance
This documentation structure was implemented following Claude Code review feedback to separate project management documents from technical documentation for better maintainability and organization.

**Contributing to Documentation:**
1. Follow section 3.1 for placement guidelines
2. Add cross-references to related documents (see examples in section 1)
3. Update this changelog when making significant changes
4. Use section numbers for easy referencing

Last updated: July 3, 2025