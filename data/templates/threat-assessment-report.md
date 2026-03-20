---
name: "Threat Assessment Report"
description: "Comprehensive threat modeling and risk assessment report with mitigation strategies"
type: "template"
version: "2.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "security"
tags: ["threat-modeling", "risk-assessment", "security-analysis", "threat-intelligence"]
variables:
  - { name: "system_name", type: "string", required: true, description: "Name of the system being assessed" }
  - { name: "assessment_date", type: "string", required: true, description: "Date of the threat assessment" }
  - { name: "threat_analyst", type: "string", required: true, description: "Lead threat analyst name" }
  - { name: "business_owner", type: "string", required: true, description: "Business system owner" }
  - { name: "methodology", type: "string", required: false, description: "Threat modeling methodology (STRIDE, PASTA, OCTAVE, TRIKE, VAST)", default: "STRIDE" }
  - { name: "system_criticality", type: "string", required: false, description: "Business criticality (low, medium, high, critical)", default: "high" }
  - { name: "system_overview", type: "string", required: false, description: "System description including business function, user base, data sensitivity, and technology stack" }
  - { name: "threat_summary", type: "string", required: false, description: "Threat landscape summary with total threats, categories, and top critical threats" }
  - { name: "risk_summary", type: "string", required: false, description: "Pre-formatted table rows: | Risk Level | Threat Count | Business Impact | Timeline |" }
  - { name: "key_recommendations", type: "string", required: false, description: "Pre-formatted numbered list of key security recommendations" }
  - { name: "methodology_description", type: "string", required: false, description: "Methodology approach, framework description, and category definitions" }
  - { name: "system_architecture", type: "string", required: false, description: "Architecture components, trust boundaries, and data flow analysis" }
  - { name: "asset_inventory", type: "string", required: false, description: "Pre-formatted asset list organized by category with name, description, and criticality" }
  - { name: "detailed_threats", type: "string", required: false, description: "Pre-formatted threat analysis with ID, category, risk score, description, threat actors, attack scenarios, affected assets, risk assessment, existing controls, recommended mitigations, and residual risk for each" }
  - { name: "attack_trees", type: "string", required: false, description: "Pre-formatted attack tree diagrams with goals, tree structure, key insights, and mitigation focus areas" }
  - { name: "risk_register", type: "string", required: false, description: "Pre-formatted table rows: | Rank | Threat | Risk Score | Likelihood | Impact | Controls | Priority |" }
  - { name: "risk_heatmap", type: "string", required: false, description: "Pre-formatted risk heat map showing threat distribution by likelihood and impact" }
  - { name: "defense_strategy", type: "string", required: false, description: "Defense-in-depth strategy across perimeter, network, host, application, and data layers" }
  - { name: "security_controls", type: "string", required: false, description: "Pre-formatted recommended controls organized by priority with name, description, cost, timeline, and risk reduction" }
  - { name: "phase1_plan", type: "string", required: false, description: "Phase 1 implementation plan (0-3 months): objectives, activities, metrics, budget" }
  - { name: "phase2_plan", type: "string", required: false, description: "Phase 2 implementation plan (3-6 months): objectives, activities, metrics, budget" }
  - { name: "phase3_plan", type: "string", required: false, description: "Phase 3 implementation plan (6-12 months): objectives, activities, metrics, budget" }
  - { name: "risk_indicators", type: "string", required: false, description: "Pre-formatted key risk indicators with threshold, measurement, and reporting frequency" }
  - { name: "security_metrics", type: "string", required: false, description: "Security metrics dashboard covering risk posture, operations, and business impact" }
  - { name: "assessment_conclusion", type: "string", required: false, description: "Assessment summary with key findings and investment recommendations" }
  - { name: "immediate_next_steps", type: "string", required: false, description: "Pre-formatted numbered list of immediate actions with due dates and owners" }
  - { name: "strategic_next_steps", type: "string", required: false, description: "Long-term strategic security recommendations" }
  - { name: "review_schedule", type: "string", required: false, description: "Review and update schedule with quarterly, annual, and triggered review details" }
  - { name: "technical_reviewers", type: "string", required: false, description: "Names of technical reviewers" }
---
# Threat Assessment Report

**System:** {{system_name}}
**Assessment Date:** {{assessment_date}}
**Threat Analyst:** {{threat_analyst}}
**Business Owner:** {{business_owner}}
**Methodology:** {{methodology}}
**System Criticality:** {{system_criticality}}
**Classification:** CONFIDENTIAL

---

## Executive Summary

### System Overview

{{system_overview}}

### Threat Landscape Summary

{{threat_summary}}

### Risk Assessment Overview

| Risk Level | Threat Count | Business Impact | Recommended Timeline |
|------------|--------------|-----------------|---------------------|
{{risk_summary}}

### Key Recommendations

{{key_recommendations}}

---

## Threat Modeling Methodology

### Approach and Framework

{{methodology_description}}

### System Decomposition

{{system_architecture}}

### Asset Inventory

{{asset_inventory}}

---

## Threat Analysis

{{detailed_threats}}

---

## Attack Tree Analysis

### High-Priority Attack Trees

{{attack_trees}}

---

## Risk Prioritization Matrix

### Prioritized Risk Register

| Rank | Threat | Risk Score | Likelihood | Impact | Controls | Priority |
|------|--------|------------|------------|--------|----------|----------|
{{risk_register}}

### Risk Heat Map

{{risk_heatmap}}

---

## Mitigation Strategy

### Defense-in-Depth Approach

{{defense_strategy}}

### Recommended Security Controls

{{security_controls}}

---

## Implementation Roadmap

### Phase 1: Critical Risk Mitigation (0-3 months)

{{phase1_plan}}

### Phase 2: Comprehensive Security Enhancement (3-6 months)

{{phase2_plan}}

### Phase 3: Security Maturity and Optimization (6-12 months)

{{phase3_plan}}

---

## Monitoring and Measurement

### Key Risk Indicators (KRIs)

{{risk_indicators}}

### Security Metrics Dashboard

{{security_metrics}}

---

## Conclusion and Next Steps

### Assessment Summary

{{assessment_conclusion}}

### Immediate Actions Required

{{immediate_next_steps}}

### Long-term Strategic Recommendations

{{strategic_next_steps}}

### Review and Update Schedule

{{review_schedule}}

---

**Report prepared by:** {{threat_analyst}}
**Technical reviewers:** {{technical_reviewers}}
**Business approval:** {{business_owner}}
**Document classification:** CONFIDENTIAL
**Retention period:** 3 years from assessment date

*This threat assessment contains sensitive security information and should be handled according to organizational data classification policies.*
