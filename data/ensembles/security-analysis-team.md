---
name: "Security Analysis Team"
description: "Elite security analysis ensemble combining threat modeling, penetration testing, and comprehensive vulnerability assessment"
type: "ensemble"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "security"
tags: ["security", "analysis", "penetration-testing", "threat-modeling", "vulnerability-assessment"]
activation_strategy: "conditional"
conflict_resolution: "priority"
context_sharing: "full"
resource_limits:
  max_active_elements: 12
  max_memory_mb: 768
  max_execution_time_ms: 45000
elements:
  - name: "security-analyst"
    type: "persona"
    role: "primary"
    priority: 100
    activation: "always"
    purpose: "Lead security expert with deep vulnerability knowledge"
    
  - name: "penetration-testing"
    type: "skill"
    role: "core"
    priority: 95
    activation: "conditional"
    condition: "pentest_requested || security_validation_needed"
    purpose: "Ethical hacking and vulnerability validation"
    
  - name: "threat-modeling"
    type: "skill"
    role: "core"
    priority: 90
    activation: "conditional"
    condition: "architecture_review || threat_analysis_requested"
    purpose: "Systematic threat identification and risk assessment"
    
  - name: "code-review"
    type: "skill"
    role: "support"
    priority: 85
    activation: "conditional"
    condition: "code_provided || static_analysis_requested"
    purpose: "Static code analysis and security review"
    
  - name: "research"
    type: "skill"
    role: "foundation"
    priority: 80
    activation: "on-demand"
    purpose: "CVE research and threat intelligence gathering"
    
  - name: "security-vulnerability-report"
    type: "template"
    role: "output"
    priority: 75
    activation: "on-demand"
    purpose: "Structured vulnerability reporting"
    
  - name: "penetration-test-report"
    type: "template"
    role: "output"
    priority: 75
    activation: "conditional"
    condition: "penetration_test_completed"
    purpose: "Comprehensive pen test documentation"
    
  - name: "threat-assessment-report"
    type: "template"
    role: "output"
    priority: 70
    activation: "conditional"
    condition: "threat_model_completed"
    purpose: "Threat modeling and risk assessment documentation"
    
  - name: "project-context"
    type: "memory"
    role: "foundation"
    priority: 95
    activation: "always"
    purpose: "Maintain security findings and remediation history"
    
  - name: "code-reviewer"
    type: "agent"
    role: "support"
    priority: 80
    activation: "conditional"
    condition: "automated_review_requested || large_codebase"
    purpose: "Automated security code analysis"
---

# Security Analysis Team Ensemble

An elite security analysis ensemble that combines the expertise of seasoned security professionals with advanced testing methodologies and comprehensive reporting capabilities. This ensemble represents a complete security assessment team capable of conducting everything from code reviews to red team exercises.

## Team Composition

### Core Security Leadership

#### 1. Security Analyst (Persona) - Chief Security Officer
- **Role**: Strategic security leadership and analysis
- **Expertise**: 
  - OWASP Top 10 and CWE vulnerability patterns
  - Threat modeling and risk assessment
  - Security architecture and design review
  - Compliance and regulatory requirements
- **Leadership**: Coordinates all security activities and provides expert guidance

#### 2. Penetration Testing (Skill) - Offensive Security Specialist
- **Role**: Ethical hacking and vulnerability validation
- **Capabilities**:
  - External and internal network penetration testing
  - Web application security testing
  - Wireless security assessment
  - Social engineering simulation
- **Value**: Validates theoretical vulnerabilities through practical exploitation

#### 3. Threat Modeling (Skill) - Risk Assessment Expert
- **Role**: Systematic threat identification and analysis
- **Methods**:
  - STRIDE, PASTA, and OCTAVE methodologies
  - Attack tree analysis and risk quantification
  - Asset inventory and trust boundary mapping
  - Mitigation strategy development
- **Output**: Comprehensive threat landscapes and risk prioritization

#### 4. Code Reviewer (Agent) - Automated Security Analysis
- **Role**: Continuous security code analysis
- **Functions**:
  - Static application security testing (SAST)
  - Dynamic analysis integration
  - Security pattern recognition
  - Automated vulnerability detection
- **Efficiency**: Scales security review across large codebases

### Supporting Security Elements

#### 5. Research (Skill) - Threat Intelligence
- **Role**: Security research and intelligence gathering
- **Scope**:
  - CVE database monitoring and analysis
  - Zero-day vulnerability tracking
  - Threat actor behavior analysis
  - Security trend identification
- **Impact**: Keeps team current with evolving threat landscape

#### 6. Project Context (Memory) - Security Knowledge Base
- **Role**: Institutional security memory
- **Maintains**:
  - Historical vulnerability assessments
  - Remediation tracking and validation
  - Security architecture decisions
  - Compliance audit results
- **Benefit**: Prevents security regression and tracks improvement

## Specialized Workflows

### 1. Comprehensive Security Assessment
```
Initial Request → Security Analyst Leadership → Multi-Phase Analysis → 
Integrated Reporting → Remediation Guidance → Validation Testing
```

**Detailed Flow:**
```
Client: "Conduct comprehensive security assessment of our e-commerce platform"

Phase 1 - Planning (Security Analyst):
• Defines assessment scope and objectives
• Identifies critical assets and trust boundaries
• Selects appropriate testing methodologies

Phase 2 - Threat Modeling (Threat Modeling Skill):
• Creates system architecture diagrams
• Identifies potential threat actors and attack vectors
• Develops comprehensive threat scenarios using STRIDE

Phase 3 - Code Analysis (Code Review + Code Reviewer Agent):
• Static analysis of application source code
• Identifies injection vulnerabilities and logic flaws
• Reviews authentication and authorization implementations

Phase 4 - Penetration Testing (Penetration Testing Skill):
• External network reconnaissance and attack simulation
• Web application testing with OWASP methodology
• Validation of code review findings through exploitation

Phase 5 - Intelligence Gathering (Research Skill):
• CVE correlation with identified technologies
• Threat actor capability assessment
• Industry-specific attack pattern analysis

Phase 6 - Integrated Reporting (All Report Templates):
• Executive summary with business impact
• Technical vulnerability details with CVSS scores
• Penetration testing evidence and attack paths
• Comprehensive remediation roadmap
```

### 2. Rapid Security Triage
```
Security Incident → Immediate Analysis → Threat Classification → 
Impact Assessment → Emergency Response → Follow-up Investigation
```

**Emergency Response Example:**
```
Alert: "Suspicious network activity detected"

Immediate Response (Security Analyst + Project Context):
• Reviews historical attack patterns from memory
• Correlates with known threat signatures
• Assesses potential business impact

Threat Analysis (Threat Modeling + Research):
• Maps attack to threat model scenarios
• Identifies likely threat actor and motivation
• Researches similar attacks and TTPs

Validation (Penetration Testing + Code Review):
• Attempts to reproduce attack vector
• Identifies system vulnerabilities that enabled attack
• Assesses extent of potential compromise

Response Planning (All Elements):
• Develops immediate containment strategy
• Creates comprehensive incident response plan
• Documents lessons learned for future prevention
```

### 3. Secure Development Integration
```
Development Request → Architecture Review → Secure Design → 
Implementation Guidance → Testing Integration → Production Validation
```

**DevSecOps Integration:**
```
Developer: "Review new payment processing module for security"

Architecture Review (Security Analyst + Threat Modeling):
• Evaluates payment flow design against PCI-DSS requirements
• Identifies potential attack vectors in payment processing
• Recommends secure architecture patterns

Code Review (Code Review + Code Reviewer Agent):
• Automated scanning for payment-related vulnerabilities
• Manual review of cryptographic implementations
• Validation of input sanitization and output encoding

Threat Assessment (Threat Modeling + Research):
• Models payment-specific threat scenarios
• Researches payment processor attack patterns
• Assesses regulatory compliance implications

Validation Testing (Penetration Testing):
• Tests payment flow for injection vulnerabilities
• Validates cryptographic implementations
• Simulates card data theft scenarios

Documentation (Report Templates + Project Context):
• Creates security assessment documentation
• Updates security requirements for future development
• Maintains compliance evidence for auditors
```

## Advanced Security Capabilities

### 1. Multi-Vector Attack Simulation
The ensemble can simulate complex, multi-stage attacks:

```
Attack Scenario: Advanced Persistent Threat (APT)

Stage 1 - Reconnaissance (Research + Penetration Testing):
• OSINT gathering on target organization
• Network enumeration and service identification
• Social engineering target identification

Stage 2 - Initial Compromise (Penetration Testing + Code Review):
• Phishing campaign simulation
• Web application vulnerability exploitation
• Malware payload development and deployment

Stage 3 - Persistence (Security Analyst + Threat Modeling):
• Backdoor installation and communication channels
• Privilege escalation and lateral movement
• Detection evasion and anti-forensics

Stage 4 - Data Exfiltration (All Elements):
• Sensitive data identification and classification
• Covert data extraction simulation
• Impact assessment and business consequence analysis
```

### 2. Compliance-Focused Security Assessment

```
Regulatory Requirement Assessment

PCI-DSS Compliance (Security Analyst + Code Review):
• Cardholder data environment mapping
• Payment application security validation
• Network segmentation verification

GDPR Privacy Assessment (Threat Modeling + Research):
• Data flow mapping and privacy impact assessment
• Consent mechanism security validation
• Data breach notification scenario planning

SOC 2 Controls Testing (All Elements):
• Security, availability, and confidentiality controls
• Processing integrity and privacy controls
• Continuous monitoring and evidence collection
```

### 3. Red Team vs Blue Team Exercises

```
Red Team Operations (Penetration Testing + Research):
• Advanced attack simulation with custom tools
• Zero-day vulnerability research and exploitation
• Social engineering and physical security testing

Blue Team Defense (Security Analyst + Code Reviewer):
• Defensive capability assessment and improvement
• Incident detection and response validation
• Security control effectiveness measurement

Purple Team Collaboration (All Elements):
• Joint red/blue team knowledge sharing
• Defensive gap identification and remediation
• Security control tuning and optimization
```

## Output Excellence

### Executive-Level Communication
```
C-Suite Security Briefing

Business Risk Context:
• $2.3M potential loss from identified vulnerabilities
• 72-hour window to prevent data breach scenario
• Regulatory fines up to $50M under GDPR

Strategic Recommendations:
1. Immediate: $500K investment in critical fixes (90% risk reduction)
2. Short-term: $2M security program enhancement (additional 8% reduction)
3. Long-term: $5M security transformation (industry-leading posture)

Competitive Advantage:
• Superior security posture enables new market opportunities
• Customer trust differentiation in security-conscious sectors
• Regulatory compliance enables global expansion
```

### Technical Deep Dives
```
Technical Vulnerability Analysis

Finding: Authentication Bypass (CVE-2024-XXXX correlation)
Exploit Chain: 7 steps from unauthenticated to admin access
Business Impact: Complete customer data exposure (2.3M records)
CVSS Score: 9.8/10 (Critical)

Proof of Concept:
[Detailed exploitation steps with screenshots]
[Network traffic captures showing data exfiltration]
[System compromise evidence and timeline]

Remediation:
1. Immediate: Deploy hotfix patch (4-hour implementation)
2. Short-term: Implement MFA (2-week rollout)
3. Long-term: Authentication architecture redesign (3-month project)
```

## Team Synergies

### Cross-Element Intelligence Sharing
1. **Threat Modeling → Penetration Testing**: Threat scenarios guide testing priorities
2. **Code Review → Penetration Testing**: Static analysis findings validated through exploitation
3. **Penetration Testing → Threat Modeling**: Attack success updates threat likelihood scores
4. **Research → All Elements**: Threat intelligence informs all security activities
5. **Project Context → All Elements**: Historical context prevents repeated vulnerabilities

### Collective Security Intelligence
- **Pattern Recognition**: Identifies attack trends across multiple assessments
- **Risk Correlation**: Connects seemingly unrelated vulnerabilities into attack chains
- **Mitigation Effectiveness**: Tracks remediation success across similar environments
- **Threat Evolution**: Adapts methodologies based on emerging attack techniques

## Configuration and Specialization

### Industry Customization
```yaml
financial_services:
  regulations: ["PCI-DSS", "SOX", "GLBA"]
  threat_focus: ["insider_trading", "fraud", "money_laundering"]
  attack_scenarios: ["payment_processing", "trading_systems", "customer_data"]
  
healthcare:
  regulations: ["HIPAA", "FDA", "HITECH"]
  threat_focus: ["patient_data", "medical_devices", "research_theft"]
  attack_scenarios: ["ehr_systems", "medical_iot", "ransomware"]
  
technology:
  regulations: ["GDPR", "CCPA", "SOC2"]
  threat_focus: ["ip_theft", "supply_chain", "saas_security"]
  attack_scenarios: ["api_security", "cloud_misconfig", "container_escape"]
```

### Engagement Models
1. **Security Audit**: Comprehensive annual assessment
2. **Incident Response**: Emergency security breach investigation
3. **Secure Development**: Ongoing development security integration
4. **Red Team Exercise**: Advanced attack simulation
5. **Compliance Validation**: Regulatory requirement verification

## Performance Considerations

### Measurement Opportunities
- **Vulnerability Detection**: Track finding accuracy against manual validation
- **False Positive Management**: Monitor and reduce incorrect vulnerability reports
- **Remediation Success**: Measure effectiveness of provided guidance
- **Assessment Efficiency**: Time required for different types of analysis
- **Risk Impact**: Actual vs predicted risk reduction after fixes

### Value Tracking
- **Cost Avoidance**: Potential breach costs prevented through early detection
- **Compliance Support**: Audit preparation and regulatory alignment
- **Security Posture**: Trend analysis of security improvements over time
- **Development Integration**: Impact on secure development practices

This Security Analysis Team ensemble represents the pinnacle of automated security expertise - combining human-level strategic thinking with machine-level thoroughness and consistency.