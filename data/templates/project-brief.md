---
name: "Project Brief"
description: "Comprehensive project overview template for planning and stakeholder communication"
type: "template"
version: "2.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "business"
tags: ["project", "planning", "brief", "documentation", "management"]
variables:
  - { name: "project_name", type: "string", required: true, description: "Name of the project" }
  - { name: "project_code", type: "string", required: false, description: "Project code or ID" }
  - { name: "start_date", type: "string", required: true, description: "Project start date" }
  - { name: "end_date", type: "string", required: true, description: "Project end date" }
  - { name: "project_manager", type: "string", required: true, description: "Project manager name" }
  - { name: "status", type: "string", required: false, description: "Current project status", default: "Planning" }
  - { name: "budget", type: "string", required: false, description: "Project budget", default: "TBD" }
  - { name: "executive_summary", type: "string", required: false, description: "Concise overview of purpose and expected outcomes" }
  - { name: "background", type: "string", required: false, description: "Context and reasons for initiating the project" }
  - { name: "objectives", type: "string", required: false, description: "Project objectives with success criteria" }
  - { name: "in_scope", type: "string", required: false, description: "What is included in this project (bullet list)" }
  - { name: "out_of_scope", type: "string", required: false, description: "What is explicitly excluded (bullet list)" }
  - { name: "stakeholders", type: "string", required: false, description: "Pre-formatted table rows: | Name | Role | Influence | Contact |" }
  - { name: "team_members", type: "string", required: false, description: "Pre-formatted table rows: | Name | Role | Responsibilities | Allocation |" }
  - { name: "milestones", type: "string", required: false, description: "Pre-formatted table rows: | Milestone | Description | Target Date | Dependencies |" }
  - { name: "risks", type: "string", required: false, description: "Pre-formatted table rows: | Risk | Probability | Impact | Mitigation | Owner |" }
  - { name: "kpis", type: "string", required: false, description: "Key performance indicators with targets" }
  - { name: "deliverables", type: "string", required: false, description: "Project deliverables with due dates and acceptance criteria" }
  - { name: "communication_plan", type: "string", required: false, description: "Pre-formatted table rows: | Type | Frequency | Audience | Purpose |" }
  - { name: "sponsor", type: "string", required: false, description: "Project sponsor name" }
---
# Project Brief: {{project_name}}

**Project Code:** {{project_code}}
**Status:** {{status}}
**Project Manager:** {{project_manager}}

## Executive Summary

{{executive_summary}}

## Project Overview

### Background
{{background}}

### Objectives
{{objectives}}

### Scope

#### In Scope
{{in_scope}}

#### Out of Scope
{{out_of_scope}}

## Stakeholders

### Key Stakeholders
| Name | Role | Influence | Contact |
|------|------|-----------|---------|
{{stakeholders}}

### Project Team
| Name | Role | Responsibilities | Allocation |
|------|------|-----------------|------------|
{{team_members}}

## Timeline & Milestones

**Start Date:** {{start_date}}
**End Date:** {{end_date}}

### Key Milestones
| Milestone | Description | Target Date | Dependencies |
|-----------|-------------|-------------|--------------|
{{milestones}}

## Budget & Resources

**Total Budget:** {{budget}}

## Risks & Mitigation

| Risk | Probability | Impact | Mitigation | Owner |
|------|-------------|--------|------------|-------|
{{risks}}

## Success Criteria

### Key Performance Indicators
{{kpis}}

### Deliverables
{{deliverables}}

## Communication Plan

| Type | Frequency | Audience | Purpose |
|------|-----------|----------|---------|
{{communication_plan}}

## Approval

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Project Sponsor | {{sponsor}} | __________ | _____ |
| Project Manager | {{project_manager}} | __________ | _____ |

---
*This document is a living document and will be updated as the project progresses.*
