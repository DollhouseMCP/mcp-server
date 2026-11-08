import { acceptedExtensions } from './elementFileExtensions.js';
export { ELEMENT_FILE_EXTENSIONS, acceptedExtensions } from './elementFileExtensions.js';
/**
 * One normalization for every element name comparison. Storage attributes FAILED records with
 * it and exposes the healthy candidates a name lookup could select; the resolver's selector and
 * every listing consumer compare with the same keys, so no caller can disagree with the index.
 */
import { basename, extname } from 'node:path';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { sanitizeInput } from '../security/InputValidator.js';
import { normalizeElementFilename } from '../utils/filesystem.js';
import { PathValidator } from '../security/pathValidator.js';
import { DEFAULT_MEMORY_NAME } from '../elements/memories/constants.js';

/** The longest element name any element keeps; longer names are truncated by canonicalisation. */
export const MAX_ELEMENT_NAME_LENGTH = 100;

/** A healthy index entry offered to the shared selector. */
export interface NamedCandidate { reference: string; name: string }

/** One canonicalisation pass; a pass can expose text the next pass changes (a stripped quote before a combining mark). */
function canonicalPass(raw: string): string {
  return sanitizeInput(UnicodeValidator.normalize(raw).normalizedContent, MAX_ELEMENT_NAME_LENGTH);
}

/** Passes needed to reach the fixed point for any input; each pass only removes or composes characters. */
const MAX_CANONICAL_PASSES = 4;

/**
 * The one canonical form of an element name: Unicode-normalised, then the input sanitiser, then
 * truncated to the name limit, repeated to its fixed point so canonical(canonical(x)) is
 * canonical(x). Element hydration, the file and memory indexes, database writes and both selection
 * keys use it, so a stored name and the name an element carries never disagree. Two stored names
 * that collide after canonicalising are ambiguity the certification refuses.
 */
export function canonicalElementName(raw: string): string {
  let current = canonicalPass(raw);
  for (let pass = 1; pass < MAX_CANONICAL_PASSES; pass++) {
    const next = canonicalPass(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

const DEFAULT_ELEMENT_NAMES: Readonly<Record<string, string>> = {
  personas: 'Untitled Persona', skills: 'Untitled Skill', templates: 'Untitled Template',
  agents: 'Untitled Agent', ensembles: 'Untitled Ensemble', memories: DEFAULT_MEMORY_NAME,
};

/** The one default for a definition whose name is missing or canonicalises to nothing, per element type. */
export function defaultElementName(elementType?: string): string {
  return (elementType && DEFAULT_ELEMENT_NAMES[elementType]) || 'unnamed';
}

/**
 * The name a stored definition carries, in the index and once hydrated alike: its canonical name,
 * or the type's one default. A definition with no name at all is named by `missingNameFallback`
 * when the reader has one (the loader names a nameless file by its filename stem). Several
 * definitions that default alike are an ambiguity, as any collision is.
 */
export function storedElementName(raw: unknown, elementType?: string, missingNameFallback?: string): string {
  const source = raw === undefined || raw === null || raw === '' ? missingNameFallback : raw;
  return (typeof source === 'string' ? canonicalElementName(source) : '') || defaultElementName(elementType);
}

interface NameKeys { folded: string; slug: string }

/** Distinct names whose keys are kept; the keys are pure, so a bounded memo only saves recomputation. */
const MAX_MEMOISED_NAMES = 20_000;
const memoisedKeys = new Map<string, NameKeys>();

/** Both selection keys of a name, computed once per distinct text (canonicalisation is the cost). */
function nameKeys(name: string): NameKeys {
  const known = memoisedKeys.get(name);
  if (known) return known;
  const canonical = canonicalElementName(name);
  const keys = { folded: canonical.toLowerCase(), slug: canonical === '' ? '' : normalizeElementFilename(canonical) };
  if (memoisedKeys.size >= MAX_MEMOISED_NAMES) {
    const oldest = memoisedKeys.keys().next();
    if (!oldest.done) memoisedKeys.delete(oldest.value);
  }
  memoisedKeys.set(name, keys);
  return keys;
}

/** Case-folded canonical name; the file index is keyed by it. A name that canonicalises to nothing has no key. */
export function foldedNameKey(name: string): string {
  return nameKeys(name).folded;
}

/** Filename-shaped form of a canonical name; the slug tier of selection. Blank input has no key. */
export function slugNameKey(name: string): string {
  return nameKeys(name).slug;
}

/**
 * Filename-shaped form of the caller's own text (Unicode-normalised, never sanitised): a filename
 * can only witness what was asked, so the tie-break between candidates that canonicalise alike
 * compares the stored filename with this key, not with the canonical one.
 */
function askedFilenameKey(identifier: string): string {
  const normalized = UnicodeValidator.normalize(identifier).normalizedContent;
  return normalized.trim() === '' ? '' : normalizeElementFilename(normalized);
}

/** Filename-derived key of a storage reference, extension removed. */
export function filenameKey(reference: string): string {
  return normalizeElementFilename(basename(reference, extname(reference)));
}

/**
 * The tier a healthy entry can be selected by: exact storage reference, folded metadata name,
 * then metadata slug (never for a name holding a separator). A filename alone never selects; it
 * only breaks ties within one tier.
 */
export function namedCandidateTier(identifier: string, candidate: NamedCandidate,
  options: { reference?: boolean } = {}): 0 | 1 | 2 | undefined {
  if (options.reference !== false && candidate.reference === identifier) return 0;
  const folded = foldedNameKey(identifier);
  if (folded !== '' && foldedNameKey(candidate.name) === folded) return 1;
  // Path-shaped text ('CI/CD Helper', 'Save 50%25 Now') selects only by exact or folded name: its
  // slug would collide with an unrelated name ('team/notes' and 'Team Notes' share 'team-notes').
  if (PathValidator.isPathShaped(identifier)) return undefined;
  const key = slugNameKey(identifier);
  if (key !== '' && slugNameKey(candidate.name) === key) return 2;
  return undefined;
}

export interface NamedSelection<T extends NamedCandidate> {
  /** The one entry the identifier selects; undefined when nothing matches or the match is ambiguous. */
  selected: T | undefined;
  /** The same-tier entries that could not be told apart; empty unless the match is ambiguous. */
  competitors: readonly T[];
}

/**
 * The names caller text selects a database row by: the text as written, then, for a plain
 * filename ('readme.md'; never path-shaped text such as 'team/notes.md'), its extension-stripped
 * name ('readme'). The database layer offers them as its callerNames, and the shared selector ranks
 * their candidates together, so reads, existence checks, deletes and agent reads of one text select
 * one row.
 */
export function databaseNameCandidates(text: string, extension: string): string[] {
  const carried = extension ? acceptedExtensions(extension).find(candidate => text.toLowerCase().endsWith(candidate.toLowerCase())) : undefined;
  if (!carried || PathValidator.isPathShaped(text)) return [text];
  const stripped = text.slice(0, -carried.length);
  return stripped ? [text, stripped] : [text];
}

/**
 * The one selection rule: the best tier wins; within it a filename key breaks a tie, and anything
 * still tied is ambiguous. Pure, so the storage layer and the read contract report ambiguity in
 * their own error shapes from the same decision.
 */
export function resolveNamedCandidate<T extends NamedCandidate>(identifier: string, candidates: readonly T[]): NamedSelection<T> {
  return resolveNamedCandidateAmong([identifier], candidates);
}

/**
 * The selection rule over every name one caller text addresses (the storage layer's callerNames:
 * the text itself, and on the database its extension-stripped name). Candidates of all the names
 * are ranked together: the best tier wins, and at one tier the text as written comes before its
 * stripped form, so an exact match on the stripped name beats a slug match on the text as written.
 * Within one rank a filename key breaks a tie, and anything still tied is ambiguous.
 */
export function resolveNamedCandidateAmong<T extends NamedCandidate>(names: readonly string[], candidates: readonly T[]): NamedSelection<T> {
  const ranks: T[][] = [];
  for (const candidate of candidates) {
    let best: number | undefined;
    names.forEach((name, index) => {
      // Only the text as written can be a storage reference; an added name (a stripped extension)
      // offers the name tiers alone, so '<row id>.md' never selects the row by its id.
      const tier = namedCandidateTier(name, candidate, { reference: index === 0 });
      if (tier !== undefined) best = Math.min(best ?? Infinity, tier * names.length + index);
    });
    if (best === undefined) continue;
    ranks[best] ??= [];
    ranks[best].push(candidate);
  }
  const matches = ranks.find(rank => rank !== undefined && rank.length > 0) ?? [];
  if (matches.length <= 1) return { selected: matches[0], competitors: [] };
  const key = askedFilenameKey(names[0]);
  const filenames = matches.filter(candidate => key !== '' && filenameKey(candidate.reference) === key);
  if (filenames.length === 1) return { selected: filenames[0], competitors: [] };
  return { selected: undefined, competitors: matches };
}

/** Attribute a failed record conservatively; this does not select healthy metadata. */
export function couldHoldElementName(reference: string, names: readonly string[], identifier: string): boolean {
  if (reference === identifier) return true;
  const query = /\.(?:md|markdown|yaml|yml)$/i.test(identifier) ? basename(identifier, extname(identifier)) : identifier;
  const key = slugNameKey(query);
  const asked = askedFilenameKey(query);
  const folded = foldedNameKey(identifier);
  // Conservative: the record's filename attributes it under the canonical slug and the caller's own text.
  const filename = filenameKey(reference);
  return names.some(name => folded !== '' && foldedNameKey(name) === folded || key !== '' && slugNameKey(name) === key)
    || key !== '' && filename === key || asked !== '' && filename === asked;
}
