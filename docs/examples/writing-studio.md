---
name: Writing Studio
description: Parallel content creation tools with creative writing, grammar checking, style guidance, and fact verification
version: 1.0.0
author: DollhouseMCP
created: 2025-01-15T00:00:00.000Z
tags:
  - writing
  - content-creation
  - editing
  - fact-checking

# Activation settings
activationStrategy: all
conflictResolution: priority
contextSharing: selective

# Resource limits
resourceLimits:
  maxActiveElements: 10
  maxExecutionTimeMs: 30000

# Elements in this ensemble (parallel activation with priority-based conflicts)
elements:
  - name: creative-writer
    type: persona
    role: primary
    priority: 100
    activation: always
    purpose: Primary creative writing and content generation

  - name: grammar-checker
    type: skill
    role: support
    priority: 90
    activation: always
    purpose: Grammar, spelling, and punctuation validation

  - name: style-guide
    type: template
    role: support
    priority: 85
    activation: always
    purpose: Enforces consistent style and tone

  - name: fact-checker
    type: agent
    role: support
    priority: 80
    activation: always
    purpose: Verifies factual claims and data accuracy
---

# Writing Studio Ensemble

A powerful content creation ensemble that combines creative writing, editing, and fact-checking tools. This ensemble uses **parallel activation** (`all` strategy) to run all tools simultaneously for fast content creation.

## Features

This ensemble coordinates four specialized tools:

1. **Creative Writer** (Priority 100)
   - Generates engaging, well-structured content
   - Adapts tone and style to the target audience
   - Provides the primary creative output

2. **Grammar Checker** (Priority 90)
   - Real-time grammar and spelling validation
   - Punctuation and syntax correction
   - Ensures professional quality writing

3. **Style Guide** (Priority 85)
   - Enforces brand voice and tone consistency
   - Applies formatting standards
   - Maintains writing style guidelines

4. **Fact Checker** (Priority 80)
   - Validates factual claims and statistics
   - Verifies source citations
   - Flags potential misinformation

## Usage

Activate this ensemble for content creation tasks:

```typescript
activate_element name="Writing-Studio" type="ensembles"
```

All elements activate simultaneously and work in parallel. If conflicts arise (e.g., multiple elements suggest different phrasings), the higher-priority element's suggestion wins.

## Configuration Notes

- **Strategy**: All (parallel) - All elements activate simultaneously for speed
- **Conflict Resolution**: Priority - Higher priority elements win conflicts (creative-writer > grammar-checker > style-guide > fact-checker)
- **Context Sharing**: Selective - Elements only share explicitly marked context values
- **Timeout**: 30 seconds - Fast activation for responsive writing experience

## Conflict Resolution Example

If both the Creative Writer and Grammar Checker suggest different text for the same section:
- Creative Writer (priority 100) wins
- Grammar Checker's suggestion is noted but not applied
- You can manually review and apply grammar fixes if needed

## Use Cases

Perfect for:
- Blog posts and articles
- Marketing copy
- Technical documentation
- Social media content
- Email newsletters
- Product descriptions

## Dependencies

This ensemble expects the following elements to exist in your portfolio:
- `creative-writer` (persona)
- `grammar-checker` (skill)
- `style-guide` (template)
- `fact-checker` (agent)

## Tips

1. Set the writing context before activation (audience, tone, purpose)
2. Review priority order - adjust if you want grammar to override creativity
3. Use selective context sharing to control what information flows between elements
4. The parallel approach makes this ensemble very fast - ideal for interactive writing
