/** Browser-side YAML parsing boundary for the self-hosted console. */

const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_ANCHORS = 128;
const MAX_ALIASES = 512;
const MAX_ALIAS_RATIO = 5;
const MAX_STRUCTURE_DEPTH = 64;
const MAX_STRUCTURE_NODES = 10_000;

export function assertTextWithinByteLimit(source, maxBytes = DEFAULT_MAX_BYTES) {
  if (typeof source !== 'string') throw new Error('YAML input must be text.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid YAML size limit.');
  if (new TextEncoder().encode(source).byteLength > maxBytes) {
    throw new Error(`YAML input exceeds the ${maxBytes}-byte limit.`);
  }
}

export function parseBrowserYaml(source, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, schema = 'core', requireObject = true } = options;
  assertTextWithinByteLimit(source, maxBytes);
  assertBoundedAliases(source);

  if (!globalThis.jsyaml) throw new Error('YAML support is not available in this browser session.');
  const selectedSchema = selectSchema(globalThis.jsyaml, schema);
  const parsed = globalThis.jsyaml.load(source, { schema: selectedSchema, json: false });

  if (requireObject && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error('YAML input must contain an object.');
  }
  assertBoundedStructure(parsed);
  return parsed;
}

function selectSchema(jsyaml, schema) {
  switch (schema) {
    case 'failsafe':
      return jsyaml.FAILSAFE_SCHEMA;
    case 'json':
      return jsyaml.JSON_SCHEMA;
    case 'core':
      return jsyaml.CORE_SCHEMA;
    default:
      throw new Error(`Unsupported YAML schema: ${schema}`);
  }
}

function assertBoundedAliases(source) {
  const anchors = source.match(/&[A-Za-z0-9_-]+/gu) ?? [];
  const aliases = source.match(/(?<!\*)\*[A-Za-z0-9_-]+/gu) ?? [];
  const ratio = anchors.length === 0 ? 0 : aliases.length / anchors.length;
  if (anchors.length > MAX_ANCHORS || aliases.length > MAX_ALIASES || ratio > MAX_ALIAS_RATIO) {
    throw new Error('YAML aliases exceed the console safety limit.');
  }
}

function assertBoundedStructure(root) {
  if (!root || typeof root !== 'object') return;
  const visited = new WeakSet();
  const visiting = new WeakSet();
  let nodes = 0;

  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    if (visiting.has(value)) throw new Error('YAML aliases may not create cyclic data.');
    visiting.add(value);
    nodes += 1;
    if (nodes > MAX_STRUCTURE_NODES || depth > MAX_STRUCTURE_DEPTH) {
      throw new Error('YAML structure exceeds the console safety limit.');
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
    visiting.delete(value);
    visited.add(value);
  };

  visit(root, 0);
}
