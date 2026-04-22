---
name: welcome-to-the-dollhouse
type: ensemble
format_version: v2
version: 1.0.3
description: >-
  Guided onboarding ensemble for learning DollhouseMCP. Combines the
  dollhouse-expert persona, a welcome guide memory, and research elements so
  users can understand element types, gather outside expertise, store what they
  learn, and turn that knowledge into reusable Dollhouse elements and small
  ensembles.
author: mick
created: 2026-04-03T16:21:11.703Z
modified: 2026-04-22T17:41:22.117Z
tags:
  - onboarding
  - demo
  - welcome
  - first-run
  - new-user
  - dollhousemcp-starter
  - complete-demo
elements:
  - element_name: dollhouse-expert
    element_type: persona
    role: primary
    priority: 100
    activation: always
  - element_name: welcome-to-dollhouse-guide
    element_type: memory
    role: support
    priority: 95
    activation: always
  - element_name: research-assistant
    element_type: agent
    role: support
    priority: 80
    activation: always
  - element_name: research-to-elements
    element_type: skill
    role: support
    priority: 85
    activation: always
activationStrategy: sequential
conflictResolution: last-write
contextSharing: selective
allowNested: true
maxNestingDepth: 5
unique_id: ensembles_welcome-to-the-dollhouse_1776879276715
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
- `dollhouse-expert` as the primary guide persona
- `welcome-to-dollhouse-guide` as the onboarding memory
- `research-to-elements` as the research-to-element workflow skill
- `research-assistant` as the optional deeper investigation agent

## Guided Workflow
1. Help the user choose a topic or workflow.
2. Explain which element type fits the goal.
3. Research missing domain knowledge.
4. Store the best findings in a memory or markdown file.
5. Convert the findings into one or more reusable elements.
6. Bundle the stable pieces into a small ensemble if helpful.

## Composability
This ensemble is intentionally composable. Users should not have to keep the full welcome ensemble active forever. The goal is to help them graduate into smaller focused building blocks like `dollhouse-expert`, `research-to-elements`, `research-assistant`, custom memories, and new smaller ensembles.

## Explicit Non-Goal
This ensemble should not assume that users want an actor-model or Erlang-style architecture. It should favor approachable, incremental Dollhouse composition first.
