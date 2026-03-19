---
name: Data Pipeline
description: Priority-based ETL workflow for data validation, transformation, analysis, and reporting
version: 1.0.0
author: DollhouseMCP
created: 2025-01-15T00:00:00.000Z
tags:
  - data
  - etl
  - analytics
  - pipeline

# Activation settings
activationStrategy: priority
conflictResolution: priority
contextSharing: full

# Resource limits
resourceLimits:
  maxActiveElements: 10
  maxExecutionTimeMs: 120000

# Elements in this ensemble (priority-based sequential execution)
elements:
  - name: data-validator
    type: skill
    role: primary
    priority: 100
    activation: always
    purpose: Validates data quality and schema compliance (runs first)

  - name: data-transformer
    type: skill
    role: primary
    priority: 75
    activation: always
    purpose: Transforms and normalizes data (runs second)

  - name: data-analyzer
    type: agent
    role: primary
    priority: 50
    activation: always
    purpose: Performs statistical analysis and pattern detection (runs third)

  - name: report-generator
    type: template
    role: support
    priority: 25
    activation: always
    purpose: Generates formatted reports and visualizations (runs last)
---

# Data Pipeline Ensemble

A robust ETL (Extract, Transform, Load) pipeline that processes data through validation, transformation, analysis, and reporting stages. This ensemble uses **priority-based activation** to ensure proper execution order.

## Pipeline Stages

The data flows through four stages in priority order:

### 1. Data Validator (Priority 100 - Highest)
**Runs first** to ensure data quality:
- Schema validation
- Data type checking
- Range and constraint validation
- Missing value detection
- Duplicate removal

If validation fails, the pipeline can halt before wasting resources on bad data.

### 2. Data Transformer (Priority 75)
**Runs second** after validation passes:
- Data normalization
- Format standardization
- Field mapping
- Data enrichment
- Aggregation and grouping

### 3. Data Analyzer (Priority 50)
**Runs third** on clean, transformed data:
- Statistical analysis (mean, median, std dev)
- Trend detection
- Anomaly identification
- Correlation analysis
- Pattern recognition

### 4. Report Generator (Priority 25 - Lowest)
**Runs last** to present findings:
- Formatted HTML/PDF reports
- Data visualizations
- Summary statistics
- Insights and recommendations
- Export to various formats

## Usage

Activate this ensemble for data processing tasks:

```typescript
activate_element name="Data-Pipeline" type="ensembles"
```

Elements activate in priority order (highest to lowest), ensuring each stage completes before the next begins.

## Configuration Notes

- **Strategy**: Priority - Elements activate in descending priority order
- **Conflict Resolution**: Priority - Higher priority elements control shared context
- **Context Sharing**: Full - All stages share complete pipeline context
- **Timeout**: 120 seconds (2 minutes) - Accommodates large datasets

## Priority Scores Explained

| Priority | Stage | Why This Order |
|----------|-------|----------------|
| 100 | Validator | Must run first - no point processing invalid data |
| 75 | Transformer | Must run after validation, before analysis |
| 50 | Analyzer | Needs clean data from transformer |
| 25 | Reporter | Final stage - presents all results |

## Context Flow

Each stage adds to the shared context:

1. **Validator** sets: `data.valid`, `data.errors`, `data.warnings`
2. **Transformer** sets: `data.transformed`, `data.mappings`
3. **Analyzer** sets: `data.statistics`, `data.insights`, `data.anomalies`
4. **Reporter** reads all context and sets: `report.html`, `report.pdf`, `report.summary`

## Use Cases

Perfect for:
- CSV/JSON data processing
- Database ETL workflows
- Data quality monitoring
- Business intelligence pipelines
- Research data analysis
- Log file processing

## Error Handling

If the validator detects critical errors:
- Pipeline can halt early (saving time)
- Context will contain `data.valid = false`
- Detailed error messages available in `data.errors`

If later stages fail:
- Previous stages' results are preserved
- Partial results available in context
- Can retry failed stage without reprocessing

## Dependencies

This ensemble expects the following elements to exist in your portfolio:
- `data-validator` (skill)
- `data-transformer` (skill)
- `data-analyzer` (agent)
- `report-generator` (template)

## Performance Tips

1. Use priority strategy for deterministic execution order
2. The 2-minute timeout accommodates large datasets
3. Full context sharing allows each stage to build on previous results
4. Higher priorities for critical stages (validation/transformation)
5. Lower priorities for non-critical stages (reporting/visualization)
