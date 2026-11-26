/**
 * The one owner of each element type's definition extension: the managers' getFileExtension and
 * the database layer's caller names read it, so the two cannot drift.
 */
export const ELEMENT_FILE_EXTENSIONS = {
  personas: '.md', skills: '.md', templates: '.md', agents: '.md', ensembles: '.md', memories: '.yaml',
} as const;

/** The alternative spellings a definition extension accepts: '.yml' for '.yaml'. */
const EXTENSION_ALIASES: Readonly<Record<string, readonly string[]>> = { '.yaml': ['.yml'] };

/**
 * The extensions a reference to a definition may carry: the type's own extension and its aliases.
 * The file layer's exact-reference rule and the database layer's caller names both read it.
 */
export function acceptedExtensions(extension: string): readonly string[] {
  return [extension, ...(EXTENSION_ALIASES[extension] ?? [])];
}

/** The seeder and the layout detector must agree on which shipped files are defaults. */
export function isBundledElementFilename(filename: string, elementType: string): boolean {
  return filename.endsWith('.md') || (
    elementType === 'memories' && acceptedExtensions(ELEMENT_FILE_EXTENSIONS.memories)
      .some(extension => filename.endsWith(extension))
  );
}
