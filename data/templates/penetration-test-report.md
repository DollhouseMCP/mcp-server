---
name: "Penetration Test Report"
description: "Comprehensive penetration testing report with executive summary and technical findings"
type: "template"
version: "2.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "security"
tags: ["penetration-testing", "security", "assessment", "report", "ethical-hacking"]
variables:
  - { name: "target_organization", type: "string", required: true, description: "Target organization name" }
  - { name: "test_period", type: "string", required: true, description: "Testing period (start - end dates)" }
  - { name: "lead_tester", type: "string", required: true, description: "Lead penetration tester name" }
  - { name: "client_contact", type: "string", required: true, description: "Primary client contact" }
  - { name: "test_type", type: "string", required: false, description: "Type of penetration test (external, internal, web_application, wireless, social_engineering, red_team)", default: "external" }
  - { name: "methodology", type: "string", required: false, description: "Testing methodology (PTES, OWASP, NIST, OSSTMM)", default: "PTES" }
  - { name: "report_date", type: "string", required: false, description: "Date of report" }
  - { name: "assessment_overview", type: "string", required: false, description: "Assessment overview with objectives and key goals" }
  - { name: "key_findings", type: "string", required: false, description: "Key findings summary including major achievements and critical vulnerabilities" }
  - { name: "risk_summary", type: "string", required: false, description: "Pre-formatted table rows: | Risk Level | Findings | Percentage |" }
  - { name: "overall_rating", type: "string", required: false, description: "Overall security rating (POOR, FAIR, GOOD, EXCELLENT)" }
  - { name: "business_impact", type: "string", required: false, description: "Business impact analysis of identified vulnerabilities" }
  - { name: "executive_recommendations", type: "string", required: false, description: "Pre-formatted numbered list of executive-level recommendations" }
  - { name: "scope_details", type: "string", required: false, description: "In-scope and out-of-scope items with testing objectives" }
  - { name: "methodology_details", type: "string", required: false, description: "Testing phases with activities and duration for each phase" }
  - { name: "rules_of_engagement", type: "string", required: false, description: "Pre-formatted list of engagement rules and constraints" }
  - { name: "technical_findings", type: "string", required: false, description: "Pre-formatted findings with severity, CVSS, CWE, description, affected systems, exploitation details, evidence, impact, and remediation for each" }
  - { name: "attack_chain", type: "string", required: false, description: "Complete attack path analysis showing initial access, privilege escalation, lateral movement, and data exfiltration stages" }
  - { name: "compromise_timeline", type: "string", required: false, description: "Pre-formatted table rows: | Time | Activity | Result |" }
  - { name: "risk_analysis", type: "string", required: false, description: "Detailed risk analysis per asset with scores and justification" }
  - { name: "immediate_actions", type: "string", required: false, description: "Pre-formatted checklist of immediate remediation actions (0-24 hours)" }
  - { name: "short_term_actions", type: "string", required: false, description: "Pre-formatted checklist of short-term actions (1-7 days)" }
  - { name: "medium_term_actions", type: "string", required: false, description: "Pre-formatted checklist of medium-term actions (1-4 weeks)" }
  - { name: "long_term_actions", type: "string", required: false, description: "Pre-formatted checklist of long-term actions (1-6 months)" }
  - { name: "strategic_recommendations", type: "string", required: false, description: "Strategic security improvement recommendations" }
  - { name: "technical_controls", type: "string", required: false, description: "Recommended technical controls for application, infrastructure, and IAM" }
  - { name: "organizational_controls", type: "string", required: false, description: "Recommended organizational controls for governance, training, and vendor management" }
  - { name: "conclusion", type: "string", required: false, description: "Overall assessment summary with key concerns" }
  - { name: "success_metrics", type: "string", required: false, description: "Metrics to measure remediation effectiveness" }
  - { name: "next_steps", type: "string", required: false, description: "Pre-formatted numbered list of recommended next steps" }
  - { name: "technical_evidence", type: "string", required: false, description: "Detailed technical evidence including screenshots and logs" }
  - { name: "tool_output", type: "string", required: false, description: "Raw output from security testing tools" }
  - { name: "network_diagrams", type: "string", required: false, description: "Network topology diagrams showing attack paths" }
  - { name: "cost_analysis", type: "string", required: false, description: "Pre-formatted table rows: | Priority | Estimated Cost | Timeline | Risk Reduction |" }
  - { name: "team_members", type: "string", required: false, description: "Testing team member names" }
  - { name: "reviewer", type: "string", required: false, description: "Senior security consultant who reviewed the report" }
---
# Penetration Testing Report

**Target Organization:** {{target_organization}}
**Testing Period:** {{test_period}}
**Lead Tester:** {{lead_tester}}
**Client Contact:** {{client_contact}}
**Test Type:** {{test_type}}
**Methodology:** {{methodology}}
**Report Date:** {{report_date}}
**Classification:** CONFIDENTIAL

---

## Executive Summary

### Assessment Overview

{{assessment_overview}}

### Key Findings Summary

{{key_findings}}

### Risk Assessment

| Risk Level | Findings | Percentage |
|------------|----------|------------|
{{risk_summary}}

**Overall Security Rating:** {{overall_rating}}

### Business Impact

{{business_impact}}

### Executive Recommendations

{{executive_recommendations}}

---

## Testing Methodology

### Scope and Objectives

{{scope_details}}

### Testing Phases

{{methodology_details}}

### Rules of Engagement

{{rules_of_engagement}}

---

## Technical Findings

{{technical_findings}}

---

## Attack Chain Analysis

### Complete Attack Path

{{attack_chain}}

### Timeline of Compromise

| Time | Activity | Result |
|------|----------|--------|
{{compromise_timeline}}

---

## Risk Assessment

### Detailed Risk Analysis

{{risk_analysis}}

---

## Remediation Plan

### Immediate Actions (0-24 hours)

{{immediate_actions}}

### Short-term Actions (1-7 days)

{{short_term_actions}}

### Medium-term Actions (1-4 weeks)

{{medium_term_actions}}

### Long-term Actions (1-6 months)

{{long_term_actions}}

---

## Recommendations

### Strategic Security Improvements

{{strategic_recommendations}}

### Technical Controls

{{technical_controls}}

### Organizational Controls

{{organizational_controls}}

---

## Conclusion

### Overall Assessment

{{conclusion}}

### Success Metrics

{{success_metrics}}

### Next Steps

{{next_steps}}

---

## Appendices

### Appendix A: Detailed Technical Evidence

{{technical_evidence}}

### Appendix B: Tool Output and Scan Results

{{tool_output}}

### Appendix C: Network Diagrams and Attack Paths

{{network_diagrams}}

### Appendix D: Remediation Cost Analysis

| Priority | Estimated Cost | Timeline | Risk Reduction |
|----------|---------------|----------|----------------|
{{cost_analysis}}

---

**Report prepared by:** {{lead_tester}}
**Testing team:** {{team_members}}
**Report review:** {{reviewer}}
**Date:** {{report_date}}

*This report contains confidential information and should be treated as such. Distribution should be limited to authorized personnel only.*
