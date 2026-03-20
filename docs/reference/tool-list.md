# MCP Tool → Module Map

**Last Updated:** November 7, 2025

Use this table to quickly find where each MCP tool is defined. Tool registration happens in `src/server/tools/*.ts`, with behavior implemented in the corresponding handler under `src/handlers`.

> 📌 Always run `npm run inspector` or `list_tools` in your client to confirm the live toolset. This table is a convenience reference for navigating the codebase.

## Current Tools (40 Active Tools)

The table below lists **40 active MCP tools**. These are the current, recommended tools for all use cases.

| Tool | Module | Primary Handler |
|------|--------|-----------------|
| `setup_github_auth` | `AuthTools.ts` | `GitHubAuthHandler` |
| `check_github_auth` | `AuthTools.ts` | `GitHubAuthHandler` |
| `clear_github_auth` | `AuthTools.ts` | `GitHubAuthHandler` |
| `configure_oauth` | `AuthTools.ts` | `GitHubAuthHandler` |
| `oauth_helper_status` | `AuthTools.ts` | `GitHubAuthHandler` |
| `browse_collection` | `CollectionTools.ts` | `CollectionHandler` |
| `search_collection` | `CollectionTools.ts` | `CollectionHandler` |
| `search_collection_enhanced` | `CollectionTools.ts` | `CollectionHandler` |
| `get_collection_content` | `CollectionTools.ts` | `CollectionHandler` |
| `install_collection_content` | `CollectionTools.ts` | `CollectionHandler` |
| `submit_collection_content` | `CollectionTools.ts` | `CollectionHandler` |
| `get_collection_cache_health` | `CollectionTools.ts` | `CollectionHandler` |
| `dollhouse_config` | `ConfigToolsV2.ts` | `ConfigHandler` |
| `portfolio_element_manager` | `ConfigToolsV2.ts` | `SyncHandlerV2` |
| `list_elements` | `ElementTools.ts` | `ElementCRUDHandler` |
| `activate_element` | `ElementTools.ts` | `ElementCRUDHandler` (supports ensembles) |
| `get_active_elements` | `ElementTools.ts` | `ElementCRUDHandler` |
| `deactivate_element` | `ElementTools.ts` | `ElementCRUDHandler` |
| `get_element_details` | `ElementTools.ts` | `ElementCRUDHandler` |
| `reload_elements` | `ElementTools.ts` | `ElementCRUDHandler` |
| `render_template` | `ElementTools.ts` | `ElementCRUDHandler` (templates) |
| `execute_agent` | `ElementTools.ts` | `ElementCRUDHandler` (agents) |
| `create_element` | `ElementTools.ts` | `ElementCRUDHandler` |
| `edit_element` | `ElementTools.ts` | `ElementCRUDHandler` |
| `validate_element` | `ElementTools.ts` | `ElementCRUDHandler` |
| `delete_element` | `ElementTools.ts` | `ElementCRUDHandler` |
| `find_similar_elements` | `EnhancedIndexTools.ts` | `EnhancedIndexHandler` |
| `get_element_relationships` | `EnhancedIndexTools.ts` | `EnhancedIndexHandler` |
| `search_by_verb` | `EnhancedIndexTools.ts` | `EnhancedIndexHandler` |
| `get_relationship_stats` | `EnhancedIndexTools.ts` | `EnhancedIndexHandler` |
| `import_persona` | `PersonaTools.ts` | `PersonaHandler` |
| `portfolio_status` | `PortfolioTools.ts` | `PortfolioHandler` |
| `init_portfolio` | `PortfolioTools.ts` | `PortfolioHandler` |
| `portfolio_config` | `PortfolioTools.ts` | `PortfolioHandler` |
| `sync_portfolio` | `PortfolioTools.ts` | `SyncHandlerV2` |
| `search_portfolio` | `PortfolioTools.ts` | `PortfolioHandler` |
| `search_all` | `PortfolioTools.ts` | `PortfolioHandler` |
| `get_build_info` | `BuildInfoTools.ts` | `BuildInfoService` (via handler bundle) |

## Deprecated Tools (7 Legacy Tools)

The following tools are **deprecated** and will be removed in v2.0.0. They are still available for backwards compatibility but should not be used in new code:

| Deprecated Tool | Replacement | Module |
|----------------|-------------|--------|
| `set_user_identity` | `dollhouse_config` with `action="set"` and `setting="user.username"` | `UserTools.ts` |
| `get_user_identity` | `dollhouse_config` with `action="get"` and `setting="user"` | `UserTools.ts` |
| `clear_user_identity` | `dollhouse_config` with `action="reset"` and `section="user"` | `UserTools.ts` |
| `configure_indicator` | `dollhouse_config` with display settings | `ConfigTools.ts` |
| `get_indicator_config` | `dollhouse_config` with `action="get"` | `ConfigTools.ts` |
| `configure_collection_submission` | `dollhouse_config` with submission settings | `ConfigTools.ts` |
| `get_collection_submission_config` | `dollhouse_config` with `action="get"` | `ConfigTools.ts` |

See [Migration Guide](../guides/migration-from-legacy-tools.md) for detailed migration instructions.

---

**Total Tools:** 47 (40 active + 7 deprecated)

If you add a new tool, update this table and the inspector docs to keep navigation simple.
