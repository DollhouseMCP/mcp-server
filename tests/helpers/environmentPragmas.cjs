const { extract, parse } = require('jest-docblock');
const { createRequire } = require('node:module');
const { realpathSync } = require('node:fs');
const path = require('node:path');

/** Resolve pragmas as Jest does, allowing only this package's isolated environment. */
function allowsEnvironment(source, rootDirectory, environment) {
  const pragma = parse(extract(source))['jest-environment'];
  if (!pragma) return true;
  try {
    const requireFromRoot = createRequire(path.join(rootDirectory, 'package.json'));
    const resolved = requireFromRoot.resolve(pragma.replace('<rootDir>', rootDirectory));
    return realpathSync(resolved) === realpathSync(environment);
  } catch { return false; }
}
module.exports = { allowsEnvironment };
