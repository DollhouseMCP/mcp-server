---
name: "Project Brief"
description: "Comprehensive project overview template for planning and communication"
type: "template"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "business"
tags: ["project", "planning", "brief", "documentation", "management"]
variables:
  project_name:
    type: "string"
    description: "Name of the project"
    required: true
  project_code:
    type: "string"
    description: "Project code or ID"
    required: false
  start_date:
    type: "string"
    description: "Project start date"
    required: true
  end_date:
    type: "string"
    description: "Project end date"
    required: true
  project_manager:
    type: "string"
    description: "Project manager name"
    required: true
  budget:
    type: "string"
    description: "Project budget"
    required: false
    default: "TBD"
outputFormats: ["markdown", "html", "pdf", "docx"]
includes: []
---

# Project Brief: {{project_name}}

{{#if project_code}}**Project Code:** {{project_code}}{{/if}}  
**Date Created:** {{creation_date}}  
**Last Updated:** {{last_updated}}  
**Status:** {{status}}

## Executive Summary
{{#if executive_summary}}
{{executive_summary}}
{{else}}
[Provide a concise overview of the project, its purpose, and expected outcomes in 2-3 paragraphs]
{{/if}}

## Project Overview

### Background
{{#if background}}
{{background}}
{{else}}
[Describe the context and reasons for initiating this project]
{{/if}}

### Objectives
{{#if objectives}}
{{#each objectives}}
1. {{description}} {{#if success_criteria}}
   - Success Criteria: {{success_criteria}}{{/if}}
{{/each}}
{{else}}
1. [Primary objective]
   - Success Criteria: [How we measure success]
2. [Secondary objective]
   - Success Criteria: [How we measure success]
{{/if}}

### Scope

#### In Scope
{{#if in_scope}}
{{#each in_scope}}
- {{item}}
{{/each}}
{{else}}
- [What is included in this project]
- [Key deliverable 1]
- [Key deliverable 2]
{{/if}}

#### Out of Scope
{{#if out_scope}}
{{#each out_scope}}
- {{item}}
{{/each}}
{{else}}
- [What is explicitly not included]
- [Future phase consideration]
{{/if}}

## Stakeholders

### Key Stakeholders
| Name | Role | Interest/Influence | Contact |
|------|------|-------------------|---------|
{{#if stakeholders}}
{{#each stakeholders}}
| {{name}} | {{role}} | {{influence_level}} | {{contact}} |
{{/each}}
{{else}}
| [Name] | [Role] | High/Medium/Low | [Email] |
{{/if}}

### Project Team
| Name | Role | Responsibilities | Allocation |
|------|------|-----------------|------------|
{{#if team_members}}
{{#each team_members}}
| {{name}} | {{role}} | {{responsibilities}} | {{allocation}}% |
{{/each}}
{{else}}
| {{project_manager}} | Project Manager | Overall delivery | 100% |
| [Name] | [Role] | [Key responsibilities] | [%] |
{{/if}}

## Timeline & Milestones

### Project Timeline
- **Start Date:** {{start_date}}
- **End Date:** {{end_date}}
- **Duration:** {{duration}}

### Key Milestones
| Milestone | Description | Target Date | Dependencies |
|-----------|-------------|-------------|--------------|
{{#if milestones}}
{{#each milestones}}
| {{name}} | {{description}} | {{date}} | {{dependencies}} |
{{/each}}
{{else}}
| Project Kickoff | Initial team meeting | {{start_date}} | None |
| [Milestone 1] | [Description] | [Date] | [Dependencies] |
| Project Completion | Final delivery | {{end_date}} | All prior milestones |
{{/if}}

## Budget & Resources

### Budget Overview
- **Total Budget:** {{budget}}
- **Contingency:** {{#if contingency}}{{contingency}}{{else}}10%{{/if}}

{{#if budget_breakdown}}
### Budget Breakdown
| Category | Amount | % of Total | Notes |
|----------|--------|------------|-------|
{{#each budget_breakdown}}
| {{category}} | {{amount}} | {{percentage}}% | {{notes}} |
{{/each}}
{{/if}}

### Required Resources
{{#if resources}}
{{#each resources}}
- **{{type}}:** {{description}} {{#if quantity}}({{quantity}}){{/if}}
{{/each}}
{{else}}
- **Human Resources:** [Team members, contractors]
- **Technical Resources:** [Software, hardware, tools]
- **Physical Resources:** [Office space, equipment]
{{/if}}

## Risks & Mitigation

### Risk Assessment
| Risk | Probability | Impact | Mitigation Strategy | Owner |
|------|-------------|--------|-------------------|-------|
{{#if risks}}
{{#each risks}}
| {{description}} | {{probability}} | {{impact}} | {{mitigation}} | {{owner}} |
{{/each}}
{{else}}
| [Risk description] | High/Medium/Low | High/Medium/Low | [Mitigation plan] | [Name] |
{{/if}}

## Success Criteria

### Key Performance Indicators (KPIs)
{{#if kpis}}
{{#each kpis}}
1. **{{metric}}**: {{target}} {{#if measurement_method}}({{measurement_method}}){{/if}}
{{/each}}
{{else}}
1. **[KPI 1]**: [Target value] ([How measured])
2. **[KPI 2]**: [Target value] ([How measured])
{{/if}}

### Deliverables
{{#if deliverables}}
{{#each deliverables}}
- **{{name}}**: {{description}}
  - Due: {{due_date}}
  - Acceptance Criteria: {{acceptance_criteria}}
{{/each}}
{{else}}
- **[Deliverable 1]**: [Description]
  - Due: [Date]
  - Acceptance Criteria: [What constitutes completion]
{{/if}}

## Communication Plan

### Communication Schedule
| Type | Frequency | Audience | Purpose |
|------|-----------|----------|---------|
{{#if communication_plan}}
{{#each communication_plan}}
| {{type}} | {{frequency}} | {{audience}} | {{purpose}} |
{{/each}}
{{else}}
| Status Updates | Weekly | All stakeholders | Progress tracking |
| Steering Committee | Monthly | Key stakeholders | Decision making |
| Team Meetings | Daily/Weekly | Project team | Coordination |
{{/if}}

## Approval

### Sign-off
| Role | Name | Signature | Date |
|------|------|-----------|------|
| Project Sponsor | {{#if sponsor}}{{sponsor}}{{else}}[Name]{{/if}} | __________ | _____ |
| Project Manager | {{project_manager}} | __________ | _____ |
| {{#if additional_approvers}}{{#each additional_approvers}}{{role}} | {{name}} | __________ | _____ |
{{/each}}{{/if}}

---
*This document is a living document and will be updated as the project progresses.*