# Telemetry Incentive Strategy

**Date**: October 16, 2025
**Status**: Planning Phase
**Target Launch**: TBD

---

## Executive Summary

This document outlines the future incentive program for opt-in telemetry in DollhouseMCP. The infrastructure is **already built and ready** - we're just waiting for the right time to launch with proper incentives that provide genuine value to users.

---

## Current Status: Opt-In Only

**Decision**: After thorough legal and technical research, we've implemented fully opt-in telemetry to ensure GDPR compliance and respect user privacy.

**Infrastructure**: The PostHog telemetry code is production-ready and deployed with v1.9.18+. It simply requires users to set `POSTHOG_API_KEY` in their MCP configuration to activate.

---

## Why Opt-In?

### Legal Compliance
- **GDPR requirements**: European privacy lawyers advise opt-out telemetry is non-compliant
- **No consent mechanism**: MCP servers run as background services with no UI for prompts
- **Legitimate interest is weak**: For commercial software without explicit consent
- **Industry shift**: 2025 sees increasing scrutiny of automatic telemetry

### Ethical Considerations
- **Respect user privacy**: Don't collect data without permission
- **Build trust**: Transparency and user control foster community support
- **Avoid controversy**: Next.js/VS Code/Homebrew all face criticism for opt-out approach

### Technical Constraints
- **No interactive prompts**: MCP protocol uses stdio/SSE for JSON-RPC communication
- **No UI during startup**: MCP servers start automatically via Claude Desktop config
- **Auto-updates break consent**: `@latest` installs can't show first-run prompts

---

## Future Incentive Program

### Value Exchange Model

Instead of collecting data automatically, we offer **genuine value** in exchange for voluntary participation:

#### 🎁 Premium Collection Access
- **Exclusive personas**: High-value personas not in public collection
- **Advanced templates**: Professional-grade templates for specialized use cases
- **Premium skills**: Complex capabilities requiring more development
- **Early access**: New elements 30 days before public release

**Rationale**: Users who help us improve get access to our best work

#### 💳 LLM Credits or API Access
- **Monthly credits**: Free API calls to Claude/GPT/other LLMs
- **Hosted services**: Access to Dollhouse-hosted inference
- **Priority processing**: Faster response times for API calls
- **Volume discounts**: Better rates for heavy users

**Rationale**: Direct financial value for contributing usage data

#### ⭐ Priority Support & Beta Access
- **Priority issue handling**: GitHub issues marked and tracked faster
- **Beta testing**: Early access to new features
- **Direct communication**: Discord/Slack channel for telemetry participants
- **Feature voting**: Voice in roadmap decisions

**Rationale**: Most engaged users get most attention

#### 🏅 Community Recognition
- **Contributor badges**: Profile badges on website/collection
- **Public dashboard**: Opt-in to show your contributions
- **Leaderboard**: Recognition for most helpful data contributors
- **Special thanks**: Mentioned in release notes

**Rationale**: Gamification and social recognition

---

## Implementation Plan

### Phase 1: Soft Launch (3-6 months)

**Goal**: Test infrastructure and gather initial data

**Activities**:
1. Create landing page explaining program benefits
2. Email existing users (if we have list) about opt-in opportunity
3. Offer ONE incentive to start (likely premium collection access)
4. Monitor participation rate (target: 5-10% initially)
5. Collect feedback on value proposition

**Success Metrics**:
- 50+ users opted in within first month
- Participation rate >5%
- Positive feedback on premium content
- Technical infrastructure stable (no PostHog failures)

### Phase 2: Full Launch (6-12 months)

**Goal**: Scale to meaningful data coverage

**Activities**:
1. Add LLM credits as second incentive
2. Create tiered participation (more data = more benefits)
3. Launch community recognition program
4. Add dashboard showing aggregate stats (transparent about what we learn)
5. Promote via blog posts, social media, documentation

**Success Metrics**:
- 500+ users opted in
- Participation rate >15%
- Actionable insights from telemetry data
- Community engagement around program

### Phase 3: Optimization (12+ months)

**Goal**: Sustainable value exchange

**Activities**:
1. Refine incentives based on what users actually want
2. Add new premium features as incentives
3. Consider tiered access (more sharing = more benefits)
4. Potential partnerships for additional incentives
5. Regular reporting to community about insights gained

---

## Data We Need

### Priority 1: Platform Distribution
**Question**: Which platforms should we prioritize for testing and support?

**Data Needed**:
- OS distribution (macOS %, Linux %, Windows %)
- Node.js version distribution
- MCP client type (Claude Desktop, Claude Code, other)

**Decision Impact**:
- Focus CI testing on most-common platforms
- Prioritize bug fixes for majority platforms
- Allocate support resources effectively

### Priority 2: Adoption Trends
**Question**: Is DollhouseMCP growing? What's the rate?

**Data Needed**:
- Installation count over time
- Version adoption curves
- Upgrade patterns

**Decision Impact**:
- Justify investment in development
- Plan for scaling (support, infrastructure)
- Celebrate milestones with community

### Priority 3: Compatibility Planning
**Question**: Can we drop support for older Node versions?

**Data Needed**:
- Node 18 vs 20 vs 22 distribution
- Update frequency

**Decision Impact**:
- Drop Node 18 support if <5% usage
- Focus compatibility testing efforts
- Simplify codebase by removing legacy support

---

## Privacy & Transparency

### Data Collection Promise

**What we collect** (if user opts in):
- Installation UUID (anonymous, generated locally)
- Version number
- OS type
- Node.js version
- MCP client type
- Timestamp of installation

**What we NEVER collect**:
- Personal information (names, emails, IP addresses)
- User content (personas, skills, templates, memories)
- Behavioral data (which tools used, conversations)
- File paths or system information
- Usage patterns or activity logs

### Transparency Measures

1. **Public Dashboard**: Show aggregate stats to all users
   - "40% of users on macOS, 35% on Linux, 25% on Windows"
   - "Most common Node version: 20.11.0"
   - "Average installation count growing 15%/month"

2. **Regular Reporting**: Blog posts about what we learned
   - "Why we're focusing Windows testing based on telemetry"
   - "Node 18 support decision explained"

3. **Open Source**: All telemetry code remains public
   - Community can audit implementation
   - Verify promises match reality

4. **Easy Opt-Out**: One config change to stop
   - Remove POSTHOG_API_KEY from MCP config
   - Keep benefits for 30 days after opt-out (grace period)

---

## Technical Implementation

### Current Infrastructure (Already Built)

```typescript
// src/telemetry/OperationalTelemetry.ts
// Already production-ready, just needs opt-in

private static initPostHog(): void {
  // Skip if no API key (opt-in for remote)
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) {
    logger.debug('Telemetry: PostHog not configured (no POSTHOG_API_KEY)');
    return;
  }

  // Initialize PostHog client
  this.posthog = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
    flushAt: 1,
    flushInterval: 10000,
  });
}
```

### User Configuration

When we launch the program, users add to their `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/path/to/node_modules/@dollhousemcp/mcp-server/dist/index.js"],
      "env": {
        "POSTHOG_API_KEY": "phc_provided_by_dollhouse_program"
      }
    }
  }
}
```

### PostHog Project Setup

We'll provide users with a shared project API key (`phc_*`) that:
- Is safe to expose publicly (write-only)
- Allows sending events but not reading data
- Can be rotated if abused

### Premium Content Delivery

**Option A: GitHub Private Repository**
- Create private repo `DollhouseMCP/premium-collection`
- Grant access to telemetry participants' GitHub accounts
- Users can install elements via GitHub integration

**Option B: Authenticated API**
- Create API endpoint that checks telemetry participation
- Serve premium elements via authenticated download
- Simpler for users but more infrastructure

---

## Business Model Alignment

### Why This Works

1. **Legitimate exchange**: Users get value for data shared
2. **Scalable**: More participants = better data without linear cost increase
3. **Community-driven**: Reinforces open-source ethos with transparency
4. **Ethical**: Voluntary participation with clear benefits
5. **GDPR compliant**: Explicit consent with clear purpose

### Revenue Potential

This program enables future monetization:
- **Premium tier**: $5-10/month for premium collection + credits
- **Enterprise tier**: $50-100/month for team access + priority support
- **API access**: Usage-based pricing for hosted inference

Telemetry participants could get these benefits free or discounted as thank-you.

---

## Risk Analysis

### Risk 1: Low Participation
**Likelihood**: Medium
**Impact**: High
**Mitigation**:
- Start with high-value incentives (premium content)
- Clear communication of benefits
- Social proof (leaderboard, badges)
- Regular value additions to program

### Risk 2: Data Not Actionable
**Likelihood**: Low
**Impact**: Medium
**Mitigation**:
- Focus on specific questions we need answered
- Implement analytics dashboard to spot trends
- Regular review of data insights

### Risk 3: Privacy Concerns
**Likelihood**: Low
**Impact**: High
**Mitigation**:
- Maximum transparency about collection
- Easy opt-out mechanism
- Public reporting of aggregates
- Open-source code for audit

### Risk 4: Infrastructure Costs
**Likelihood**: Low
**Impact**: Low
**Mitigation**:
- PostHog free tier: 1M events/month
- Even at 10,000 users = 10,000 events (well under limit)
- Can self-host PostHog if needed

---

## Success Criteria

### Minimum Viable Success (Phase 1)
- ✅ 50+ users opted in
- ✅ Participation rate >5%
- ✅ Technical infrastructure stable
- ✅ Positive user feedback

### Good Success (Phase 2)
- ✅ 500+ users opted in
- ✅ Participation rate >15%
- ✅ Actionable platform insights gained
- ✅ Premium content library growing

### Exceptional Success (Phase 3)
- ✅ 2,000+ users opted in
- ✅ Participation rate >25%
- ✅ Data-driven roadmap decisions validated by community
- ✅ Sustainable value exchange model established

---

## Timeline

| Milestone | Target Date | Dependencies |
|-----------|-------------|--------------|
| Infrastructure complete | ✅ Done (v1.9.18) | PostHog integration merged |
| Premium collection created | Q1 2026 | Need 20-30 high-quality personas/skills |
| Program documentation | Q1 2026 | Landing page, legal review |
| Soft launch (Phase 1) | Q2 2026 | Premium content ready |
| Full launch (Phase 2) | Q3 2026 | Phase 1 success metrics met |
| Optimization (Phase 3) | Q4 2026+ | Ongoing |

---

## Next Steps

### Immediate (Next 30 Days)
- [x] Revert to opt-in implementation (DONE)
- [x] Update documentation to reflect opt-in approach (DONE)
- [ ] Validate all tests pass with opt-in implementation
- [ ] Merge PR #1361 with opt-in approach

### Short Term (Next 3 Months)
- [ ] Create landing page for future program
- [ ] Start building premium collection content
- [ ] Legal review of incentive program
- [ ] Design premium content delivery mechanism

### Medium Term (Next 6 Months)
- [ ] Build dashboard for aggregate stats
- [ ] Implement authentication for premium content
- [ ] Create first tier of incentives (premium collection)
- [ ] Soft launch to early adopters

---

## Conclusion

The opt-in telemetry approach with incentives is the **best path forward**:

✅ **Legally sound**: GDPR compliant, explicit consent
✅ **Ethically right**: Voluntary participation, fair value exchange
✅ **Technically ready**: Infrastructure already built and tested
✅ **Business aligned**: Enables future monetization
✅ **Community friendly**: Transparent, beneficial, respectful

**We're positioned to launch when ready** with proper incentives that provide real value to users who choose to help us improve DollhouseMCP.

---

*Document maintained by: DollhouseMCP Core Team*
*Last updated: October 16, 2025*
