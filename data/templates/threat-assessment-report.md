---
name: "Threat Assessment Report"
description: "Comprehensive threat modeling and risk assessment report with mitigation strategies"
type: "template"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "security"
tags: ["threat-modeling", "risk-assessment", "security-analysis", "threat-intelligence"]
variables:
  system_name:
    type: "string"
    description: "Name of the system being assessed"
    required: true
  assessment_date:
    type: "string"
    description: "Date of the threat assessment"
    required: true
    default: "{{TODAY}}"
  threat_analyst:
    type: "string"
    description: "Lead threat analyst name"
    required: true
  business_owner:
    type: "string"
    description: "Business system owner"
    required: true
  methodology:
    type: "string"
    description: "Threat modeling methodology used"
    default: "STRIDE"
    enum: ["STRIDE", "PASTA", "OCTAVE", "TRIKE", "VAST"]
  system_criticality:
    type: "string"
    description: "Business criticality of the system"
    default: "high"
    enum: ["low", "medium", "high", "critical"]
outputFormats: ["pdf", "html", "markdown", "docx"]
includes: []
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
{{#if system_overview}}
{{system_overview}}
{{else}}
{{system_name}} is a {{system_criticality}} business system that {{system_description}}. This threat assessment evaluates potential security risks and provides recommendations for risk mitigation.

**Key System Characteristics:**
- Business Function: {{business_function}}
- User Base: {{user_count}} users
- Data Sensitivity: {{data_sensitivity}}
- Regulatory Requirements: {{compliance_requirements}}
- Technology Stack: {{tech_stack}}
{{/if}}

### Threat Landscape Summary
{{#if threat_summary}}
{{threat_summary}}
{{else}}
This assessment identified **{{total_threats}}** distinct threat scenarios across **{{threat_categories}}** categories. The analysis reveals **{{high_risk_threats}}** high-risk threats requiring immediate attention and **{{medium_risk_threats}}** medium-risk threats needing mitigation within the next quarter.

**Most Critical Threats:**
1. {{threat_1_name}} - Risk Score: {{threat_1_score}}
2. {{threat_2_name}} - Risk Score: {{threat_2_score}}  
3. {{threat_3_name}} - Risk Score: {{threat_3_score}}
{{/if}}

### Risk Assessment Overview
| Risk Level | Threat Count | Business Impact | Recommended Timeline |
|------------|--------------|-----------------|---------------------|
{{#if risk_summary}}
{{#each risk_summary}}
| {{level}} | {{count}} | {{impact}} | {{timeline}} |
{{/each}}
{{else}}
| Critical | X | Severe | Immediate (0-7 days) |
| High | Y | Major | Urgent (7-30 days) |
| Medium | Z | Moderate | Important (30-90 days) |
| Low | W | Minor | Standard (90+ days) |
{{/if}}

### Key Recommendations
{{#if key_recommendations}}
{{#each key_recommendations}}
{{@index+1}}. **{{category}}**: {{recommendation}}
{{/each}}
{{else}}
1. **Identity & Access Management**: Implement multi-factor authentication and privileged access controls
2. **Network Security**: Deploy network segmentation and intrusion detection systems
3. **Data Protection**: Enhance encryption and data loss prevention capabilities
4. **Monitoring & Response**: Establish security operations center and incident response procedures
5. **Security Awareness**: Conduct comprehensive security training for all users
{{/if}}

---

## Threat Modeling Methodology

### Approach and Framework
{{#if methodology_description}}
{{methodology_description}}
{{else}}
This threat assessment follows the **{{methodology}}** methodology, providing a systematic approach to identify, analyze, and prioritize security threats.

**{{methodology}} Categories:**
{{#if methodology == "STRIDE"}}
- **S**poofing: Identity and authentication threats
- **T**ampering: Data and system integrity threats  
- **R**epudiation: Non-repudiation and audit threats
- **I**nformation Disclosure: Confidentiality and privacy threats
- **D**enial of Service: Availability and performance threats
- **E**levation of Privilege: Authorization and access control threats
{{else if methodology == "PASTA"}}
- Stage 1: Define Objectives
- Stage 2: Define Technical Scope
- Stage 3: Application Decomposition
- Stage 4: Threat Analysis
- Stage 5: Weakness Analysis
- Stage 6: Attack Modeling
- Stage 7: Risk Analysis
{{/if}}
{{/if}}

### System Decomposition
{{#if system_architecture}}
{{system_architecture}}
{{else}}
#### Architecture Components
```
{{system_name}} Architecture:

┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Web Clients   │────│  Load Balancer  │────│   Web Servers   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                       │
                                               ┌─────────────────┐
                                               │ Application     │
                                               │ Servers         │
                                               └─────────────────┘
                                                       │
                                               ┌─────────────────┐
                                               │   Database      │
                                               │   Cluster       │
                                               └─────────────────┘
```

#### Trust Boundaries
1. **Internet ↔ DMZ**: External users accessing public services
2. **DMZ ↔ Internal Network**: Web tier accessing application services
3. **Application ↔ Data Tier**: Application servers accessing databases
4. **Internal ↔ Management**: Administrative access to system components

#### Data Flow Analysis
- **User Authentication**: Credentials flow from client to authentication service
- **Business Logic**: Application processes user requests and business rules
- **Data Storage**: Sensitive data stored and retrieved from database systems
- **External Integrations**: API calls to third-party services and partners
{{/if}}

### Asset Inventory
{{#if asset_inventory}}
{{#each asset_inventory}}
#### {{category}}
{{#each assets}}
- **{{name}}**: {{description}} (Criticality: {{criticality}})
{{/each}}
{{/each}}
{{else}}
#### Critical Assets
- **Customer Database**: Contains PII and financial data (Criticality: Critical)
- **Authentication Service**: Manages user access controls (Criticality: High)
- **Payment Processor**: Handles financial transactions (Criticality: Critical)
- **Web Application**: Primary user interface (Criticality: High)
- **API Gateway**: External integration point (Criticality: Medium)

#### Supporting Assets
- **Load Balancers**: Traffic distribution (Criticality: Medium)
- **Monitoring Systems**: Operational visibility (Criticality: Medium)
- **Backup Systems**: Data recovery capability (Criticality: High)
- **Network Infrastructure**: Connectivity foundation (Criticality: Medium)
{{/if}}

---

## Threat Analysis

{{#if detailed_threats}}
{{#each detailed_threats}}
### Threat {{@index+1}}: {{name}}

**Threat ID:** {{id}}  
**Category:** {{category}}  
**Risk Score:** {{risk_score}}/10  
**Priority:** {{priority}}

#### Threat Description
{{description}}

#### Threat Actors
{{#each threat_actors}}
- **{{type}}**: {{capabilities}} (Motivation: {{motivation}})
{{/each}}

#### Attack Scenarios
{{#each attack_scenarios}}
{{@index+1}}. **{{scenario_name}}**
   - **Prerequisites:** {{prerequisites}}
   - **Attack Steps:** {{attack_steps}}
   - **Success Criteria:** {{success_criteria}}
   - **Detection Difficulty:** {{detection_difficulty}}
{{/each}}

#### Affected Assets
{{#each affected_assets}}
- **{{asset_name}}**: {{impact_description}} (Impact Level: {{impact_level}})
{{/each}}

#### Risk Assessment
**Likelihood Assessment:** {{likelihood}}/5
- Threat Actor Capability: {{actor_capability}}/5
- Attack Complexity: {{complexity}}/5  
- Required Access: {{access_required}}/5
- Detection Probability: {{detection_prob}}/5

**Impact Assessment:** {{impact}}/5
- Confidentiality Impact: {{confidentiality}}/5
- Integrity Impact: {{integrity}}/5
- Availability Impact: {{availability}}/5
- Business Impact: {{business_impact}}/5

**Risk Calculation:** 
```
Risk Score = (Likelihood × Impact × Vulnerability) / Controls
Risk Score = ({{likelihood}} × {{impact}} × {{vulnerability}}) / {{controls}} = {{risk_score}}
```

#### Existing Controls
{{#each existing_controls}}
- **{{control_name}}**: {{effectiveness}} effectiveness ({{description}})
{{/each}}

#### Recommended Mitigations
{{#each mitigations}}
{{@index+1}}. **{{control_type}}**: {{description}}
   - **Implementation Cost:** {{cost}}
   - **Timeline:** {{timeline}}
   - **Risk Reduction:** {{risk_reduction}}%
   - **Responsible Party:** {{owner}}
{{/each}}

#### Residual Risk
After implementing recommended mitigations:
- **Residual Risk Score:** {{residual_risk}}/10
- **Acceptance Criteria:** {{acceptance_criteria}}
- **Monitoring Requirements:** {{monitoring_requirements}}

---

{{/each}}
{{else}}
### Example Threat: SQL Injection Attack

**Threat ID:** THR-001  
**Category:** Tampering (STRIDE)  
**Risk Score:** 8.5/10  
**Priority:** Critical

#### Threat Description
Attackers exploit insufficient input validation in web application forms to inject malicious SQL commands, potentially gaining unauthorized access to the database and sensitive customer information.

#### Threat Actors
- **External Attackers**: Script kiddies to advanced persistent threat groups (Motivation: Data theft, financial gain)
- **Malicious Insiders**: Employees with database access (Motivation: Financial gain, revenge)

#### Attack Scenarios
1. **Unauthenticated SQL Injection**
   - **Prerequisites:** Web application accessible, input validation missing
   - **Attack Steps:** Submit malicious SQL in form fields, extract database contents
   - **Success Criteria:** Access to user accounts or sensitive data
   - **Detection Difficulty:** Medium (depends on logging)

2. **Authenticated SQL Injection** 
   - **Prerequisites:** Valid user account, application access
   - **Attack Steps:** Escalate privileges through SQL injection in authenticated features
   - **Success Criteria:** Administrative access to database
   - **Detection Difficulty:** High (legitimate user activity)

#### Affected Assets
- **Customer Database**: Complete data exposure (Impact Level: Critical)
- **User Authentication**: Account takeover possible (Impact Level: High)
- **Payment Data**: Financial information at risk (Impact Level: Critical)

#### Risk Assessment
**Likelihood Assessment:** 4/5
- Threat Actor Capability: 3/5 (Moderate skill required)
- Attack Complexity: 2/5 (Automated tools available)
- Required Access: 1/5 (No special access needed)
- Detection Probability: 3/5 (May avoid detection)

**Impact Assessment:** 5/5
- Confidentiality Impact: 5/5 (Complete data exposure)
- Integrity Impact: 4/5 (Data modification possible)
- Availability Impact: 3/5 (Database could be corrupted)
- Business Impact: 5/5 (Regulatory violations, customer loss)

**Risk Calculation:**
```
Risk Score = (4 × 5 × 4) / 2 = 40/2 = 8.5/10
```

#### Existing Controls
- **Input Validation**: Low effectiveness (Basic client-side only)
- **Database Permissions**: Medium effectiveness (Some access restrictions)
- **Web Application Firewall**: Not implemented

#### Recommended Mitigations
1. **Parameterized Queries**: Implement prepared statements for all database queries
   - **Implementation Cost:** $15,000
   - **Timeline:** 4-6 weeks
   - **Risk Reduction:** 80%
   - **Responsible Party:** Development Team

2. **Input Validation Framework**: Deploy comprehensive server-side validation
   - **Implementation Cost:** $25,000
   - **Timeline:** 6-8 weeks
   - **Risk Reduction:** 70%
   - **Responsible Party:** Security Team

3. **Database Activity Monitoring**: Implement real-time SQL injection detection
   - **Implementation Cost:** $40,000
   - **Timeline:** 2-3 weeks
   - **Risk Reduction:** 60%
   - **Responsible Party:** Operations Team

#### Residual Risk
After implementing recommended mitigations:
- **Residual Risk Score:** 2.5/10
- **Acceptance Criteria:** Acceptable with continuous monitoring
- **Monitoring Requirements:** Daily review of database access logs

---
{{/if}}

## Attack Tree Analysis

### High-Priority Attack Trees

{{#if attack_trees}}
{{#each attack_trees}}
#### {{goal}}

```
{{tree_structure}}
```

**Key Insights:**
{{#each insights}}
- {{insight}}
{{/each}}

**Mitigation Focus Areas:**
{{#each mitigation_areas}}
- {{area}}: {{description}}
{{/each}}

{{/each}}
{{else}}
#### Goal: Gain Unauthorized Access to Customer Data

```
Steal Customer Data
│
├─ OR ─ Database Direct Access
│       │
│       ├─ AND ─ SQL Injection
│       │        ├─ Unvalidated Input
│       │        ├─ Dynamic Query Construction
│       │        └─ Database Errors Exposed
│       │
│       └─ AND ─ Privilege Escalation
│                ├─ Initial Database Access
│                ├─ Weak Database Permissions
│                └─ Inadequate Monitoring
│
├─ OR ─ Application Compromise  
│       │
│       ├─ AND ─ Authentication Bypass
│       │        ├─ Weak Password Policy
│       │        ├─ No Multi-Factor Auth
│       │        └─ Session Management Flaws
│       │
│       └─ AND ─ Authorization Bypass
│                ├─ Insecure Direct Object Refs
│                ├─ Missing Function Level Checks
│                └─ Privilege Escalation Bugs
│
└─ OR ─ Infrastructure Attack
        │
        ├─ AND ─ Network Intrusion
        │        ├─ Vulnerable Network Services
        │        ├─ Weak Network Segmentation
        │        └─ Insufficient Monitoring
        │
        └─ AND ─ System Compromise
                 ├─ Operating System Vulnerabilities
                 ├─ Misconfigurations
                 └─ Backdoor Installation
```

**Key Insights:**
- Multiple attack paths exist to achieve the same goal
- Authentication and input validation are critical control points
- Network segmentation could limit attack impact
- Monitoring and detection capabilities need improvement

**Mitigation Focus Areas:**
- **Input Validation**: Implement comprehensive validation framework
- **Authentication**: Deploy multi-factor authentication
- **Network Security**: Enhance segmentation and monitoring
- **Database Security**: Implement least privilege access controls
{{/if}}

---

## Risk Prioritization Matrix

### Risk Scoring Methodology
```
Risk Score = (Threat Likelihood × Business Impact × Technical Impact) / Control Effectiveness

Where each factor is scored 1-5:
- Threat Likelihood: Probability of successful attack
- Business Impact: Consequence to business operations  
- Technical Impact: Severity of technical compromise
- Control Effectiveness: Current mitigation strength
```

### Prioritized Risk Register
{{#if risk_register}}
| Rank | Threat | Risk Score | Likelihood | Impact | Controls | Priority |
|------|--------|------------|------------|--------|----------|----------|
{{#each risk_register}}
| {{rank}} | {{threat_name}} | {{risk_score}} | {{likelihood}} | {{impact}} | {{controls}} | {{priority}} |
{{/each}}
{{else}}
| Rank | Threat | Risk Score | Likelihood | Impact | Controls | Priority |
|------|--------|------------|------------|--------|----------|----------|
| 1 | SQL Injection | 8.5 | High | Critical | Weak | Critical |
| 2 | Authentication Bypass | 7.8 | Medium | High | Medium | High |
| 3 | Data Exfiltration | 7.2 | Medium | Critical | Medium | High |
| 4 | Privilege Escalation | 6.9 | High | Medium | Medium | High |
| 5 | Denial of Service | 6.1 | High | Medium | Strong | Medium |
| 6 | Session Hijacking | 5.8 | Medium | Medium | Weak | Medium |
| 7 | Cross-Site Scripting | 5.2 | High | Low | Medium | Medium |
| 8 | Information Disclosure | 4.9 | Medium | Medium | Medium | Low |
{{/if}}

### Risk Heat Map
{{#if risk_heatmap}}
{{risk_heatmap}}
{{else}}
```
Impact →     Low    Medium    High    Critical
Likelihood ↓
Very High    |  6   |   7   |   1   |    2    |
High         |  8   |   5   |   4   |    -    |
Medium       |  -   |   6   |   3   |    -    |
Low          |  -   |   -   |   -   |    -    |
Very Low     |  -   |   -   |   -   |    -    |

Legend: Numbers represent threat IDs from risk register
```
{{/if}}

---

## Mitigation Strategy

### Defense-in-Depth Approach
{{#if defense_strategy}}
{{defense_strategy}}
{{else}}
#### Layer 1: Perimeter Security
- **Network Firewalls**: Control traffic between network segments
- **Web Application Firewall**: Filter malicious web traffic
- **DDoS Protection**: Mitigate distributed denial of service attacks
- **VPN Gateways**: Secure remote access connections

#### Layer 2: Network Security
- **Network Segmentation**: Isolate critical systems and data
- **Intrusion Detection/Prevention**: Monitor for malicious activity
- **Network Access Control**: Authenticate and authorize device access
- **Traffic Analysis**: Monitor for anomalous network behavior

#### Layer 3: Host Security
- **Endpoint Protection**: Anti-malware and behavioral analysis
- **System Hardening**: Secure configuration management
- **Patch management**: Timely security update deployment
- **Host-based Monitoring**: Local security event collection

#### Layer 4: Application Security
- **Secure Development**: Security built into SDLC processes
- **Input Validation**: Comprehensive data sanitization
- **Authentication**: Multi-factor authentication implementation
- **Authorization**: Role-based access controls

#### Layer 5: Data Security
- **Encryption**: Data protection in transit and at rest
- **Data Classification**: Sensitivity-based handling procedures
- **Data Loss Prevention**: Monitor and prevent data exfiltration
- **Backup Security**: Secure and tested backup procedures
{{/if}}

### Recommended Security Controls
{{#if security_controls}}
{{#each security_controls}}
#### {{category}}
{{#each controls}}
- **{{name}}**: {{description}}
  - Priority: {{priority}}
  - Cost: {{cost}}
  - Timeline: {{timeline}}
  - Risk Reduction: {{risk_reduction}}%
{{/each}}
{{/each}}
{{else}}
#### Critical Priority (0-30 days)
- **Multi-Factor Authentication**: Deploy MFA for all user accounts
  - Priority: Critical
  - Cost: $50,000
  - Timeline: 2-3 weeks
  - Risk Reduction: 70%

- **Input Validation Framework**: Implement comprehensive validation
  - Priority: Critical  
  - Cost: $75,000
  - Timeline: 4-6 weeks
  - Risk Reduction: 80%

#### High Priority (1-3 months)
- **Network Segmentation**: Isolate critical systems
  - Priority: High
  - Cost: $150,000
  - Timeline: 8-12 weeks
  - Risk Reduction: 60%

- **Security Monitoring**: Deploy SIEM and SOC capabilities
  - Priority: High
  - Cost: $200,000
  - Timeline: 10-14 weeks
  - Risk Reduction: 50%

#### Medium Priority (3-6 months)
- **Endpoint Protection**: Advanced threat protection
  - Priority: Medium
  - Cost: $100,000
  - Timeline: 6-8 weeks
  - Risk Reduction: 40%

- **Security Training**: Comprehensive awareness program
  - Priority: Medium
  - Cost: $25,000
  - Timeline: 3-4 weeks
  - Risk Reduction: 30%
{{/if}}

---

## Implementation Roadmap

### Phase 1: Critical Risk Mitigation (0-3 months)
{{#if phase1_plan}}
{{phase1_plan}}
{{else}}
**Objectives:** Address critical and high-risk threats that could result in significant business impact.

**Key Activities:**
- Deploy multi-factor authentication across all systems
- Implement comprehensive input validation framework
- Establish security monitoring and incident response capabilities
- Conduct emergency security awareness training
- Perform immediate vulnerability remediation

**Success Metrics:**
- 90% reduction in critical risk threats
- MFA deployment to 100% of users
- 24/7 security monitoring operational
- Zero tolerance for critical vulnerabilities

**Budget:** $400,000
**Timeline:** 12 weeks
**Responsible:** Security Team, Development Team
{{/if}}

### Phase 2: Comprehensive Security Enhancement (3-6 months)
{{#if phase2_plan}}
{{phase2_plan}}
{{else}}
**Objectives:** Implement defense-in-depth strategy and strengthen overall security posture.

**Key Activities:**
- Deploy network segmentation and micro-segmentation
- Implement advanced threat protection and endpoint security
- Establish security operations center (SOC)
- Conduct comprehensive penetration testing
- Develop incident response and business continuity plans

**Success Metrics:**
- 70% reduction in high-risk threats
- Network segmentation 95% complete
- Mean time to detect (MTTD) < 1 hour
- Mean time to respond (MTTR) < 4 hours

**Budget:** $600,000
**Timeline:** 12 weeks
**Responsible:** Security Team, Infrastructure Team
{{/if}}

### Phase 3: Security Maturity and Optimization (6-12 months)
{{#if phase3_plan}}
{{phase3_plan}}
{{else}}
**Objectives:** Achieve security maturity and establish continuous improvement processes.

**Key Activities:**
- Implement advanced threat intelligence and analytics
- Deploy automated security testing and DevSecOps
- Establish security metrics and KPI tracking
- Conduct regular security assessments and audits
- Develop security community of practice

**Success Metrics:**
- 50% reduction in medium-risk threats
- 99.9% security tool availability
- Zero security incidents with major business impact
- Security maturity level 4 (Optimized)

**Budget:** $300,000
**Timeline:** 24 weeks
**Responsible:** All Teams
{{/if}}

---

## Monitoring and Measurement

### Key Risk Indicators (KRIs)
{{#if risk_indicators}}
{{#each risk_indicators}}
- **{{name}}**: {{description}}
  - Threshold: {{threshold}}
  - Measurement: {{measurement}}
  - Reporting: {{frequency}}
{{/each}}
{{else}}
- **Critical Vulnerability Count**: Number of unpatched critical vulnerabilities
  - Threshold: 0 vulnerabilities > 7 days old
  - Measurement: Weekly vulnerability scans
  - Reporting: Weekly executive dashboard

- **Failed Authentication Attempts**: Anomalous login attempt patterns
  - Threshold: >50 failed attempts per user per hour
  - Measurement: Real-time authentication logs
  - Reporting: Immediate alerting

- **Privileged Access Usage**: Administrative account activity monitoring
  - Threshold: >5 simultaneous admin sessions
  - Measurement: Continuous privileged access monitoring
  - Reporting: Daily review and monthly reporting
{{/if}}

### Security Metrics Dashboard
{{#if security_metrics}}
{{security_metrics}}
{{else}}
**Risk Posture Metrics:**
- Overall Risk Score: [Current score vs target]
- Critical Threats Remaining: [Count and trend]
- Control Implementation Progress: [Percentage complete]
- Residual Risk Acceptance: [Approved vs total]

**Operational Security Metrics:**
- Security Incident Count: [Monthly incidents by severity]
- Mean Time to Detect: [Average detection time]
- Mean Time to Respond: [Average response time]
- Control Effectiveness: [Pass/fail rates for security controls]

**Business Impact Metrics:**
- Security Investment ROI: [Risk reduction per dollar spent]
- Compliance Status: [Percentage of requirements met]
- Security Awareness: [Training completion and phishing click rates]
- Customer Trust Index: [Security-related satisfaction scores]
{{/if}}

---

## Conclusion and Next Steps

### Assessment Summary
{{#if assessment_conclusion}}
{{assessment_conclusion}}
{{else}}
This comprehensive threat assessment of {{system_name}} identified significant security risks that require immediate attention. While the system provides critical business functionality, the current security posture presents unacceptable risks to the organization.

**Key Findings:**
- {{total_critical_threats}} critical threats require immediate remediation
- Current security controls are insufficient for the system's risk profile
- Implementation of recommended mitigations will reduce overall risk by 75%
- Estimated investment of $1.3M over 12 months to achieve target security posture
{{/if}}

### Immediate Actions Required
{{#if immediate_next_steps}}
{{#each immediate_next_steps}}
{{@index+1}}. **{{action}}** (Due: {{due_date}}, Owner: {{owner}})
{{/each}}
{{else}}
1. **Executive Approval** (Due: Within 48 hours, Owner: {{business_owner}})
   - Approve security investment and implementation roadmap
   - Assign dedicated resources for critical risk mitigation

2. **Critical Vulnerability Remediation** (Due: Within 7 days, Owner: Development Team)
   - Address all critical findings identified in this assessment
   - Implement temporary compensating controls where necessary

3. **Incident Response Activation** (Due: Immediate, Owner: Security Team)
   - Activate enhanced monitoring for identified threat scenarios
   - Prepare incident response team for potential security events
{{/if}}

### Long-term Strategic Recommendations
{{#if strategic_next_steps}}
{{strategic_next_steps}}
{{else}}
1. **Security Program Maturity**: Establish comprehensive information security program
2. **Regular Assessments**: Conduct quarterly threat modeling and annual penetration testing
3. **Security Culture**: Develop security-conscious organizational culture
4. **Threat Intelligence**: Implement proactive threat intelligence program
5. **Continuous Improvement**: Establish security metrics and continuous improvement processes
{{/if}}

### Review and Update Schedule
{{#if review_schedule}}
{{review_schedule}}
{{else}}
- **Quarterly Reviews**: Update threat landscape and risk assessments
- **Annual Assessment**: Complete threat model refresh and validation
- **Triggered Reviews**: Major system changes, security incidents, or regulatory updates
- **Next Scheduled Review**: {{next_review_date}}
{{/if}}

---

**Report prepared by:** {{threat_analyst}}  
**Technical reviewers:** {{#if technical_reviewers}}{{technical_reviewers}}{{else}}[Senior security architects]{{/if}}  
**Business approval:** {{business_owner}}  
**Document classification:** CONFIDENTIAL  
**Retention period:** 3 years from assessment date  

*This threat assessment contains sensitive security information and should be handled according to organizational data classification policies.*