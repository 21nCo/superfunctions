import { get, writable, type Readable } from "svelte/store";
import type { Camera, Drawfn, ToolName } from "drawfn";

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

export function createDrawfnStore(): DrawfnStoreType {
  const initialState: DrawfnStore = {
    instance: null,
    isReady: false,
    currentTool: "select",
    canUndo: false,
    canRedo: false,
    selectedIds: [],
    elementCount: 0,
    camera: { x: 0, y: 0, zoom: 1 },
  };
  const { subscribe, update } = writable<DrawfnStore>({
    ...initialState,
  });
  let unsubscribers: Array<() => void> = [];

  function clearSubscriptions(): void {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    unsubscribers = [];
  }

  return {
    subscribe,
    setInstance(instance: Drawfn) {
      clearSubscriptions();
      update((state) => ({
        ...state,
        instance,
        isReady: true,
        currentTool: instance.getTool(),
        canUndo: instance.getHistoryState().canUndo,
        canRedo: instance.getHistoryState().canRedo,
        selectedIds: instance.getSelectedIds(),
        camera: instance.getCamera(),
        elementCount: instance.getElements().length,
      }));

      unsubscribers.push(
        instance.on("historyChanged", ({ canUndo, canRedo }) => {
          update((state) => ({ ...state, canUndo, canRedo }));
        }) ?? (() => {}),
        instance.on("selectionChanged", (selectedIds) => {
          update((state) => ({ ...state, selectedIds }));
        }) ?? (() => {}),
        instance.on("sceneChanged", ({ scene }) => {
          update((state) => ({
            ...state,
            elementCount: scene.elements.length,
            camera: scene.camera,
          }));
        }) ?? (() => {})
      );
    },
    setTool(tool: ToolName, opts?: any) {
      update((state) => {
        state.instance?.setTool(tool, opts);
        return { ...state, currentTool: tool };
      });
    },
    clear() {
      get({ subscribe }).instance?.clear();
    },
    resetHistory() {
      get({ subscribe }).instance?.resetHistory();
    },
    destroy() {
      clearSubscriptions();
      update((state) => {
        state.instance?.destroy();
        return { ...initialState };
      });
    },
  };
}

export type DrawfnStoreType = {
  subscribe: Readable<DrawfnStore>["subscribe"];
  setInstance(instance: Drawfn): void;
  setTool(tool: ToolName, opts?: unknown): void;
  clear(): void;
  resetHistory(): void;
  destroy(): void;
};
