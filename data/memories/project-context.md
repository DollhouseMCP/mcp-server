---
name: "Project Context"
description: "Persistent memory for project-specific information, decisions, and history"
type: "memory"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "project"
tags: ["context", "project", "history", "decisions", "knowledge-base"]
storage_backend: "file"
retention_policy:
  default: "perpetual"
  rules:
    - type: "decisions"
      retention: "perpetual"
    - type: "daily_updates"
      retention: "90 days"
    - type: "meeting_notes"
      retention: "1 year"
    - type: "technical_details"
      retention: "perpetual"
privacy_level: "project-internal"
searchable: true
schema:
  project_info:
    type: "object"
    properties:
      name: "string"
      description: "string"
      start_date: "date"
      team_members: "array"
      tech_stack: "array"
      repositories: "array"
  decisions:
    type: "array"
    items:
      date: "date"
      decision: "string"
      rationale: "string"
      participants: "array"
  technical_notes:
    type: "object"
    properties:
      architecture: "object"
      dependencies: "array"
      api_contracts: "object"
      known_issues: "array"
_dollhouseMCPTest: true
_testMetadata:
  suite: "bundled-test-data"
  purpose: "General test data for DollhouseMCP system validation"
  created: "2025-08-20"
  version: "1.0.0"
  migrated: "2025-08-20T23:47:24.343Z"
  originalPath: "data/memories/project-context.md"
---
# Project Context Memory

This memory element maintains comprehensive project knowledge including technical decisions, team information, architecture details, and historical context.

## Memory Structure

### 1. Project Information
```yaml
project:
  name: "{{project_name}}"
  description: "{{project_description}}"
  start_date: "{{start_date}}"
  status: "{{status}}"
  phase: "{{current_phase}}"
  
team:
  lead: "{{team_lead}}"
  members:
    - name: "{{member_name}}"
      role: "{{role}}"
      expertise: ["{{skill1}}", "{{skill2}}"]
      availability: "{{availability}}"
  
stakeholders:
    - name: "{{stakeholder_name}}"
      role: "{{stakeholder_role}}"
      interest: "{{interest_level}}"
```

### 2. Technical Context
```yaml
architecture:
  pattern: "{{architecture_pattern}}"
  components:
    frontend:
      framework: "{{frontend_framework}}"
      version: "{{version}}"
      key_libraries: ["{{lib1}}", "{{lib2}}"]
    backend:
      language: "{{backend_language}}"
      framework: "{{backend_framework}}"
      database: "{{database_type}}"
    infrastructure:
      hosting: "{{hosting_platform}}"
      ci_cd: "{{ci_cd_tool}}"
      monitoring: "{{monitoring_solution}}"

api_endpoints:
  - path: "/api/v1/{{resource}}"
    method: "{{http_method}}"
    description: "{{endpoint_description}}"
    authentication: "{{auth_type}}"

integrations:
  - service: "{{service_name}}"
    purpose: "{{integration_purpose}}"
    status: "{{integration_status}}"
```

### 3. Decision Log
```yaml
decisions:
  - date: "2025-07-20"
    category: "architecture"
    decision: "Use microservices architecture"
    rationale: "Need independent scaling and deployment"
    impact: "high"
    participants: ["John", "Sarah", "Mike"]
    alternatives_considered:
      - option: "Monolithic"
        rejected_because: "Scaling limitations"
      - option: "Serverless"
        rejected_because: "Vendor lock-in concerns"
    follow_up: "Review after 6 months"
    
  - date: "2025-07-21"
    category: "technology"
    decision: "Adopt TypeScript for all new code"
    rationale: "Type safety and better IDE support"
    impact: "medium"
    participants: ["Dev Team"]
    migration_plan: "Gradual migration over Q3"
```

### 4. Knowledge Base
```yaml
common_issues:
  - issue: "Database connection timeout"
    symptoms: ["API returns 504", "Logs show connection pool exhausted"]
    root_cause: "Connection pool size too small"
    solution: "Increased pool size to 50"
    prevention: "Monitor connection usage metrics"
    
coding_conventions:
  - category: "naming"
    convention: "Use camelCase for variables"
    examples: ["userName", "getProductList"]
    
  - category: "file_structure"
    convention: "Feature-based organization"
    structure: "src/features/[feature-name]/"
    
deployment_procedures:
  staging:
    steps:
      1: "Run test suite"
      2: "Build Docker image"
      3: "Deploy to staging cluster"
      4: "Run smoke tests"
    rollback: "kubectl rollout undo deployment/app-staging"
    
  production:
    approval_required: true
    steps:
      1: "Get approval from PM"
      2: "Create release tag"
      3: "Deploy using blue-green strategy"
      4: "Monitor for 30 minutes"
```

## Memory Operations

### 1. Context Retrieval
```
Query: "What database are we using?"
Response: "PostgreSQL 14.2 on AWS RDS, chosen for JSONB support and proven scalability"

Query: "Why did we choose React?"
Response: "Decision made on 2025-07-15: React chosen for component reusability, large ecosystem, and team expertise. Vue.js was considered but team lacked experience."
```

### 2. Historical Analysis
```
Query: "What decisions were made about authentication?"
Response: 
- 2025-07-18: OAuth2 with JWT tokens
- 2025-07-25: Added 2FA for admin users
- 2025-08-02: Implemented refresh token rotation
```

### 3. Team Knowledge
```
Query: "Who knows about the payment system?"
Response: "Sarah (primary), Mike (secondary). Sarah implemented the Stripe integration and Mike did the refund logic."
```

## Integration Patterns

### Auto-Population Sources
1. **Meeting Notes**: Extracts decisions and action items
2. **Code Commits**: Updates technical details
3. **Documentation**: Syncs architecture changes
4. **Chat History**: Captures informal decisions

### Conflict Resolution
When conflicting information is detected:
1. More recent information takes precedence
2. Information from authoritative sources (PM, Tech Lead) weighted higher
3. Conflicts logged for human review

## Privacy & Access Control

### Access Levels
- **Public**: General project information
- **Team**: Technical details, non-sensitive decisions
- **Restricted**: Security details, personnel information
- **Confidential**: Financial data, strategic plans

### Data Retention
```yaml
retention_rules:
  immediate_purge:
    - passwords
    - api_keys
    - personal_emails
    
  short_term:
    - daily_standups: 30_days
    - debug_logs: 7_days
    
  long_term:
    - architectural_decisions: permanent
    - post_mortems: 2_years
    - release_notes: 1_year
```

## Search Capabilities

### Natural Language Queries
- "What did we decide about caching?"
- "Show me all security-related decisions"
- "Who worked on the user authentication?"
- "What were the reasons for choosing MongoDB?"

### Structured Queries
```yaml
search:
  type: "decision"
  category: "architecture"
  date_range: 
    from: "2025-01-01"
    to: "2025-07-31"
  participants: ["Sarah"]
```

## Learning & Adaptation

### Pattern Recognition
- Identifies recurring issues
- Suggests solutions based on past fixes
- Alerts when similar problems arise
- Tracks decision outcomes

### Knowledge Graph
Builds relationships between:
- People and their expertise areas
- Decisions and their outcomes
- Problems and their solutions
- Components and their dependencies