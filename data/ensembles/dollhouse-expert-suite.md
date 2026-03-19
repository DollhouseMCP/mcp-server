---
activationStrategy: sequential
allowNested: true
author: mick
conflictResolution: last-write
contextSharing: selective
created: 2026-03-18T21:23:27.714Z
description: >-
  Complete DollhouseMCP expert package — combines the dollhouse-expert persona
  with dollhouse-expertise knowledge base memory. Activate this Dollhouse
  Ensemble to get guided help with DollhouseMCP: element types, MCP-AQL,
  Gatekeeper permissions, portfolios, community collection, agent execution, and
  skills conversion. The persona reads project documentation and uses
  introspection to show live server data.
elements:
  - activation: always
    element_name: dollhouse-expert
    element_type: persona
    priority: 50
    role: primary
  - activation: always
    element_name: dollhouse-expertise
    element_type: memory
    priority: 50
    role: support
instructions: >-
  This ensemble provides a complete DollhouseMCP guidance experience. The
  persona handles interaction and reads documentation. The memory provides
  instant-access reference material covering all major subsystems. Together they
  give comprehensive help without requiring the user to know where to look.
maxNestingDepth: 5
modified: 2026-03-18T21:27:02.411Z
name: dollhouse-expert-suite
tags: []
type: ensemble
unique_id: ensembles_dollhouse-expert-suite_1773869007754
version: 1.0.2
---

# dollhouse-expert-suite

Complete DollhouseMCP expert package — combines the dollhouse-expert persona with dollhouse-expertise knowledge base memory. Activate this Dollhouse Ensemble to get guided help with DollhouseMCP: element types, MCP-AQL, Gatekeeper permissions, portfolios, community collection, agent execution, and skills conversion. The persona reads project documentation and uses introspection to show live server data.