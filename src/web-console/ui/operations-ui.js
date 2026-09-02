/** Shared, operator-safe presentation and cursor helpers. */

export function createCursorPager() {
  let page = {};
  const history = [];

  return Object.freeze({
    apply(nextPage) {
      page = nextPage && typeof nextPage === 'object' ? nextPage : {};
    },
    reset() {
      page = {};
      history.length = 0;
    },
    cursor() {
      return page.cursor;
    },
    nextCursor() {
      return page.next_cursor;
    },
    hasPrevious() {
      return history.length > 0;
    },
    moveNext() {
      if (!page.next_cursor) return false;
      history.push(page.cursor ?? null);
      page = { cursor: page.next_cursor };
      return true;
    },
    movePrevious() {
      if (history.length === 0) return false;
      page = { cursor: history.pop() };
      return true;
    },
  });
}

export function responseDetail(response, fallback) {
  return typeof response?.body?.detail === 'string' ? response.body.detail : fallback;
}

export function formatTimestamp(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

export function escapeHtml(value) {
  return String(value ?? '').replaceAll(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

export function escapeAttr(value) {
  return escapeHtml(value);
}
