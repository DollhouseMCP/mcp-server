/** Textual pattern heuristics, evaluated with bounded forward scans. */
export interface PatternRisks {
  risks: string[];
  quantifierCount: number;
}

interface GroupRisks {
  nested: boolean;
  repeatedAlternation: boolean;
  overlappingAlternation: boolean;
  repeatedWildcard: boolean;
}

const isRepetition = (character: string | undefined): boolean => character === '+' || character === '*';
const isDigit = (character: string | undefined): boolean => character !== undefined && character >= '0' && character <= '9';

function countQuantifiers(source: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor++];
    if (isRepetition(character) || character === '?') count++;
    if (character !== '{') continue;
    while (isDigit(source[cursor])) cursor++;
    if (source[cursor] === ',') cursor++;
    while (isDigit(source[cursor])) cursor++;
    if (source[cursor] === '}') count++;
  }
  return count;
}

function hasOverlappingAlternation(segment: string): boolean {
  const parts = segment.split('|');
  for (let i = 0; i < parts.length - 1; i++) {
    const open = parts[i].indexOf('(');
    if (open < 0 || open === parts[i].length - 1) continue;
    if (i === parts.length - 2 && parts[i + 1] === '') return false;
    const seen = new Set([parts[i].slice(open + 1)]);
    for (const part of parts.slice(i + 1)) {
      if (seen.has(part)) return true;
      seen.add(part);
    }
    // The first complete textual group consumes this closing delimiter.
    return false;
  }
  return false;
}

function inspectGroups(source: string): GroupRisks {
  const result: GroupRisks = { nested: false, repeatedAlternation: false, overlappingAlternation: false, repeatedWildcard: false };
  let offset = 0;
  for (const segment of source.split(')')) {
    const close = offset + segment.length;
    offset = close + 1;
    if (close === source.length) break;
    const open = segment.indexOf('(');
    if (open < 0) continue;
    const body = segment.slice(open + 1);
    const repetition = source[close + 1];
    result.overlappingAlternation ||= hasOverlappingAlternation(segment);
    if (isRepetition(repetition)) {
      result.nested ||= body.length >= 2 && isRepetition(body.at(-1));
      result.repeatedAlternation ||= body.includes('|');
    }
    if (repetition === '+') {
      result.repeatedWildcard ||= body.includes('.+') || body.includes('.*') || body.includes(String.raw`\w+`);
    }
  }
  return result;
}

function hasRepeatedBracedGroup(source: string): boolean {
  let open = -1;
  let brace = -1;
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (character === '(' && open < 0) open = i;
    if (character === ')') open = -1;
    if (character === '{' && brace < 0 && open >= 0 && i > open + 1) brace = i;
    if (character !== '}') continue;
    if (brace >= 0 && i > brace + 1 && source[i + 1] === ')' && isRepetition(source[i + 2])) return true;
    brace = -1;
  }
  return false;
}

function hasUnboundedLookaround(source: string): boolean {
  let lookaround = false;
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if ('\n\r\u2028\u2029'.includes(character)) lookaround = false;
    if (lookaround && isRepetition(character)) return true;
    if (character === '(' && source[i + 1] === '?' && '=!<'.includes(source[i + 2] ?? '\0')) lookaround = true;
  }
  return false;
}

export function analyzePatternRisks(source: string): PatternRisks {
  const groups = inspectGroups(source);
  const risks: string[] = [];
  if (groups.nested || hasRepeatedBracedGroup(source)) risks.push('Nested quantifiers detected');
  if (groups.repeatedAlternation) risks.push('Quantified alternation detected');
  if (groups.overlappingAlternation) risks.push('Overlapping alternation detected');
  if (groups.repeatedWildcard) risks.push('Potential catastrophic backtracking');
  if (hasUnboundedLookaround(source)) risks.push('Unbounded lookahead/lookbehind');
  const quantifierCount = countQuantifiers(source);
  if (quantifierCount > 3) risks.push('Multiple quantifiers detected');
  return { risks, quantifierCount };
}
