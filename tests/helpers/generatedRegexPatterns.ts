/** Deterministic, bounded grammar for pattern-classification comparisons. */
export function generatedRegexPatterns(count = 5000, seed = 0x5eed): string[] {
  let state = seed;
  const choose = (size: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 16) % size;
  };
  const atoms = ['a', 'b', String.raw`\d`, '[a-z]', '[^x]', '.', String.raw`\w`, String.raw`\s`];
  const quantifiers = ['*', '+', '?', '{0,2}', '{1,3}', '*?', '+?', '??', '{1,2}?'];
  const pattern = (depth: number): string => {
    if (depth === 0) return atoms[choose(atoms.length)];
    const child = pattern(depth - 1);
    switch (choose(9)) {
      case 0: return `(${child})`;
      case 1: return `(?:${child})`;
      case 2: return `${child}${pattern(depth - 1)}`;
      case 3: return `(${child}|${choose(2) ? child : pattern(depth - 1)})`;
      case 4: return `(?:${child})${quantifiers[choose(quantifiers.length)]}`;
      case 5: return `(?=${child})a`;
      case 6: return `(?<=${child})b`;
      case 7: return String.raw`(${child})\1`;
      default: return `^${child}$`;
    }
  };
  return Array.from({ length: count }, (_, index) => pattern(index % 4 + 1));
}

/** Construction shapes used by runtime-authored patterns. */
export function constructedRegexPatterns(): string[] {
  const examples: string[] = [];
  for (let index = 0; index < 64; index++) {
    const text = `sample (${index}).md`;
    const escaped = text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const alternatives = [`value${index}`, 'value', `value${index}`].join('|');
    examples.push(escaped, `^${escaped}$`, `^(${alternatives})$`, `(?:${alternatives})+`);
  }
  return examples;
}
