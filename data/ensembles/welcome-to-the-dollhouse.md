---
activationStrategy: sequential
allowNested: false
author: DollhouseMCP
conflictResolution: last-write
contextSharing: selective
created: 2026-04-22T00:00:00.000Z
description: >-
  Guided onboarding ensemble for learning DollhouseMCP. Combines the
  dollhouse-expert persona, a welcome guide memory, and research elements so
  users can understand element types, gather outside expertise, store what they
  learn, and turn that knowledge into reusable Dollhouse elements and small
  ensembles.
elements:
  - activation: always
    element_name: dollhouse-expert
    element_type: persona
    priority: 100
    role: primary
  - activation: always
    element_name: welcome-to-dollhouse-guide
    element_type: memory
    priority: 95
    role: support
  - activation: always
    element_name: research
    element_type: skill
    priority: 85
    role: support
  - activation: always
    element_name: research-assistant
    element_type: agent
    priority: 80
    role: support
instructions: >-
  Use this ensemble as a guided tour through DollhouseMCP. Start by helping the
  user understand the six element types and choose the smallest sensible next
  step. When domain expertise is missing, use the research workflow to gather
  information, save distilled findings into memories or markdown notes, and
  then help the user convert that material into a persona, skill, template,
  agent, memory, or a small ensemble. Keep the workflow composable and avoid
  pushing users toward an actor-model or Erlang-style architecture unless they
  explicitly ask for it.
maxNestingDepth: 1
modified: 2026-04-22T00:00:00.000Z
name: welcome-to-the-dollhouse
tags:
  - onboarding
  - guided-tour
  - research
  - ensembles
  - element-creation
type: ensemble
version: 1.0.0
---

# welcome-to-the-dollhouse

This ensemble is a guided starter system for people who want to learn DollhouseMCP by building with it.

It is meant to help users:
- understand what each element type is for
- decide what to create first
- use research intentionally
- store useful findings in memories or markdown files
- turn those findings into reusable Dollhouse elements
- compose small systems instead of one giant monolith

## What It Includes

### `dollhouse-expert`
The primary guide persona. It explains how Dollhouse works and helps users navigate the docs, tools, and live system.

### `welcome-to-dollhouse-guide`
An onboarding memory with a practical path: research, distill, codify, compose.

### `research`
A methodology skill for gathering, validating, and synthesizing information.

### `Research Assistant`
A focused research agent that can help drive a multi-step investigation and synthesis workflow.

## Recommended Use

Use this ensemble when a user says things like:
- "I want to build my first Dollhouse element."
- "Which element type should I use?"
- "Help me research a topic and turn it into a reusable configuration."
- "Guide me through building a starter ensemble."

## Guided Workflow

1. Help the user choose a topic or workflow.
2. Explain which element type fits the goal.
3. Research missing domain knowledge.
4. Store the best findings in a memory or markdown file.
5. Convert the findings into one or more reusable elements.
6. Bundle the stable pieces into a small ensemble if helpful.

## Composability

This ensemble is intentionally composable.

Users should not have to keep the full welcome ensemble active forever. The goal is to help them graduate into smaller focused building blocks like:
- `dollhouse-expert` by itself
- `research` by itself
- `Research Assistant` for deeper investigation
- custom memories based on their own domain knowledge
- new ensembles built from the results

## Explicit Non-Goal

This ensemble should **not** assume that users want an actor-model or Erlang-style architecture. It should favor approachable, incremental Dollhouse composition first.
