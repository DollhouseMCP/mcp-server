---
name: "Data Analysis"
description: "Statistical analysis, visualization, and insights extraction from datasets"
type: "skill"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "analytics"
tags: ["data", "statistics", "visualization", "insights", "analytics"]
proficiency_levels:
  beginner: "Basic statistics and simple charts"
  intermediate: "Correlation analysis and trend detection"
  advanced: "Predictive modeling and complex visualizations"
parameters:
  analysis_type:
    type: "array"
    description: "Types of analysis to perform"
    default: ["descriptive", "diagnostic"]
    enum: ["descriptive", "diagnostic", "predictive", "prescriptive"]
  visualization_format:
    type: "string"
    description: "Preferred visualization format"
    default: "auto"
    enum: ["auto", "charts", "tables", "narrative", "dashboard"]
  confidence_level:
    type: "number"
    description: "Statistical confidence level"
    default: 0.95
    min: 0.90
    max: 0.99
  handle_missing_data:
    type: "string"
    description: "How to handle missing values"
    default: "interpolate"
    enum: ["ignore", "interpolate", "drop", "flag"]
---

# Data Analysis Skill

This skill provides comprehensive data analysis capabilities for extracting insights, identifying patterns, and making data-driven recommendations.

## Core Capabilities

### 1. Descriptive Analysis
- **Central Tendency**: Mean, median, mode
- **Dispersion**: Standard deviation, variance, range
- **Distribution**: Skewness, kurtosis, percentiles
- **Frequency**: Histograms, frequency tables

### 2. Diagnostic Analysis
- **Correlation Analysis**: Pearson, Spearman, Kendall
- **Regression**: Linear, logistic, polynomial
- **Time Series**: Trends, seasonality, decomposition
- **Anomaly Detection**: Outliers, unusual patterns

### 3. Predictive Analysis
- **Forecasting**: Time series prediction
- **Classification**: Category prediction
- **Clustering**: Group identification
- **Probability**: Risk assessment

### 4. Visualization
- **Charts**: Line, bar, scatter, pie, heatmap
- **Distributions**: Histograms, box plots, violin plots
- **Relationships**: Scatter plots, correlation matrices
- **Comparisons**: Grouped bars, stacked charts

## Analysis Process

### Step 1: Data Profiling
```
Dataset Overview:
- Rows: 10,432
- Columns: 15
- Missing values: 2.3%
- Data types: 5 numeric, 8 categorical, 2 datetime
```

### Step 2: Quality Assessment
- Completeness check
- Consistency validation
- Outlier identification
- Data type verification

### Step 3: Analysis Execution
- Apply statistical methods
- Generate visualizations
- Extract key findings
- Identify patterns

### Step 4: Insight Generation
- Summarize findings
- Highlight anomalies
- Provide recommendations
- Suggest next steps

## Output Formats

### 1. Executive Summary
```
Key Findings:
• Sales increased 23% year-over-year
• Customer retention improved by 15%
• Regional performance varies significantly
• Seasonal patterns strongly influence demand
```

### 2. Detailed Report
```
Statistical Analysis Results:

Correlation Matrix:
         Sales  Marketing  Satisfaction
Sales     1.00      0.82         0.65
Marketing 0.82      1.00         0.54
Satisfaction 0.65   0.54         1.00

Regression Analysis:
Sales = 1,234 + 2.5×Marketing + 156×Satisfaction
R² = 0.78, p < 0.001
```

### 3. Visual Dashboard
```
[Chart: Monthly Sales Trend]
📊 ────────────────────
   │     ╱╲    ╱╲
   │   ╱╲  ╲  ╱  ╲
   │ ╱╲    ╲╱    ╲
   └─────────────────
   J F M A M J J A S
```

## Special Features

### 1. Natural Language Insights
Converts statistical findings into plain English:
- "Sales peak in December (43% above average)"
- "Customer age strongly correlates with purchase frequency (r=0.72)"
- "Northern region underperforms by 18% compared to others"

### 2. Automated Recommendations
Based on analysis results:
- "Consider increasing marketing spend in Q3"
- "Focus on customer retention in 25-34 age group"
- "Investigate northern region performance issues"

### 3. Interactive Analysis
- Drill-down capabilities
- What-if scenarios
- Sensitivity analysis
- Custom segmentation

## Integration Notes

Works well with:
- Business Consultant persona for strategic insights
- Technical Analyst for deep-dive investigations
- Report templates for standardized output
- Dashboard agents for real-time monitoring