import { readable, type Readable } from "svelte/store";
import { createAdapterBridge, type AdapterSnapshot } from "@mdfn/adapter-kit";
import type { EditorController } from "@mdfn/core";

export function createMdfnStore(controller: EditorController): Readable<AdapterSnapshot> {
  const bridge = createAdapterBridge(controller);
  return readable(bridge.getSnapshot(), (set) => {
    const unsubscribe = bridge.subscribe(() => set(bridge.getSnapshot()));
    return () => { unsubscribe(); bridge.destroy(); };
  });
}
