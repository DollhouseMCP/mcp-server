/** Largest delay accepted by Node timers without overflowing to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Node's timer limit is a wake-up boundary, never the absolute deadline. */
export function atDeadline(deadline: number, action: () => void): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const arm = (): void => {
    timer = setTimeout(() => {
      if (stopped) return;
      if (Date.now() < deadline) { arm(); return; }
      action();
    }, Math.max(0, Math.min(deadline - Date.now(), MAX_TIMER_DELAY_MS)));
    timer.unref();
  };
  arm();
  return () => { stopped = true; clearTimeout(timer); };
}

