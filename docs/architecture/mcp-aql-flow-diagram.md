# MCP-AQL Tool Call Flow Diagram

This document provides a comprehensive visual reference for the entire MCP-AQL request lifecycle in the DollhouseMCP server. It covers:

- The **5 CRUDE MCP tool entry points** (Create, Read, Update, Delete, Execute)
- All **56 operations** mapped to their endpoints and handler modules
- The **4-layer Gatekeeper enforcement pipeline** (route validation, element policies, session confirmations, default policies)
- The **confirm_operation** and **verify_challenge** sub-flows
- The **dispatch routing** from handler references to concrete handler modules
- **Permission levels** and decision outcomes at each stage

## Key Concepts

| Concept | Description |
|---------|-------------|
| **CRUDE** | CRUD + Execute -- the 5 endpoint categories |
| **Operation** | A named action (e.g., `create_element`) mapped to an endpoint and handler |
| **Handler Reference** | A `Module.method` string (e.g., `ElementCRUD.create`) resolved at dispatch time |
| **Gatekeeper** | The 4-layer policy engine that enforces access control before dispatch |
| **Permission Level** | `AUTO_APPROVE`, `CONFIRM_SESSION`, `CONFIRM_SINGLE_USE`, or `DENY` |

## Flow Diagram

```mermaid
flowchart TD
    classDef entryPoint fill:#4A90D9,color:#fff,stroke:#2C5F8A,stroke-width:2px
    classDef operation fill:#E8E8E8,color:#333,stroke:#999
    classDef decision fill:#FFD700,color:#333,stroke:#B8960F,stroke-width:2px
    classDef allowed fill:#5CB85C,color:#fff,stroke:#3D8B3D,stroke-width:2px
    classDef denied fill:#D9534F,color:#fff,stroke:#A94442,stroke-width:2px
    classDef pending fill:#F0AD4E,color:#333,stroke:#C89B3C,stroke-width:2px
    classDef handler fill:#6C5CE7,color:#fff,stroke:#4834C7
    classDef layer fill:#17A2B8,color:#fff,stroke:#117A8B,stroke-width:2px

    %% ================================================================
    %% MCP TOOL ENTRY POINTS
    %% ================================================================
    subgraph ENTRY["MCP Tool Entry Points (5 CRUDE Endpoints)"]
        direction LR
        CREATE([mcp_aql_create]):::entryPoint
        READ([mcp_aql_read]):::entryPoint
        UPDATE([mcp_aql_update]):::entryPoint
        DELETE([mcp_aql_delete]):::entryPoint
        EXECUTE([mcp_aql_execute]):::entryPoint
    end

    %% ================================================================
    %% OPERATIONS BY ENDPOINT
    %% ================================================================
    subgraph CREATE_OPS["CREATE Operations (13)"]
        direction LR
        c1["create_element<br/><i>CONFIRM_SESSION</i>"]:::operation
        c2["import_element<br/><i>CONFIRM_SESSION</i>"]:::operation
        c3["addEntry<br/><i>CONFIRM_SESSION</i>"]:::operation
        c4["activate_element<br/><i>CONFIRM_SESSION</i>"]:::operation
        c5["verify_challenge<br/><i>AUTO_APPROVE</i>"]:::operation
        c6["install_collection_content<br/><i>CONFIRM_SESSION</i>"]:::operation
        c7["submit_collection_content<br/><i>CONFIRM_SESSION</i>"]:::operation
        c8["init_portfolio<br/><i>CONFIRM_SESSION</i>"]:::operation
        c9["sync_portfolio<br/><i>CONFIRM_SESSION</i>"]:::operation
        c10["portfolio_element_manager<br/><i>CONFIRM_SESSION</i>"]:::operation
        c11["setup_github_auth<br/><i>CONFIRM_SESSION</i>"]:::operation
        c12["configure_oauth<br/><i>CONFIRM_SESSION</i>"]:::operation
        c13["import_persona<br/><i>CONFIRM_SESSION</i>"]:::operation
    end

    subgraph READ_OPS["READ Operations (29)"]
        direction LR
        r1["list_elements"]:::operation
        r2["get_element"]:::operation
        r3["get_element_details"]:::operation
        r4["search_elements"]:::operation
        r5["query_elements"]:::operation
        r6["get_active_elements"]:::operation
        r7["validate_element"]:::operation
        r8["render"]:::operation
        r9["export_element"]:::operation
        r10["deactivate_element<br/><i>CONFIRM_SESSION</i>"]:::operation
        r11["introspect"]:::operation
        r12["search"]:::operation
        r13["browse_collection"]:::operation
        r14["search_collection"]:::operation
        r15["search_collection_enhanced"]:::operation
        r16["get_collection_content"]:::operation
        r17["get_collection_cache_health"]:::operation
        r18["portfolio_status"]:::operation
        r19["portfolio_config"]:::operation
        r20["search_portfolio"]:::operation
        r21["search_all"]:::operation
        r22["check_github_auth"]:::operation
        r23["oauth_helper_status"]:::operation
        r24["dollhouse_config"]:::operation
        r25["get_build_info"]:::operation
        r26["find_similar_elements"]:::operation
        r27["get_element_relationships"]:::operation
        r28["search_by_verb"]:::operation
        r29["get_relationship_stats"]:::operation
    end

    subgraph UPDATE_OPS["UPDATE Operations (1)"]
        u1["edit_element<br/><i>CONFIRM_SINGLE_USE</i>"]:::operation
    end

    subgraph DELETE_OPS["DELETE Operations (3)"]
        direction LR
        d1["delete_element<br/><i>CONFIRM_SINGLE_USE</i>"]:::operation
        d2["clear<br/><i>CONFIRM_SINGLE_USE</i>"]:::operation
        d3["clear_github_auth<br/><i>CONFIRM_SINGLE_USE</i>"]:::operation
    end

    subgraph EXECUTE_OPS["EXECUTE Operations (10)"]
        direction LR
        e1["execute_agent<br/><i>CONFIRM_SINGLE_USE</i>"]:::operation
        e2["get_execution_state<br/><i>AUTO_APPROVE</i>"]:::operation
        e3["record_execution_step<br/><i>CONFIRM_SESSION</i>"]:::operation
        e4["complete_execution<br/><i>CONFIRM_SESSION</i>"]:::operation
        e5["continue_execution<br/><i>CONFIRM_SESSION</i>"]:::operation
        e6["abort_execution<br/><i>CONFIRM_SINGLE_USE</i>"]:::operation
        e7["get_gathered_data<br/><i>AUTO_APPROVE</i>"]:::operation
        e8["prepare_handoff<br/><i>CONFIRM_SESSION</i>"]:::operation
        e9["resume_from_handoff<br/><i>CONFIRM_SINGLE_USE</i>"]:::operation
        e10["confirm_operation<br/><i>AUTO_APPROVE</i>"]:::operation
    end

    %% Connect entry points to operation groups
    CREATE --> CREATE_OPS
    READ --> READ_OPS
    UPDATE --> UPDATE_OPS
    DELETE --> DELETE_OPS
    EXECUTE --> EXECUTE_OPS

    %% ================================================================
    %% UNIFIED EXECUTION PATH
    %% ================================================================
    CREATE_OPS --> PARSE
    READ_OPS --> PARSE
    UPDATE_OPS --> PARSE
    DELETE_OPS --> PARSE
    EXECUTE_OPS --> PARSE

    PARSE["Step 1: parseOperationInput()<br/>Validate + normalize input structure"]

    PARSE --> GK_CHECK{"Gatekeeper<br/>enabled?<br/>(env var)"}

    GK_CHECK -- "Yes" --> GATEKEEPER
    GK_CHECK -- "No" --> ROUTE_ONLY["Route validation only<br/>(Gatekeeper.validate static)"]
    ROUTE_ONLY --> ROUTE

    %% ================================================================
    %% GATEKEEPER 4-LAYER PIPELINE
    %% ================================================================
    subgraph GATEKEEPER["Gatekeeper.enforce() -- 4-Layer Pipeline"]
        direction TB

        L1["Layer 1: Route Validation<br/>Operation exists? Correct endpoint?"]:::layer
        L1 --> L1_D{"Valid<br/>route?"}
        L1_D -- "No: unknown op" --> L1_DENY["DENY<br/>UNKNOWN_OPERATION"]:::denied
        L1_D -- "No: wrong endpoint" --> L1_MISMATCH["DENY<br/>ENDPOINT_MISMATCH<br/>Suggests correct endpoint"]:::denied
        L1_D -- "Yes" --> L2

        L2["Layer 2: Element Policy Resolution<br/>Check active personas/skills/agents/ensembles"]:::layer
        L2 --> L2_SCAN["For each active element with<br/>metadata.gatekeeper policy:"]
        L2_SCAN --> L2_DENY_CHECK{"Operation in<br/>deny list?"}
        L2_DENY_CHECK -- "Yes" --> L2_DENY["DENY<br/>ELEMENT_POLICY_VIOLATION"]:::denied
        L2_DENY_CHECK -- "No" --> L2_SCOPE{"Scope<br/>restriction<br/>violated?"}
        L2_SCOPE -- "Yes (all elements block)" --> L2_SCOPE_DENY["DENY<br/>SCOPE_RESTRICTION"]:::denied
        L2_SCOPE -- "No" --> L2_CONFIRM{"Operation in<br/>confirm list?"}
        L2_CONFIRM -- "Yes" --> L2_SET_CONFIRM["Set level to<br/>CONFIRM_SESSION"]
        L2_CONFIRM -- "No" --> L2_ALLOW{"Operation in<br/>allow list?"}
        L2_ALLOW -- "Yes + canBeElevated" --> L2_SET_AUTO["Set level to<br/>AUTO_APPROVE"]
        L2_ALLOW -- "No" --> L2_DEFAULT["Keep default<br/>permission level"]
        L2_SET_CONFIRM --> L3
        L2_SET_AUTO --> L3
        L2_DEFAULT --> L3

        L3["Layer 3: Session Confirmation Check<br/>Check GatekeeperSession cache"]:::layer
        L3 --> L3_D{"Session has<br/>confirmation<br/>for op?"}
        L3_D -- "Yes" --> L3_ALLOW["ALLOWED<br/>via session confirmation"]:::allowed
        L3_D -- "No" --> L4

        L4["Layer 4: Apply Resolved Policy"]:::layer
        L4 --> L4_D{"Permission<br/>level?"}
        L4_D -- "AUTO_APPROVE" --> L4_ALLOW["ALLOWED<br/>auto-approved"]:::allowed
        L4_D -- "CONFIRM_SESSION" --> L4_PENDING["confirmationPending: true<br/>Requires user approval"]:::pending
        L4_D -- "CONFIRM_SINGLE_USE" --> L4_PENDING
        L4_D -- "DENY" --> L4_DENY["DENIED<br/>blocked by policy"]:::denied
    end

    %% ================================================================
    %% DECISION OUTCOMES
    %% ================================================================
    L4_ALLOW --> ROUTE
    L3_ALLOW --> ROUTE
    L4_PENDING --> CONFIRM_RESPONSE["Return failure with guidance:<br/>Use confirm_operation to approve,<br/>then retry"]:::pending
    L4_DENY --> HARD_DENY["Throw Error:<br/>[Gatekeeper] reason"]:::denied

    %% ================================================================
    %% CONFIRM_OPERATION SUB-FLOW
    %% ================================================================
    subgraph CONFIRM_FLOW["confirm_operation Sub-Flow"]
        direction TB
        CF_START["LLM calls confirm_operation<br/>params: { operation, element_type? }"]
        CF_START --> CF_ENFORCE["Re-run gatekeeper.enforce()<br/>for the target operation"]
        CF_ENFORCE --> CF_DECISION{"Decision?"}
        CF_DECISION -- "Already allowed" --> CF_NOOP["Return: already approved,<br/>no confirmation needed"]:::allowed
        CF_DECISION -- "confirmationPending" --> CF_RECORD["Record confirmation<br/>in GatekeeperSession"]
        CF_DECISION -- "Hard deny" --> CF_REJECT["Throw: operation denied<br/>by policy, cannot confirm"]:::denied
        CF_RECORD --> CF_LEVEL{"Permission<br/>level?"}
        CF_LEVEL -- "CONFIRM_SESSION" --> CF_SESSION["Session-wide approval<br/>Auto-approve for rest of session"]:::allowed
        CF_LEVEL -- "CONFIRM_SINGLE_USE" --> CF_SINGLE["Single-use approval<br/>Consumed on next check"]:::allowed
        CF_SESSION --> CF_DONE["Return: confirmed,<br/>retry the operation"]
        CF_SINGLE --> CF_DONE
    end

    CONFIRM_RESPONSE -.-> CF_START

    %% ================================================================
    %% VERIFY_CHALLENGE SUB-FLOW (Danger Zone)
    %% ================================================================
    subgraph VERIFY_FLOW["verify_challenge Sub-Flow (Danger Zone)"]
        direction TB
        VF_START["LLM calls verify_challenge<br/>params: { challenge_id, code }"]
        VF_START --> VF_RATE{"Rate limit<br/>exceeded?<br/>(10 fails/60s)"}
        VF_RATE -- "Yes" --> VF_RATE_DENY["Throw: too many failed attempts"]:::denied
        VF_RATE -- "No" --> VF_UUID{"UUID v4<br/>format<br/>valid?"}
        VF_UUID -- "No" --> VF_FORMAT_DENY["Throw: invalid challenge_id format"]:::denied
        VF_UUID -- "Yes" --> VF_STORE{"Challenge<br/>exists in<br/>store?"}
        VF_STORE -- "No (expired/used/invalid)" --> VF_EXPIRED["Throw: challenge not found<br/>Retry blocked op for new code"]:::denied
        VF_STORE -- "Yes" --> VF_CODE{"Code<br/>correct?"}
        VF_CODE -- "No" --> VF_WRONG["Throw: incorrect code<br/>Code consumed (one-time use)"]:::denied
        VF_CODE -- "Yes" --> VF_UNBLOCK["Find blocked agent<br/>by challengeId"]
        VF_UNBLOCK --> VF_AGENT{"Agent<br/>found?"}
        VF_AGENT -- "Yes" --> VF_SUCCESS["Unblock agent via<br/>DangerZoneEnforcer.unblock()<br/>Return: verified + unblocked"]:::allowed
        VF_AGENT -- "No" --> VF_STANDALONE["Return: verified<br/>(standalone verification)"]:::allowed
    end

    %% ================================================================
    %% ROUTE + DISPATCH
    %% ================================================================
    ROUTE["Step 3: getRoute(operation)<br/>Resolve handler reference<br/>(Module.method string)"]

    ROUTE --> SCHEMA_CHECK{"SchemaDispatcher<br/>canDispatch?"}
    SCHEMA_CHECK -- "Yes" --> SCHEMA_DISPATCH["SchemaDispatcher.dispatch()<br/>Declarative, auto-validated"]:::handler
    SCHEMA_CHECK -- "No" --> MODULE_SPLIT["Split handler ref:<br/>Module.method"]

    %% ================================================================
    %% HANDLER MODULE ROUTING
    %% ================================================================
    subgraph DISPATCH["Handler Module Dispatch"]
        direction TB
        MODULE_SPLIT --> MOD_DECISION{"Module?"}

        MOD_DECISION -- "ElementCRUD" --> H_CRUD["dispatchElementCRUD()<br/>create, list, get, getDetails,<br/>edit, validate, delete,<br/>import, export"]:::handler

        MOD_DECISION -- "Memory" --> H_MEM["dispatchMemory()<br/>addEntry, clear"]:::handler

        MOD_DECISION -- "Template" --> H_TPL["dispatchTemplate()<br/>render"]:::handler

        MOD_DECISION -- "Activation" --> H_ACT["dispatchActivation()<br/>activate, deactivate,<br/>getActive"]:::handler

        MOD_DECISION -- "Search" --> H_SEARCH["dispatchSearch()<br/>search, query"]:::handler

        MOD_DECISION -- "Introspection" --> H_INTRO["dispatchIntrospection()<br/>resolve"]:::handler

        MOD_DECISION -- "Collection" --> H_COLL["dispatchCollection()<br/>browse, search, searchEnhanced,<br/>getContent, getCacheHealth,<br/>install, submit"]:::handler

        MOD_DECISION -- "Portfolio" --> H_PORT["dispatchPortfolio()<br/>status, config, search,<br/>searchAll, init, sync,<br/>elementManager"]:::handler

        MOD_DECISION -- "Auth" --> H_AUTH["dispatchAuth()<br/>setup, check, clear,<br/>configureOAuth,<br/>oauthHelperStatus"]:::handler

        MOD_DECISION -- "Config" --> H_CONF["dispatchConfig()<br/>manage, getBuildInfo"]:::handler

        MOD_DECISION -- "EnhancedIndex" --> H_IDX["dispatchEnhancedIndex()<br/>findSimilar, getRelationships,<br/>searchByVerb, getStats"]:::handler

        MOD_DECISION -- "Persona" --> H_PERSONA["dispatchPersona()<br/>import"]:::handler

        MOD_DECISION -- "Execute" --> H_EXEC["dispatchExecute()<br/>execute, getState, updateState,<br/>complete, continue, abort,<br/>getGatheredData, prepareHandoff,<br/>resumeFromHandoff"]:::handler

        MOD_DECISION -- "Gatekeeper" --> H_GK["dispatchGatekeeper()<br/>confirm, verify"]:::handler
    end

    %% ================================================================
    %% EXECUTE MODULE DETAIL (Agent lifecycle)
    %% ================================================================
    subgraph EXEC_DETAIL["Execute Module Detail"]
        direction TB
        EX_IN["dispatchExecute(method, params)"]
        EX_IN --> EX_DANGER{"DangerZone<br/>check:<br/>agent blocked?"}
        EX_DANGER -- "Yes" --> EX_BLOCKED["Throw: agent blocked<br/>Include verify instructions"]:::denied
        EX_DANGER -- "No" --> EX_ABORT_CHECK{"Goal<br/>aborted?"}
        EX_ABORT_CHECK -- "Yes" --> EX_ABORT_DENY["Throw: execution aborted<br/>Use execute_agent for new run"]:::denied
        EX_ABORT_CHECK -- "No" --> EX_METHOD{"Method?"}
        EX_METHOD -- "execute" --> EX_RUN["AgentManager.executeAgent()<br/>Track in executingAgents Map<br/>for Gatekeeper policy"]
        EX_METHOD -- "getState" --> EX_STATE["AgentManager.getAgentState()"]
        EX_METHOD -- "updateState" --> EX_UPDATE["AgentManager.recordAgentStep()<br/>Returns autonomy directive"]
        EX_METHOD -- "complete" --> EX_COMPLETE["AgentManager.completeAgentGoal()<br/>Remove from executingAgents"]
        EX_METHOD -- "abort" --> EX_ABORT_DO["Mark goals aborted<br/>Clean up executingAgents<br/>Unblock DangerZone"]
    end

    H_EXEC --> EX_IN

    %% ================================================================
    %% RESPONSE
    %% ================================================================
    SCHEMA_DISPATCH --> FIELD_SELECT
    H_CRUD --> FIELD_SELECT
    H_MEM --> FIELD_SELECT
    H_TPL --> FIELD_SELECT
    H_ACT --> FIELD_SELECT
    H_SEARCH --> FIELD_SELECT
    H_INTRO --> FIELD_SELECT
    H_COLL --> FIELD_SELECT
    H_PORT --> FIELD_SELECT
    H_AUTH --> FIELD_SELECT
    H_CONF --> FIELD_SELECT
    H_IDX --> FIELD_SELECT
    H_PERSONA --> FIELD_SELECT

    EX_RUN --> FIELD_SELECT
    EX_STATE --> FIELD_SELECT
    EX_UPDATE --> FIELD_SELECT
    EX_COMPLETE --> FIELD_SELECT
    EX_ABORT_DO --> FIELD_SELECT

    FIELD_SELECT["Step 5: applyFieldSelection()<br/>Transform name to element_name<br/>Apply field filtering"]

    FIELD_SELECT --> RESULT(["OperationResult<br/>{ success, data, _meta }"]):::allowed

    %% ================================================================
    %% ERROR PATH
    %% ================================================================
    L1_DENY --> ERROR_RESULT
    L1_MISMATCH --> ERROR_RESULT
    L2_DENY --> ERROR_RESULT
    L2_SCOPE_DENY --> ERROR_RESULT
    HARD_DENY --> ERROR_RESULT
    EX_BLOCKED --> ERROR_RESULT
    EX_ABORT_DENY --> ERROR_RESULT

    ERROR_RESULT(["OperationFailure<br/>{ success: false, error, _meta }"]):::denied
```

## Permission Level Summary

| Level | Behavior | Example Operations |
|-------|----------|--------------------|
| **AUTO_APPROVE** | Always allowed, no confirmation | All READ ops, `confirm_operation`, `verify_challenge`, `get_execution_state`, `get_gathered_data` |
| **CONFIRM_SESSION** | Confirm once, auto-approve for rest of session | `create_element`, `import_element`, `addEntry`, `activate_element`, `deactivate_element`, `record_execution_step`, `complete_execution` |
| **CONFIRM_SINGLE_USE** | Each invocation requires individual approval | `edit_element`, `delete_element`, `clear`, `execute_agent`, `abort_execution`, `resume_from_handoff`, `clear_github_auth` |
| **DENY** | Never allowed (blocked by element policy) | No operations are DENY by default; only set by active element `deny` lists or scope restrictions |

## Operation Count by Endpoint

| Endpoint | Count | Characteristics |
|----------|-------|-----------------|
| **CREATE** | 13 | Additive, non-destructive |
| **READ** | 29 | Read-only, safe |
| **UPDATE** | 1 | Modifies existing state |
| **DELETE** | 3 | Removes state |
| **EXECUTE** | 10 | Runtime lifecycle, non-idempotent (includes `confirm_operation`) |
| **Total** | **56** | All unique operations across 5 endpoints |

> **Note:** `confirm_operation` is routed through EXECUTE (not CREATE) to prevent auto-approval bypass -- confirming a confirmation would create an infinite loop. `verify_challenge` is routed through CREATE because it creates state (unblocks an agent) but is AUTO_APPROVE to avoid requiring confirmation to verify.

## Gatekeeper Layer Reference

| Layer | Purpose | Failure Mode |
|-------|---------|--------------|
| **Layer 1: Route Validation** | Verify operation exists and matches the called endpoint | `UNKNOWN_OPERATION` or `ENDPOINT_MISMATCH` |
| **Layer 2: Element Policies** | Check active elements' `metadata.gatekeeper` for deny/scope/confirm/allow lists | `ELEMENT_POLICY_VIOLATION` or `SCOPE_RESTRICTION` |
| **Layer 3: Session Confirmations** | Check `GatekeeperSession` for cached approvals (session-wide or single-use) | Falls through to Layer 4 |
| **Layer 4: Default Policies** | Apply the operation's default permission level from `OperationPolicies.ts` | `CONFIRMATION_REQUIRED` or auto-approve |

## Key Source Files

| File | Role |
|------|------|
| `src/handlers/mcp-aql/OperationRouter.ts` | Maps all 56 operations to endpoints and handler references |
| `src/handlers/mcp-aql/MCPAQLHandler.ts` | Unified handler: validate, enforce, route, dispatch, respond |
| `src/handlers/mcp-aql/Gatekeeper.ts` | 4-layer policy engine with audit logging |
| `src/handlers/mcp-aql/GatekeeperSession.ts` | In-memory per-connection session state for confirmations |
| `src/handlers/mcp-aql/GatekeeperTypes.ts` | Permission levels, error codes, policy interfaces |
| `src/handlers/mcp-aql/policies/OperationPolicies.ts` | Default permission levels for all 56 operations |
| `src/handlers/mcp-aql/policies/ElementPolicies.ts` | Element-level policy resolution (deny > scope > confirm > allow) |
| `src/handlers/mcp-aql/policies/AgentToolPolicyTranslator.ts` | Synthesizes Gatekeeper policies from agent `tools` config |
| `src/handlers/mcp-aql/SchemaDispatcher.ts` | Declarative dispatch for schema-driven operations |
