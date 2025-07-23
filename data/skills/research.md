---
name: "Research"
description: "Comprehensive research methodology for gathering and synthesizing information"
type: "skill"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "knowledge"
tags: ["research", "analysis", "synthesis", "investigation", "fact-checking"]
proficiency_levels:
  beginner: "Basic fact-finding and summarization"
  intermediate: "Multi-source synthesis and validation"
  advanced: "Academic-level research with citations"
parameters:
  research_depth:
    type: "string"
    description: "How deep to research"
    default: "standard"
    enum: ["quick", "standard", "comprehensive", "exhaustive"]
  source_types:
    type: "array"
    description: "Types of sources to consider"
    default: ["academic", "industry", "news", "expert"]
  citation_style:
    type: "string"
    description: "Citation format to use"
    default: "none"
    enum: ["none", "APA", "MLA", "Chicago", "Harvard"]
  fact_checking:
    type: "boolean"
    description: "Verify claims and cross-reference"
    default: true
---

# Research Skill

This skill provides systematic research capabilities for investigating topics, validating information, and synthesizing knowledge from multiple sources.

## Core Capabilities

### 1. Information Gathering
- **Source Identification**: Finding relevant, credible sources
- **Data Collection**: Systematic information extraction
- **Cross-referencing**: Validating across multiple sources
- **Bias Detection**: Identifying potential biases

### 2. Analysis Methods
- **Comparative Analysis**: Contrasting different viewpoints
- **Trend Identification**: Spotting patterns over time
- **Gap Analysis**: Finding missing information
- **Critical Evaluation**: Assessing source credibility

### 3. Synthesis Techniques
- **Thematic Organization**: Grouping by themes
- **Chronological Ordering**: Timeline-based structure
- **Hierarchical Structure**: Main points and sub-points
- **Narrative Integration**: Coherent storytelling

### 4. Validation Process
- **Fact-checking**: Verifying claims
- **Source Verification**: Confirming authenticity
- **Date Validation**: Ensuring currency
- **Expert Validation**: Cross-checking with authorities

## Research Process

### Phase 1: Planning
```
Research Plan:
Topic: [Subject]
Scope: [Boundaries]
Questions: [Key questions to answer]
Timeline: [Research schedule]
```

### Phase 2: Discovery
- Initial exploration
- Source identification
- Preliminary reading
- Keyword refinement

### Phase 3: Deep Dive
- Detailed investigation
- Note-taking and organization
- Pattern identification
- Gap filling

### Phase 4: Synthesis
- Information integration
- Conclusion drawing
- Recommendation formulation
- Report creation

## Output Formats

### 1. Executive Brief
```
Topic: AI Ethics in Healthcare

Key Findings:
• 78% of healthcare AI applications lack ethical frameworks
• Patient privacy concerns top priority (mentioned in 92% of studies)
• Regulatory gaps exist in 15 identified areas

Recommendations:
1. Implement ethical review boards
2. Develop privacy-first architectures
3. Create regulatory roadmap
```

### 2. Detailed Research Report
```
I. Introduction
   A. Background
   B. Research objectives
   C. Methodology

II. Literature Review
   A. Current state of knowledge
   B. Key debates
   C. Research gaps

III. Findings
   A. Primary discoveries
   B. Supporting evidence
   C. Contradictory data

IV. Analysis
   A. Interpretation
   B. Implications
   C. Limitations

V. Conclusions
   A. Summary
   B. Recommendations
   C. Future research
```

### 3. Annotated Bibliography
```
Smith, J. (2024). "AI Ethics Framework." Journal of Tech Ethics, 15(3), 45-62.
   - Proposes comprehensive framework
   - Strong empirical foundation
   - Limited to US context

Chen, L. (2024). "Global AI Governance." AI Policy Review, 8(2), 12-28.
   - International perspective
   - Policy-focused
   - Recent data (2023-2024)
```

## Special Features

### 1. Research Strategies
- **Systematic Review**: Comprehensive literature analysis
- **Meta-Analysis**: Statistical combination of studies
- **Case Study**: Deep dive into specific instances
- **Survey Research**: Primary data collection

### 2. Quality Indicators
```
Source Quality: ⭐⭐⭐⭐⭐
- Peer-reviewed: ✓
- Recent (< 2 years): ✓
- High citation count: ✓
- Reputable publisher: ✓
```

### 3. Research Tools
- Boolean search optimization
- Citation tracking
- Duplicate detection
- Bias assessment

## Integration Notes

Works well with:
- Technical Analyst for specialized research
- Academic Writer for scholarly output
- Data Analysis skill for quantitative research
- Report templates for standardized formatting