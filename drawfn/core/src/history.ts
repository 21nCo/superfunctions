import type { Scene } from './types';

export type HistoryState = {
  scene: Scene;
  timestamp: number;
};

export class History {
  private past: HistoryState[] = [];
  private future: HistoryState[] = [];
  private maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  push(scene: Scene): void {
    this.past.push({
      scene: JSON.parse(JSON.stringify(scene)),
      timestamp: Date.now(),
    });
    if (this.past.length > this.maxSize) {
      this.past.shift();
    }
    this.future = [];
  }

  undo(currentScene: Scene): Scene | null {
    if (this.past.length === 0) return null;

    this.future.push({
      scene: JSON.parse(JSON.stringify(currentScene)),
      timestamp: Date.now(),
    });

    const state = this.past.pop()!;
    return state.scene;
  }

  redo(currentScene: Scene): Scene | null {
    if (this.future.length === 0) return null;

    this.past.push({
      scene: JSON.parse(JSON.stringify(currentScene)),
      timestamp: Date.now(),
    });

    const state = this.future.pop()!;
    return state.scene;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  depth(): number {
    return this.past.length;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
