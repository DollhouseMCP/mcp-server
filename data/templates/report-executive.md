---
name: "Executive Report"
description: "High-level report template for executive audiences with focus on insights and recommendations"
type: "template"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "business"
tags: ["report", "executive", "summary", "business", "strategy"]
variables:
  report_title:
    type: "string"
    description: "Title of the report"
    required: true
  report_period:
    type: "string"
    description: "Reporting period"
    required: true
  prepared_by:
    type: "string"
    description: "Report author(s)"
    required: true
  report_date:
    type: "string"
    description: "Date of report"
    required: true
    default: "{{TODAY}}"
  executive_audience:
    type: "array"
    description: "Target executive audience"
    default: ["CEO", "CFO", "Board"]
  report_type:
    type: "string"
    description: "Type of executive report"
    default: "general"
    enum: ["general", "quarterly", "annual", "strategic", "performance", "risk", "opportunity"]
outputFormats: ["pdf", "pptx", "markdown", "html"]
includes: []
---

# {{report_title}}

**Report Period:** {{report_period}}  
**Date:** {{report_date}}  
**Prepared by:** {{prepared_by}}  
**Distribution:** {{#each executive_audience}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}

---

## Executive Summary

{{#if executive_summary}}
{{executive_summary}}
{{else}}
### Key Highlights
• [Most important finding or achievement]
• [Second key point with impact metric]
• [Third critical insight or recommendation]

### Bottom Line
[One paragraph summary of the most critical information executives need to know, including any urgent actions required]
{{/if}}

## Strategic Overview

### Current State
{{#if current_state}}
{{current_state}}
{{else}}
[Brief assessment of where we are now, using concrete metrics and comparisons to previous period]
{{/if}}

### Key Performance Indicators

| KPI | Current | Previous | Target | Status |
|-----|---------|----------|--------|--------|
{{#if kpis}}
{{#each kpis}}
| {{name}} | {{current}} | {{previous}} | {{target}} | {{status_indicator}} |
{{/each}}
{{else}}
| Revenue Growth | +15% | +12% | +10% | 🟢 |
| Market Share | 23% | 21% | 25% | 🟡 |
| Customer Satisfaction | 4.2/5 | 4.0/5 | 4.5/5 | 🟡 |
| Operating Margin | 18% | 17% | 20% | 🟡 |
{{/if}}

## Critical Insights

{{#if insights}}
{{#each insights}}
### {{@index+1}}. {{title}}
**Finding:** {{finding}}  
**Impact:** {{impact}}  
**Evidence:** {{evidence}}  
{{/each}}
{{else}}
### 1. [Primary Insight Title]
**Finding:** [What we discovered]  
**Impact:** [Why it matters - quantify if possible]  
**Evidence:** [Data points supporting this insight]  

### 2. [Secondary Insight Title]
**Finding:** [What we discovered]  
**Impact:** [Business implications]  
**Evidence:** [Supporting metrics]  
{{/if}}

## Recommendations

{{#if recommendations}}
{{#each recommendations}}
### {{priority}} Priority: {{title}}
**Action:** {{action}}  
**Rationale:** {{rationale}}  
**Resources Required:** {{resources}}  
**Timeline:** {{timeline}}  
**Expected ROI:** {{roi}}  
{{/each}}
{{else}}
### High Priority: [Recommendation 1]
**Action:** [Specific action to take]  
**Rationale:** [Why this is important now]  
**Resources Required:** [Budget/headcount/time]  
**Timeline:** [When to implement]  
**Expected ROI:** [Quantified benefit]  

### Medium Priority: [Recommendation 2]
**Action:** [Specific action to take]  
**Rationale:** [Business case]  
**Resources Required:** [What's needed]  
**Timeline:** [Implementation schedule]  
**Expected ROI:** [Expected return]  
{{/if}}

## Risk Assessment

### Critical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|-------------|--------|------------|-------|
{{#if risks}}
{{#each risks}}
| {{description}} | {{probability}} | {{impact}} | {{mitigation}} | {{owner}} |
{{/each}}
{{else}}
| [Risk 1] | High | High | [Mitigation strategy] | [Executive] |
| [Risk 2] | Medium | High | [Mitigation strategy] | [Executive] |
{{/if}}

## Financial Summary

{{#if financial_summary}}
### Key Financial Metrics
{{financial_summary}}
{{else}}
### Key Financial Metrics
• **Revenue:** ${{revenue}} ({{revenue_change}} YoY)
• **EBITDA:** ${{ebitda}} ({{ebitda_margin}}% margin)
• **Cash Position:** ${{cash_position}}
• **Burn Rate:** ${{burn_rate}}/month
{{/if}}

{{#if financial_chart}}
### Financial Performance Trend
{{financial_chart}}
{{else}}
### Performance Trend
```
Revenue Growth (Quarterly)
Q1: ████████ +12%
Q2: ██████████ +15%
Q3: ████████████ +18%
Q4: ██████████████ +22% (projected)
```
{{/if}}

## Strategic Initiatives Update

{{#if initiatives}}
{{#each initiatives}}
### {{name}}
**Status:** {{status}}  
**Progress:** {{progress}}%  
**Key Milestones:** {{milestones}}  
**Issues:** {{issues}}  
{{/each}}
{{else}}
### Initiative 1: [Name]
**Status:** On Track / At Risk / Behind  
**Progress:** XX%  
**Key Milestones:** [What's been achieved]  
**Issues:** [Any blockers or concerns]  
{{/if}}

## Decisions Required

{{#if decisions}}
{{#each decisions}}
1. **{{decision}}**
   - Context: {{context}}
   - Options: {{options}}
   - Recommendation: {{recommendation}}
   - Deadline: {{deadline}}
{{/each}}
{{else}}
1. **[Decision needed]**
   - Context: [Why this decision is needed now]
   - Options: [Available choices]
   - Recommendation: [Preferred option and why]
   - Deadline: [When decision is needed]
{{/if}}

## Looking Ahead

### Next Period Focus Areas
{{#if focus_areas}}
{{#each focus_areas}}
1. {{area}} - {{description}}
{{/each}}
{{else}}
1. [Focus Area 1] - [Why this is priority]
2. [Focus Area 2] - [Expected outcomes]
3. [Focus Area 3] - [Success metrics]
{{/if}}

### Key Milestones
{{#if upcoming_milestones}}
{{#each upcoming_milestones}}
• {{date}}: {{milestone}}
{{/each}}
{{else}}
• [Date]: [Milestone 1]
• [Date]: [Milestone 2]
• [Date]: [Milestone 3]
{{/if}}

## Appendices

{{#if include_appendices}}
### A. Detailed Financial Statements
[Link to detailed financials]

### B. Market Analysis
[Link to market research]

### C. Competitive Intelligence
[Link to competitive analysis]

### D. Technical Deep Dives
[Link to technical documentation]
{{/if}}

---

**Questions or Need More Detail?**  
Contact: {{#if contact_person}}{{contact_person}}{{else}}{{prepared_by}}{{/if}}  
{{#if contact_email}}Email: {{contact_email}}{{/if}}  
{{#if next_review}}Next Review: {{next_review}}{{/if}}