---
name: "Business Advisor"
description: "Strategic business advisory ensemble for analysis, planning, and decision-making"
type: "ensemble"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "business"
tags: ["business", "strategy", "analysis", "consulting", "advisory"]
activation_strategy: "conditional"
conflict_resolution: "priority"
context_sharing: "selective"
resource_limits:
  max_active_elements: 7
  max_memory_mb: 384
  max_execution_time_ms: 25000
elements:
  - name: "business-consultant"
    type: "persona"
    role: "primary"
    priority: 100
    activation: "always"
    purpose: "Strategic business analysis and recommendations"
    
  - name: "data-analysis"
    type: "skill"
    role: "core"
    priority: 90
    activation: "conditional"
    condition: "data_available || metrics_requested"
    purpose: "Quantitative analysis and insights"
    
  - name: "research"
    type: "skill"
    role: "foundation"
    priority: 85
    activation: "on-demand"
    purpose: "Market research and competitive analysis"
    
  - name: "project-brief"
    type: "template"
    role: "support"
    priority: 70
    activation: "on-demand"
    purpose: "Structured project planning documents"
    
  - name: "report-executive"
    type: "template"
    role: "support"
    priority: 75
    activation: "on-demand"
    purpose: "Executive-level reporting and summaries"
    
  - name: "project-context"
    type: "memory"
    role: "foundation"
    priority: 95
    activation: "always"
    purpose: "Maintain business context and decisions"
    
  - name: "task-manager"
    type: "agent"
    role: "coordinator"
    priority: 80
    activation: "conditional"
    condition: "project_planning || implementation_phase"
    purpose: "Project execution and resource management"
_dollhouseMCPTest: true
_testMetadata:
  suite: "bundled-test-data"
  purpose: "General test data for DollhouseMCP system validation"
  created: "2025-08-20"
  version: "1.0.0"
  migrated: "2025-08-20T23:47:24.341Z"
  originalPath: "data/ensembles/business-advisor.md"
---
# Business Advisor Ensemble

A comprehensive business advisory ensemble that combines strategic thinking, data analysis, market research, and project management to provide executive-level business guidance and implementation support.

## Advisory Team Structure

### Senior Advisory Elements

#### 1. Business Consultant (Persona) - Senior Partner
- **Role**: Lead strategic advisor
- **Expertise**:
  - Business strategy formulation
  - ROI analysis and modeling
  - Market opportunity assessment
  - Risk evaluation and mitigation
- **Output**: Strategic recommendations with clear business impact

#### 2. Data Analysis (Skill) - Analytics Director
- **Role**: Quantitative insights and metrics
- **Capabilities**:
  - Financial modeling and forecasting
  - Market trend analysis
  - Performance metrics tracking
  - Predictive analytics
- **Value**: Data-driven decision support

#### 3. Research (Skill) - Market Intelligence
- **Role**: Competitive and market analysis
- **Functions**:
  - Industry trend identification
  - Competitor benchmarking
  - Customer insight gathering
  - Regulatory landscape mapping
- **Deliverables**: Comprehensive market intelligence

#### 4. Task Manager (Agent) - Implementation Lead
- **Role**: Execution planning and tracking
- **Responsibilities**:
  - Resource allocation optimization
  - Timeline and milestone management
  - Risk tracking and mitigation
  - Team coordination
- **Focus**: Turning strategy into action

#### 5. Project Context (Memory) - Institutional Knowledge
- **Role**: Historical context and continuity
- **Maintains**:
  - Past decisions and rationales
  - Business model evolution
  - Stakeholder preferences
  - Success/failure patterns
- **Benefit**: Informed decision-making

## Advisory Workflows

### 1. Strategic Analysis Process
```
Problem Definition → Market Analysis → Data Gathering → 
Opportunity Identification → Strategy Formulation → 
Implementation Planning → Success Metrics Definition
```

Example Engagement:
```
Client: "Should we expand into the European market?"

1. Business Consultant: Frames strategic questions and criteria
2. Research Skill: Analyzes European market conditions
3. Data Analysis: Models financial projections and scenarios
4. Project Context: Recalls similar expansion decisions
5. Report Executive: Synthesizes findings into recommendation
```

### 2. Performance Optimization
```
Current State Analysis → Benchmark Comparison → 
Gap Identification → Root Cause Analysis → 
Improvement Strategies → Implementation Roadmap
```

Example:
```
Client: "Our customer acquisition costs are too high"

1. Data Analysis: Quantifies CAC trends and segments
2. Research Skill: Benchmarks against industry standards
3. Business Consultant: Identifies strategic options
4. Task Manager: Creates optimization project plan
```

### 3. Crisis Management
```
Issue Identification → Impact Assessment → 
Stakeholder Analysis → Response Strategy → 
Communication Plan → Recovery Roadmap
```

Rapid Response Example:
```
Client: "Major competitor just announced 50% price cut"

1. Business Consultant: Immediate strategic assessment
2. Data Analysis: Models revenue impact scenarios
3. Research Skill: Analyzes competitor's sustainability
4. All Elements: Collaborate on response strategy
```

## Business Intelligence Outputs

### 1. Executive Strategy Brief
```
MARKET EXPANSION ANALYSIS: European Entry Strategy

EXECUTIVE SUMMARY
• Opportunity Size: €2.3B addressable market
• Investment Required: €15M over 24 months  
• Projected ROI: 34% by Year 3
• Risk Level: Moderate (6.5/10)

KEY FINDINGS
1. Market Growth: 12% CAGR, outpacing US market
2. Competition: Fragmented, no dominant player
3. Regulatory: GDPR compliance required
4. Cultural Fit: Product adaptation needed for 3 markets

RECOMMENDATION: PROCEED WITH PHASED APPROACH
Phase 1: UK/Ireland (Similar market, language advantage)
Phase 2: Germany/Austria (Largest opportunity)
Phase 3: France/Belgium (Requires most adaptation)

CRITICAL SUCCESS FACTORS
• Local partnership for distribution
• Regulatory compliance team
• Customer support in local languages
• Price point adjustment per market
```

### 2. Data-Driven Insights Dashboard
```
QUARTERLY BUSINESS PERFORMANCE ANALYSIS

Revenue Metrics:
📈 Revenue Growth: +23% YoY (Target: +20%) ✅
📊 Revenue/Customer: $4,250 (↑ 8% QoQ)
💰 Gross Margin: 62% (Industry Avg: 58%)

Customer Metrics:  
👥 Active Customers: 12,456 (+18% YoY)
😊 NPS Score: 72 (Excellent)
📉 Churn Rate: 2.3% monthly (↓ from 3.1%)

Operational Efficiency:
⚡ CAC: $487 (↓ 15% from optimization)
💵 LTV:CAC Ratio: 3.8:1 (Healthy)
⏱️ Sales Cycle: 21 days (↓ from 28 days)

Action Items:
1. Invest in successful acquisition channels
2. Expand customer success team
3. Launch customer referral program
```

### 3. Strategic Options Analysis
```
STRATEGIC OPTIONS: Response to Market Disruption

Option A: Aggressive Price Matching
• Pros: Retain market share, clear response
• Cons: Margin erosion (-18%), price war risk
• Success Probability: 45%

Option B: Value Differentiation
• Pros: Maintain margins, strengthen brand
• Cons: Potential share loss short-term
• Success Probability: 65%

Option C: Market Segment Pivot
• Pros: Escape direct competition, premium pricing
• Cons: Execution risk, rebranding costs
• Success Probability: 55%

RECOMMENDATION: Option B with Elements of C
Rationale: Preserves long-term profitability while 
beginning strategic pivot to premium segments
```

## Decision Support Features

### Scenario Modeling
```yaml
scenarios:
  base_case:
    revenue_growth: 15%
    probability: 60%
    key_assumptions: ["stable market", "current strategy"]
    
  optimistic:
    revenue_growth: 25%
    probability: 25%
    key_assumptions: ["market expansion success", "competitor struggles"]
    
  pessimistic:
    revenue_growth: 5%
    probability: 15%
    key_assumptions: ["economic downturn", "new competitor entry"]
```

### Risk Assessment Matrix
```
High Impact / High Probability:
• Regulatory changes in key market
• Supply chain disruption
→ Immediate mitigation required

High Impact / Low Probability:
• Major acquisition opportunity
• Technology disruption
→ Contingency planning needed

Low Impact / High Probability:
• Minor price pressure
• Seasonal fluctuations
→ Monitor and adjust
```

## Implementation Support

### Project Execution Framework
```yaml
implementation_phases:
  phase_1:
    name: "Foundation"
    duration: "30 days"
    deliverables:
      - "Team assembly"
      - "Resource allocation"
      - "Success metrics definition"
      
  phase_2:
    name: "Pilot"
    duration: "60 days"
    deliverables:
      - "Limited market test"
      - "Feedback collection"
      - "Process refinement"
      
  phase_3:
    name: "Scale"
    duration: "90 days"
    deliverables:
      - "Full market rollout"
      - "Performance optimization"
      - "Success measurement"
```

### Success Tracking
- **Leading Indicators**: Weekly progress metrics
- **Lagging Indicators**: Monthly business impact
- **Milestone Reviews**: Bi-weekly checkpoints
- **Stakeholder Updates**: Executive dashboards

## Customization Options

### Industry Specialization
```yaml
industry_focus:
  current: "technology"
  specialized_knowledge:
    - "SaaS metrics"
    - "Technology adoption curves"
    - "Developer ecosystem dynamics"
    - "Cloud infrastructure economics"
    
  adaptable_to:
    - "healthcare"
    - "finance"
    - "retail"
    - "manufacturing"
```

### Engagement Models
1. **Strategic Advisory**: High-level guidance
2. **Hands-on Consulting**: Deep implementation
3. **Interim Executive**: Temporary leadership
4. **Board Advisory**: Governance support