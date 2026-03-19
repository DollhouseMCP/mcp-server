---
name: "Executive Report"
description: "High-level report template for executive audiences with insights and recommendations"
type: "template"
version: "2.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "business"
tags: ["report", "executive", "summary", "business", "strategy"]
variables:
  - { name: "report_title", type: "string", required: true, description: "Title of the report" }
  - { name: "report_period", type: "string", required: true, description: "Reporting period (e.g. Q1 2026)" }
  - { name: "report_date", type: "string", required: true, description: "Date of report" }
  - { name: "prepared_by", type: "string", required: true, description: "Report author(s)" }
  - { name: "distribution", type: "string", required: false, description: "Target audience (e.g. CEO, CFO, Board)" }
  - { name: "executive_summary", type: "string", required: false, description: "Executive summary with key highlights and bottom line" }
  - { name: "current_state", type: "string", required: false, description: "Current state assessment with metrics" }
  - { name: "key_metrics", type: "string", required: false, description: "Pre-formatted table rows: | KPI | Current | Previous | Target | Status |" }
  - { name: "insights", type: "string", required: false, description: "Critical insights with findings, impact, and evidence" }
  - { name: "recommendations", type: "string", required: false, description: "Prioritized recommendations with action, rationale, and timeline" }
  - { name: "risks", type: "string", required: false, description: "Pre-formatted table rows: | Risk | Probability | Impact | Mitigation | Owner |" }
  - { name: "financial_summary", type: "string", required: false, description: "Key financial metrics and trends" }
  - { name: "initiatives", type: "string", required: false, description: "Strategic initiative updates with status and progress" }
  - { name: "decisions_required", type: "string", required: false, description: "Decisions needed with context, options, and deadlines" }
  - { name: "next_period_focus", type: "string", required: false, description: "Focus areas and key milestones for next period" }
  - { name: "contact_info", type: "string", required: false, description: "Contact information for follow-up questions" }
---
# {{report_title}}

**Report Period:** {{report_period}}
**Date:** {{report_date}}
**Prepared by:** {{prepared_by}}
**Distribution:** {{distribution}}

---

## Executive Summary

{{executive_summary}}

## Strategic Overview

### Current State
{{current_state}}

### Key Performance Indicators

| KPI | Current | Previous | Target | Status |
|-----|---------|----------|--------|--------|
{{key_metrics}}

## Critical Insights

{{insights}}

## Recommendations

{{recommendations}}

## Risk Assessment

| Risk | Probability | Impact | Mitigation | Owner |
|------|-------------|--------|------------|-------|
{{risks}}

## Financial Summary

{{financial_summary}}

## Strategic Initiatives Update

{{initiatives}}

## Decisions Required

{{decisions_required}}

## Looking Ahead

{{next_period_focus}}

---

**Questions or Need More Detail?**
{{contact_info}}
