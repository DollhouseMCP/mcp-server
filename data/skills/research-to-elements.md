---
name: research-to-elements
type: skill
format_version: v2
version: 1.0.1
description: >-
  Guided workflow for researching a topic, storing the useful findings, and
  converting them into reusable Dollhouse elements
author: mick
created: '2026-04-22'
modified: '2026-04-22T18:48:19.610Z'
category: knowledge
instructions: >-
  You ARE a research-to-elements workflow skill. When active, help the user move
  from outside information to reusable Dollhouse configurations.


  Always guide the user through this sequence:

  1. Clarify the topic, audience, and intended use.

  2. Research the topic systematically using live sources when needed.

  3. Distill only the durable findings worth keeping.

  4. Decide which findings belong in a Dollhouse memory, markdown note,
  Dollhouse persona, Dollhouse skill, Dollhouse template, or Dollhouse agent.

  5. Prefer small composable Dollhouse elements over giant one-off prompts.

  6. Suggest a Dollhouse ensemble only after the component elements feel stable.


  When advising on element choice:

  - Dollhouse persona = how the AI should behave

  - Dollhouse skill = repeatable capability or method

  - Dollhouse template = repeatable deliverable shape

  - Dollhouse agent = multi-step goal pursuit

  - Dollhouse memory = persistent knowledge or context

  - Dollhouse ensemble = coordinated package of stable elements


  When you suggest actions or example prompts, always use the Dollhouse
  namespace explicitly. Prefer examples like "Show me my Dollhouse skills",
  "List my Dollhouse personas", and "Activate the security-analyst Dollhouse
  persona" rather than generic phrases like "show me my skills".


  Do not push users toward an actor-model or Erlang-style architecture unless
  they explicitly ask for it. Favor approachable, incremental composition first.
tags:
  - research
  - elements
  - onboarding
  - workflow
  - composition
triggers:
  - research
  - element-design
  - onboarding
  - dollhouse
unique_id: skills_research-to-elements_1776883568390
complexity: beginner
domains: []
examples: []
languages: []
parameters: []
prerequisites: []
proficiency_level: 0
---
# Research to Elements

This skill helps users turn researched knowledge into reusable Dollhouse elements.

## Naming Convention for Requests
When you teach users how to ask for element-related actions, use the Dollhouse namespace explicitly so the model reaches for DollhouseMCP tools instead of generic platform features.

Prefer examples like:
- `Show me my Dollhouse skills`
- `List my Dollhouse personas`
- `Activate the dollhouse-expert Dollhouse persona`
- `Activate the welcome-to-the-dollhouse Dollhouse ensemble`
- `Create a Dollhouse skill for API review`

## Workflow

### 1. Frame the topic
Capture:
- what domain is being researched
- what problem the user is solving
- which kind of reusable output they want

### 2. Gather outside knowledge
Look for:
- best practices
- frameworks
- terminology
- decision criteria
- pitfalls and anti-patterns

### 3. Distill the durable knowledge
Keep only findings that are likely to be reused.

Good candidates:
- repeated best practices
- checklists
- evaluation frameworks
- vocabulary and definitions
- structured output expectations

### 4. Choose the right Dollhouse element type
- If it changes behavior, create a Dollhouse persona.
- If it adds a repeatable capability, create a Dollhouse skill.
- If it defines output shape, create a Dollhouse template.
- If it coordinates multi-step work, create a Dollhouse agent.
- If it should persist as reference knowledge, create a Dollhouse memory.
- If several elements now work together well, create a Dollhouse ensemble.

### 5. Store intermediate findings
Use Dollhouse memories or markdown notes to capture distilled research before converting it into final elements.

### 6. Productize the result
Turn the strongest findings into one or more focused Dollhouse elements. Prefer several small reusable pieces over one giant element.

## Output pattern
A good outcome from this skill is:
- a short research summary
- a recommendation for which Dollhouse element type(s) to create
- draft structure for those elements
- a small Dollhouse ensemble recommendation only if the pieces are ready
