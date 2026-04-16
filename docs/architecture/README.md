# DollhouseMCP Architecture Documentation

This directory contains deep-dive architecture documents explaining how DollhouseMCP works internally.

## Start Here
For a high-level overview, see the [Architecture Overview](overview.md).

## Deep Dive Documents

### Core Systems
- [Element Architecture](element-architecture.md) - How elements (personas, skills, etc.) are structured
- [Capability Index System](capability-index-system.md) - Enhanced Index data model & runtime integration
- [Unified Capability Index](unified-capability-index.md) - Trigger and metadata design guidelines
- [Enhanced Index Architecture](enhanced-index-architecture.md) - Performance analysis and component diagram
- [Persona State Lifecycle](persona-state-lifecycle.md) - Initialization, indicator, and notifier workflow
- [Unified Search Pipeline](unified-search-pipeline.md) - Aggregated search across local, GitHub, and collection sources
- [Collection Index Cache](collection-index-cache.md) - Community collection snapshotting and fallback strategy
- [Portfolio Sync Architecture](portfolio-sync-architecture.md) - Local ↔ GitHub synchronization flows

### Specialized Topics
- [Version Storage](version-storage-approach.md) - How we handle element versions
- [ADR-002: Version-Aware Web Console Leadership](ADR-002-CONSOLE-VERSION-AWARE-LEADERSHIP.md) - Why the newest compatible console leader wins and how stale tabs recover

## For Contributors
If you're implementing new features, start with the relevant deep dive, then refer to the [Development Guide](../developer-guide/workflow.md).
