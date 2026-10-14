/** Own Jest callbacks, since a Jest timeout does not settle their promises.
 * Only test-owned boundaries cooperate; admitted product operations finish normally.
 */
export class OwnedStorageCase {
  private state: 'idle' | 'open' | 'closing' | 'blocked' = 'idle';
  private readonly pending = new Set<Promise<unknown>>();

  begin(): void {
    if (this.state !== 'idle') throw new Error('Previous storage case has not completed safe cleanup');
    this.state = 'open';
  }

  checkpoint(): void {
    if (this.state !== 'open') throw new Error('Storage case work admission is closed');
  }

  own<Args extends unknown[], Result>(body: (...args: Args) => Result | Promise<Result>): (...args: Args) => Promise<Result> {
    return (...args) => {
      this.checkpoint();
      // Register before invoking the callback, including its synchronous prefix.
      const original = Promise.resolve().then(() => body(...args));
      this.pending.add(original);
      void original.then(() => this.pending.delete(original), () => this.pending.delete(original));
      return original;
    };
  }

  async teardown(cleanup: () => Promise<void>, hookBudgetMs = 10000): Promise<void> {
    if (this.state !== 'open') throw new Error('Storage cleanup refused: previous case is not safely settled');
    this.state = 'closing';
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One budget for drain AND cleanup. Leave 100ms for reporting before Jest's
    // existing hook deadline; this never grants a fresh budget to either phase.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true; this.state = 'blocked';
        reject(new Error('Storage case did not settle and clean up within the existing hook budget; safe cleanup not established'));
      }, Math.max(0, hookBudgetMs - 100));
    });
    try {
      await Promise.race([deadline, (async () => {
        await Promise.allSettled([...this.pending]);
        if (expired) return; // Never resume teardown after failing closed.
        await cleanup();
        if (!expired) this.state = 'idle';
      })()]);
    } catch (cause) {
      this.state = 'blocked';
      throw cause;
    } finally { clearTimeout(timer); }
  }
}
