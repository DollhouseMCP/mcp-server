/** Repository inputs are read from the pinned base revision for reproducible regeneration. */
import { writeFileSync } from 'node:fs';
import ts from 'typescript';
import { listAtBaseline, readAtBaseline, baselineCompilerHost } from './baseline-inputs.mjs';
import { serializeAsciiJson } from './serialize-ascii-json.mjs';

const testFiles = new Set([
  'tests/security/regexValidator.test.ts',
  'tests/security/redos-pathological-inputs.test.ts',
  'tests/unit/handlers/mcp-aql/policies/ElementPolicies.externalRestrictions.test.ts',
  'tests/unit/handlers/element-crud/helpers.helper.test.ts',
]);
const files = [...listAtBaseline('src').filter(file => /\.(?:[cm]?js|tsx?)$/.test(file)).sort(), ...testFiles];
const options = { allowJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
const program = ts.createProgram(files, options, baselineCompilerHost(ts, options));
const checker = program.getTypeChecker();
const entries = [];
const dynamic = [];

function isAliasSymbol(symbol) {
  return symbol.declarations?.some(declaration =>
    ts.isImportSpecifier(declaration)
    || (ts.isImportClause(declaration) && declaration.name !== undefined)
    || ts.isNamespaceImport(declaration)
    || ts.isExportSpecifier(declaration)
    || ts.isImportEqualsDeclaration(declaration)
    || ts.isNamespaceExport(declaration)
    || ts.isNamespaceExportDeclaration(declaration)) ?? false;
}

function constantText(node, seen = new Set()) {
  if (!node || seen.has(node)) return undefined;
  seen.add(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && isAliasSymbol(symbol)) symbol = checker.getAliasedSymbol(symbol);
    return constantText(symbol?.valueDeclaration?.initializer, seen);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantText(node.left, new Set(seen));
    const right = constantText(node.right, new Set(seen));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTaggedTemplateExpression(node) && node.tag.getText() === 'String.raw' && ts.isNoSubstitutionTemplateLiteral(node.template)) {
    return node.template.rawText;
  }
  return undefined;
}

function sourceOfLiteral(node, sf) {
  const text = node.getText(sf);
  const delimiter = text.lastIndexOf('/');
  return { source: text.slice(1, delimiter), flags: text.slice(delimiter + 1) };
}

function isTestData(node) {
  if (ts.isImportDeclaration(node.parent)) return false;
  const parent = node.parent;
  return !(ts.isCallExpression(parent) && parent.arguments[0] === node && /^(?:it|test|describe)(?:\.|$)/.test(parent.expression.getText()));
}

function enclosingSymbol(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name) return parent.name.getText();
  }
  return '<module>';
}

function capture(node, sf, file) {
  const site = `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  if (ts.isRegularExpressionLiteral(node)) {
    entries.push({ site, kind: 'literal', ...sourceOfLiteral(node, sf) });
  } else if (ts.isNewExpression(node) && node.expression.getText(sf) === 'RegExp') {
    const source = constantText(node.arguments?.[0]);
    const flags = node.arguments?.[1] ? constantText(node.arguments[1]) : '';
    if (source !== undefined && flags !== undefined) entries.push({ site, kind: 'constructor', source, flags });
    else dynamic.push({ site, symbol: enclosingSymbol(node), expression: node.getText(sf), source: source ?? null, flags: flags ?? null });
  } else if (testFiles.has(file) && ts.isStringLiteralLike(node) && isTestData(node)) {
    // Include all test data strings, a superset of the string-authored patterns.
    entries.push({ site, kind: 'test-data', source: node.text, flags: '' });
  }
}

for (const file of files) {
  const sf = program.getSourceFile(file) ?? ts.createSourceFile(file, readAtBaseline(file), ts.ScriptTarget.Latest, true);
  const visit = node => { capture(node, sf, file); ts.forEachChild(node, visit); };
  visit(sf);
}
const rows = values => values.map(value => '    ' + serializeAsciiJson(value)).join(',\n');
const fixture = '{\n  "entries": [\n' + rows(entries) + '\n  ],\n  "dynamic": [\n' + rows(dynamic) + '\n  ]\n}\n';
writeFileSync('tests/fixtures/security/regex-source-corpus.json', fixture);
console.log(JSON.stringify({ entries: entries.length, dynamic: dynamic.length }));
