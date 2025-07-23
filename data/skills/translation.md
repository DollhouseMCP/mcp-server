---
name: "Translation"
description: "Multi-language translation with cultural context and tone preservation"
type: "skill"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "communication"
tags: ["translation", "languages", "localization", "culture"]
proficiency_levels:
  beginner: "Basic word-for-word translation"
  intermediate: "Context-aware translation with idioms"
  advanced: "Cultural adaptation and transcreation"
parameters:
  source_language:
    type: "string"
    description: "Language to translate from"
    required: false
    default: "auto-detect"
  target_language:
    type: "string"
    description: "Language to translate to"
    required: true
  formality:
    type: "string"
    description: "Formality level"
    default: "neutral"
    enum: ["casual", "neutral", "formal", "professional"]
  preserve_tone:
    type: "boolean"
    description: "Maintain original tone and style"
    default: true
  cultural_adaptation:
    type: "boolean"
    description: "Adapt content for target culture"
    default: false
---

# Translation Skill

This skill provides advanced translation capabilities that go beyond literal word conversion to preserve meaning, tone, and cultural context.

## Core Capabilities

### 1. Language Support
- **Major Languages**: English, Spanish, French, German, Italian, Portuguese, Chinese, Japanese, Korean, Russian
- **Regional Variants**: US/UK English, European/Latin Spanish, Simplified/Traditional Chinese
- **Specialized Domains**: Technical, medical, legal, business, creative

### 2. Translation Types

#### Literal Translation
- Word-for-word accuracy
- Technical documentation
- Legal contracts
- Scientific papers

#### Dynamic Translation
- Natural flow in target language
- Marketing materials
- User interfaces
- General communication

#### Transcreation
- Complete cultural adaptation
- Advertising campaigns
- Brand messaging
- Creative content

### 3. Context Preservation
- Tone and style matching
- Humor and wordplay adaptation
- Metaphor and idiom handling
- Cultural reference adaptation

## Translation Process

### Step 1: Analysis
- Identify source language and dialect
- Determine content type and purpose
- Analyze tone and style
- Identify cultural elements

### Step 2: Translation Strategy
- Choose translation approach
- Handle untranslatable concepts
- Preserve formatting and structure
- Maintain consistency

### Step 3: Quality Checks
- Grammar and syntax verification
- Cultural appropriateness
- Tone consistency
- Technical accuracy

## Special Features

### 1. Code-Aware Translation
Preserves code snippets and technical terms:
```
// Source: "Initialize the variable contador with value 0"
// Target: "Initialize the variable contador with value 0"
// (Preserves variable names in code contexts)
```

### 2. Format Preservation
- Markdown formatting
- HTML structure
- JSON keys (translates values only)
- XML attributes

### 3. Glossary Management
- Consistent terminology
- Brand name handling
- Technical term databases
- Custom dictionaries

## Output Options

### Standard Translation
```
Source: "Hello, how are you today?"
Target (Spanish, formal): "Buenos días, ¿cómo está usted hoy?"
Target (Spanish, casual): "Hola, ¿cómo estás hoy?"
```

### Annotated Translation
```
Source: "Break a leg!"
Target: "¡Mucha suerte!" [Literal: "Much luck!"]
Note: English idiom adapted to Spanish equivalent
```

### Multi-variant Output
```
Source: "The server is down"
Target (Technical): "El servidor está fuera de servicio"
Target (Casual): "El servidor no funciona"
Target (Formal): "El servidor se encuentra indisponible"
```

## Integration Notes

Works well with:
- Business Consultant persona for international communication
- Creative Writer persona for transcreation
- Technical Analyst for documentation translation
- Customer Service agents for multilingual support