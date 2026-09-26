/** Small value constructors shared by the catalog families. */

export const s = (title, text, extras = {}) => ({ title, text, ...extras });
export const r = (id, label, steps) => ({ id, label, steps });
export const c = (id, label, group, summary, docsUrl, routes, availability) =>
  ({ id, label, group, summary, docsUrl, routes, ...(availability ? { availability } : {}) });
export const endpointStep = (url) => s('MCP endpoint', 'Copy this hosted URL into the client.', { value: url, copyLabel: 'Copy endpoint' });
