/** Repository inputs are read from the pinned base revision for reproducible regeneration. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { BASELINE_REVISION, readAtBaseline } from './baseline-inputs.mjs';
import { serializeAsciiJson } from './serialize-ascii-json.mjs';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('An explicit output path is required');
const revision = BASELINE_REVISION;
const original = readAtBaseline('src/security/regexValidator.ts');
const sf = ts.createSourceFile('reference.ts', original, ts.ScriptTarget.Latest, true);
let method = '';
let limits = '';
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(sf) === 'analyzePattern') method = node.getText(sf);
  if (ts.isPropertyDeclaration(node) && node.name.getText(sf) === 'COMPLEXITY_LIMITS') limits = node.getText(sf);
  ts.forEachChild(node, visit);
}
visit(sf);
const hash = crypto.createHash('sha256').update(method).digest('hex');
if (hash !== '957d288522d507dc1f3f04b9bcfdd6b7bce23272ec3f26202532f474f3b1977b') throw new Error('Reference text changed');
const compile = text => ts.transpile(text, {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022});
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'regex-classification-'));
try {
  fs.writeFileSync(path.join(temporaryDirectory, 'BaselinePatternClassifier.mjs'), compile(`export class BaselinePatternClassifier { ${limits}\n${method}\n}`));
  fs.writeFileSync(path.join(temporaryDirectory, 'GeneratedPatternCorpus.mjs'), compile(fs.readFileSync('tests/helpers/generatedRegexPatterns.ts', 'utf8')));

  const {BaselinePatternClassifier} = await import(pathToFileURL(path.join(temporaryDirectory, 'BaselinePatternClassifier.mjs')).href);
  const {generatedRegexPatterns, constructedRegexPatterns} = await import(pathToFileURL(path.join(temporaryDirectory, 'GeneratedPatternCorpus.mjs')).href);
  const corpus = JSON.parse(fs.readFileSync('tests/fixtures/security/regex-source-corpus.json', 'utf8'));
  const entries = [
    ...corpus.entries.map(({source, flags, site}) => ({group: site.startsWith('src/') ? 'source' : 'test', source, flags})),
    ...generatedRegexPatterns().map(source => ({group: 'generated', source, flags: ''})),
    ...constructedRegexPatterns().map(source => ({group: 'constructed', source, flags: ''})),
  ].map(entry => {
    let expected;
    try { expected = {value: BaselinePatternClassifier.analyzePattern(new RegExp(entry.source, entry.flags))}; }
    catch (error) { expected = {error: error.name, message: error.message}; }
    return {...entry, expected};
  });
  const header = {
    revision, methodSha256: hash, seed: 0x5eed, node: process.version,
    generationCommand: 'node scripts/testing/generate-regex-classification-golden.mjs tests/fixtures/security/regex-pattern-analysis.golden.json',
    inputs: ['tests/fixtures/security/regex-source-corpus.json', 'tests/helpers/generatedRegexPatterns.ts'],
    sourceCases: entries.filter(e => e.group === 'source').length,
    testCases: entries.filter(e => e.group === 'test').length,
    generatedCases: 5000, constructedCases: 256,
  };
  const output = '{\n  "header": ' + serializeAsciiJson(header) + ',\n  "entries": [\n' + entries.map(entry => '    ' + serializeAsciiJson(entry)).join(',\n') + '\n  ]\n}\n';
  fs.writeFileSync(outputPath, output);
  console.log(JSON.stringify({entries: entries.length, bytes: Buffer.byteLength(output), header}));
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
