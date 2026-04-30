# Why DollhouseMCP: Persona-Based Security for AI Agents

<!--
  This document serves as both a technical white paper and a source for
  blog post extractions. Sections marked [BLOG CANDIDATE] can be adapted
  for standalone publication.
-->

## Executive Summary

DollhouseMCP elements are markdown files with YAML front matter. You could copy one, paste it into a clean Claude session, and it would work reasonably well as a prompt.

But that misses the point entirely.

DollhouseMCP treats elements — especially personas — as **security principals**. When you activate a persona, you're not just changing the AI's tone. You're changing what tools it can access, what files it can touch, what commands it can run, and what operations require approval. The prompt is the identity. The server enforces the permissions.

This is persona-based permissioning: the same model that operating systems have used for decades with user accounts, applied to AI agents operating in agentic loops.

---

## Part I: The Core Insight

### [BLOG CANDIDATE] Personas Are Not Prompts — They're Security Principals

In a traditional operating system, a user account is more than a name. It's a security principal: an identity that carries permissions, belongs to groups, has audit trails, and can be granted or denied access to resources.

DollhouseMCP personas work the same way:

| Traditional OS Security | DollhouseMCP Equivalent |
|------------------------|------------------------|
| User identity (uid/gid) | Active persona/agent name |
| Login / session creation | `activate_element` |
| Logout / session teardown | `deactivate_element` |
| File permissions (rwx) | `allow` / `deny` patterns per element |
| Groups | Ensembles |
| `sudo` / privilege escalation | Gatekeeper `confirm_operation` |
| `whoami` | `get_active_elements` |
| Audit log (`/var/log/auth.log`) | Security monitor + `query_logs` |
| `su` / user switching | Persona swap mid-session |
| Shell prompt showing `user@host` | Status line / message prefix |
| Role-based access (RBAC) | Element-type-based policies |

The mapping is almost 1:1. And that's what makes the gaps visible — we can use decades of OS security research as a rubric for what AI agent security needs to look like.

### Where Personas Exceed OS Users

Personas actually go beyond traditional user accounts in several ways:

- **Behavioral contracts**: A Unix user doesn't come with instructions for how they should act. Personas do. The permission system enforces what they *can* do, and the instructions shape what they *choose* to do. Defense in depth at the identity level.
- **Composable identity**: Ensembles create compound identities (persona + skills + agent) that inherit combined permissions. OS groups are flat; ensembles are structured with activation strategies and conflict resolution.
- **Hot-swappable context**: You can change who's "logged in" without restarting the session, and the permission surface instantly reshapes. No PAM reconfiguration needed.
- **Policy federation**: The export/import pipeline means one MCP server's security decisions flow into another server's enforcement layer. There's no `passwd`/`shadow` equivalent that does cross-system policy sync this cleanly.

### Where DollhouseMCP Fits in the Landscape

As of March 2026, the industry has several approaches to agentic AI security. Many are highly sophisticated and battle-tested in production environments — the question is what they optimize for versus what DollhouseMCP optimizes for.

- **Policy-based authorization** (Cerbos, Oso, SailPoint): Runtime access control for agent actions. These support agent-aware authorization — not just user roles — and can evaluate rich policy contexts. They optimize for enterprise identity governance: who can do what, across which systems, with what audit trail. DollhouseMCP optimizes for a different axis: what *behavioral profile* is active, and how does that reshape the available capability surface.
- **LLM Firewalls** (Securiti, WitnessAI, Cisco AI Defense): Context-aware firewalls that monitor prompt injection, data leakage, and tool misuse at the request level. Strong at detecting threats in the data plane. DollhouseMCP's gatekeeper operates in the control plane — it doesn't inspect content for threats (that's ContentValidator's job), it enforces structural permission policies based on active element composition.
- **Agent identity platforms** (Microsoft Agent 365 with Entra Agent ID, Cyata): Identity-aware agent frameworks where agents have their own credentials and permission boundaries. These are closer to DollhouseMCP's model than static sandboxes. The difference: DollhouseMCP's identity is *behavioral* (persona + skills + agent as a composed ensemble) rather than *credential-based* (agent as an authenticated principal).
- **Runtime sandboxing** (NVIDIA guidance, Northflank, hardened containers): Execution environment isolation — MicroVMs, gVisor, network segmentation. Essential infrastructure, but orthogonal to DollhouseMCP. Sandboxing constrains *where* code runs; DollhouseMCP constrains *what operations* the AI can request based on its active behavioral configuration.

**What DollhouseMCP does differently:**

1. **Persona as behavioral contract** — not just agent-as-identity-principal. A persona defines tone, priorities, workflows, AND security policy in a single human-readable document.
2. **Dynamic capability reshaping** — the permission surface changes instantly when elements are activated or deactivated, without restarting sessions or reconfiguring infrastructure.
3. **Ensemble composition with conflict resolution** — compound identities (persona + skills + agent) with deterministic priority rules when policies conflict.
4. **Element-driven policy** — security configuration lives in the same markdown files that define behavior, making policy auditable by non-engineers.

---

## Part II: What the Runtime Does

### [BLOG CANDIDATE] "It's Just Markdown" — Yes, and .py Files Are Just Text

A `.py` file is also "just text." You can read it, understand it, mentally execute it. But the difference between reading a Python file and running it through the Python interpreter is everything.

The interpreter gives it a runtime, state management, error handling, permissions, and the ability to interact with the outside world.

DollhouseMCP elements are natural-language programs. The MCP server is their interpreter. Here's what the interpreter provides:

### 1. Deterministic Permission Enforcement

When you paste a prompt that says "don't run destructive commands," the LLM might comply. It might not. It might rationalize an exception. It might forget halfway through a long context.

DollhouseMCP enforces permissions through a three-layer gatekeeper that runs server-side on every operation:

- **Layer 1 — Route policies**: Every operation (52+) has an explicit permission level (`AUTO_APPROVE`, `CONFIRM_SESSION`, `CONFIRM_SINGLE_USE`, `DENY`). `delete_element` cannot be elevated to auto-approve — that's a code invariant, not an instruction.
- **Layer 2 — Element policies**: Active personas, skills, and agents can declare `allow`, `confirm`, and `deny` lists that override route defaults at runtime. A security-focused persona can require confirmation for operations that are normally auto-approved. Priority resolution is deterministic: element deny > element confirm > element allow > route default.
- **Layer 3 — Session confirmation**: `confirm_operation` is the only way to unlock gated operations. The server tracks what's been confirmed per session and enforces it.

The LLM generates tool calls. The server decides whether they execute.

### 2. Dynamic Composition

Copy-pasting a prompt is static. You get one behavior profile for the entire conversation.

DollhouseMCP elements activate and deactivate at runtime:

- **Ensembles** bundle multiple elements into coordinated groups with activation strategies (`sequential`, `parallel`, `lazy`) and conflict resolution (`first_wins`, `merge`, `deny`).
- **Activation limits** prevent resource exhaustion — configurable per element type, enforced server-side.
- **Circular dependency detection** prevents `A activates B, B activates A` infinite loops.
- **Per-session activation state** persists across tool calls, so concurrent sessions (Claude Code + Zulip bridge) maintain independent element profiles without interference.

When you deactivate an ensemble, all its elements' policies disappear. When you activate a different one, different policies apply.

### 3. Cross-System Policy Propagation

A pasted prompt lives in one context window. It has no way to tell external systems what's allowed.

DollhouseMCP's `PolicyExportService` writes a JSON policy file on every activation change. The DollhouseBridge imports it. The standalone permission-prompt server evaluates it. Claude Code respects the decision.

**Four-system chain, proven end-to-end**:
1. DollhouseMCP exports static classification rules (71 dangerous patterns, 35 safe patterns, 5 blocked patterns, 9 gatekeeper-essential operations) and per-element external restrictions
2. The bridge imports and validates the policy file (500ms debounce file watcher)
3. The permission-prompt server classifies every tool call against the imported policies
4. Claude Code receives allow/deny decisions and enforces them

The policy re-exports automatically when elements activate or deactivate. No restart, no re-paste, no manual intervention.

### 4. State That Survives

A conversation with a pasted prompt has no memory beyond the context window.

DollhouseMCP maintains persistent state across sessions:

- **Agent execution state**: Goal progress, step history, gathered data persist to `.state/` files with file-locked atomic writes. Agents can be handed off between sessions with integrity validation.
- **Memory elements**: Structured entries that auto-load on startup. Date-organized with deduplication, collision-safe backup, and configurable retention.
- **Activation state**: Which elements are active persists per session ID, so restarting the server restores the same profile.
- **Danger zone blocks**: If an agent triggers a dangerous pattern, the block persists to disk and survives server restarts. Only a verified 2FA-style challenge can unblock it.

### 5. Validation the LLM Can't Skip

When you paste an element as text, the LLM takes it at face value. Malformed YAML, injection attacks in metadata, path traversal in filenames — the LLM has no defense.

DollhouseMCP validates everything server-side:

- `SecureYamlParser` with size guards and fail-closed semantics
- Unicode normalization (NFC), control character stripping, command injection prevention
- Directory traversal blocked, operations scoped to approved directories
- `sanitizeGatekeeperPolicy()` on element load prevents prompt-injection of policy metadata — an element can't grant itself elevated permissions
- Duplicate name detection, invalid character rejection with suggested corrections

### 6. Automatic Safety Nets

- **Universal backup**: Pre-save and pre-delete backups for all 6 element types with automatic pruning
- **Atomic file operations**: `FileLockManager` prevents race conditions
- **Danger zone enforcement**: Destructive operations spawn OS-native verification dialogs the LLM never sees
- **Agent execution resilience**: Retry policies, circuit breakers, autonomy evaluation that pauses agents when risk scores exceed thresholds

### 7. Self-Describing API

DollhouseMCP's introspection system lets the LLM discover capabilities at runtime rather than requiring static tool definitions. A CI gate ensures every operation has a corresponding schema definition. The LLM learns the API dynamically.

### 8. Sharing and Reuse Through Validated Distribution

DollhouseMCP provides a three-tier architecture for element distribution:

1. **Local portfolio** (`~/.dollhouse/portfolio/`) — your private workspace
2. **GitHub portfolio** — personal backup and sync
3. **Community collection** — shared library with search, browse, and install

This is where persona-based security intersects with distribution. Elements in the community collection can declare their permission profiles on the tin:

- "This persona only accesses `src/components/` — you must specify the path before activation"
- "This agent requires temporarily elevated privileges for deployment, then reverts to locked-down mode"
- "This ensemble's personas cannot run simultaneously — mutex enforcement is built in"

Users can inspect the permission profile before installing, and the server enforces it after activation. The collection becomes a curated marketplace of validated security principals, not just a library of prompts.

---

## Part III: MCP-AQL's Role

### [BLOG CANDIDATE] Why a Query Language Matters for Agent Security

MCP-AQL is a protocol layer on top of MCP, created by Dollhouse Research. In DollhouseMCP, that GraphQL-inspired query layer routed through CRUDE endpoints isn't just an API design choice. It's a security architecture decision.

By collapsing dozens of individual MCP tools into 5 typed endpoints (Create, Read, Update, Delete, Execute), MCP-AQL provides:

- **Semantic endpoint selection**: The model chooses an action family based on intent first, rather than hunting through a long list of narrowly functional tools. That better matches how LLMs reason about tasks.
- **Endpoint-level permission defaults**: All READ operations auto-approve. All DELETE operations require single-use confirmation. This is enforced by the routing layer before any handler runs.
- **Schema-driven validation**: Every operation has a typed schema. The server validates parameters before dispatch — malformed requests never reach handler code.
- **Introspection as capability discovery**: The LLM doesn't need to know every operation at startup. It discovers available operations via `introspect`, reducing token overhead and eliminating stale tool definitions.
- **Audit granularity**: Every operation passes through the same dispatch pipeline, so logging, gatekeeper enforcement, and telemetry apply uniformly.

The CRUDE endpoint model maps naturally to permission levels:
- **Create** → `CONFIRM_SESSION` (confirm once per session)
- **Read** → `AUTO_APPROVE` (safe, no side effects)
- **Update** → `CONFIRM_SINGLE_USE` (confirm every time)
- **Delete** → `CONFIRM_SINGLE_USE` (cannot be elevated)
- **Execute** → `CONFIRM_SINGLE_USE` (agent execution, highest scrutiny)

This means the *shape of the API itself* encodes security policy.

---

## Part IV: The Bridge as the Login Shell

### [BLOG CANDIDATE] How the Zulip Bridge Proves the Model

The DollhouseBridge — specifically the Zulip integration — is the clearest demonstration of persona-based security in action. It's the equivalent of a login shell in the OS metaphor.

In a live production test (March 14, 2026), the bridge exercised all four layers of the permission system:

**Layer 1 — Static Classification**: `cat package.json` was classified as safe (`cat *` matches safe bash patterns) and allowed. No LLM evaluation needed.

**Layer 2 — Dangerous Pattern Denial**: `npm install some-package` was denied at static classification. The dangerous bash pattern `npm install *` matched. The LLM was never consulted — the denial happened mechanically.

**Layer 3 — MCP Tools through Gatekeeper**: `get_build_info` via `mcp_aql_read` flowed through the permission prompt (Layer 1 allowed it) and the Gatekeeper (Layer 2 allows read operations). Succeeded correctly.

**Layer 4 — Policy File Verification**: The bridge session read the exported policy file at `~/.dollhouse/bridge/imports/policies/dollhousemcp-crude-policies.json` and confirmed:
- Source: DollhouseMCP-V2-Refactor CRUDE v2.0.0-beta.3
- 15 safe tools, 61 safe bash patterns, 71 dangerous patterns, 5 blocked patterns
- 5 active element policies from the `zulip-chat-bridge` ensemble
- Risk scores: safe=0, moderate=40, dangerous=80, blocked=100

The full loop: DollhouseMCP exported → bridge imported → permission-prompt server evaluated → correct allow/deny decisions at each tier.

### The Remote Approval Pattern

When an agent running through the Zulip bridge hits a gatekeeper block (e.g., `execute_agent` requires `CONFIRM_SINGLE_USE`):

1. The approval request bubbles up through the agentic loop
2. The Zulip integration surfaces the request to the human operator as a message
3. The operator approves or denies remotely
4. The decision flows back through `confirm_operation` to unblock execution

This is `sudo` for AI agents — with the approval happening in a chat interface instead of a terminal.

---

## Part V: Temporary Privilege Escalation

### [BLOG CANDIDATE] Escalate, Execute, Revert

One of the most powerful patterns that persona-based security enables is temporary privilege escalation with automatic reversion.

Consider a deployment agent that needs broad filesystem access for exactly one operation:

1. The agent is running under a locked-down persona with access only to `src/`
2. A deployment step requires writing to `infrastructure/` and running `docker compose`
3. The agent requests privilege escalation via the gatekeeper
4. A human approves (or a policy auto-approves for known deployment patterns)
5. A more permissive persona activates temporarily — the permission surface expands
6. The deployment operation executes under audit
7. The permissive persona deactivates — permissions revert to locked-down
8. The audit trail records the entire escalation: who requested it, who approved it, what happened during the elevated window, and when it reverted

With auditable trails and proper logging, you can prevent persistent escalation while still allowing elevated privileges under specific, time-bounded circumstances. The key insight: the escalation is not about the *user* — it's about the *persona*. And personas can be programmatically activated and deactivated.

---

## Part VI: Known Gaps and Future Work

Using traditional OS security as a rubric reveals gaps that become clear issue candidates:

### Identity Visibility
In Unix, the shell prompt shows `user@host`. DollhouseMCP needs the equivalent:
- Status line showing active persona name in Claude Code
- Message prefix in Zulip showing which persona generated the response
- Transition announcements when persona swaps happen mid-session

### Privilege Escalation Controls
The Gatekeeper handles operation-level confirmation, but:
- Can a persona activate a more permissive persona? That's `su` without a password.
- Should certain persona transitions require confirmation?
- Should there be a "root" persona that requires explicit approval to activate?

### Separation of Duties
- Can we guarantee that Persona A and Persona B never run simultaneously?
- Mutex personas: "if `code-reviewer` is active, `code-writer` cannot be"
- This is like Unix's `nologin` shell but for persona combinations

### Least Privilege Validation
- Can we detect when a persona has more permissions than its instructions require?
- Static analysis: parse the persona's instructions, identify which tools it references, flag `allow` patterns that grant tools it never mentions

### Audit Trail Depth
- Log every `activate_element` / `deactivate_element` with timestamp and session
- Track which persona was active when each tool call was made
- Queryable history: "what did Persona X do between T1 and T2?"

---

## Part VII: The Comparison Table

| Aspect | Pasted Text | DollhouseMCP Runtime |
|--------|-------------|---------------------|
| **Identity** | None — the LLM is always "itself" | Active persona is a security principal with permissions |
| **Permissions** | Suggestions the LLM can ignore | Server-enforced gates the LLM cannot bypass |
| **Permission changes** | Manual text swap | Dynamic activation/deactivation reshapes security surface |
| **Composition** | Static, one profile per conversation | Ensembles with conflict resolution and activation strategies |
| **Cross-system** | Lives in one context window | Policies propagate to bridge, permission system, CLI |
| **State** | Lost when conversation ends | Persists across sessions, survives restarts |
| **Escalation** | N/A | Temporary, auditable, automatically reverted |
| **Validation** | LLM takes input at face value | Server-side sanitization, schema enforcement, injection prevention |
| **Safety** | Hope the LLM follows instructions | Automatic backups, atomic writes, danger zone blocks |
| **Discovery** | LLM guesses available operations | Runtime introspection from authoritative schemas |
| **Distribution** | Copy-paste text | Portfolio system with validated permission profiles |
| **Audit** | None | Security monitor, query_logs, session accounting |

---

## The Bottom Line

When someone says "it's just markdown" — they're right about the format and wrong about the value.

The markdown is human-readable by design. That's a feature: elements are portable, inspectable, version-controllable, and editable by anyone. You *can* paste them into a clean LLM session and get useful results.

But the MCP server treats those files as security principals. When you activate a persona, you're logging in. When you activate an ensemble, you're joining a group. When the gatekeeper blocks an operation, that's access control. When the bridge exports policies, that's policy federation.

The prompt is the identity. The server enforces the permissions. That's the difference between reading a user manual and having an operating system.

**The term for what we've built: Agentic Capability Surface Management.** Nobody else is using that term yet — because nobody else has built this yet.
