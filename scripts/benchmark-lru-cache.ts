/**
 * Standalone benchmark for LRU Cache size estimation
 * Can be run directly without build step
 */

type SizeEstimationMode = 'fast' | 'balanced' | 'accurate';

interface LRUCacheOptions {
  maxSize: number;
  maxMemoryMB?: number;
  ttlMs?: number;
  onEviction?: (key: string, value: any) => void;
  sizeEstimationMode?: SizeEstimationMode;
}

interface CacheStats {
  size: number;
  maxSize: number;
  hitCount: number;
  missCount: number;
  evictionCount: number;
  memoryUsageMB: number;
  hitRate: number;
}

interface CacheNode<T> {
  key: string;
  value: T;
  prev: CacheNode<T> | null;
  next: CacheNode<T> | null;
  timestamp: number;
  size: number;
}

class SimpleLRUCache<T> {
  private readonly maxSize: number;
  private readonly maxMemoryBytes: number;
  private readonly ttlMs: number;
  private readonly onEviction?: (key: string, value: T) => void;
  private readonly sizeEstimationMode: SizeEstimationMode;

  private cache = new Map<string, CacheNode<T>>();
  private head: CacheNode<T> | null = null;
  private tail: CacheNode<T> | null = null;
  private currentMemoryBytes = 0;

  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  private static readonly PRIMITIVE_SIZE = 8;
  private static readonly OBJECT_BASE_OVERHEAD = 64;
  private static readonly ARRAY_BASE_OVERHEAD = 32;
  private static readonly FIELD_OVERHEAD = 48;
  private static readonly ELEMENT_ESTIMATE = 64;
  private static readonly BALANCED_SAMPLE_SIZE = 10;

  constructor(options: LRUCacheOptions) {
    this.maxSize = options.maxSize;
    this.maxMemoryBytes = (options.maxMemoryMB || 50) * 1024 * 1024;
    this.ttlMs = options.ttlMs || 0;
    this.onEviction = options.onEviction;
    this.sizeEstimationMode = options.sizeEstimationMode || 'fast';
  }

  set(key: string, value: T): void {
    const existingNode = this.cache.get(key);

    if (existingNode) {
      const oldSize = existingNode.size;
      existingNode.value = value;
      existingNode.timestamp = Date.now();
      existingNode.size = this.estimateSize(value);

      this.currentMemoryBytes += existingNode.size - oldSize;
      this.moveToFront(existingNode);
    } else {
      const newNode: CacheNode<T> = {
        key,
        value,
        prev: null,
        next: null,
        timestamp: Date.now(),
        size: this.estimateSize(value)
      };

      this.cache.set(key, newNode);
      this.currentMemoryBytes += newNode.size;
      this.addToFront(newNode);
    }

    this.evictIfNecessary();
  }

  getStats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      evictionCount: this.evictionCount,
      memoryUsageMB: this.currentMemoryBytes / (1024 * 1024),
      hitRate: this.hitCount + this.missCount > 0 ? this.hitCount / (this.hitCount + this.missCount) : 0
    };
  }

  private moveToFront(node: CacheNode<T>): void {
    if (node === this.head) return;
    this.removeNode(node);
    this.addToFront(node);
  }

  private addToFront(node: CacheNode<T>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private removeNode(node: CacheNode<T>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
  }

  private evictIfNecessary(): void {
    while (this.cache.size > this.maxSize) {
      this.evictLeastRecentlyUsed();
    }
    while (this.currentMemoryBytes > this.maxMemoryBytes && this.tail) {
      this.evictLeastRecentlyUsed();
    }
  }

  private evictLeastRecentlyUsed(): void {
    if (!this.tail) return;
    const evicted = this.tail;
    this.removeNode(evicted);
    this.cache.delete(evicted.key);
    this.currentMemoryBytes -= evicted.size;
    this.evictionCount++;
    if (this.onEviction) {
      this.onEviction(evicted.key, evicted.value);
    }
  }

  private estimateSize(value: T): number {
    try {
      switch (this.sizeEstimationMode) {
        case 'fast':
          return this.estimateSizeFast(value);
        case 'balanced':
          return this.estimateSizeBalanced(value);
        case 'accurate':
          return this.estimateSizeAccurate(value);
        default:
          return this.estimateSizeFast(value);
      }
    } catch {
      return SimpleLRUCache.OBJECT_BASE_OVERHEAD;
    }
  }

  private estimateSizeFast(value: T): number {
    if (value === null || value === undefined) {
      return SimpleLRUCache.PRIMITIVE_SIZE;
    }

    const type = typeof value;

    if (type === 'string') {
      return (value as unknown as string).length * 2;
    }

    if (type === 'number' || type === 'boolean') {
      return SimpleLRUCache.PRIMITIVE_SIZE;
    }

    if (Array.isArray(value)) {
      return SimpleLRUCache.ARRAY_BASE_OVERHEAD + value.length * SimpleLRUCache.ELEMENT_ESTIMATE;
    }

    if (type === 'object') {
      const keyCount = Object.keys(value as object).length;
      return SimpleLRUCache.OBJECT_BASE_OVERHEAD + keyCount * SimpleLRUCache.FIELD_OVERHEAD;
    }

    return SimpleLRUCache.OBJECT_BASE_OVERHEAD;
  }

  private estimateSizeBalanced(value: T): number {
    if (value === null || value === undefined) {
      return SimpleLRUCache.PRIMITIVE_SIZE;
    }

    const type = typeof value;

    if (type === 'string') {
      return (value as unknown as string).length * 2;
    }

    if (type === 'number' || type === 'boolean') {
      return SimpleLRUCache.PRIMITIVE_SIZE;
    }

    if (Array.isArray(value)) {
      const sampleSize = Math.min(value.length, SimpleLRUCache.BALANCED_SAMPLE_SIZE);
      if (sampleSize === 0) {
        return SimpleLRUCache.ARRAY_BASE_OVERHEAD;
      }

      let sampleTotal = 0;
      for (let i = 0; i < sampleSize; i++) {
        sampleTotal += this.estimateSizeFast(value[i]);
      }
      const avgSize = sampleTotal / sampleSize;
      return SimpleLRUCache.ARRAY_BASE_OVERHEAD + value.length * avgSize;
    }

    if (type === 'object') {
      const keys = Object.keys(value as object);
      const sampleSize = Math.min(keys.length, SimpleLRUCache.BALANCED_SAMPLE_SIZE);

      if (sampleSize === 0) {
        return SimpleLRUCache.OBJECT_BASE_OVERHEAD;
      }

      let sampleTotal = 0;
      for (let i = 0; i < sampleSize; i++) {
        const key = keys[i];
        const propValue = (value as any)[key];
        sampleTotal += key.length * 2 + this.estimateSizeFast(propValue) + 16;
      }
      const avgFieldSize = sampleTotal / sampleSize;
      return SimpleLRUCache.OBJECT_BASE_OVERHEAD + keys.length * avgFieldSize;
    }

    return SimpleLRUCache.OBJECT_BASE_OVERHEAD;
  }

  private estimateSizeAccurate(value: T): number {
    if (value === null || value === undefined) {
      return SimpleLRUCache.PRIMITIVE_SIZE;
    }

    if (typeof value === 'string') {
      return (value as unknown as string).length * 2;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return SimpleLRUCache.PRIMITIVE_SIZE;
    }

    if (Array.isArray(value)) {
      return value.reduce((acc, item) => acc + this.estimateSizeAccurate(item), SimpleLRUCache.ARRAY_BASE_OVERHEAD);
    }

    if (typeof value === 'object') {
      const jsonStr = JSON.stringify(value);
      return jsonStr.length * 2 + SimpleLRUCache.OBJECT_BASE_OVERHEAD;
    }

    return SimpleLRUCache.OBJECT_BASE_OVERHEAD;
  }
}

// Benchmark code
function generateSmallObject(): any {
  return {
    id: 'test-123',
    name: 'Test Object',
    active: true,
    count: 42
  };
}

function generateMediumObject(): any {
  return {
    id: 'user-456',
    profile: {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      age: 30
    },
    settings: {
      notifications: true,
      theme: 'dark',
      language: 'en'
    },
    metadata: {
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      version: 1
    }
  };
}

function generateLargeObject(): any {
  const tags: string[] = [];
  for (let i = 0; i < 50; i++) {
    tags.push(`tag-${i}`);
  }

  const properties: Record<string, any> = {};
  for (let i = 0; i < 100; i++) {
    properties[`prop_${i}`] = {
      value: Math.random(),
      label: `Property ${i}`,
      enabled: i % 2 === 0
    };
  }

  return {
    id: 'large-789',
    tags,
    properties,
    description: 'A'.repeat(1000),
    timestamp: Date.now()
  };
}

function runBenchmark(mode: SizeEstimationMode, testData: any[], iterations: number) {
  const cache = new SimpleLRUCache<any>({
    maxSize: 1000,
    maxMemoryMB: 100,
    sizeEstimationMode: mode
  });

  const startTime = performance.now();

  for (let i = 0; i < iterations; i++) {
    const dataIndex = i % testData.length;
    cache.set(`key-${i}`, testData[dataIndex]);
  }

  const endTime = performance.now();
  const durationMs = endTime - startTime;
  const opsPerSecond = (iterations / durationMs) * 1000;

  return { mode, durationMs, opsPerSecond, operations: iterations };
}

async function main() {
  console.log('\n=== LRU Cache Size Estimation Performance Benchmark ===\n');

  const testData = [
    ...Array(100).fill(null).map(() => generateSmallObject()),
    ...Array(50).fill(null).map(() => generateMediumObject()),
    ...Array(20).fill(null).map(() => generateLargeObject())
  ];

  const iterations = 10000;
  const modes: SizeEstimationMode[] = ['accurate', 'fast', 'balanced'];

  const results: any[] = [];

  for (const mode of modes) {
    console.log(`Running ${mode} mode benchmark...`);
    const result = runBenchmark(mode, testData, iterations);
    results.push(result);
  }

  console.log('\nResults:');
  console.log('─'.repeat(80));

  const accurateResult = results.find(r => r.mode === 'accurate');

  results.forEach(result => {
    const speedup = result.opsPerSecond / accurateResult.opsPerSecond;
    console.log(`${result.mode.padEnd(12)} | ${result.durationMs.toFixed(2).padStart(10)}ms | ${Math.round(result.opsPerSecond).toLocaleString().padStart(12)} ops/sec | ${speedup.toFixed(2)}x speedup`);
  });

  console.log('─'.repeat(80));

  const fastResult = results.find(r => r.mode === 'fast');
  const speedup = fastResult.opsPerSecond / accurateResult.opsPerSecond;

  console.log(`\n✓ Fast mode achieved ${speedup.toFixed(2)}x speedup over accurate mode`);
  console.log(`✓ Performance improvement: ${((speedup - 1) * 100).toFixed(0)}%\n`);

  if (speedup >= 2.0) {
    console.log('SUCCESS: Fast mode meets performance target (2-5x speedup)');
  } else if (speedup >= 1.5) {
    console.log('PARTIAL: Fast mode shows improvement but below 2x target');
  } else {
    console.log('FAILED: Fast mode does not meet performance target');
  }
}

main();

export {};
