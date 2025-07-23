---
name: "Threat Modeling"
description: "Systematic approach to identifying, analyzing, and mitigating security threats in systems and applications"
type: "skill"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "security"
tags: ["threat-modeling", "security-analysis", "risk-assessment", "architecture", "security-design"]
proficiency_levels:
  beginner: "Basic threat identification using simple frameworks"
  intermediate: "STRIDE methodology and attack tree analysis"
  advanced: "Custom frameworks and quantitative risk modeling"
parameters:
  methodology:
    type: "string"
    description: "Threat modeling methodology"
    default: "STRIDE"
    enum: ["STRIDE", "PASTA", "OCTAVE", "TRIKE", "VAST", "hybrid"]
  scope:
    type: "string"
    description: "Analysis scope"
    default: "application"
    enum: ["application", "system", "network", "organization", "supply_chain"]
  risk_appetite:
    type: "string"
    description: "Organization's risk tolerance"
    default: "moderate"
    enum: ["low", "moderate", "high", "very_high"]
  compliance_requirements:
    type: "array"
    description: "Regulatory requirements to consider"
    default: []
    enum: ["PCI-DSS", "HIPAA", "GDPR", "SOX", "ISO27001", "NIST"]
---

# Threat Modeling Skill

This skill provides systematic threat modeling capabilities using industry-standard methodologies to identify, analyze, and prioritize security threats in complex systems.

## Core Capabilities

### 1. Threat Identification
- **Asset Inventory**: Critical data, systems, and processes
- **Attack Surface Mapping**: Entry points and interfaces
- **Threat Actor Profiling**: Capabilities, motivations, and resources
- **Attack Vector Analysis**: Potential paths to compromise

### 2. Risk Assessment
- **Likelihood Evaluation**: Probability of successful attacks
- **Impact Analysis**: Business and technical consequences
- **Risk Prioritization**: Cost-benefit analysis for mitigations
- **Quantitative Modeling**: Expected annual loss calculations

### 3. Mitigation Strategy
- **Control Selection**: Preventive, detective, and corrective controls
- **Defense in Depth**: Layered security architecture
- **Residual Risk**: Remaining risk after mitigations
- **Continuous Monitoring**: Threat landscape evolution

### 4. Documentation & Communication
- **Threat Models**: Visual representations and narratives
- **Risk Registers**: Centralized risk tracking
- **Security Requirements**: Derived from threat analysis
- **Executive Reporting**: Business-focused risk communication

## Threat Modeling Methodologies

### STRIDE Framework
```
SPOOFING
├── Identity spoofing attacks
├── Authentication bypass
├── Impersonation threats
└── Credential theft scenarios

TAMPERING
├── Data integrity attacks  
├── Man-in-the-middle
├── Code injection
└── Configuration manipulation

REPUDIATION
├── Non-repudiation failures
├── Log tampering
├── Audit trail gaps
└── Transaction disputes

INFORMATION DISCLOSURE
├── Data exposure
├── Privacy violations
├── Information leakage
└── Unauthorized access

DENIAL OF SERVICE
├── Resource exhaustion
├── Service disruption
├── Availability attacks
└── Performance degradation

ELEVATION OF PRIVILEGE
├── Privilege escalation
├── Authorization bypass
├── Administrative access
└── System compromise
```

### PASTA (Process for Attack Simulation and Threat Analysis)
```
Stage 1: Define Objectives
• Business impact analysis
• Compliance requirements
• Security objectives
• Success criteria

Stage 2: Define Technical Scope  
• Application architecture
• Technology stack
• Network topology
• Data flows

Stage 3: Application Decomposition
• Use cases and user roles
• Entry and exit points
• Trust boundaries
• Dependencies

Stage 4: Threat Analysis
• Attack scenarios
• Threat agent capabilities
• Attack vectors
• Vulnerability correlation

Stage 5: Weakness Analysis
• Design flaws
• Implementation bugs
• Configuration errors
• Process weaknesses

Stage 6: Attack Modeling
• Attack trees
• Kill chains
• Attack scenarios
• Exploitation paths

Stage 7: Risk Analysis
• Business impact
• Technical impact
• Likelihood assessment
• Risk scoring
```

## Threat Modeling Process

### Phase 1: System Understanding
```
Architecture Analysis:
• System boundaries and scope
• Data flow diagrams (DFDs)
• Trust boundaries identification
• External dependencies mapping

Components Inventory:
• Web servers and applications
• Databases and data stores
• Network infrastructure
• Third-party services
• Human processes

Data Classification:
• Sensitive data identification
• Data flow mapping
• Storage locations
• Processing activities
• Retention requirements
```

### Phase 2: Threat Identification
```
Threat Enumeration:
Using STRIDE per element:

Process Threats:
├── Spoofing: Fake service instances
├── Tampering: Code injection attacks
├── Repudiation: Log manipulation
├── Information Disclosure: Memory dumps
├── Denial of Service: Resource exhaustion
└── Elevation of Privilege: Buffer overflows

Data Store Threats:
├── Spoofing: Rogue databases
├── Tampering: Direct DB access
├── Repudiation: Audit trail gaps
├── Information Disclosure: Data dumps
├── Denial of Service: Storage exhaustion
└── Elevation of Privilege: DB admin access

Data Flow Threats:
├── Spoofing: Man-in-the-middle
├── Tampering: Packet modification
├── Repudiation: Message alteration
├── Information Disclosure: Eavesdropping
├── Denial of Service: Connection flooding
└── Elevation of Privilege: Protocol exploits
```

### Phase 3: Risk Analysis
```
Likelihood Assessment:
• Threat actor capabilities
• Attack complexity
• Required resources
• Detection probability
• Success rate

Impact Assessment:
• Confidentiality impact
• Integrity impact  
• Availability impact
• Business disruption
• Regulatory violations
• Reputation damage

Risk Calculation:
Risk = Likelihood × Impact × Vulnerability

Where:
• Likelihood: 1-5 scale (Very Low to Very High)
• Impact: 1-5 scale (Minimal to Catastrophic)  
• Vulnerability: 0.1-1.0 (Well Protected to Exposed)
```

### Phase 4: Mitigation Planning
```
Control Categories:

PREVENTIVE CONTROLS:
• Input validation
• Authentication mechanisms
• Authorization checks
• Encryption implementation
• Network segmentation

DETECTIVE CONTROLS:
• Logging and monitoring
• Intrusion detection
• Anomaly detection
• Security scanning
• Audit mechanisms

CORRECTIVE CONTROLS:
• Incident response
• Backup and recovery
• Patch management
• Configuration management
• Business continuity

DETERRENT CONTROLS:
• Security policies
• Legal agreements
• Awareness training
• Physical security
• Compliance monitoring
```

## Attack Tree Analysis

### Example: Web Application Login Bypass
```
Goal: Gain Unauthorized Access to User Account

OR
├── Credential-based Attacks
│   OR
│   ├── Password Attacks
│   │   OR
│   │   ├── Brute Force (AND)
│   │   │   ├── No account lockout
│   │   │   ├── Weak password policy
│   │   │   └── No rate limiting
│   │   ├── Dictionary Attack (AND)
│   │   │   ├── Common passwords used
│   │   │   └── No complexity requirements
│   │   └── Credential Stuffing (AND)
│   │       ├── Breached credentials available
│   │       └── Users reuse passwords
│   └── Social Engineering (AND)
│       ├── Phishing successful
│       ├── User provides credentials
│       └── No 2FA implemented
│
├── Technical Vulnerabilities
│   OR
│   ├── SQL Injection (AND)
│   │   ├── Unparameterized queries
│   │   ├── Insufficient input validation
│   │   └── Database errors exposed
│   ├── Session Management (AND)
│   │   ├── Session fixation possible
│   │   ├── Weak session tokens
│   │   └── No session timeout
│   └── Authentication Bypass (AND)
│       ├── Logic flaws in auth code
│       ├── Race conditions
│       └── Parameter tampering
│
└── Infrastructure Attacks
    OR
    ├── Network Interception (AND)
    │   ├── Unencrypted traffic
    │   ├── Man-in-the-middle position
    │   └── Credential capture tools
    └── System Compromise (AND)
        ├── Server vulnerability
        ├── Privilege escalation
        └── Database access
```

## Threat Intelligence Integration

### Threat Actor Profiles
```
NATION-STATE ACTORS:
• Capabilities: Advanced persistent threats
• Motivations: Espionage, infrastructure disruption
• Resources: Significant funding and expertise
• Typical TTPs: Zero-day exploits, supply chain attacks

CYBERCRIMINALS:
• Capabilities: Sophisticated tools and techniques
• Motivations: Financial gain
• Resources: Organized crime networks
• Typical TTPs: Ransomware, banking trojans, fraud

INSIDER THREATS:
• Capabilities: Authorized access and knowledge
• Motivations: Financial, ideological, revenge
• Resources: System access and credentials
• Typical TTPs: Data exfiltration, sabotage

HACKTIVISTS:
• Capabilities: Moderate technical skills
• Motivations: Political or social causes
• Resources: Community support
• Typical TTPs: DDoS, website defacement, leaks

SCRIPT KIDDIES:
• Capabilities: Limited technical skills
• Motivations: Curiosity, recognition
• Resources: Publicly available tools
• Typical TTPs: Automated attacks, known exploits
```

## Output Formats

### Executive Threat Model Summary
```
THREAT MODEL EXECUTIVE SUMMARY

System: [Application/System Name]
Date: [Assessment Date]
Methodology: STRIDE + Attack Trees

RISK SUMMARY:
• Critical Risks: X
• High Risks: Y  
• Medium Risks: Z
• Low Risks: W

TOP THREATS:
1. [Threat Name] - Risk Score: X.X
   Impact: [Business consequence]
   Likelihood: [Probability assessment]
   
2. [Threat Name] - Risk Score: X.X
   Impact: [Business consequence]  
   Likelihood: [Probability assessment]

3. [Threat Name] - Risk Score: X.X
   Impact: [Business consequence]
   Likelihood: [Probability assessment]

RECOMMENDED MITIGATIONS:
1. [Priority 1 Control] - Addresses X threats
2. [Priority 2 Control] - Addresses Y threats  
3. [Priority 3 Control] - Addresses Z threats

RESIDUAL RISK: [Acceptable/Needs Review/Unacceptable]
```

### Technical Threat Analysis
```
THREAT: [Specific Threat Name]
ID: THR-001
STRIDE Category: [S/T/R/I/D/E]

DESCRIPTION:
[Detailed threat scenario description]

AFFECTED ASSETS:
• [Asset 1] - [Impact type]
• [Asset 2] - [Impact type]

THREAT ACTORS:
• [Actor Type] - [Capability Level]
• [Motivation] - [Resource Level]

ATTACK VECTORS:
1. [Vector 1] - [Complexity: Low/Medium/High]
2. [Vector 2] - [Complexity: Low/Medium/High]

PREREQUISITES:
• [Condition 1]
• [Condition 2]

IMPACT ANALYSIS:
• Confidentiality: [High/Medium/Low]
• Integrity: [High/Medium/Low]  
• Availability: [High/Medium/Low]
• Business Impact: [Description]

LIKELIHOOD ASSESSMENT:
• Attack Complexity: [Low/Medium/High]
• Required Skills: [Basic/Intermediate/Advanced]
• Required Access: [None/User/Admin]
• Overall Likelihood: [1-5 scale]

EXISTING CONTROLS:
• [Control 1] - [Effectiveness: High/Medium/Low]
• [Control 2] - [Effectiveness: High/Medium/Low]

RECOMMENDED MITIGATIONS:
1. [Mitigation 1] - [Cost: $X, Effort: Y days]
2. [Mitigation 2] - [Cost: $X, Effort: Y days]

ACCEPTANCE CRITERIA:
[Conditions under which residual risk is acceptable]
```

## Integration Capabilities

### Works Best With:
- **Security Analyst Persona**: Strategic security expertise
- **Penetration Testing Skill**: Validation of identified threats
- **Code Review Skills**: Implementation vulnerability correlation
- **Risk Assessment Templates**: Consistent risk documentation
- **Architecture Documentation**: System understanding

### Tool Integration:
- **Microsoft Threat Modeling Tool**: Visual diagram creation
- **OWASP Threat Dragon**: Web-based threat modeling
- **IriusRisk**: Automated threat identification
- **ThreatModeler**: Enterprise threat modeling platform

## Continuous Threat Modeling

### Iterative Process:
1. **Initial Assessment**: Baseline threat model creation
2. **Regular Reviews**: Quarterly threat landscape updates  
3. **Change Triggers**: Architecture modifications, new threats
4. **Validation Testing**: Penetration testing correlation
5. **Metrics Tracking**: Threat model effectiveness measurement

### Automation Opportunities:
- **Asset Discovery**: Automated inventory updates
- **Threat Intelligence**: Feed integration for new threats
- **Control Validation**: Automated testing of mitigations
- **Risk Scoring**: Dynamic risk calculation updates