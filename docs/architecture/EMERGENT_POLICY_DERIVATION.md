# Emergent Policy Derivation

**Status:** Design Principle
**Created:** 2025-12-22
**Related Issues:** #155, #150, #152

---

## Core Principle

Policy declarations should be **derived from intrinsic operation properties**, not manually configured. A well-designed system makes correct policy behavior feel inevitable - the constraints emerge naturally from the structure of operations themselves.

> "If we do it right, it's almost like there's no other way we could have properly done it."

---

## The Problem with Manual Policy

Traditional approach:
```graphql
type Mutation {
  delete_element(...): Result @requiresPermission(level: CONFIRM_ALWAYS)
  list_elements(...): Result @requiresPermission(level: AUTO_APPROVE)
  sync_portfolio(...): Result @requiresPermission(level: CONFIRM_ALWAYS)
  # ... 40 more manual declarations
}
```

Problems:
- **Error-prone**: Forget one annotation, create a security hole
- **Maintenance burden**: Every new operation needs policy review
- **Arbitrary**: Why is X risky? Because someone said so
- **Inconsistent**: Different authors, different judgment calls

---

## Emergent Derivation

Instead of declaring policies, **derive them from what operations inherently are**.

### Derivable Properties

| Property | Source | Risk Signal |
|----------|--------|-------------|
| Operation verb | Naming convention | `delete_*`, `clear_*`, `force_*` = high risk |
| GraphQL type | Schema structure | Mutation > Query |
| External impact | Handler metadata | Touches auth, GitHub, webhooks = higher risk |
| Reversibility | Operation semantics | Create (reversible) vs Delete unique (irreversible) |
| Parameter signatures | Schema inspection | Has `force: boolean` = destructive variant |
| Element type affected | Operation target | Agents (autonomous) > Templates (inert text) |
| Scope | Parameter analysis | Bulk operations > single-item operations |

### Risk Scoring Model

```typescript
interface RiskFactors {
  operationVerb: 'read' | 'list' | 'create' | 'update' | 'delete' | 'clear' | 'sync' | 'force';
  mutationType: 'query' | 'mutation';
  externalImpact: boolean;      // Touches external systems (GitHub, auth, webhooks)
  reversibility: 'full' | 'partial' | 'none';
  hasForceFlag: boolean;
  elementType: 'agent' | 'persona' | 'skill' | 'template' | 'memory';
  bulkOperation: boolean;
}

function deriveRiskScore(factors: RiskFactors): number {
  let score = 0;

  // Verb analysis
  const verbRisk = {
    'read': 0, 'list': 0,
    'create': 0.3, 'update': 0.4,
    'delete': 0.7, 'clear': 0.8, 'force': 0.9, 'sync': 0.5
  };
  score += verbRisk[factors.operationVerb] ?? 0.5;

  // Mutation type
  if (factors.mutationType === 'mutation') score += 0.2;

  // External impact
  if (factors.externalImpact) score += 0.3;

  // Reversibility
  if (factors.reversibility === 'none') score += 0.3;
  else if (factors.reversibility === 'partial') score += 0.15;

  // Force flag presence
  if (factors.hasForceFlag) score += 0.2;

  // Element type risk
  const typeRisk = { 'agent': 0.2, 'persona': 0.1, 'skill': 0.05, 'template': 0, 'memory': 0.1 };
  score += typeRisk[factors.elementType] ?? 0;

  // Bulk operations
  if (factors.bulkOperation) score += 0.2;

  return Math.min(score, 1.0);
}
```

### Policy Derivation

```typescript
function derivePolicy(riskScore: number): PermissionLevel {
  if (riskScore < 0.3) return 'AUTO_APPROVE';
  if (riskScore < 0.6) return 'CONFIRM_ONCE';
  return 'CONFIRM_ALWAYS';
}
```

---

## What Remains Explicit

Only **genuinely arbitrary business decisions** require explicit declaration:

```graphql
# This IS derivable (delete = destructive)
delete_element @requiresPermission(level: CONFIRM_ALWAYS)  # DERIVED

# This is NOT derivable (organizational policy)
edit_agent @personaRestricted(deny: ["junior-dev"])  # EXPLICIT OVERRIDE
```

The distinction:
- **Derivable**: "Delete is dangerous" - intrinsic to what delete means
- **Not derivable**: "Junior devs can't touch agents" - organizational choice

---

## Implementation Strategy

### Phase 1: Schema Derivation
The GraphQL schema is auto-generated from existing tool registrations and TypeScript types. No manual schema authoring.

### Phase 2: Policy Derivation
Risk scores are computed from operation properties. Default policies emerge from scores.

### Phase 3: Override Layer
A minimal config file allows explicit overrides for business-specific policies:

```yaml
# policy-overrides.yaml
overrides:
  - operation: edit_agent
    personaRestricted:
      deny: ["junior-dev", "frontend-dev"]
    reason: "Organizational policy - agents require senior review"
```

### Phase 4: Audit Trail
Derived policies are logged with their derivation reasoning:

```json
{
  "operation": "delete_element",
  "derivedPolicy": "CONFIRM_ALWAYS",
  "riskScore": 0.72,
  "factors": {
    "verb": "delete (0.7)",
    "mutation": true,
    "reversibility": "none (+0.3)"
  },
  "override": null
}
```

---

## Benefits

1. **Security by default**: New operations get appropriate policies automatically
2. **Consistency**: Same factors always produce same policy
3. **Transparency**: Policy decisions are explainable ("this is CONFIRM_ALWAYS because...")
4. **Maintainability**: Add operations without manual policy review
5. **Correctness**: The system can't "forget" to secure a dangerous operation

---

## The Inevitability Test

Good architecture passes this test:

> "Given the structure of this operation, could the policy reasonably be anything else?"

- `delete_element` → CONFIRM_ALWAYS? **Inevitable**. What else would it be?
- `list_elements` → AUTO_APPROVE? **Inevitable**. It's read-only.
- `sync_portfolio --force` → CONFIRM_ALWAYS? **Inevitable**. Force flag + external sync.

When policies feel inevitable, the architecture is right.

---

## Related Documents

- [01-MCP-AQL-CORE](../merview-v2-roadmap/01-MCP-AQL-CORE.md) - Core architecture
- [02-MCP-AQL-ADAPTERS](../merview-v2-roadmap/02-MCP-AQL-ADAPTERS.md) - Adapter system
- [SESSION_NOTES_2025-12-17-MCPAQL-GRAPHQL-ARCHITECTURE-DECISION](../agent/development/SESSION_NOTES_2025-12-17-MCPAQL-GRAPHQL-ARCHITECTURE-DECISION.md) - GraphQL decision

---

*The best policy is the one you didn't have to write.*
