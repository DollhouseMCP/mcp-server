export class AsyncKeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.tails.set(key, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === queued) {
        this.tails.delete(key);
      }
    }
  }
}
