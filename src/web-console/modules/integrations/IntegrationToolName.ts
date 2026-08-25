export function normalizeIntegrationToolName(value: string, fallback: string): string {
  let normalized = '';
  let replacingInvalidRun = false;
  for (const character of value.toLowerCase()) {
    const isLetter = character >= 'a' && character <= 'z';
    const isDigit = character >= '0' && character <= '9';
    if (isLetter || isDigit || character === '_') {
      normalized += character;
      replacingInvalidRun = false;
    } else if (!replacingInvalidRun) {
      normalized += '_';
      replacingInvalidRun = true;
    }
  }
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === '_') start += 1;
  while (end > start && normalized[end - 1] === '_') end -= 1;
  return normalized.slice(start, end) || fallback;
}
