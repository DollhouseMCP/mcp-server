---
name: "welcome-to-dollhouse-guide"
description: "Guided onboarding memory for learning DollhouseMCP element types, research workflows, and composable ensemble-building patterns"
type: "memory"
version: "1.0.0"
author: "DollhouseMCP"
created: "2026-04-22"
category: "onboarding"
tags: ["welcome", "onboarding", "elements", "research", "ensembles", "guided-tour"]
storage_backend: "file"
privacy_level: "user-private"
searchable: true
schema:
  onboarding_path:
    type: "object"
    properties:
      stage: "string"
      goal: "string"
      next_action: "string"
  research_workflow:
    type: "object"
    properties:
      topic: "string"
      sources: "array"
      findings_location: "string"
      next_element_type: "string"
  composition_patterns:
    type: "array"
---
# Welcome to the Dollhouse Guide

This memory is a guided tour for people who are new to DollhouseMCP or who want a more intentional path for building reusable AI configurations.

Its job is to help the user:
- understand what each element type is for
- decide which element type to create next
- use research intentionally instead of improvising from memory
- turn research into reusable Dollhouse elements
- build small composable systems instead of one giant all-in-one setup

## Start Simple

The recommended learning path is:

1. Learn the six element types.
2. Create one simple element of a single type.
3. Use research to gather domain expertise.
4. Store that expertise in a memory or markdown file.
5. turn the expertise into a reusable persona, skill, template, or agent.
6. Bundle the pieces into an ensemble when the workflow feels stable.

This guide is intentionally friendly to users who do **not** want a distributed actor model or Erlang-style orchestration. You can build very capable systems with plain elements plus one simple ensemble.

## What Each Element Type Does

### Personas
Use a persona when you want to change **how** the AI behaves.

Good for:
- tone
- methodology
- domain posture
- decision style

Examples:
- a Dollhouse guide
- a security reviewer
- a patient explainer

### Skills
Use a skill when you want to add a repeatable **capability**.

Good for:
- research methodology
- code review checklists
- writing systems
- analysis procedures

Examples:
- a research workflow
- a structured bug triage process
- a content review checklist

### Templates
Use a template when you want a repeatable **output shape**.

Good for:
- reports
- briefs
- playbooks
- onboarding docs

Examples:
- an element proposal template
- a research summary template
- an implementation brief template

### Agents
Use an agent when you want the system to pursue a **goal** across steps.

Good for:
- running a research plan
- producing a structured deliverable
- coordinating a bounded workflow

You do **not** need an actor model to get value from agents. A single focused agent is enough for many workflows.

### Memories
Use a memory when you want to preserve **knowledge or context**.

Good for:
- distilled research findings
- domain notes
- team conventions
- project context

Memories are a great bridge between internet research and reusable elements.

### Ensembles
Use an ensemble when you want multiple elements to work together as a guided package.

Good for:
- onboarding kits
- expert bundles
- repeatable team-style workflows
- a guided “starter system” for a topic

## Recommended Beginner Workflow

### Phase 1: Pick a Topic

Choose a domain you want the AI to become better at.

Examples:
- API design
- indie game narrative design
- podcast research
- compliance documentation
- product discovery interviews

### Phase 2: Research the Topic

Use the research skill and research assistant to gather outside knowledge.

The goal is not to keep everything.
The goal is to bring back only the parts that should become reusable expertise.

### Phase 3: Save What Matters

Save useful findings into:
- a Dollhouse memory for persistent structured knowledge
- a markdown file when the content is still being shaped

Examples of things worth saving:
- repeated best practices
- vocabulary and terminology
- decision frameworks
- evaluation criteria
- domain-specific pitfalls

### Phase 4: Convert Research into Elements

Ask:
- should this become a **persona** because it changes behavior?
- should this become a **skill** because it is a repeatable method?
- should this become a **template** because it is a repeatable deliverable?
- should this become an **agent** because it is a multi-step goal?
- should it stay a **memory** because it is supporting knowledge?

### Phase 5: Bundle What Works

When a set of elements starts working together reliably, make an ensemble.

That ensemble can stay small.
It does not need to do everything.

## Composable Patterns

Prefer small composable combinations like these:

### Guide + Knowledge
- persona: expert guide
- memory: reference knowledge

### Guide + Research
- persona: guide
- skill: research
- agent: research assistant

### Research to Productization
- skill: research
- memory: findings
- template: output structure

### Guided Starter Pack
- persona: guide
- memory: onboarding playbook
- skill: research
- agent: research assistant

## How to Help the User

When this memory is active, guide the user by:
- starting with the smallest useful next step
- explaining trade-offs between element types
- suggesting when to stop researching and start codifying
- encouraging small reusable pieces over giant one-off prompts
- showing how to move from external knowledge to reusable Dollhouse elements

## Suggested Prompts

Useful prompts with this guide:

- "Help me choose which element type to create first."
- "Research this domain and turn the findings into a memory plus a persona."
- "Create a skill from these research notes."
- "Help me bundle these elements into a simple ensemble."
- "Walk me through building a reusable Dollhouse workflow without using the actor model."
