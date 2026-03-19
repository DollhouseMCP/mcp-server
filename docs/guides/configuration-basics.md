# Configuration Basics for DollhouseMCP

**Goal:** Understand how server settings are stored, how to inspect or change them with MCP tools, and where those settings live on disk.

---

## 1. Where Configuration Lives

| Location | Purpose |
|----------|---------|
| `~/.dollhouse/config.yml` | Primary configuration file created by `ConfigManager` the first time you run the server or the setup wizard. |
| `~/.dollhouse/config.yml.backup` | Automatic backup taken before each write so you can recover from a bad edit. |
| `~/.dollhouse/` (directory) | Also stores OAuth helper state and logs (`.auth/`, `oauth-helper.log`). |

Configuration is YAML-based. Manual edits are allowed, but using the `dollhouse_config` MCP tool keeps validation and backups automatic.

---

## 2. Run the Setup Wizard

The wizard populates the most common fields (GitHub auth, portfolio defaults, sync preferences):

```bash
dollhouse_config action="wizard"
```

You can rerun the wizard at any time—existing values are shown and you can press Enter to keep them.

---

## 3. Inspect Settings

### View Everything
```bash
dollhouse_config action="get"
```

### View a Specific Setting
Dot notation drills into the YAML structure:
```bash
dollhouse_config action="get" setting="github.portfolio.repository_name"
dollhouse_config action="get" setting="sync.bulk.upload_enabled"
```

---

## 4. Update Settings Safely

Set individual values without editing the file manually:
```bash
dollhouse_config action="set" \
  setting="github.portfolio.repository_name" \
  value="dollhouse-portfolio"

dollhouse_config action="set" \
  setting="sync.enabled" \
  value=true
```

- Strings, booleans, numbers, and JSON/YAML objects are accepted in `value`.
- Each update writes a new `config.yml` and refreshes the backup.

---

## 5. Reset, Export, Import

- **Reset an entire section**
  ```bash
  dollhouse_config action="reset" section="sync"
  ```

- **Export your configuration**
  ```bash
  dollhouse_config action="export" format="yaml"
  ```

- **Import a saved configuration**
  ```bash
  dollhouse_config action="import" data="$(cat config-backup.yaml)"
  ```

Exports are useful for sharing team presets or backing up before major changes.

---

## 6. Portfolio-Specific Shortcuts

Some frequently toggled options also have a dedicated helper:

```bash
portfolio_config auto_sync=true
portfolio_config auto_submit=false
portfolio_config default_visibility="private"
```

These commands ultimately write to the same `github` and `collection` sections in `config.yml`, so you can mix and match with `dollhouse_config`.

---

## 7. Manual Editing Tips

If you edit `~/.dollhouse/config.yml` directly:
- Keep valid YAML (spaces, not tabs; quotes around special characters).
- After saving, you can confirm the server sees your changes with:
  ```bash
  dollhouse_config action="get" setting="elements.enhanced_index.enabled"
  ```
- If something goes wrong, restore the backup:
  ```bash
  cp ~/.dollhouse/config.yml.backup ~/.dollhouse/config.yml
  ```

---

## 8. What’s Configurable?

Key sections you’ll see in the file:

| Section | Controls |
|---------|----------|
| `user` | Display name used for new personas/elements. |
| `github` | Portfolio repository name, OAuth mode, auto-create behavior. |
| `sync` | Whether bulk/individual sync is enabled, preview requirements, privacy scanning. |
| `collection` | Auto-submit defaults, attribution flags. |
| `elements` | Portfolio directory path, Enhanced Index tuning (trigger limits, telemetry). |
| `display` | Persona indicator style, verbose logging, progress indicators. |
| `wizard` | Tracks completion state so the wizard knows whether to prompt you again. |

Each of these sections is accessible with `dollhouse_config action="get"` and adjustable via `action="set"`.

---

## 9. Troubleshooting

- **“Config file not found”** – Run the wizard once: `dollhouse_config action="wizard"`.
- **“Invalid value” errors** – Ensure boolean values are literal `true`/`false` and objects are valid JSON/YAML.
- **Need to start over** – Rename the file and rerun the wizard:
  ```bash
  mv ~/.dollhouse/config.yml ~/.dollhouse/config.yml.old
  dollhouse_config action="wizard"
  ```

---

### Next Steps
- Configure your portfolio repository with `init_portfolio` and `portfolio_status`.
- Explore more configuration options in `docs/architecture/capability-index-system.md` (Enhanced Index tuning) and `docs/architecture/persona-state-lifecycle.md` (indicator settings).
