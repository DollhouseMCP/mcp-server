# Workflow Examples

This directory contains real-world examples of efficient issue handling workflows used in the DollhouseMCP project. Each example demonstrates how to structure handover documents and session prompts to enable rapid, high-quality issue resolution.

## Purpose

These examples serve as:
- **Templates** for creating new issue handover documents
- **Training materials** for contributors learning the project workflow
- **Documentation** of best practices for AI-assisted development
- **Transparency** showing how we build in the open

## Structure

Each workflow example contains:
- `SESSION_PROMPT.md` - The initial prompt given to start work
- `HANDOVER.md` - Detailed context, procedures, and references
- `OUTCOME.md` - Results, metrics, and lessons learned (when available)

## Available Examples

### Issue #1225: SonarCloud S7758 String Method Modernization
**Directory**: `issue-1225-sonarcloud-s7758/`
**Status**: ✅ Completed
**PR**: [#1234](https://github.com/DollhouseMCP/mcp-server/pull/1234)
**Time**: ~30 minutes from start to merged PR

Demonstrates:
- Complete SonarCloud issue resolution workflow
- Handling false positives with proper documentation
- Efficient testing and verification procedures
- Professional PR creation and merge process

**Key Learnings**:
- Handover documents reduce onboarding time from hours to minutes
- Clear step-by-step procedures prevent mistakes
- Including common pitfalls saves debugging time
- Documenting "why" in code prevents future confusion

## Using These Examples

### For Creating New Handovers

1. Copy the structure from an existing example
2. Adapt sections to your specific issue type
3. Include all critical references and procedures
4. Add common pitfalls you've encountered

### For Starting Work

1. Read the `HANDOVER.md` thoroughly
2. Use the `SESSION_PROMPT.md` to initiate work
3. Follow procedures step-by-step
4. Update the handover if you discover improvements

### For Learning the Workflow

1. Start with the SESSION_PROMPT to understand the initial context
2. Study the HANDOVER to see the full procedure
3. Review the linked PR to see the actual implementation
4. Note the time estimates vs actual results

## Best Practices

### Handover Documents Should Include

- ✅ Quick start commands
- ✅ Complete context (what's been done, what's next)
- ✅ Step-by-step procedures
- ✅ Critical documentation references
- ✅ Common pitfalls to avoid
- ✅ Edge cases and gotchas
- ✅ Success metrics
- ✅ Time estimates

### Session Prompts Should Be

- ✅ Concise (point to handover for details)
- ✅ Clear about the goal
- ✅ Specific about what needs doing
- ✅ Free of assumptions

## Contributing Examples

We welcome contributions of workflow examples! To add one:

1. Create a new directory: `issue-XXXX-brief-description/`
2. Include at minimum: `SESSION_PROMPT.md` and `HANDOVER.md`
3. Link to the actual PR/issue in the README
4. Add an entry to this index
5. Submit as part of your PR or separately

## Metrics

Tracking efficiency improvements from using handover documents:

| Metric | Before Handovers | With Handovers | Improvement |
|--------|------------------|----------------|-------------|
| Setup Time | 15-30 min | 2-5 min | 75-83% |
| Context Errors | Common | Rare | ~90% |
| Missed Steps | 10-20% | <5% | 50-75% |
| Rework Required | 20-30% | <10% | 67% |

*Metrics based on observed patterns across multiple issues*

## Philosophy

> "A good handover document turns a complex task into a simple checklist."

We believe in:
- **Radical transparency** - All processes documented
- **Knowledge transfer** - Every issue is a learning opportunity
- **Continuous improvement** - Update handovers when you find better ways
- **Building in the open** - Share what works so others can benefit

---

*Last updated: October 2, 2025*
*For questions or suggestions, open an issue or discussion on GitHub*
