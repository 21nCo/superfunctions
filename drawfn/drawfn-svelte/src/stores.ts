import { writable, derived, type Readable } from 'svelte/store';
import type { Drawfn, Scene, ToolName, Camera } from '@21n/drawfn';

export type DrawfnStore = {
  instance: Drawfn | null;
  isReady: boolean;
  currentTool: ToolName;
  canUndo: boolean;
  canRedo: boolean;
  selectedIds: string[];
  elementCount: number;
  camera: Camera;
};

export function createDrawfnStore() {
  const { subscribe, set, update } = writable<DrawfnStore>({
    instance: null,
    isReady: false,
    currentTool: 'select',
    canUndo: false,
    canRedo: false,
    selectedIds: [],
    elementCount: 0,
    camera: { x: 0, y: 0, zoom: 1 },
  });

  return {
    subscribe,
    setInstance(instance: Drawfn) {
      update(state => ({
        ...state,
        instance,
        isReady: true,
        camera: instance.getCamera(),
        elementCount: instance.getElements().length,
      }));

      // Subscribe to instance events
      instance.on('historyChanged', ({ canUndo, canRedo }) => {
        update(state => ({ ...state, canUndo, canRedo }));
      });

      instance.on('selectionChanged', (ids) => {
        update(state => ({ ...state, selectedIds: ids }));
      });

      instance.on('elementAdded', () => {
        update(state => ({
          ...state,
          elementCount: instance.getElements().length,
        }));
      });

      instance.on('elementRemoved', () => {
        update(state => ({
          ...state,
          elementCount: instance.getElements().length,
        }));
      });

      instance.on('cameraChanged', (camera) => {
        update(state => ({ ...state, camera }));
      });
    },
    setTool(tool: ToolName, opts?: any) {
      update(state => {
        state.instance?.setTool(tool, opts);
        return { ...state, currentTool: tool };
      });
    },
    clear() {
      update(state => {
        state.instance?.clear();
        return state;
      });
    },
    destroy() {
      update(state => {
        state.instance?.destroy();
        return {
          ...state,
          instance: null,
          isReady: false,
        };
      });
    },
  };
}

export type DrawfnStoreType = ReturnType<typeof createDrawfnStore>;
