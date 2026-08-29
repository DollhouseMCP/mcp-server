import * as yaml from 'js-yaml';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import {
  DIRECT_METADATA_FIELDS,
  ARRAY_METADATA_FIELDS,
  COPY_THROUGH_FIELDS,
  LANGUAGE_BY_EXTENSION,
  SECTION_TITLE_BY_DIRECTORY,
  TOP_LEVEL_CONTENT_PREFIX,
  BINARY_LINK_FENCE,
  BINARY_LINK_PREFIX,
  REMAPPED_DIRECTORY_PREFIX,
  REMAPPED_TOP_LEVEL_PREFIX,
  ALLOWED_AGENT_DIRECTORIES,
  BINARY_EXTENSIONS,
  CONVERSION_MAX_SINGLE_TEXT_BYTES,
  CONVERSION_MAX_TOTAL_TEXT_BYTES,
  CONVERSION_MAX_FILES,
  CONVERSION_METRICS_LOG_INPUT_THRESHOLD_BYTES,
  CONVERSION_METRICS_LOG_DURATION_THRESHOLD_MS,
} from './agentSkillConverter.constants.js';
import { ContentValidator } from '../security/contentValidator.js';
import { logger } from '../utils/logger.js';

export const AGENT_SKILL_MAPPING_VERSION = 'agent-skill-v1';
const REFERENCES_DIRECTORY = 'references/';
const AGENT_FRONTMATTER_FIELDS = ['version', 'author', 'license', 'created', 'modified'] as const;
const AGENT_NESTED_METADATA_FIELDS = [
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
] as const;

export type ConversionDirection = 'agent_to_dollhouse' | 'dollhouse_to_agent';
export type SkillPathMode = 'safe' | 'lossless';
export type SkillSecurityMode = 'strict' | 'warn';
export type ConversionWarningCode =
  | 'unsupported_field'
  | 'ambiguous_mapping'
  | 'missing_required_field'
  | 'invalid_input';

export interface ConversionWarning {
  code: ConversionWarningCode;
  path: string;
  message: string;
  preserved: boolean;
}

export interface ConversionReport {
  mappingVersion: string;
  deterministic: boolean;
  roundTripAvailable: boolean;
  warnings: ConversionWarning[];
  unsupportedFields: string[];
  metrics?: ConversionMetrics;
}

export interface ConversionMetrics {
  durationMs: number;
  inputTextBytes: number;
  outputTextBytes: number;
  memoryDeltaBytes: number;
  heapUsedBytes: number;
}

export interface AgentSkillStructure {
  'SKILL.md': string;
  'scripts/'?: Record<string, string>;
  'references/'?: Record<string, string>;
  'assets/'?: Record<string, string>;
  'agents/'?: Record<string, string>;
  [key: string]: string | Record<string, string> | undefined;
}

export interface DollhouseSkillArtifact {
  metadata: Record<string, unknown>;
  instructions: string;
  content: string;
}

export interface SkillRoundTripState {
  mappingVersion: string;
  agentSkill: AgentSkillStructure;
}

export interface SkillConversionOptions {
  direction: ConversionDirection;
  path_mode?: SkillPathMode;
  security_mode?: SkillSecurityMode;
  agent_skill?: AgentSkillStructure;
  dollhouse?: DollhouseSkillArtifact;
  dollhouse_markdown?: string;
  roundtrip_state?: SkillRoundTripState;
  prefer_roundtrip_state?: boolean;
}

export interface SkillConversionResult {
  direction: ConversionDirection;
  mappingVersion: string;
  dollhouse?: DollhouseSkillArtifact;
  dollhouse_markdown?: string;
  agent_skill?: AgentSkillStructure;
  roundtrip_state?: SkillRoundTripState;
  report: ConversionReport;
}

interface ParsedMarkdownWithFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface ParsedDollhouseContentBlock {
  fileReference: string;
  normalizedFileContent: string;
  span: { start: number; end: number };
}

type ResourceDirectories = Partial<Record<string, Record<string, string>>>;

export class AgentSkillConverter {
  convert(options: SkillConversionOptions): SkillConversionResult {
    const startedAt = performance.now();
    const heapUsedBefore = process.memoryUsage().heapUsed;
    const pathMode = options.path_mode ?? 'safe';
    const securityMode = options.security_mode ?? 'strict';
    this.validateInputBounds(options);

    let result: SkillConversionResult;

    const direction: unknown = options.direction;
    if (direction === 'agent_to_dollhouse') {
      if (!options.agent_skill) {
        throw new Error(
          `Missing required parameter 'agent_skill' for direction '${direction}'`
        );
      }
      result = this.convertAgentToDollhouse(options.agent_skill, pathMode, securityMode);
    } else if (direction === 'dollhouse_to_agent') {
      result = this.convertDollhouseToAgent(options, pathMode);
    } else {
      throw new Error(
        `Unsupported conversion direction '${String(direction)}'. Expected 'agent_to_dollhouse' or 'dollhouse_to_agent'.`
      );
    }

    return this.attachConversionMetrics(result, options, startedAt, heapUsedBefore);
  }

  private validateInputBounds(options: SkillConversionOptions): void {
    let totalBytes = 0;
    let fileCount = 0;

    const addTextBudget = (value: string, pathLabel: string) => {
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > CONVERSION_MAX_SINGLE_TEXT_BYTES) {
        throw new Error(
          `Input '${pathLabel}' exceeds maximum per-field size (${CONVERSION_MAX_SINGLE_TEXT_BYTES} bytes).`
        );
      }
      totalBytes += bytes;
      if (totalBytes > CONVERSION_MAX_TOTAL_TEXT_BYTES) {
        throw new Error(
          `Input exceeds maximum aggregate size (${CONVERSION_MAX_TOTAL_TEXT_BYTES} bytes).`
        );
      }
    };

    if (options.dollhouse_markdown) {
      addTextBudget(options.dollhouse_markdown, 'dollhouse_markdown');
      fileCount += 1;
    }

    if (options.dollhouse) {
      const metadata = isRecord(options.dollhouse.metadata) ? options.dollhouse.metadata : {};
      const instructions = typeof options.dollhouse.instructions === 'string' ? options.dollhouse.instructions : '';
      const content = typeof options.dollhouse.content === 'string' ? options.dollhouse.content : '';
      addTextBudget(JSON.stringify(metadata), 'dollhouse.metadata');
      addTextBudget(instructions, 'dollhouse.instructions');
      addTextBudget(content, 'dollhouse.content');
      fileCount += 3;
    }

    if (options.agent_skill) {
      fileCount += this.visitAgentSkillText(options.agent_skill, addTextBudget);
    }

    if (fileCount > CONVERSION_MAX_FILES) {
      throw new Error(`Input exceeds maximum file count (${CONVERSION_MAX_FILES}).`);
    }
  }

  private attachConversionMetrics(
    result: SkillConversionResult,
    options: SkillConversionOptions,
    startedAt: number,
    heapUsedBefore: number
  ): SkillConversionResult {
    const durationMs = performance.now() - startedAt;
    const heapUsedAfter = process.memoryUsage().heapUsed;
    const inputTextBytes = this.measureInputBytes(options);
    const outputTextBytes = this.measureOutputBytes(result);
    const memoryDeltaBytes = heapUsedAfter - heapUsedBefore;

    result.report.metrics = {
      durationMs,
      inputTextBytes,
      outputTextBytes,
      memoryDeltaBytes,
      heapUsedBytes: heapUsedAfter,
    };

    if (
      inputTextBytes >= CONVERSION_METRICS_LOG_INPUT_THRESHOLD_BYTES ||
      durationMs >= CONVERSION_METRICS_LOG_DURATION_THRESHOLD_MS
    ) {
      logger.info('Agent skill conversion completed with large payload metrics', {
        direction: result.direction,
        pathMode: options.path_mode ?? 'safe',
        securityMode: options.security_mode ?? 'strict',
        durationMs,
        inputTextBytes,
        outputTextBytes,
        memoryDeltaBytes,
        heapUsedBytes: heapUsedAfter,
      });
    }

    return result;
  }

  private measureInputBytes(options: SkillConversionOptions): number {
    let totalBytes = 0;

    if (options.dollhouse_markdown) {
      totalBytes += Buffer.byteLength(options.dollhouse_markdown, 'utf8');
    }

    if (options.dollhouse) {
      totalBytes += this.measureDollhouseArtifactBytes(options.dollhouse);
    }

    if (options.agent_skill) {
      this.visitAgentSkillText(options.agent_skill, value => {
        totalBytes += Buffer.byteLength(value, 'utf8');
      });
    }

    return totalBytes;
  }

  private measureOutputBytes(result: SkillConversionResult): number {
    let totalBytes = 0;

    if (result.dollhouse_markdown) {
      totalBytes += Buffer.byteLength(result.dollhouse_markdown, 'utf8');
    }

    if (result.dollhouse) {
      totalBytes += this.measureDollhouseArtifactBytes(result.dollhouse);
    }

    if (result.agent_skill) {
      this.visitAgentSkillText(result.agent_skill, value => {
        totalBytes += Buffer.byteLength(value, 'utf8');
      });
    }

    return totalBytes;
  }

  private visitAgentSkillText(
    agentSkill: AgentSkillStructure,
    visit: (value: string, pathLabel: string) => void
  ): number {
    let fileCount = 0;
    for (const [pathKey, pathValue] of Object.entries(agentSkill)) {
      if (typeof pathValue === 'string') {
        visit(pathValue, `agent_skill.${pathKey}`);
        fileCount += 1;
        continue;
      }

      if (!pathValue || typeof pathValue !== 'object') {
        continue;
      }
      for (const [fileName, fileContent] of Object.entries(pathValue)) {
        if (typeof fileContent !== 'string') {
          continue;
        }
        visit(fileContent, `agent_skill.${pathKey}${fileName}`);
        fileCount += 1;
      }
    }
    return fileCount;
  }

  private measureDollhouseArtifactBytes(dollhouse: DollhouseSkillArtifact): number {
    const metadata = isRecord(dollhouse.metadata) ? dollhouse.metadata : {};
    const instructions = typeof dollhouse.instructions === 'string' ? dollhouse.instructions : '';
    const content = typeof dollhouse.content === 'string' ? dollhouse.content : '';
    return Buffer.byteLength(JSON.stringify(metadata), 'utf8')
      + Buffer.byteLength(instructions, 'utf8')
      + Buffer.byteLength(content, 'utf8');
  }

  private applyDollhouseSecurityPolicy(
    dollhouse: DollhouseSkillArtifact,
    warnings: ConversionWarning[],
    pathMode: SkillPathMode,
    securityMode: SkillSecurityMode
  ): DollhouseSkillArtifact {
    const metadata = this.scanObjectStrings(
      dollhouse.metadata,
      'dollhouse.metadata',
      warnings,
      pathMode,
      securityMode
    ) as Record<string, unknown>;

    const instructions = this.scanTextContent(
      dollhouse.instructions,
      'dollhouse.instructions',
      warnings,
      pathMode,
      securityMode,
      'skill'
    );
    const content = this.scanTextContent(
      dollhouse.content,
      'dollhouse.content',
      warnings,
      pathMode,
      securityMode,
      'skill'
    );

    return {
      metadata,
      instructions,
      content,
    };
  }

  private scanObjectStrings(
    value: unknown,
    basePath: string,
    warnings: ConversionWarning[],
    pathMode: SkillPathMode,
    securityMode: SkillSecurityMode
  ): unknown {
    if (typeof value === 'string') {
      return this.scanTextContent(value, basePath, warnings, pathMode, securityMode);
    }
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.scanObjectStrings(item, `${basePath}[${index}]`, warnings, pathMode, securityMode)
      );
    }
    if (isRecord(value)) {
      const scanned: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        scanned[key] = this.scanObjectStrings(item, `${basePath}.${key}`, warnings, pathMode, securityMode);
      }
      return scanned;
    }
    return value;
  }

  private scanTextContent(
    value: string,
    path: string,
    warnings: ConversionWarning[],
    pathMode: SkillPathMode,
    securityMode: SkillSecurityMode,
    contentContext?: 'persona' | 'skill' | 'template' | 'agent' | 'memory'
  ): string {
    if (!value) {
      return value;
    }

    try {
      const securityResult = ContentValidator.validateAndSanitize(value, {
        maxLength: CONVERSION_MAX_SINGLE_TEXT_BYTES,
        contentContext,
      });

      if (securityMode === 'strict' && !securityResult.isValid) {
        const patternSummary = securityResult.detectedPatterns?.slice(0, 5).join(', ') || 'unknown patterns';
        throw new Error(
          `Strict security mode blocked conversion at '${path}' due to detected risky patterns: ${patternSummary}. ` +
          `Review input and retry with security_mode='warn' only if you explicitly accept the risk.`
        );
      }

      this.recordDetectedSecurityPatterns(securityResult.detectedPatterns, path, warnings, pathMode);

      if (pathMode === 'safe') {
        return securityResult.sanitizedContent ?? value;
      }
      return value;
    } catch (error) {
      if (securityMode === 'strict') {
        throw error;
      }
      warnings.push({
        code: 'invalid_input',
        path,
        message: `Security validation failed: ${error instanceof Error ? error.message : String(error)}.`,
        preserved: pathMode === 'lossless',
      });
      return pathMode === 'safe' ? '[CONTENT_BLOCKED]' : value;
    }
  }

  private recordDetectedSecurityPatterns(
    detectedPatterns: string[] | undefined,
    path: string,
    warnings: ConversionWarning[],
    pathMode: SkillPathMode
  ): void {
    if (!detectedPatterns || detectedPatterns.length === 0) {
      return;
    }
    const displayedPatterns = detectedPatterns.slice(0, 5);
    const suffix = detectedPatterns.length > 5 ? ` (+${detectedPatterns.length - 5} more)` : '';
    warnings.push({
      code: 'invalid_input',
      path,
      message: pathMode === 'safe'
        ? `Security patterns detected (${displayedPatterns.join(', ')}${suffix}). Content was sanitized in safe mode.`
        : `Security patterns detected (${displayedPatterns.join(', ')}${suffix}). Content preserved because path_mode='lossless'.`,
      preserved: pathMode === 'lossless',
    });
  }

  private normalizeAgentSkill(agentSkill: AgentSkillStructure): AgentSkillStructure {
    const normalizedSkill = {} as AgentSkillStructure;
    for (const [key, value] of Object.entries(agentSkill)) {
      const normalizedKey = key.normalize('NFC');
      const untrustedValue: unknown = value;
      if (typeof untrustedValue === 'string') {
        normalizedSkill[normalizedKey] = untrustedValue.normalize('NFC');
        continue;
      }
      if (typeof untrustedValue === 'object' && untrustedValue !== null) {
        const normalizedDirectory: Record<string, string> = {};
        for (const [fileName, fileContent] of Object.entries(untrustedValue)) {
          normalizedDirectory[fileName.normalize('NFC')] = typeof fileContent === 'string'
            ? fileContent.normalize('NFC')
            : String(fileContent);
        }
        normalizedSkill[normalizedKey] = normalizedDirectory;
        continue;
      }
      normalizedSkill[normalizedKey] = value;
    }
    return normalizedSkill;
  }

  private buildDollhouseMetadata(
    frontmatter: Record<string, unknown>,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>
  ): Record<string, unknown> {
    const name = this.readRequiredString(
      frontmatter,
      'name',
      warnings,
      unsupportedFields,
      'agent_skill.SKILL.md.frontmatter.name'
    );
    const description = this.readRequiredString(
      frontmatter,
      'description',
      warnings,
      unsupportedFields,
      'agent_skill.SKILL.md.frontmatter.description'
    );
    const metadata: Record<string, unknown> = {
      name: name ?? 'Unnamed Agent Skill',
      description: description ?? 'No description provided',
      type: 'skill',
      version: this.readString(frontmatter, 'version') ?? '1.0.0',
    };

    this.recordAgentTypeNormalization(frontmatter, warnings);
    for (const field of COPY_THROUGH_FIELDS) {
      if (Object.hasOwn(frontmatter, field)) {
        metadata[field] = frontmatter[field];
      }
    }
    this.copyAgentArrayMetadata(frontmatter, metadata, warnings, unsupportedFields);
    metadata.custom = this.buildAgentCustomMetadata(frontmatter, warnings, unsupportedFields);
    return metadata;
  }

  private recordAgentTypeNormalization(
    frontmatter: Record<string, unknown>,
    warnings: ConversionWarning[]
  ): void {
    const agentType = this.readString(frontmatter, 'type');
    if (!agentType || agentType === 'skill') {
      return;
    }
    warnings.push({
      code: 'ambiguous_mapping',
      path: 'agent_skill.SKILL.md.frontmatter.type',
      message: `Agent skill type '${agentType}' is normalized to Dollhouse type 'skill'.`,
      preserved: false,
    });
  }

  private copyAgentArrayMetadata(
    frontmatter: Record<string, unknown>,
    metadata: Record<string, unknown>,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>
  ): void {
    for (const field of ARRAY_METADATA_FIELDS) {
      if (!Object.hasOwn(frontmatter, field)) {
        continue;
      }
      const value = frontmatter[field];
      if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
        metadata[field] = value;
        continue;
      }
      if (typeof value === 'string') {
        metadata[field] = [value];
        warnings.push({
          code: 'ambiguous_mapping',
          path: `agent_skill.SKILL.md.frontmatter.${field}`,
          message: `Expected array for '${field}'. Converted single string to one-item array.`,
          preserved: true,
        });
        continue;
      }
      warnings.push({
        code: 'unsupported_field',
        path: `agent_skill.SKILL.md.frontmatter.${field}`,
        message: `Unsupported '${field}' type '${typeof value}'. Field was preserved in custom metadata.`,
        preserved: true,
      });
      unsupportedFields.add(`agent_skill.SKILL.md.frontmatter.${field}`);
    }
  }

  private buildAgentCustomMetadata(
    frontmatter: Record<string, unknown>,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>
  ): Record<string, unknown> {
    const customMetadata: Record<string, unknown> = {
      source_format: 'agent_skill_current',
      mapping_version: AGENT_SKILL_MAPPING_VERSION,
    };
    if (isRecord(frontmatter.metadata)) {
      customMetadata.agent_metadata = clone(frontmatter.metadata);
    } else if (Object.hasOwn(frontmatter, 'metadata')) {
      warnings.push({
        code: 'unsupported_field',
        path: 'agent_skill.SKILL.md.frontmatter.metadata',
        message: 'Expected object for frontmatter.metadata. Value was preserved as-is in custom metadata.',
        preserved: true,
      });
      unsupportedFields.add('agent_skill.SKILL.md.frontmatter.metadata');
      customMetadata.agent_metadata = frontmatter.metadata;
    }

    const unknownFrontmatter: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(frontmatter)) {
      if (!DIRECT_METADATA_FIELDS.has(key)) {
        unknownFrontmatter[key] = value;
      }
    }
    if (Object.keys(unknownFrontmatter).length > 0) {
      customMetadata.agent_frontmatter_unknown = unknownFrontmatter;
    }
    return customMetadata;
  }

  private collectAgentResources(
    agentSkill: AgentSkillStructure,
    pathMode: SkillPathMode,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>
  ): { resourceDirectories: ResourceDirectories; topLevelFiles: Record<string, string> } {
    const resourceDirectories: ResourceDirectories = {};
    const topLevelFiles: Record<string, string> = {};
    for (const [pathKey, pathValue] of Object.entries(agentSkill)) {
      if (pathKey === 'SKILL.md') {
        continue;
      }
      if (pathKey.endsWith('/')) {
        this.mapAgentDirectory(pathKey, pathValue, pathMode, resourceDirectories, warnings, unsupportedFields);
        continue;
      }
      this.mapAgentTopLevelFile(
        pathKey,
        pathValue,
        pathMode,
        resourceDirectories,
        topLevelFiles,
        warnings,
        unsupportedFields
      );
    }
    return { resourceDirectories, topLevelFiles };
  }

  private mapAgentDirectory(
    pathKey: string,
    pathValue: unknown,
    pathMode: SkillPathMode,
    resourceDirectories: ResourceDirectories,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>
  ): void {
    if (!isStringRecord(pathValue)) {
      warnings.push({
        code: 'invalid_input',
        path: `agent_skill.${pathKey}`,
        message: `Directory '${pathKey}' must be a map of filename -> string content.`,
        preserved: false,
      });
      unsupportedFields.add(`agent_skill.${pathKey}`);
      return;
    }
    if (pathMode === 'lossless' || (isAllowedAgentDirectory(pathKey) && isSafeDirectoryName(pathKey))) {
      resourceDirectories[pathKey] = clone(pathValue);
      return;
    }

    warnings.push({
      code: 'ambiguous_mapping',
      path: `agent_skill.${pathKey}`,
      message: `Directory '${pathKey}' is outside allowed directories and was remapped under references/${REMAPPED_DIRECTORY_PREFIX}/.`,
      preserved: true,
    });
    const remapRoot = `${REMAPPED_DIRECTORY_PREFIX}/${sanitizePathToken(removeTrailingSlashes(pathKey))}`;
    const references = this.ensureResourceDirectory(resourceDirectories, REFERENCES_DIRECTORY);
    for (const [fileName, fileContent] of Object.entries(pathValue)) {
      const safeFilePath = sanitizeRelativePathForReference(fileName);
      references[`${remapRoot}/${safeFilePath}`] = fileContent;
    }
  }

  private mapAgentTopLevelFile(
    pathKey: string,
    pathValue: unknown,
    pathMode: SkillPathMode,
    resourceDirectories: ResourceDirectories,
    topLevelFiles: Record<string, string>,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>
  ): void {
    if (typeof pathValue !== 'string') {
      warnings.push({
        code: 'invalid_input',
        path: `agent_skill.${pathKey}`,
        message: `Top-level file '${pathKey}' must contain string content.`,
        preserved: false,
      });
      unsupportedFields.add(`agent_skill.${pathKey}`);
      return;
    }
    if (pathMode === 'lossless' || isSafeTopLevelFileName(pathKey)) {
      topLevelFiles[pathKey] = pathValue;
      return;
    }

    warnings.push({
      code: 'ambiguous_mapping',
      path: `agent_skill.${pathKey}`,
      message: `Top-level path '${pathKey}' is unsafe and was remapped under references/${REMAPPED_TOP_LEVEL_PREFIX}/.`,
      preserved: true,
    });
    const references = this.ensureResourceDirectory(resourceDirectories, REFERENCES_DIRECTORY);
    const safeFilePath = sanitizeRelativePathForReference(pathKey);
    references[`${REMAPPED_TOP_LEVEL_PREFIX}/${safeFilePath}`] = pathValue;
  }

  private ensureResourceDirectory(
    resourceDirectories: ResourceDirectories,
    directory: string
  ): Record<string, string> {
    const existing = resourceDirectories[directory];
    if (existing) {
      return existing;
    }
    const created: Record<string, string> = {};
    resourceDirectories[directory] = created;
    return created;
  }

  convertAgentToDollhouse(
    agentSkill: AgentSkillStructure,
    pathMode: SkillPathMode = 'safe',
    securityMode: SkillSecurityMode = 'strict'
  ): SkillConversionResult {
    const warnings: ConversionWarning[] = [];
    const unsupportedFields = new Set<string>();

    // Normalize all text inputs to NFC to prevent Unicode homograph attacks
    const normalizedSkill = this.normalizeAgentSkill(agentSkill);

    const parsed = this.parseSkillMarkdown(normalizedSkill['SKILL.md'], 'agent_skill.SKILL.md');
    const metadata = this.buildDollhouseMetadata(parsed.frontmatter, warnings, unsupportedFields);
    const { resourceDirectories, topLevelFiles } = this.collectAgentResources(
      agentSkill,
      pathMode,
      warnings,
      unsupportedFields
    );

    const content = this.buildDollhouseContent(resourceDirectories, topLevelFiles);
    const dollhouse: DollhouseSkillArtifact = {
      metadata,
      instructions: parsed.body.trim(),
      content,
    };
    const securedDollhouse = this.applyDollhouseSecurityPolicy(dollhouse, warnings, pathMode, securityMode);

    const roundtrip_state: SkillRoundTripState = {
      mappingVersion: AGENT_SKILL_MAPPING_VERSION,
      agentSkill: clone(agentSkill),
    };

    return {
      direction: 'agent_to_dollhouse',
      mappingVersion: AGENT_SKILL_MAPPING_VERSION,
      dollhouse: securedDollhouse,
      dollhouse_markdown: this.serializeDollhouseMarkdown(securedDollhouse),
      roundtrip_state,
      report: {
        mappingVersion: AGENT_SKILL_MAPPING_VERSION,
        deterministic: true,
        roundTripAvailable: true,
        warnings,
        unsupportedFields: [...unsupportedFields].sort((a, b) => a.localeCompare(b)),
      },
    };
  }

  private resolveRoundTripConversion(
    options: SkillConversionOptions,
    warnings: ConversionWarning[]
  ): SkillConversionResult | undefined {
    const preferRoundTripState = options.prefer_roundtrip_state ?? true;
    const roundTripState = options.roundtrip_state;
    if (!preferRoundTripState || !roundTripState) {
      return undefined;
    }
    if (roundTripState.mappingVersion !== AGENT_SKILL_MAPPING_VERSION) {
      warnings.push({
        code: 'ambiguous_mapping',
        path: 'roundtrip_state.mappingVersion',
        message: `roundtrip_state mapping version '${roundTripState.mappingVersion}' does not match '${AGENT_SKILL_MAPPING_VERSION}'. Falling back to best-effort mapping.`,
        preserved: false,
      });
      return undefined;
    }
    return {
      direction: 'dollhouse_to_agent',
      mappingVersion: AGENT_SKILL_MAPPING_VERSION,
      agent_skill: clone(roundTripState.agentSkill),
      report: {
        mappingVersion: AGENT_SKILL_MAPPING_VERSION,
        deterministic: true,
        roundTripAvailable: true,
        warnings,
        unsupportedFields: [],
      },
    };
  }

  private buildAgentFrontmatter(
    metadata: Record<string, unknown>,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>
  ): Record<string, unknown> {
    const name = this.readRequiredString(
      metadata,
      'name',
      warnings,
      unsupportedFields,
      'dollhouse.metadata.name'
    );
    const description = this.readRequiredString(
      metadata,
      'description',
      warnings,
      unsupportedFields,
      'dollhouse.metadata.description'
    );
    const frontmatter: Record<string, unknown> = {
      name: name ?? 'Converted Dollhouse Skill',
      description: description ?? 'No description provided',
    };
    this.copyPresentMetadataFields(metadata, frontmatter, AGENT_FRONTMATTER_FIELDS);

    const mappedMetadata: Record<string, unknown> = {};
    this.copyPresentMetadataFields(metadata, mappedMetadata, AGENT_NESTED_METADATA_FIELDS);
    this.restoreAgentCustomMetadata(metadata.custom, frontmatter, mappedMetadata, warnings);
    if (Object.keys(mappedMetadata).length > 0) {
      frontmatter.metadata = mappedMetadata;
    }
    this.recordUnsupportedDollhouseMetadata(metadata, warnings, unsupportedFields);
    return frontmatter;
  }

  private copyPresentMetadataFields(
    source: Record<string, unknown>,
    target: Record<string, unknown>,
    fields: readonly string[]
  ): void {
    for (const field of fields) {
      if (Object.hasOwn(source, field)) {
        target[field] = source[field];
      }
    }
  }

  private restoreAgentCustomMetadata(
    customValue: unknown,
    frontmatter: Record<string, unknown>,
    mappedMetadata: Record<string, unknown>,
    warnings: ConversionWarning[]
  ): void {
    if (!isRecord(customValue)) {
      return;
    }
    const agentMetadata = customValue.agent_metadata;
    if (isRecord(agentMetadata)) {
      Object.assign(mappedMetadata, clone(agentMetadata));
    } else if (agentMetadata !== undefined) {
      mappedMetadata.dollhouse_custom_agent_metadata = clone(agentMetadata);
    }

    const unknownFrontmatter = customValue.agent_frontmatter_unknown;
    if (!isRecord(unknownFrontmatter)) {
      return;
    }
    for (const [key, value] of Object.entries(unknownFrontmatter)) {
      if (Object.hasOwn(frontmatter, key)) {
        warnings.push({
          code: 'ambiguous_mapping',
          path: `dollhouse.metadata.custom.agent_frontmatter_unknown.${key}`,
          message: `Unknown frontmatter key '${key}' conflicts with mapped frontmatter and was not applied.`,
          preserved: false,
        });
        continue;
      }
      frontmatter[key] = clone(value);
    }
  }

  private recordUnsupportedDollhouseMetadata(
    metadata: Record<string, unknown>,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>
  ): void {
    for (const key of Object.keys(metadata)) {
      if (DIRECT_METADATA_FIELDS.has(key) || key === 'custom') {
        continue;
      }
      warnings.push({
        code: 'unsupported_field',
        path: `dollhouse.metadata.${key}`,
        message: `Dollhouse metadata field '${key}' is not mapped to Agent Skill frontmatter.`,
        preserved: false,
      });
      unsupportedFields.add(`dollhouse.metadata.${key}`);
    }
  }

  private appendResidualContent(
    instructions: string,
    residualContent: string,
    warnings: ConversionWarning[]
  ): string {
    if (residualContent.length === 0) {
      return instructions;
    }
    warnings.push({
      code: 'ambiguous_mapping',
      path: 'dollhouse.content',
      message: 'Some Dollhouse content could not be mapped to Agent Skill subdirectories. Unmapped content was appended to SKILL.md body.',
      preserved: true,
    });
    return instructions.length > 0
      ? `${instructions}\n\n## Additional Dollhouse Content\n\n${residualContent}`
      : residualContent;
  }

  private buildAgentSkillStructure(
    frontmatter: Record<string, unknown>,
    body: string,
    resourceDirectories: ResourceDirectories,
    topLevelFiles: Record<string, string>
  ): AgentSkillStructure {
    const agentSkill: AgentSkillStructure = {
      'SKILL.md': this.serializeSkillMarkdown(frontmatter, body),
    };
    for (const [directory, files] of Object.entries(resourceDirectories)) {
      if (files && Object.keys(files).length > 0) {
        agentSkill[directory] = files;
      }
    }
    for (const [fileName, fileContent] of Object.entries(topLevelFiles)) {
      agentSkill[fileName] = fileContent;
    }
    return agentSkill;
  }

  convertDollhouseToAgent(options: SkillConversionOptions, pathMode: SkillPathMode = 'safe'): SkillConversionResult {
    const warnings: ConversionWarning[] = [];
    const unsupportedFields = new Set<string>();

    // Normalize dollhouse markdown input to NFC
    if (options.dollhouse_markdown && typeof options.dollhouse_markdown === 'string') {
      options.dollhouse_markdown = options.dollhouse_markdown.normalize('NFC');
    }

    const roundTripConversion = this.resolveRoundTripConversion(options, warnings);
    if (roundTripConversion) {
      return roundTripConversion;
    }

    const dollhouse = this.resolveDollhouseInput(options, warnings, unsupportedFields);
    const metadata = isRecord(dollhouse.metadata) ? dollhouse.metadata : {};
    const frontmatter = this.buildAgentFrontmatter(metadata, warnings, unsupportedFields);

    const instructions = (typeof dollhouse.instructions === 'string' ? dollhouse.instructions : '').trim();
    const content = (typeof dollhouse.content === 'string' ? dollhouse.content : '').trim();
    const contentParseResult = this.extractResourcesFromDollhouseContent(
      content,
      warnings,
      unsupportedFields,
      pathMode
    );
    const body = this.appendResidualContent(instructions, contentParseResult.residualContent, warnings);
    const agentSkill = this.buildAgentSkillStructure(
      frontmatter,
      body,
      contentParseResult.resourceDirectories,
      contentParseResult.topLevelFiles
    );

    return {
      direction: 'dollhouse_to_agent',
      mappingVersion: AGENT_SKILL_MAPPING_VERSION,
      agent_skill: agentSkill,
      report: {
        mappingVersion: AGENT_SKILL_MAPPING_VERSION,
        deterministic: true,
        roundTripAvailable: false,
        warnings,
        unsupportedFields: [...unsupportedFields].sort((a, b) => a.localeCompare(b)),
      },
    };
  }

  parseDollhouseMarkdown(markdown: string): DollhouseSkillArtifact {
    const parsed = this.parseSkillMarkdown(markdown, 'dollhouse_markdown');
    const frontmatter = clone(parsed.frontmatter);
    const instructions = typeof frontmatter.instructions === 'string'
      ? frontmatter.instructions
      : parsed.body.trim();
    const content = typeof frontmatter.instructions === 'string'
      ? parsed.body.trim()
      : '';

    delete frontmatter.instructions;

    return {
      metadata: frontmatter,
      instructions,
      content,
    };
  }

  serializeDollhouseMarkdown(skill: DollhouseSkillArtifact): string {
    const metadata = clone(skill.metadata);
    metadata.instructions = skill.instructions;
    return this.serializeSkillMarkdown(metadata, skill.content);
  }

  private resolveDollhouseInput(
    options: SkillConversionOptions,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>
  ): DollhouseSkillArtifact {
    if (options.dollhouse) {
      return options.dollhouse;
    }

    if (options.dollhouse_markdown) {
      return this.parseDollhouseMarkdown(options.dollhouse_markdown);
    }

    warnings.push({
      code: 'missing_required_field',
      path: 'dollhouse',
      message: `Provide either 'dollhouse' artifact or 'dollhouse_markdown' for direction '${options.direction}'.`,
      preserved: false,
    });
    unsupportedFields.add('dollhouse');
    throw new Error(`Missing required input for '${options.direction}': expected dollhouse or dollhouse_markdown`);
  }

  private parseSkillMarkdown(markdown: string, pathLabel: string): ParsedMarkdownWithFrontmatter {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(markdown);
    if (!match) {
      throw new Error(`Missing YAML frontmatter in ${pathLabel}`);
    }

    if (!ContentValidator.validateYamlContent(match[1])) {
      throw new Error(`Malicious or unsafe YAML frontmatter detected in ${pathLabel}`);
    }

    let parsedFrontmatter: unknown;
    try {
      parsedFrontmatter = SecureYamlParser.parseRawYaml(match[1]);
    } catch (error) {
      if (error instanceof Error && error.message === 'YAML content must parse to an object') {
        throw new Error(`Frontmatter in ${pathLabel} must be a YAML object`);
      }
      throw new Error(
        `Invalid YAML frontmatter in ${pathLabel}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isRecord(parsedFrontmatter)) {
      throw new Error(`Frontmatter in ${pathLabel} must be a YAML object`);
    }

    return {
      frontmatter: parsedFrontmatter,
      body: match[2],
    };
  }

  private serializeSkillMarkdown(frontmatter: Record<string, unknown>, body: string): string {
    const yamlBody = yaml.dump(frontmatter, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: true,
    });
    const normalizedBody = body.trim();
    return `---\n${yamlBody}---\n\n${normalizedBody}\n`;
  }

  private readRequiredString(
    source: Record<string, unknown>,
    field: string,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>,
    path: string
  ): string | undefined {
    const value = source[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    warnings.push({
      code: 'missing_required_field',
      path,
      message: `Required string field '${field}' was missing or empty.`,
      preserved: false,
    });
    unsupportedFields.add(path);
    return undefined;
  }

  private readString(source: Record<string, unknown>, field: string): string | undefined {
    const value = source[field];
    return typeof value === 'string' ? value : undefined;
  }

  private buildDollhouseContent(
    resourceDirectories: ResourceDirectories,
    topLevelFiles: Record<string, string>
  ): string {
    const sections: string[] = [];

    const knownOrder = [REFERENCES_DIRECTORY, 'scripts/', 'agents/', 'assets/'];
    const discoveredDirectories = Object.keys(resourceDirectories);
    const orderedDirectories = [
      ...knownOrder.filter(path => Object.hasOwn(resourceDirectories, path)),
      ...discoveredDirectories
        .filter(path => !knownOrder.includes(path))
        .sort((a, b) => a.localeCompare(b)),
    ];

    for (const directory of orderedDirectories) {
      const files = resourceDirectories[directory];
      if (!files) {
        continue;
      }
      const sortedFiles = Object.keys(files).sort((a, b) => a.localeCompare(b));
      if (sortedFiles.length === 0) {
        continue;
      }

      const fileBlocks: string[] = [];
      for (const fileName of sortedFiles) {
        const content = files[fileName];
        const pathReference = `${directory}${fileName}`;
        fileBlocks.push(this.buildContentBlock(pathReference, content, directory));
      }
      sections.push(`## ${getSectionTitle(directory)}\n\n${fileBlocks.join('\n\n')}`);
    }

    const topLevelNames = Object.keys(topLevelFiles).sort((a, b) => a.localeCompare(b));
    if (topLevelNames.length > 0) {
      const topLevelBlocks = topLevelNames.map(fileName =>
        this.buildContentBlock(`${TOP_LEVEL_CONTENT_PREFIX}${fileName}`, topLevelFiles[fileName], '')
      );
      sections.push(`## Top-level Files\n\n${topLevelBlocks.join('\n\n')}`);
    }

    return sections.join('\n\n').trim();
  }

  private buildContentBlock(pathReference: string, content: string, directory: string): string {
    if (isBinaryFile(pathReference, content)) {
      const linkTarget = deriveBinaryLinkTarget(pathReference, content);
      return `### ${pathReference}\n\`\`\`${BINARY_LINK_FENCE}\n${linkTarget}\n\`\`\``;
    }

    const defaultLanguage = getDefaultLanguageForDirectory(directory);
    const shouldInferLanguage = shouldInferLanguageForDirectory(directory);
    const language = shouldInferLanguage
      ? inferLanguageFromFilename(pathReference, defaultLanguage)
      : defaultLanguage;
    const normalizedContent = content.endsWith('\n')
      ? content
      : `${content}\n`;
    return `### ${pathReference}\n\`\`\`${language}\n${normalizedContent}\`\`\``;
  }

  private parseDollhouseContentBlock(match: RegExpExecArray): ParsedDollhouseContentBlock {
    const leadingOffset = match[0].startsWith('\n') ? 1 : 0;
    const start = match.index + leadingOffset;
    const end = start + match[0].length - leadingOffset;
    const fileReference = match[1].trim();
    const fenceLanguage = match[2].trim().toLowerCase();
    let fileContent = match[3];

    // Backward compatibility: earlier formatter inserted an extra blank line
    // after the opening fence and before the closing fence.
    if (match[0].includes('```\n\n') && fileContent.startsWith('\n')) {
      fileContent = fileContent.slice(1);
    }
    if (match[0].includes('\n\n```') && fileContent.endsWith('\n')) {
      fileContent = fileContent.slice(0, -1);
    }

    const normalizedFileContent = fenceLanguage === BINARY_LINK_FENCE
      ? `${BINARY_LINK_PREFIX}${fileContent.trim()}`
      : fileContent;
    return { fileReference, normalizedFileContent, span: { start, end } };
  }

  private mapDollhouseContentBlock(
    block: ParsedDollhouseContentBlock,
    resourceDirectories: ResourceDirectories,
    topLevelFiles: Record<string, string>,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>,
    pathMode: SkillPathMode
  ): boolean {
    if (block.fileReference.startsWith(TOP_LEVEL_CONTENT_PREFIX)) {
      return this.mapDollhouseTopLevelBlock(block, topLevelFiles, warnings, unsupportedFields, pathMode);
    }
    return this.mapDollhouseResourceBlock(
      block,
      resourceDirectories,
      warnings,
      unsupportedFields,
      pathMode
    );
  }

  private mapDollhouseTopLevelBlock(
    block: ParsedDollhouseContentBlock,
    topLevelFiles: Record<string, string>,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>,
    pathMode: SkillPathMode
  ): boolean {
    const topLevelName = block.fileReference.slice(TOP_LEVEL_CONTENT_PREFIX.length).trim();
    const isInvalid = topLevelName.length === 0
      || (pathMode === 'safe' && !isSafeTopLevelFileName(topLevelName));
    if (isInvalid) {
      warnings.push({
        code: 'invalid_input',
        path: `dollhouse.content.${block.fileReference}`,
        message: `Top-level content block '${block.fileReference}' is not a valid${pathMode === 'safe' ? ' safe' : ''} top-level filename.`,
        preserved: false,
      });
      unsupportedFields.add(`dollhouse.content.${block.fileReference}`);
      return false;
    }
    topLevelFiles[topLevelName] = block.normalizedFileContent;
    return true;
  }

  private mapDollhouseResourceBlock(
    block: ParsedDollhouseContentBlock,
    resourceDirectories: ResourceDirectories,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>,
    pathMode: SkillPathMode
  ): boolean {
    const slashIndex = block.fileReference.indexOf('/');
    if (slashIndex <= 0 || slashIndex >= block.fileReference.length - 1) {
      warnings.push({
        code: 'unsupported_field',
        path: `dollhouse.content.${block.fileReference}`,
        message: `Content block '${block.fileReference}' is not in a recognized '<directory>/<file>' format.`,
        preserved: true,
      });
      unsupportedFields.add(`dollhouse.content.${block.fileReference}`);
      return false;
    }

    const directory = `${block.fileReference.slice(0, slashIndex + 1)}`;
    const fileName = block.fileReference.slice(slashIndex + 1);
    if (pathMode === 'safe' && (!isAllowedAgentDirectory(directory) || !isSafeDirectoryName(directory))) {
      warnings.push({
        code: 'unsupported_field',
        path: `dollhouse.content.${block.fileReference}`,
        message: `Directory '${directory}' is not in the allowed converter directory set.`,
        preserved: true,
      });
      unsupportedFields.add(`dollhouse.content.${block.fileReference}`);
      return false;
    }
    if (pathMode === 'safe' && !isSafeRelativePath(fileName)) {
      warnings.push({
        code: 'invalid_input',
        path: `dollhouse.content.${block.fileReference}`,
        message: `File path '${fileName}' is not a safe relative path.`,
        preserved: false,
      });
      unsupportedFields.add(`dollhouse.content.${block.fileReference}`);
      return false;
    }
    const directoryFiles = this.ensureResourceDirectory(resourceDirectories, directory);
    directoryFiles[fileName] = block.normalizedFileContent;
    return true;
  }

  private removeMappedContentSpans(content: string, mappedSpans: Array<{ start: number; end: number }>): string {
    if (mappedSpans.length === 0) {
      return content;
    }
    const sortedSpans = [...mappedSpans];
    sortedSpans.sort((a, b) => a.start - b.start);
    const pieces: string[] = [];
    let cursor = 0;
    for (const span of sortedSpans) {
      pieces.push(content.slice(cursor, span.start));
      cursor = span.end;
    }
    pieces.push(content.slice(cursor));
    return pieces.join('');
  }

  private cleanResidualDollhouseContent(content: string): string {
    const withoutMappedSectionHeadings = content
      .replaceAll(/^## (References|Scripts|Assets|Agent Metadata|Top-level Files|Directory: .+)\n?/gm, '')
      .replaceAll(/\n{3,}/g, '\n\n');
    return pruneOrphanSectionHeadings(withoutMappedSectionHeadings).trim();
  }

  private extractResourcesFromDollhouseContent(
    content: string,
    warnings: ConversionWarning[],
    unsupportedFields: Set<string>,
    pathMode: SkillPathMode
  ): {
    resourceDirectories: ResourceDirectories;
    topLevelFiles: Record<string, string>;
    residualContent: string;
  } {
    const resourceDirectories: ResourceDirectories = {};
    const topLevelFiles: Record<string, string> = {};
    if (content.trim().length === 0) {
      return {
        resourceDirectories,
        topLevelFiles,
        residualContent: '',
      };
    }

    const mappedSpans: Array<{ start: number; end: number }> = [];
    const blockRegex = /(?:^|\n)### ([^\n]+)\n(?:\n)?```([^\n]*)\n([\s\S]*?)\n```(?=\n|$)/g;
    let match: RegExpExecArray | null = null;
    while ((match = blockRegex.exec(content)) !== null) {
      const block = this.parseDollhouseContentBlock(match);
      const mapped = this.mapDollhouseContentBlock(
        block,
        resourceDirectories,
        topLevelFiles,
        warnings,
        unsupportedFields,
        pathMode
      );
      if (mapped) {
        mappedSpans.push(block.span);
      }
    }

    const residualContent = this.cleanResidualDollhouseContent(
      this.removeMappedContentSpans(content, mappedSpans)
    );

    return {
      resourceDirectories,
      topLevelFiles,
      residualContent,
    };
  }
}

function inferLanguageFromFilename(fileName: string, fallback: string): string {
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';
  if (!extension) {
    return fallback;
  }
  return LANGUAGE_BY_EXTENSION[extension] ?? fallback;
}

function getSectionTitle(directory: string): string {
  return SECTION_TITLE_BY_DIRECTORY[directory] ?? `Directory: ${directory}`;
}

function getDefaultLanguageForDirectory(directory: string): string {
  if (directory === REFERENCES_DIRECTORY) {
    return 'markdown';
  }
  if (directory === 'agents/') {
    return 'yaml';
  }
  return 'text';
}

function shouldInferLanguageForDirectory(directory: string): boolean {
  return directory !== REFERENCES_DIRECTORY;
}

function isBinaryFile(pathReference: string, content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.startsWith(BINARY_LINK_PREFIX)) {
    return true;
  }
  const extension = pathReference.includes('.') ? pathReference.split('.').pop()?.toLowerCase() : '';
  if (extension && BINARY_EXTENSIONS.has(extension) && isLikelyPathOrUrl(trimmed) && !trimmed.includes('\n')) {
    return true;
  }
  return false;
}

function deriveBinaryLinkTarget(pathReference: string, content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith(BINARY_LINK_PREFIX)) {
    return trimmed.slice(BINARY_LINK_PREFIX.length).trim();
  }
  if (isLikelyPathOrUrl(trimmed) && !trimmed.includes('\n')) {
    return trimmed;
  }
  return `./skills/binaries/${extractFileName(pathReference)}`;
}

function isLikelyPathOrUrl(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  return /^(https?:\/\/|\.{0,2}\/|\/|~\/|[A-Za-z]:[\\/])/.test(value);
}

function pruneOrphanSectionHeadings(markdown: string): string {
  const lines = markdown.split('\n');
  const cleaned: string[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    if (!line.startsWith('## ')) {
      cleaned.push(line);
      idx += 1;
      continue;
    }

    let probe = idx + 1;
    while (probe < lines.length && lines[probe].trim() === '') {
      probe += 1;
    }

    const isOrphan = probe >= lines.length || lines[probe].startsWith('## ');
    if (isOrphan) {
      idx = probe;
      continue;
    }

    cleaned.push(line);
    idx += 1;
  }

  return cleaned.join('\n');
}

function isAllowedAgentDirectory(directory: string): boolean {
  return ALLOWED_AGENT_DIRECTORIES.has(directory);
}

function isSafeDirectoryName(directory: string): boolean {
  return /^[A-Za-z0-9._-]+\/$/u.test(directory);
}

function isSafeTopLevelFileName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  if (name.includes('/') || name.includes('\\')) {
    return false;
  }
  if (name === '.' || name === '..') {
    return false;
  }
  if (name.includes('\0')) {
    return false;
  }
  return true;
}

function isSafeRelativePath(pathValue: string): boolean {
  if (pathValue.length === 0) {
    return false;
  }
  if (/^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/u.test(pathValue)) {
    return false;
  }
  if (pathValue.includes('\0') || pathValue.includes('\\')) {
    return false;
  }
  const segments = pathValue.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    return false;
  }
  return true;
}

function sanitizeRelativePathForReference(pathValue: string): string {
  const normalized = pathValue.replaceAll('\\', '/').replace(/^\/+/u, '');
  const pieces = normalized
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
    .map(segment => sanitizePathToken(segment));
  if (pieces.length === 0) {
    return 'unknown-file';
  }
  return pieces.join('/');
}

function removeTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end--;
  }
  return value.slice(0, end);
}

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') {
    start++;
  }
  while (end > start && value[end - 1] === '-') {
    end--;
  }
  return value.slice(start, end);
}

function sanitizePathToken(token: string): string {
  const cleaned = token
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/-+/g, '-');
  const trimmed = trimHyphens(cleaned);
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function extractFileName(pathReference: string): string {
  const normalized = pathReference.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(segment => segment.length > 0);
  const candidate = segments.at(-1) ?? 'binary.dat';
  return sanitizePathToken(candidate) || 'binary.dat';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
