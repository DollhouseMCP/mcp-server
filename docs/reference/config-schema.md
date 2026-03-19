# Configuration Schema (`~/.dollhouse/config.yml`)

The configuration wizard (`dollhouse_config action="wizard"`) creates and maintains `~/.dollhouse/config.yml`. This document describes each section, key fields, defaults, and how they interplay with environment variables.

> ⚠️ When editing by hand, keep valid YAML spacing and run `dollhouse_config action="get"` afterwards to confirm the file parses.

---

## Top-Level Structure

```yaml
version: "1.0.0"
user:
  username: null
  email: null
  display_name: null
autoLoad:
  enabled: true
  maxTokenBudget: 5000
  memories: []
github:
  portfolio:
    repository_url: null
    repository_name: dollhouse-portfolio
    default_branch: main
    auto_create: true
  auth:
    use_oauth: true
    token_source: environment
    client_id: null
sync:
  enabled: false
  individual:
    require_confirmation: true
    show_diff_before_sync: true
    track_versions: true
    keep_history: 10
  bulk:
    upload_enabled: false
    download_enabled: false
    require_preview: true
    respect_local_only: true
  privacy:
    scan_for_secrets: true
    scan_for_pii: true
    warn_on_sensitive: true
    excluded_patterns: ["*.secret", "*-private.*", "credentials/**", "personal/**"]
collection:
  auto_submit: false
  require_review: true
  add_attribution: true
elements:
  auto_activate: {}
  default_element_dir: /Users/<user>/.dollhouse/portfolio
  enhanced_index:
    enabled: true
    limits:
      maxTriggersPerElement: 50
      maxTriggerLength: 50
      maxKeywordsToCheck: 100
    telemetry:
      enabled: false
      sampleRate: 0.1
      metricsInterval: 60000
display:
  persona_indicators:
    enabled: true
    style: minimal
    include_emoji: true
  verbose_logging: false
  show_progress: true
wizard:
  completed: false
  dismissed: false
  completedAt: null
  version: null
```

---

## Section Details

### `user`
- Populated when you provide attribution information during the wizard.
- Used for default author metadata when creating new elements.

### `autoLoad` (v1.9.25+)
- **New feature**: Automatically load memories on server startup to provide baseline knowledge.
- `enabled` – master switch for auto-load feature (default `true`).
- `maxTokenBudget` – maximum tokens for auto-loaded memories (default `5000`).
- `memories` – array of specific memory names to load. If empty (default), uses memories marked with `autoLoad: true` in their metadata.
- Like CLAUDE.md for Claude Code, this provides immediate context without expensive searches.
- Example use cases: DollhouseMCP baseline knowledge, team onboarding docs, project context for agents.

### `github.portfolio`
- `repository_name` – default for `init_portfolio`. Environment override: `TEST_GITHUB_REPO` (tests only).
- `auto_create` – if true, `init_portfolio` will create the repo when absent.
- `default_branch` – where uploads occur (`main` by default).

### `github.auth`
- `use_oauth` – whether the server uses OAuth device flow (default `true`).
- `token_source` – `environment` or `oauth`. Typically leave as `environment`; OAuth flow stores tokens under `~/.dollhouse/.auth/`.
- `client_id` – custom GitHub OAuth client ID. If unset, the bundled client is used unless `DOLLHOUSE_GITHUB_CLIENT_ID` is set.

### `sync`
- `enabled` – master switch for portfolio syncing.
- `individual` – behavior for single-element operations (`portfolio_element_manager`).
- `bulk` – settings for `sync_portfolio` (dir sync). Respect `require_preview` to prevent accidental overwrites.
- `privacy` – scanning options before uploads (secrets, PII). Works in tandem with `portfolio_element_manager` and `submit_collection_content`.

### `collection`
- `auto_submit` – if true, successful uploads via `submit_collection_content` automatically file collection issues.
- `require_review` – default flag for submission checklists.
- `add_attribution` – include metadata about the author in submissions.

### `elements`
- `auto_activate` – optional arrays telling the server which elements to auto-activate on startup (keys: `personas`, `skills`, etc.).
- `default_element_dir` – base path for local elements. Controlled by the wizard or `DOLLHOUSE_PORTFOLIO_DIR`.
- `enhanced_index` – tuning for the capability index:
  - `enabled` – disable if you want a lightweight server without semantic search.
  - `limits` – trigger extraction thresholds.
  - `telemetry` – future use for usage telemetry (disabled by default).

### `display`
- `persona_indicators` – toggles and styles for the active persona banner.
- `verbose_logging`, `show_progress` – adjust console output verbosity.

### `wizard`
- Records wizard completion state. The wizard uses this to decide whether to prompt again.

---

## Managing the File

### Inspect settings
```bash
dollhouse_config action="get"
dollhouse_config action="get" setting="github.portfolio.repository_name"
```

### Update a value
```bash
dollhouse_config action="set" \
  setting="sync.enabled" \
  value=true
```

### Reset a section
```bash
dollhouse_config action="reset" section="sync"
```

### Export/import
```bash
dollhouse_config action="export" format="yaml"
dollhouse_config action="import" data="$(cat config-backup.yaml)"
```

Environment variables generally override config values. Run `env | grep DOLLHOUSE` if behavior doesn’t match the file.

---

## Tips

- Prefer the wizard or `dollhouse_config` for routine changes; reserve manual edits for batch operations or scripting.
- After manual edits, validate the file with `dollhouse_config action="get"` to ensure there are no syntax errors.
- Keep backups (`config.yml.backup` is created automatically before writes). You can restore the backup if needed:
  ```bash
  cp ~/.dollhouse/config.yml.backup ~/.dollhouse/config.yml
  ```

Keep this schema updated as new configuration keys are introduced.***
