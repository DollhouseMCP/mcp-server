export const DIRECT_METADATA_FIELDS = new Set([
  'name',
  'description',
  'version',
  'author',
  'created',
  'modified',
  'category',
  'tags',
  'complexity',
  'domains',
  'dependencies',
  'prerequisites',
  'parameters',
  'examples',
  'languages',
  'proficiency_level',
  'license',
  'type',
  'metadata',
]);

export const ARRAY_METADATA_FIELDS = new Set([
  'tags',
  'domains',
  'dependencies',
  'prerequisites',
  'languages',
]);

export const COPY_THROUGH_FIELDS = new Set([
  'version',
  'author',
  'created',
  'modified',
  'category',
  'complexity',
  'parameters',
  'examples',
  'proficiency_level',
  'license',
]);

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  sh: 'bash',
  bash: 'bash',
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  txt: 'text',
  toml: 'toml',
};

export const SECTION_TITLE_BY_DIRECTORY: Record<string, string> = {
  'references/': 'References',
  'scripts/': 'Scripts',
  'agents/': 'Agent Metadata',
  'assets/': 'Assets',
  'binaries/': 'Binaries',
};

export const TOP_LEVEL_CONTENT_PREFIX = 'top-level/';
export const BINARY_LINK_FENCE = 'binary-link';
export const BINARY_LINK_PREFIX = '@binary-link ';
export const REMAPPED_DIRECTORY_PREFIX = 'from-agent-dir';
export const REMAPPED_TOP_LEVEL_PREFIX = 'from-agent-top-level';

export const ALLOWED_AGENT_DIRECTORIES = new Set([
  'scripts/',
  'references/',
  'assets/',
  'agents/',
  'binaries/',
]);

export const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'pdf',
  'zip',
  'gz',
  'tar',
  '7z',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'wav',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'bin',
  'exe',
  'dll',
  'so',
  'dylib',
]);

export const CONVERSION_MAX_SINGLE_TEXT_BYTES = 2 * 1024 * 1024; // 2 MiB per text entry
export const CONVERSION_MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024; // 16 MiB aggregate
export const CONVERSION_MAX_FILES = 2000;
export const CONVERSION_METRICS_LOG_INPUT_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4 MiB
export const CONVERSION_METRICS_LOG_DURATION_THRESHOLD_MS = 100;
