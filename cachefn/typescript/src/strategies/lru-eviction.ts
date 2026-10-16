/**
 * LRU (Least Recently Used) eviction policy
 */

/**
 * Node in the doubly-linked list
 */
class LRUNode<K> {
  constructor(
    public key: K,
    public prev: LRUNode<K> | null = null,
    public next: LRUNode<K> | null = null
  ) {}
}

/**
 * LRU cache implementation using doubly-linked list
 */
export class LRUList<K = string> {
  private head: LRUNode<K> | null = null;
  private tail: LRUNode<K> | null = null;
  private nodeMap: Map<K, LRUNode<K>> = new Map();

  /**
   * Mark a key as recently used (move to front)
   */
  touch(key: K): void {
    let node = this.nodeMap.get(key);

    if (!node) {
      // New node
      node = new LRUNode(key);
      this.nodeMap.set(key, node);
      this.addToFront(node);
    } else if (node !== this.head) {
      // Move existing node to front
      this.removeNode(node);
      this.addToFront(node);
    }
  }

  /**
   * Remove a key from the LRU list
   */
  remove(key: K): void {
    const node = this.nodeMap.get(key);
    if (node) {
      this.removeNode(node);
      this.nodeMap.delete(key);
    }
  }

  /**
   * Get the least recently used key
   */
  getLRU(): K | undefined {
    return this.tail?.key;
  }

  /**
   * Remove and return the least recently used key
   */
  evictLRU(): K | undefined {
    if (!this.tail) {
      return undefined;
    }
    const key = this.tail.key;
    this.remove(key);
    return key;
  }

  /**
   * Get the number of items in the list
   */
  get size(): number {
    return this.nodeMap.size;
  }

  /**
   * Clear all items
   */
  clear(): void {
    this.head = null;
    this.tail = null;
    this.nodeMap.clear();
  }

  /**
   * Add a node to the front of the list
   */
  private addToFront(node: LRUNode<K>): void {
    node.next = this.head;
    node.prev = null;

    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  /**
   * Remove a node from the list
   */
  private removeNode(node: LRUNode<K>): void {
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
}
