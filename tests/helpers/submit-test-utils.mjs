/** Return the first genuine GitHub URL, ignoring malformed response tokens. */
export function findGitHubUrl(text) {
  for (const candidate of text.match(/https?:\/\/[^\s]+/g) ?? []) {
    try {
      const { hostname } = new URL(candidate);
      if (hostname === 'github.com' || hostname === 'www.github.com') return candidate;
    } catch { /* Ignore malformed URL tokens in tool output. */ }
  }
  return undefined;
}
