---
name: Minimal Ensemble
description: Minimal working example - friendly assistant with code documentation support
version: 1.0.0
author: DollhouseMCP
created: 2025-01-15T00:00:00.000Z
tags:
  - minimal
  - example
  - quick-start

# Activation settings
activationStrategy: all
conflictResolution: last-write
contextSharing: none

# Elements in this ensemble (just 2 simple elements)
elements:
  - name: friendly-assistant
    type: persona
    role: primary
    priority: 100
    activation: always
    purpose: Provides helpful, friendly interaction style

  - name: code-documentation
    type: skill
    role: support
    priority: 80
    activation: always
    purpose: Generates clear code documentation
---

# Minimal Ensemble

The simplest possible ensemble - just two elements working together. This is a great starting point for learning how ensembles work.

## What's Inside

This minimal example combines just two elements:

1. **Friendly Assistant** (Persona)
   - Provides a warm, helpful personality
   - Clear and approachable communication
   - Patient explanations

2. **Code Documentation** (Skill)
   - Generates code comments and docstrings
   - Creates README files
   - Explains code in plain language

## Usage

Activate this ensemble to get started:

```typescript
activate_element name="Minimal-Ensemble" type="ensembles"
```

That's it! Both elements activate simultaneously (using the `all` strategy).

## Configuration

This minimal example uses the simplest possible configuration:

- **Strategy**: `all` - Both elements activate at the same time
- **Conflict Resolution**: `last-write` - If conflicts occur, the last value wins (though unlikely with just 2 elements)
- **Context Sharing**: `none` - Elements don't share context (keeps things simple)
- **No Dependencies**: Elements are independent
- **No Conditions**: Both always activate
- **No Resource Limits**: Uses defaults

## Why This Is Useful

This minimal example demonstrates:
- ✅ The basic structure of an ensemble
- ✅ How to combine a persona with a skill
- ✅ Simple activation without complexity
- ✅ A practical use case (friendly documentation helper)

## Learning Path

Once you understand this minimal example, explore more complex ensembles:

1. **Start here**: Minimal Ensemble (2 elements, no dependencies)
2. **Next**: Writing Studio (4 elements, parallel activation, priority conflicts)
3. **Then**: Data Pipeline (4 elements, priority-based sequential)
4. **Advanced**: Code Review Team (4 elements, sequential with dependencies)
5. **Expert**: Debugging Assistant (4 elements, conditional activation)

## Customization

You can easily modify this ensemble:

### Add More Elements

```yaml
- name: grammar-checker
  type: skill
  role: support
  priority: 75
  activation: always
  purpose: Checks grammar and spelling
```

### Add Context Sharing

```yaml
contextSharing: selective  # Elements can share specific values
```

### Add Dependencies

```yaml
elements:
  - name: friendly-assistant
    type: persona
    role: primary
    priority: 100
    activation: always

  - name: code-documentation
    type: skill
    role: support
    priority: 80
    activation: always
    dependencies:
      - friendly-assistant  # Loads after friendly-assistant
```

## Dependencies

This ensemble expects the following elements to exist in your portfolio:
- `friendly-assistant` (persona)
- `code-documentation` (skill)

## Tips for Beginners

1. **Start simple**: This ensemble is perfect for understanding the basics
2. **Test activation**: See how both elements work together
3. **Experiment**: Try changing priorities, strategies, and conflict resolution
4. **Build up**: Add more elements as you learn
5. **Read the docs**: Check out `docs/guides/ensembles.md` for complete documentation

## Common Questions

**Q: Why use an ensemble for just 2 elements?**
A: While you could activate these separately, an ensemble:
- Activates both with one command
- Manages their interaction
- Provides a single activation/deactivation point
- Demonstrates the pattern for larger ensembles

**Q: What if I don't have these specific elements?**
A: Replace `friendly-assistant` and `code-documentation` with any persona and skill you have. The structure remains the same.

**Q: Can I make this even simpler?**
A: Not really! An ensemble needs at least:
- A name and description
- An activation strategy
- At least one element (though 2+ is more useful)

This is the absolute minimum viable ensemble.

## Next Steps

1. Activate this minimal ensemble and observe the behavior
2. Try modifying the YAML frontmatter
3. Add a third element
4. Explore the other example ensembles
5. Create your own custom ensemble
