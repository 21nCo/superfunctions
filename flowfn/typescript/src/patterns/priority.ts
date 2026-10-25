/**
 * Priority queue pattern for FlowFn
 */

export interface PriorityItem<T> {
  value: T;
  priority: number;
}

/**
 * Priority queue implementation using binary heap
 */
export class PriorityQueue<T> {
  private heap: PriorityItem<T>[] = [];
  private compareFn: (a: number, b: number) => number;

  constructor(mode: "min" | "max" = "max") {
    // Max heap by default (higher priority first)
    this.compareFn =
      mode === "max"
        ? (a, b) => a - b // Max heap: parent >= children
        : (a, b) => b - a; // Min heap: parent <= children
  }

  /**
   * Add item with priority
   */
  enqueue(value: T, priority: number): void {
    this.heap.push({ value, priority });
    this.bubbleUp(this.heap.length - 1);
  }

  /**
   * Remove and return highest priority item
   */
  dequeue(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop()!.value;

    const result = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);

    return result.value;
  }

  /**
   * Peek at highest priority item without removing
   */
  peek(): T | undefined {
    return this.heap[0]?.value;
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.heap.length;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.heap = [];
  }

  /**
   * Convert to array (sorted by priority)
   */
  toArray(): T[] {
    const copy = [...this.heap];
    const result: T[] = [];

    while (this.heap.length > 0) {
      result.push(this.dequeue()!);
    }

    this.heap = copy;
    return result;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);

      if (
        this.compareFn(
          this.heap[index].priority,
          this.heap[parentIndex].priority,
        ) <= 0
      ) {
        break;
      }

      [this.heap[index], this.heap[parentIndex]] = [
        this.heap[parentIndex],
        this.heap[index],
      ];
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let largest = index;

      if (
        leftChild < this.heap.length &&
        this.compareFn(
          this.heap[leftChild].priority,
          this.heap[largest].priority,
        ) > 0
      ) {
        largest = leftChild;
      }

      if (
        rightChild < this.heap.length &&
        this.compareFn(
          this.heap[rightChild].priority,
          this.heap[largest].priority,
        ) > 0
      ) {
        largest = rightChild;
      }

      if (largest === index) break;

      [this.heap[index], this.heap[largest]] = [
        this.heap[largest],
        this.heap[index],
      ];
      index = largest;
    }
  }
}
