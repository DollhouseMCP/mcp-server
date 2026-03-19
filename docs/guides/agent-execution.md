# Dollhouse Agent Execution

How Dollhouse Agents work — the agentic loop, security enforcement, and human-in-the-loop control.

---

## The Core Idea

A Dollhouse Agent pursues a goal through a continuous loop where the LLM and the MCP server pass control back and forth. The LLM handles all semantic work — reasoning, deciding, interpreting. The MCP server handles all programmatic work — executing, enforcing, persisting. Neither operates alone.

This is different from agents that run entirely in the LLM or entirely on the server. Every step crosses the boundary, and every crossing is checked.

---

## The Agentic Loop

```
 ┌───────────────┐
 │   HUMAN       │
 │  (optional)   │◄──── LLM asks for guidance
 │               │      when autonomy evaluator
 │ Approve, deny,│      says "pause"
 │ or guide      │
 └───────┬───────┘
         │ responds to LLM
         ▼
 ┌─────────────┐     ┌─────────────────────────────┐     ┌─────────────┐
 │             │     │  DollhouseMCP MCP Server     │     │             │
 │    LLM      │────▶│                              │────▶│    LLM      │
 │             │     │  1. Gatekeeper checks policy  │     │             │
 │  Decides    │     │  2. Autonomy Evaluator scores │     │  Records    │
 │  next       │     │  3. Danger Zone enforcement   │     │  step and   │
 │  action     │     │  4. Execute or block          │     │  continues  │
 │             │     │  5. Return result + autonomy  │     │  or pauses  │
 │             │◀────│     guidance to LLM           │◀────│             │
 └─────────────┘     └─────────────────────────────┘     └─────────────┘
        │                                                       │
        └──────────────── repeats every step ───────────────────┘
```

### What happens at each step:

1. **LLM decides** what to do next — which MCP-AQL operation to call, with what parameters
2. **Gatekeeper** checks the operation against all active element policies. Deny = blocked. Confirm = ask the human. Allow = proceed.
3. **Autonomy Evaluator** scores whether the agent should continue autonomously or pause for human input. Factors include: step count, operation risk, element policies, and configured autonomy limits.
4. **Danger Zone** enforces hard blocks on high-risk operations. These cannot be overridden by the LLM or confirmed away — the element's deny policy is absolute.
5. **Step recording** logs the action, outcome, and autonomy decision. This creates an audit trail for every decision the agent makes.
6. **The LLM receives the result** along with autonomy guidance: continue, pause, or escalate. It interprets the result and decides the next action.

---

## The Division of Labor

| | LLM (Semantic) | MCP Server (Programmatic) |
|---|---|---|
| **Decides** | What to do next, which tool to call, when the goal is done | Nothing — it executes, doesn't decide |
| **Executes** | Nothing — it decides, doesn't execute | Tool calls, file I/O, element CRUD, state persistence |
| **Enforces** | Nothing — it can be told "no" | Gatekeeper policies, Danger Zone blocks, autonomy limits |
| **Context** | Active element instructions (personas, skills, memories) | Element metadata, policy definitions, execution state |

The LLM is the brain. The MCP server is the body. Elements are context that shapes how the brain thinks and what the body is allowed to do.

---

## Security at Every Step

### Gatekeeper (Policy Enforcement)

Every MCP-AQL operation passes through the Gatekeeper before execution. Active elements define what's allowed:

```yaml
# Example: a "careful-reviewer" persona
gatekeeper:
  allow:
    - list_elements
    - search_elements
    - get_element
  confirm:
    - create_element
    - edit_element
  deny:
    - delete_element
    - execute_agent
```

Policy priority: **deny > confirm > allow > route default**. A deny from any active element cannot be overridden.

### Autonomy Evaluator

After each step, the Autonomy Evaluator decides whether the agent should continue or pause:

- **Continue** — the action was routine and within configured limits
- **Pause** — the action was unusual, the step count is high, or the element policy requires human review
- **Escalate** — a Danger Zone trigger or a notification that needs human attention

The LLM receives this guidance with every response. It's not optional — the agent's next action is always informed by the evaluator's assessment.

### Danger Zone

Hard blocks on operations that should never be automated without explicit approval:

- File deletion outside approved directories
- External API calls to unknown endpoints
- System commands with destructive potential
- Any operation denied by an active element's policy

Danger Zone blocks cannot be confirmed or bypassed. The element must be deactivated or the policy changed.

### Step Recording (Audit Trail)

Every step is recorded with:
- What operation was attempted
- Whether it was allowed, confirmed, or denied
- The outcome (success, failure, blocked)
- The autonomy evaluator's decision
- Findings and data gathered

Use `get_execution_state` to inspect an agent's progress at any time.

---

## Human-in-the-Loop

The human is optional but always available. The Autonomy Evaluator decides when to involve them:

- **Fully autonomous** — `autonomy.maxAutonomousSteps: 0` (unlimited). The agent runs until the goal is complete. The Gatekeeper still enforces policies, but the agent doesn't pause for human input.
- **Step-limited** — `autonomy.maxAutonomousSteps: 10`. The agent runs for 10 steps, then pauses for the human to review progress and decide whether to continue.
- **Always-confirm** — Element policies can require confirmation on every sensitive operation. The agent pauses, the LLM asks the human, and the human approves or denies.

The human interacts with the LLM, not the MCP server directly. The LLM presents the situation, the human responds, and the LLM acts accordingly.

---

## Agent Composition

Dollhouse Agents compose with all other element types:

- **Activate Personas** — change the LLM's behavior during execution (e.g., activate a security-analyst persona for a code review agent)
- **Activate Skills** — add capabilities (e.g., threat-modeling, data-analysis)
- **Use Templates** — produce structured outputs (e.g., render a penetration test report template)
- **Load Memories** — access persistent context (e.g., project history, previous findings)
- **Run as Ensembles** — bundle an agent with its supporting elements into a single activatable unit

When an agent activates elements, those elements' Gatekeeper policies take effect immediately — shaping what the agent can do for the rest of its execution.

---

## Execution Lifecycle Operations

| Operation | Endpoint | What It Does |
|-----------|----------|-------------|
| `execute_agent` | Execute | Start a new execution with goal parameters |
| `record_execution_step` | Create | Log a step with description, outcome, findings |
| `get_execution_state` | Read | Inspect current progress, steps, and autonomy status |
| `get_gathered_data` | Read | Retrieve data collected during execution |
| `complete_execution` | Execute | Mark goal as successfully achieved |
| `abort_execution` | Execute | Cancel execution with a reason |
| `continue_execution` | Execute | Resume from a paused state |
| `prepare_handoff` | Execute | Serialize state for session transfer |
| `resume_from_handoff` | Execute | Restore state in a new session |

---

## Resilience

Agents can define resilience policies for automatic recovery:

```yaml
resilience:
  onStepLimitReached: continue    # or "pause" or "restart"
  onExecutionFailure: retry       # or "pause" or "restart-fresh"
  maxRetries: 3
  maxContinuations: 10
  retryBackoff: exponential
```

Without resilience configuration, agents pause at limits and failures (safe default).

---

## Further Reading

- [Agent Architecture Specification](../architecture/AGENT_ARCHITECTURE_SPECIFICATION.md) — the full internal design document
- [Gatekeeper Confirmation Model](../security/gatekeeper-confirmation-model.md) — detailed permission system documentation
- [MCP-AQL Architecture](../architecture/mcp-aql/README.md) — the protocol layer agents use
- [LLM Quick Reference](llm-quick-reference.md) — operation cheat sheet including execution lifecycle
