/** A live Set whose entries carry an in-process activation lifetime. */
export class ActivationSet extends Set<string> {
  readonly #lifetimes = new Map<string, symbol>();

  constructor(values?: Iterable<string>) {
    super();
    if (values) for (const value of values) this.add(value);
  }

  override add(key: string): this {
    this.#lifetimes.set(key, Symbol(key));
    return super.add(key);
  }

  override delete(key: string): boolean {
    this.#lifetimes.delete(key);
    return super.delete(key);
  }

  override clear(): void {
    this.#lifetimes.clear();
    super.clear();
  }

  /** Capture without retaining tombstones; a newer add supersedes this cleanup. */
  captureDeletion(key: string): () => boolean {
    const captured = this.#lifetimes.get(key);
    return () => {
      const current = this.#lifetimes.get(key);
      if (current !== undefined && current !== captured) return false;
      this.delete(key);
      return true;
    };
  }
}
