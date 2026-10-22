These notices cover small source adaptations, not bundled npm packages.

* `../security/frontmatter.ts` adapts the parsing, language detection, excerpt,
  and stringification subset of gray-matter 4.0.3 (Jon Schlinkert, MIT).
  The application uses its existing direct js-yaml dependency. Executable
  engines, filesystem methods, sections, and the global cache are excluded.
  Production secure wrappers retain ownership of their YAML/JSON engines.
* `../web/routes/clientConfigInstaller.ts` adapts the global client path mapping
  and named stdio configuration subset of install-mcp 1.10.2 (Dhravya Shah, MIT).
  Setup only installs the DollhouseMCP server; arbitrary command/URL parsing,
  discovery, prompts, OAuth, local-project installation, and downloads are
  outside its existing call contract. All routed clients remain supported;
  LM Studio retains its existing dedicated writer. Invalid existing configs
  now fail without overwriting them, and writes replace files atomically while
  preserving managed symlinks.

Both source tarballs were fetched from the official npm registry and matched
their registry SHA-512 integrity values. Their license text is copied verbatim
in this directory and included in the npm package's `files` list. Removing the
two npm dependencies removes their unused vulnerable transitive dependency
graphs for downstream consumers as well as repository installs.
