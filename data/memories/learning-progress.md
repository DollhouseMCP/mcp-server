---
name: "Learning Progress"
description: "Tracks learning goals, progress, and personalized educational pathways"
type: "memory"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "education"
tags: ["learning", "progress", "education", "skills", "knowledge-tracking"]
storage_backend: "file"
retention_policy:
  default: "perpetual"
  rules:
    - type: "achievements"
      retention: "perpetual"
    - type: "practice_sessions"
      retention: "1 year"
    - type: "mistakes"
      retention: "6 months"
    - type: "resources"
      retention: "perpetual"
privacy_level: "user-private"
searchable: true
schema:
  learning_profile:
    type: "object"
    properties:
      learner_id: "string"
      learning_style: "string"
      goals: "array"
      current_level: "object"
      time_investment: "object"
  progress_tracking:
    type: "object"
    properties:
      skills: "array"
      completed_modules: "array"
      current_module: "object"
      assessments: "array"
  knowledge_map:
    type: "object"
    properties:
      mastered: "array"
      in_progress: "array"
      planned: "array"
      prerequisites: "object"
---

# Learning Progress Memory

This memory element creates a personalized learning experience by tracking progress, adapting to learning patterns, and maintaining a comprehensive knowledge map.

## Learning Profile

### 1. Learner Characteristics
```yaml
learner_profile:
  id: "{{learner_id}}"
  created: "{{start_date}}"
  
  learning_style:
    primary: "visual"  # visual, auditory, kinesthetic, reading
    secondary: "kinesthetic"
    preferences:
      - "worked_examples"
      - "interactive_exercises"
      - "conceptual_diagrams"
      - "step_by_step_guidance"
  
  pace_preference:
    speed: "moderate"  # slow, moderate, fast, adaptive
    depth: "thorough"  # surface, balanced, thorough
    practice_ratio: 0.7  # theory vs practice balance
  
  motivation_factors:
    - "practical_application"
    - "skill_mastery"
    - "career_advancement"
    - "intellectual_curiosity"
```

### 2. Skills Tracking
```yaml
skills_matrix:
  programming:
    python:
      level: "intermediate"
      hours_practiced: 124
      projects_completed: 8
      sub_skills:
        syntax: "mastered"
        data_structures: "proficient"
        algorithms: "developing"
        frameworks:
          django: "proficient"
          fastapi: "learning"
          pandas: "proficient"
      
    javascript:
      level: "beginner"
      hours_practiced: 32
      projects_completed: 2
      sub_skills:
        syntax: "proficient"
        dom_manipulation: "learning"
        async_programming: "not_started"
        frameworks:
          react: "learning"
          node: "not_started"
  
  soft_skills:
    problem_solving:
      level: "advanced"
      demonstrated_in: ["bug_fixes", "algorithm_design", "debugging"]
    
    communication:
      level: "intermediate"
      areas_of_improvement: ["technical_writing", "code_documentation"]
```

### 3. Learning Goals
```yaml
goals:
  short_term:  # Next 30 days
    - goal: "Complete React fundamentals"
      deadline: "2025-08-23"
      progress: 65
      milestones:
        - "Components and Props" ✓
        - "State and Lifecycle" ✓
        - "Hooks" [in_progress]
        - "Context API" [pending]
      time_estimate: "20 hours"
      actual_time: "13 hours"
  
  medium_term:  # Next 90 days
    - goal: "Build full-stack application"
      deadline: "2025-10-23"
      progress: 20
      prerequisites_met: ["backend_api", "database_design"]
      prerequisites_pending: ["frontend_framework", "deployment"]
  
  long_term:  # Next year
    - goal: "Achieve senior developer skills"
      areas:
        - "System design"
        - "Performance optimization"
        - "Security best practices"
        - "Team leadership"
```

## Progress Analytics

### 1. Learning Patterns
```yaml
patterns:
  effective_times:
    morning: 0.2  # 20% effectiveness
    afternoon: 0.5  # 50% effectiveness
    evening: 0.3  # 30% effectiveness
  
  session_duration:
    optimal: "45 minutes"
    attention_span: "25 minutes"
    break_frequency: "every 50 minutes"
  
  retention_methods:
    most_effective:
      - "hands_on_practice"
      - "teaching_others"
      - "real_projects"
    least_effective:
      - "passive_reading"
      - "video_watching_only"
  
  struggle_indicators:
    - "repeated_same_errors"
    - "long_pause_periods"
    - "frequent_context_switching"
```

### 2. Knowledge Retention
```yaml
retention_tracking:
  concepts:
    - name: "Recursion"
      first_learned: "2025-06-15"
      reinforcement_dates: ["2025-06-20", "2025-07-01", "2025-07-15"]
      retention_score: 0.85
      application_count: 12
      
    - name: "Async/Await"
      first_learned: "2025-07-10"
      reinforcement_dates: ["2025-07-12"]
      retention_score: 0.60
      application_count: 3
      needs_review: true
  
  spaced_repetition:
    due_for_review:
      - concept: "SQL Joins"
        last_review: "2025-07-01"
        next_review: "2025-07-24"
        interval: 23  # days
      
      - concept: "Docker Basics"
        last_review: "2025-07-20"
        next_review: "2025-07-25"
        interval: 5
```

### 3. Mistake Patterns
```yaml
common_mistakes:
  - category: "syntax"
    frequency: "decreasing"
    examples:
      - "Forgetting semicolons in JavaScript"
      - "Indentation errors in Python"
    improvement_trend: 75  # % reduction
  
  - category: "logic"
    frequency: "stable"
    examples:
      - "Off-by-one errors in loops"
      - "Incorrect base cases in recursion"
    targeted_exercises: ["boundary_value_practice", "recursion_tracing"]
  
  - category: "conceptual"
    frequency: "improving"
    examples:
      - "Confusing pass-by-value vs reference"
      - "Misunderstanding closure scope"
    remediation: ["visual_diagrams", "interactive_debugger"]
```

## Adaptive Learning

### 1. Difficulty Adjustment
```yaml
difficulty_calibration:
  current_level: 6.5  # Scale 1-10
  
  performance_metrics:
    success_rate: 0.72
    time_to_complete: "normal"
    help_requests: "occasional"
  
  adjustments:
    last_increase: "2025-07-15"
    last_decrease: "2025-06-28"
    trend: "gradual_increase"
  
  challenge_types:
    preferred: ["debugging", "optimization"]
    avoided: ["from_scratch", "mathematics"]
```

### 2. Learning Path Optimization
```yaml
personalized_curriculum:
  next_topics:
    1:
      topic: "Advanced React Patterns"
      rationale: "Builds on current React knowledge"
      prerequisites_met: true
      estimated_duration: "15 hours"
      
    2:
      topic: "State Management (Redux)"
      rationale: "Needed for full-stack goal"
      prerequisites_met: false
      blocking_prerequisites: ["React Hooks mastery"]
      
    3:
      topic: "Testing with Jest"
      rationale: "Addresses weak area in skill matrix"
      prerequisites_met: true
      priority: "high"
  
  recommended_resources:
    - type: "interactive_course"
      title: "React Advanced Patterns"
      match_score: 0.92
      reason: "Matches visual learning style"
      
    - type: "project_based"
      title: "Build a Task Manager"
      match_score: 0.88
      reason: "Hands-on practice preference"
```

## Achievement System

### 1. Milestones
```yaml
achievements:
  unlocked:
    - name: "First Hello World"
      date: "2025-05-01"
      category: "beginner"
      
    - name: "Bug Squasher"
      date: "2025-06-15"
      category: "debugging"
      criteria: "Fixed 10 bugs independently"
      
    - name: "Full Stack Builder"
      date: "2025-07-20"
      category: "projects"
      criteria: "Deployed first full-stack app"
  
  in_progress:
    - name: "Open Source Contributor"
      progress: 2/5
      criteria: "Merge 5 PRs to open source projects"
      
    - name: "Performance Optimizer"
      progress: 60%
      criteria: "Improve app performance by 50%"
```

### 2. Skill Certifications
```yaml
certifications:
  internal:
    - skill: "Python Fundamentals"
      level: "certified"
      assessment_score: 92
      date: "2025-06-30"
      
    - skill: "Web Development Basics"
      level: "proficient"
      assessment_score: 85
      date: "2025-07-15"
  
  external_prep:
    - certification: "AWS Solutions Architect"
      readiness: 45%
      weak_areas: ["networking", "security"]
      study_plan_generated: true
```

## Integration Features

### Learning Companions
Works with:
- **Study Buddy Persona**: Pair learning sessions
- **Code Review Agent**: Practice feedback
- **Project Templates**: Structured practice
- **Research Assistant**: Deep dives

### Progress Reports
```
Weekly Learning Summary - Week of July 17-23, 2025

Time Invested: 12.5 hours
Skills Practiced: React (8h), Python (3h), SQL (1.5h)

Achievements:
✓ Completed React Hooks module
✓ Built todo app with local storage
✓ Debugged 5 complex issues

Areas of Growth:
📈 React component design (+15%)
📈 Debugging skills (+10%)
📊 SQL query optimization (stable)

Recommended Focus:
1. Review async/await concepts (retention declining)
2. Start Redux basics (prerequisite for next goal)
3. Practice algorithm complexity analysis

Keep up the great work! You're 72% toward your monthly goal.
```