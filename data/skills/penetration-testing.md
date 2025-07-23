---
name: "Penetration Testing"
description: "Systematic security testing methodology for identifying vulnerabilities through ethical hacking"
type: "skill"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "security"
tags: ["penetration-testing", "ethical-hacking", "vulnerability-assessment", "security", "testing"]
proficiency_levels:
  beginner: "Basic vulnerability scanning and tool usage"
  intermediate: "Manual testing techniques and exploit development"
  advanced: "Advanced persistent threats and custom payload creation"
parameters:
  test_scope:
    type: "array"
    description: "Areas to test"
    default: ["web_application", "network", "wireless", "social_engineering"]
  methodology:
    type: "string"
    description: "Testing methodology to follow"
    default: "OWASP"
    enum: ["OWASP", "NIST", "PTES", "OSsTMM", "OWASP-WSTG"]
  test_depth:
    type: "string"
    description: "Depth of testing"
    default: "comprehensive"
    enum: ["surface", "standard", "comprehensive", "red_team"]
  stealth_level:
    type: "string"
    description: "How stealthy to be"
    default: "normal"
    enum: ["aggressive", "normal", "stealth", "passive"]
---

# Penetration Testing Skill

This skill provides systematic penetration testing capabilities using industry-standard methodologies to identify security vulnerabilities through controlled, ethical attacks.

## Core Capabilities

### 1. Reconnaissance & Information Gathering
- **Passive Reconnaissance**: OSINT, DNS enumeration, search engine discovery
- **Active Reconnaissance**: Port scanning, service enumeration, banner grabbing
- **Social Engineering**: Phishing simulations, pretexting, physical security
- **Network Mapping**: Topology discovery, trust relationships, attack paths

### 2. Vulnerability Assessment
- **Automated Scanning**: Nessus, OpenVAS, Qualys integration
- **Manual Testing**: Custom payloads, logic flaws, business logic bypasses
- **Configuration Review**: Hardening standards, security baselines
- **Compliance Validation**: PCI-DSS, SOX, HIPAA requirements

### 3. Exploitation Techniques
- **Web Application**: OWASP Top 10, injection attacks, broken authentication
- **Network Services**: Buffer overflows, privilege escalation, lateral movement
- **Wireless Security**: WPA/WEP cracking, rogue access points, evil twins
- **Cloud Security**: Misconfigurations, IAM weaknesses, container escapes

### 4. Post-Exploitation Activities
- **Persistence**: Backdoors, scheduled tasks, registry modifications
- **Privilege Escalation**: Local/domain admin compromise
- **Data Exfiltration**: Sensitive data identification and extraction simulation
- **Lateral Movement**: Pivot techniques, credential harvesting

## Testing Methodologies

### OWASP Web Security Testing Guide (WSTG)
```
Phase 1: Information Gathering
├── Conduct Search Engine Discovery (WSTG-INFO-01)
├── Fingerprint Web Server (WSTG-INFO-02)
├── Review Webserver Metafiles (WSTG-INFO-03)
└── Enumerate Applications (WSTG-INFO-04)

Phase 2: Configuration and Deployment
├── Test Network Infrastructure (WSTG-CONF-01)
├── Test Application Platform (WSTG-CONF-02)
├── Test File Extensions Handling (WSTG-CONF-03)
└── Review Old Backup Files (WSTG-CONF-04)

Phase 3: Identity Management Testing
├── Test Role Definitions (WSTG-IDNT-01)
├── Test User Registration Process (WSTG-IDNT-02)
├── Test Account Provisioning (WSTG-IDNT-03)
└── Test Account Enumeration (WSTG-IDNT-05)
```

### PTES (Penetration Testing Execution Standard)
```
1. Pre-engagement Interactions
   - Scope definition
   - Rules of engagement
   - Legal considerations

2. Intelligence Gathering
   - Active/passive reconnaissance
   - Corporate information gathering
   - Individual information gathering

3. Threat Modeling
   - Business asset analysis
   - Threat agent identification
   - Attack vector analysis

4. Vulnerability Analysis
   - Vulnerability research
   - Vulnerability validation
   - Attack planning

5. Exploitation
   - Precision attacks
   - Customized attacks
   - Persistence mechanisms

6. Post Exploitation
   - Infrastructure analysis
   - Pillaging
   - Network traversal
   - Cleanup

7. Reporting
   - Executive summary
   - Technical findings
   - Risk ratings
   - Remediation roadmap
```

## Testing Phases

### Phase 1: Planning & Reconnaissance
```
Objectives:
• Define scope and rules of engagement
• Gather public information about target
• Identify potential attack vectors
• Map external network presence

Tools & Techniques:
• Nmap for network discovery
• Recon-ng for OSINT gathering
• theHarvester for email enumeration
• Shodan for exposed services
• Social media reconnaissance

Deliverables:
• Test plan and scope document
• Network topology diagram
• External attack surface map
• OSINT intelligence report
```

### Phase 2: Scanning & Enumeration
```
Objectives:
• Identify live systems and services
• Enumerate software versions
• Discover potential vulnerabilities
• Map trust relationships

Tools & Techniques:
• Nessus/OpenVAS vulnerability scanning
• Nikto web server scanning
• Enum4linux SMB enumeration
• SNMP walking and enumeration
• DNS zone transfers

Deliverables:
• Vulnerability assessment report
• Service enumeration results
• Potential attack vectors list
• Risk prioritization matrix
```

### Phase 3: Exploitation
```
Objectives:
• Validate identified vulnerabilities
• Gain initial system access
• Demonstrate business impact
• Test defense mechanisms

Tools & Techniques:
• Metasploit exploitation framework
• Custom exploit development
• Password attacks (Hydra, Hashcat)
• Social engineering toolkit
• Physical security testing

Deliverables:
• Proof-of-concept exploits
• Screenshots of compromised systems
• Extracted sensitive data samples
• Attack timeline documentation
```

### Phase 4: Post-Exploitation
```
Objectives:
• Maintain persistent access
• Escalate privileges
• Move laterally through network
• Assess data exposure risk

Tools & Techniques:
• Privilege escalation exploits
• Credential dumping (Mimikatz)
• Network pivoting (ProxyChains)
• PowerShell Empire/Cobalt Strike
• Data mining and classification

Deliverables:
• Network compromise diagram
• Sensitive data inventory
• Privilege escalation paths
• Persistence mechanism documentation
```

## Specialized Testing Areas

### Web Application Testing
```
Authentication Testing:
□ Username enumeration
□ Brute force protection
□ Session management
□ Password policy enforcement
□ Multi-factor authentication bypass

Authorization Testing:
□ Path traversal attacks
□ Privilege escalation
□ Insecure direct object references
□ Missing function level access control

Input Validation Testing:
□ SQL injection (all types)
□ Cross-site scripting (XSS)
□ Command injection
□ LDAP injection
□ XML/XXE attacks

Session Management:
□ Session token analysis
□ Session fixation
□ Cross-site request forgery
□ Session timeout validation
```

### Network Infrastructure Testing
```
Network Reconnaissance:
• Port scanning and service enumeration
• SNMP community string testing
• Network protocol analysis
• Wireless network assessment

Service Testing:
• SSH/Telnet brute forcing
• SMB share enumeration
• FTP anonymous access
• Database service testing

Network Segmentation:
• VLAN hopping attempts
• Firewall rule validation
• Network access control bypass
• DMZ security assessment
```

### Wireless Security Testing
```
Wireless Reconnaissance:
• Access point discovery
• Encryption type identification
• Client device enumeration
• Hidden SSID detection

Attack Techniques:
• WEP key cracking
• WPA/WPA2 dictionary attacks
• WPS PIN attacks
• Evil twin access points
• Wireless packet injection

Assessment Areas:
• Guest network isolation
• Enterprise authentication
• Rogue access point detection
• Wireless intrusion prevention
```

## Report Generation

### Executive Summary Template
```
EXECUTIVE SUMMARY

Overall Risk Rating: [HIGH/MEDIUM/LOW]
Critical Findings: X
High Risk Findings: Y
Medium Risk Findings: Z

BUSINESS IMPACT:
• Potential for complete network compromise
• Risk of sensitive data exposure
• Compliance violation concerns
• Estimated remediation cost: $X

TOP 3 RECOMMENDATIONS:
1. [Most critical remediation]
2. [Second priority fix]
3. [Third priority improvement]

TIMELINE FOR REMEDIATION:
• Critical issues: 7 days
• High risk issues: 30 days
• Medium risk issues: 90 days
```

### Technical Finding Format
```
FINDING: [Vulnerability Name]
SEVERITY: [Critical/High/Medium/Low]
CVSS Score: X.X
CWE ID: CWE-XXX

DESCRIPTION:
[Technical description of the vulnerability]

IMPACT:
[What an attacker could accomplish]

PROOF OF CONCEPT:
[Steps to reproduce or exploit code]

AFFECTED SYSTEMS:
• System 1 (IP: x.x.x.x)
• System 2 (IP: x.x.x.x)

REMEDIATION:
[Specific steps to fix the issue]

REFERENCES:
• CVE-XXXX-XXXX
• https://example.com/advisory
```

## Integration Notes

Works exceptionally well with:
- **Security Analyst Persona**: Strategic security guidance
- **Code Review Skill**: Static analysis correlation  
- **Vulnerability Assessment templates**: Structured reporting
- **Risk Assessment templates**: Business impact analysis
- **Incident Response procedures**: Breach simulation

## Compliance Considerations

Testing approach adapts to:
- **PCI-DSS**: Payment card industry requirements
- **HIPAA**: Healthcare data protection standards
- **SOX**: Financial reporting security controls
- **GDPR**: Data protection impact assessments
- **ISO 27001**: Information security management

## Ethical Guidelines

All testing follows strict ethical boundaries:
- Written authorization required before testing
- Scope strictly limited to agreed boundaries
- No unnecessary system damage or disruption
- Confidential handling of discovered vulnerabilities
- Responsible disclosure of findings