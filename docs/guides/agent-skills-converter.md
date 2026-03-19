# Agent Skills Converter

Convert between the current Agent Skills structure and Dollhouse skill artifacts using MCP-AQL.

## Operation

Use `mcp_aql_read` with operation `convert_skill_format`.

### Agent Skill -> Dollhouse

```json
{
  "operation": "convert_skill_format",
  "params": {
    "direction": "agent_to_dollhouse",
    "agent_skill": {
      "SKILL.md": "---\nname: sample-skill\ndescription: Demo skill\n---\n\nUse this skill for demos.",
      "scripts/": {
        "run.sh": "echo demo"
      },
      "references/": {
        "guide.md": "# Guide\n\nDemo reference"
      },
      "agents/": {
        "openai.yaml": "display_name: Demo Skill"
      }
    }
  }
}
```

Response includes:
- `dollhouse` artifact (`metadata`, `instructions`, `content`)
- `dollhouse_markdown` serialization
- `roundtrip_state` for lossless supported-field reverse conversion
- `report` with machine-readable warnings
- Optional `path_mode`:
  - `safe` (default): allowlisted directories + path safety checks
  - `lossless`: preserve non-allowlisted paths for full-fidelity conversion workflows

### Dollhouse -> Agent Skill

```json
{
  "operation": "convert_skill_format",
  "params": {
    "direction": "dollhouse_to_agent",
    "path_mode": "lossless",
    "dollhouse_markdown": "---\nname: sample-skill\ndescription: Demo skill\ninstructions: Use this skill for demos.\n---\n\nReference content",
    "roundtrip_state": {
      "mappingVersion": "agent-skill-v1",
      "agentSkill": {
        "SKILL.md": "---\nname: sample-skill\ndescription: Demo skill\n---\n\nUse this skill for demos."
      }
    }
  }
}
```

If `roundtrip_state` is valid and `prefer_roundtrip_state` is true (default), conversion restores the preserved Agent Skill structure exactly.

## Mapping Notes

- Required Agent Skill fields:
  - `SKILL.md` with frontmatter `name` and `description`
- Directory allowlist:
  - Allowed agent directories are `scripts/`, `references/`, `assets/`, `agents/`, `binaries/`.
  - Reverse conversion only reconstructs these allowlisted directories.
  - Agent input directories outside this set are remapped into safe references paths:
    - `references/from-agent-dir/<sanitized-directory>/<file>`
- Top-level file mapping:
  - Agent top-level files (other than `SKILL.md`) are emitted under `## Top-level Files`.
  - Block path format is `### top-level/<filename>`.
  - Unsafe top-level names are remapped into:
    - `references/from-agent-top-level/<sanitized-path>`
- Reverse conversion (`dollhouse_to_agent`) reconstructs both directory and top-level files from block paths:
  - `### <directory>/<file>` + fenced block -> `<directory>/[file]`
  - `### top-level/<file>` + fenced block -> top-level file `<file>`
  - Paths with traversal (`..`), absolute paths, or invalid separators are rejected.
- Path modes:
  - `safe` (default): apply allowlist + traversal validation.
  - `lossless`: preserve directory/path identity without allowlist remapping (use in trusted workflows).
- Security mode:
  - `strict` (default): fail conversion when high/critical security findings are detected in converted text fields.
  - `warn`: continue conversion, surface findings in `report.warnings`, and apply safe-mode sanitization behavior.
  - Security behavior:
    - `safe`: security patterns detected in converted text fields are sanitized and surfaced in `report.warnings`.
    - `lossless`: security patterns are still surfaced in `report.warnings`, but content is preserved as-is.
- Input validation bounds:
  - Per text field: max `2 MiB`
  - Aggregate conversion payload: max `16 MiB`
  - Maximum file entries per request: `2000`
- Conversion metrics:
  - `report.metrics.durationMs`
  - `report.metrics.inputTextBytes`
  - `report.metrics.outputTextBytes`
  - `report.metrics.memoryDeltaBytes`
  - `report.metrics.heapUsedBytes`
- Unknown frontmatter keys:
  - Preserved in `metadata.custom.agent_frontmatter_unknown` during Agent -> Dollhouse.
  - Reapplied to SKILL frontmatter during Dollhouse -> Agent when non-conflicting.
- Binary handling:
  - Binary references are represented as `binary-link` fenced blocks, not encoded payloads.
  - Link values can be local file paths or URLs.
  - Reverse conversion stores binary references as marker strings in file content:
    - `@binary-link <path-or-url>`
  - Example:
    - `### assets/logo.png`
    - <code>```binary-link</code>
    - `./skills/binaries/logo.png`
    - <code>```</code>
- Unsupported or ambiguous inputs are never silently dropped:
  - They appear in `report.warnings`
  - `report.unsupportedFields` contains stable field paths

### Current Non-Mappable Surfaces

- Malformed content blocks:
  - Missing filename in a block path (for example `### scripts/` with no file).
  - Block paths not in `<directory>/<file>` or `top-level/<file>` form.
- Restricted paths:
  - Directory paths outside the allowlist are not reconstructed on reverse conversion.
  - Unsafe relative paths are rejected and preserved as residual content.
- Residual free-form content:
  - Text outside structured blocks is preserved by appending to `SKILL.md` body under `## Additional Dollhouse Content`.

## Warning Handling Example

When `report.warnings` is non-empty, surface a short summary and optionally fail strict pipelines:

```ts
const result = await mcpRead({
  operation: 'convert_skill_format',
  params: { direction: 'agent_to_dollhouse', path_mode: 'safe', security_mode: 'warn', agent_skill }
});

if (result.report.warnings.length > 0) {
  for (const warning of result.report.warnings) {
    console.warn(`[${warning.code}] ${warning.path}: ${warning.message}`);
  }
}
```

## Performance Characteristics

The converter is deterministic and in-memory. Performance depends mostly on total text volume and file count.

- Complexity profile:
  - Frontmatter parsing: scales with YAML size.
  - Content transformation: scales with total bytes across all mapped files.
  - Cloning/serialization: scales with output payload size.
- Practical guidance:
  - Prefer smaller batches over one very large request.
  - Keep individual requests comfortably below configured limits, even when technically valid.
  - Use `report.metrics` to monitor real workload behavior in your environment.
- Metrics to watch:
  - `durationMs`: end-to-end conversion time.
  - `inputTextBytes` / `outputTextBytes`: request/response size footprint.
  - `memoryDeltaBytes`: per-request heap growth estimate.
  - `heapUsedBytes`: snapshot after conversion.
- Benchmark coverage in-repo:
  - `tests/performance/agent-skill-converter.performance.test.ts`
  - Run with:
    - `npm run test:performance -- tests/performance/agent-skill-converter.performance.test.ts`

Note: benchmark assertions are guardrails for regression detection, not universal performance SLAs. Hardware, runtime, and workload shape can materially change observed timings and memory usage.

## Troubleshooting

- `Missing YAML frontmatter...`
  - Ensure input markdown starts with `---` frontmatter block.
- `...exceeds maximum per-field size` / `...aggregate size`
  - Split large content into smaller skills or references.
- `...not a safe relative path` (safe mode)
  - Use `lossless` mode only for trusted migration workflows.
- `Malicious or unsafe YAML frontmatter detected...`
  - The frontmatter matched YAML security checks (for example YAML-bomb/amplification patterns). Inspect and sanitize source YAML before retrying.
- `Strict security mode blocked conversion...`
  - Default `security_mode` is `strict`. Fix risky patterns first, or use `security_mode: "warn"` only in explicitly trusted migration pipelines.
- Unexpected residual content in `SKILL.md`
  - Verify content blocks use `### <directory>/<file>` + fenced block format.

## Real-World Sampling QA

Run seeded random sampling against local skill corpora (for example cloned public repos):

```bash
npx tsx scripts/qa/random-agent-skill-sample.ts --sample 30 --seed 20260307
```

The script reports:
- strict-mode pass/block counts
- warn-mode conversion success/failure
- roundtrip success/failure
- warning totals and blocked-skill details

## Migration Notes

- Historical Anthropic/Claude Skills converter remains unchanged.
- This converter targets the current Agent Skills structure and is exposed through MCP-AQL.
- For 100% round-trip fidelity on supported conversion paths, pass the returned `roundtrip_state` into the reverse conversion call.
