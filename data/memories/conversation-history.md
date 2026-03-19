---
name: "Conversation History"
description: "Maintains context and continuity across multiple conversation sessions"
type: "memory"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "interaction"
tags: ["conversation", "context", "history", "continuity", "session"]
storage_backend: "memory"
retention_policy:
  default: "30 days"
  rules:
    - type: "important_marked"
      retention: "90 days"
    - type: "user_preferences"
      retention: "perpetual"
    - type: "task_context"
      retention: "until_complete"
    - type: "general_chat"
      retention: "7 days"
privacy_level: "user-private"
searchable: true
schema:
  conversation:
    type: "object"
    properties:
      session_id: "string"
      timestamp: "datetime"
      messages: "array"
      context: "object"
      summary: "string"
  user_preferences:
    type: "object"
    properties:
      communication_style: "string"
      expertise_level: "string"
      interests: "array"
      constraints: "array"
  topic_tracking:
    type: "object"
    properties:
      active_topics: "array"
      completed_topics: "array"
      parked_topics: "array"
---
# Conversation History Memory

This memory element provides continuity across conversation sessions, maintaining context, preferences, and ongoing topics to enable more natural and productive interactions.

## Memory Components

### 1. Session Management
```yaml
current_session:
  id: "{{session_id}}"
  started: "{{timestamp}}"
  topics_discussed:
    - topic: "{{topic_name}}"
      status: "{{status}}"
      key_points: ["{{point1}}", "{{point2}}"]
      action_items: ["{{action1}}", "{{action2}}"]
  
previous_sessions:
  - id: "{{previous_session_id}}"
    date: "{{date}}"
    summary: "{{session_summary}}"
    unresolved_items: ["{{item1}}", "{{item2}}"]
```

### 2. Context Preservation
```yaml
working_context:
  current_project: "{{project_name}}"
  active_files:
    - path: "{{file_path}}"
      last_modified: "{{timestamp}}"
      changes_discussed: ["{{change1}}", "{{change2}}"]
  
  current_task:
    description: "{{task_description}}"
    progress: "{{progress_percentage}}"
    blockers: ["{{blocker1}}", "{{blocker2}}"]
    next_steps: ["{{step1}}", "{{step2}}"]
  
  code_snippets:
    - id: "{{snippet_id}}"
      language: "{{language}}"
      purpose: "{{purpose}}"
      content: |
        {{code_content}}
```

### 3. User Model
```yaml
user_profile:
  expertise_level: "{{level}}"  # beginner, intermediate, expert
  technical_background:
    languages: ["{{lang1}}", "{{lang2}}"]
    frameworks: ["{{framework1}}", "{{framework2}}"]
    domains: ["{{domain1}}", "{{domain2}}"]
  
  communication_preferences:
    detail_level: "{{level}}"  # concise, balanced, detailed
    example_preference: "{{type}}"  # minimal, moderate, extensive
    explanation_style: "{{style}}"  # technical, analogies, step-by-step
  
  learning_patterns:
    prefers_examples: true
    asks_why: true
    needs_validation: false
    explores_alternatives: true
```

### 4. Topic Threading
```yaml
topic_threads:
  - id: "thread_001"
    title: "API Design Discussion"
    status: "active"
    created: "2025-07-20"
    messages: 14
    participants: ["user", "assistant"]
    key_decisions:
      - "Use REST over GraphQL"
      - "Implement versioning in URL"
    open_questions:
      - "How to handle authentication?"
      - "Rate limiting strategy?"
    related_threads: ["thread_003", "thread_007"]
  
  - id: "thread_002"
    title: "Bug Fix: Memory Leak"
    status: "resolved"
    created: "2025-07-21"
    resolved: "2025-07-22"
    solution: "Fixed circular reference in event handlers"
    verification: "Memory usage stable after 24h test"
```

## Conversation Continuity

### 1. Session Resumption
```
User returns after 2 days...

Loaded context from previous session:
- Last topic: API authentication design
- Decision made: Use JWT with refresh tokens
- Open question: How to handle token revocation?
- Action items: 2 pending (implement refresh, add tests)

Continuing where we left off: "About that token revocation question..."
```

### 2. Reference Tracking
```
Earlier in our conversation you mentioned:
- File: src/api/auth.ts (modified 3 times this session)
- Pattern: Repository pattern for database access
- Concern: Performance impact of middleware chain

Relevant to your current question about caching strategies.
```

### 3. Preference Application
```
Applying your preferences:
- Detail level: Balanced (not too verbose)
- Code style: TypeScript with explicit types
- Examples: Practical, real-world focused
- Format: Headers and bullet points preferred
```

## Privacy and Data Management

### Data Retention
- General conversation: 7 days
- Project context: Until task completion
- User preferences: Persistent
- Important decisions (marked): 90 days

### User Controls
```
Commands available:
- "Forget [topic]" - Remove specific topic from memory
- "What do you remember?" - Show current context summary
- "Clear session" - Reset conversation context
- "Mark as important" - Extend retention to 90 days
```